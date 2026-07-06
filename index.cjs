#!/usr/bin/env node
// Ignite third-party compiler plugin for Waffle projects (e.g. Uniswap
// v2-core and v2-periphery).
//
// Protocol (see Ignite's pluginTransport / plugin-runner / finalizeImage):
//   - The operation name is the last argv element.
//   - Options arrive as a JSON object on stdin (read to EOF).
//   - The PluginResponse JSON is written to stdout framed by sentinels:
//       <<<IGNITE_RESULT_BEGIN>>>{...}<<<IGNITE_RESULT_END>>>
//     Framing is mandatory — there is no bare-JSON fallback.
//   - Everything else on stdout is streamed into user-visible job logs
//     (the sentinel block is filtered out); use it for progress output.
//   - The repository under compilation is bind-mounted at /workspace.
//   - Ignite provides a persistent per-plugin volume, advertised via
//     $IGNITE_PLUGIN_CACHE (mounted at /cache).
//
// solc strategy (hybrid): the image bundles solc-js 0.5.16, 0.6.6, and a
// modern 0.8.x; the target version is resolved per repo (waffle config, then
// the workspace package.json solc pin). Any other version is downloaded from
// binaries.soliditylang.org into the plugin cache — that path needs the
// Network permission once, then compiles run offline again.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

// Result framing sentinels (mirrors @ignite/plugin-types utils/protocol).
const RESULT_BEGIN = '<<<IGNITE_RESULT_BEGIN>>>';
const RESULT_END = '<<<IGNITE_RESULT_END>>>';

const PLUGIN_VERSION = '0.3.0';
const META = {
  id: 'waffle',
  type: 'compiler',
  name: 'Waffle',
  version: PLUGIN_VERSION,
  baseImage: `ignite/installed_waffle:${PLUGIN_VERSION}`,
};

const WORKSPACE = process.env.WORKSPACE_PATH || '/workspace';
const CACHE_DIR = process.env.IGNITE_PLUGIN_CACHE || '';
const CONFIG_FILES = ['.waffle.json', 'waffle.json'];
const SOLC_BIN_HOST = 'https://binaries.soliditylang.org/bin';

// soljson binaries baked into the image at npm ci time.
const BUNDLED_SOLJSON = {
  '0.5.16': 'solc-0.5.16/soljson.js',
  '0.6.6': 'solc-0.6.6/soljson.js',
  [require('solc/package.json').version]: 'solc/soljson.js',
};

function ok(data) {
  return { success: true, data };
}

// Non-sentinel stdout is streamed into the job log — user-visible progress.
function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(code, message, details) {
  return {
    success: false,
    error: details ? { code, message, details } : { code, message },
  };
}

function findConfigPath() {
  for (const name of CONFIG_FILES) {
    const p = path.join(WORKSPACE, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Waffle config with the same defaults Waffle applies.
function loadConfig() {
  const configPath = findConfigPath();
  if (!configPath) return null;
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const compilerOptions = raw.compilerOptions || {};
  return {
    sourceDirectory: raw.sourceDirectory || './contracts',
    outputDirectory: raw.outputDirectory || './build',
    compilerVersion: raw.compilerVersion,
    evmVersion: compilerOptions.evmVersion,
    optimizer: compilerOptions.optimizer,
  };
}

// Keep every path inside the mounted workspace.
function resolveInWorkspace(rel) {
  const abs = path.resolve(WORKSPACE, rel);
  if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`Path escapes workspace: ${rel}`);
  }
  return abs;
}

function collectSources(dir, base) {
  const sources = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(sources, collectSources(p, base));
    } else if (entry.name.endsWith('.sol')) {
      // Key sources by path relative to the workspace root (e.g.
      // "contracts/UniswapV2Pair.sol") so relative imports between them
      // resolve within the source set.
      const key = path.relative(base, p).split(path.sep).join('/');
      sources[key] = { content: fs.readFileSync(p, 'utf8') };
    }
  }
  return sources;
}

function parseMetadata(artifact) {
  if (typeof artifact.metadata !== 'string') return null;
  try {
    return JSON.parse(artifact.metadata);
  } catch {
    return null;
  }
}

function normalizeLinkReferences(linkRefs) {
  if (!linkRefs || typeof linkRefs !== 'object') return undefined;
  const result = {};
  for (const [file, contracts] of Object.entries(linkRefs)) {
    if (typeof contracts !== 'object' || contracts === null) continue;
    result[file] = {};
    for (const [name, positions] of Object.entries(contracts)) {
      if (!Array.isArray(positions)) continue;
      result[file][name] = positions.map((pos) => ({
        start: pos.start || 0,
        length: pos.length || 0,
      }));
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// --- solc version resolution & loading ---

// Waffle repos usually point compilerVersion at ./node_modules/solc and pin
// the actual version in package.json (e.g. v2-core: 0.5.16, v2-periphery:
// 0.6.6). Resolution: explicit semver in the waffle config wins, then the
// package.json solc pin.
function resolveSolcVersion(config) {
  if (
    typeof config.compilerVersion === 'string' &&
    /^\d+\.\d+\.\d+$/.test(config.compilerVersion)
  ) {
    return config.compilerVersion;
  }
  const pkgPath = path.join(WORKSPACE, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const pin =
      (pkg.dependencies && pkg.dependencies.solc) ||
      (pkg.devDependencies && pkg.devDependencies.solc);
    if (typeof pin === 'string') {
      const match = pin.match(/\d+\.\d+\.\d+/);
      if (match) return match[0];
    }
  }
  return null;
}

function httpsGet(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirects > 0
        ) {
          res.resume();
          resolve(httpsGet(res.headers.location, redirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

async function downloadSoljson(version) {
  const list = JSON.parse(
    (await httpsGet(`${SOLC_BIN_HOST}/list.json`)).toString('utf8')
  );
  const file = list.releases && list.releases[version];
  if (!file) {
    throw new Error(`solc ${version} is not a known release`);
  }
  const body = await httpsGet(`${SOLC_BIN_HOST}/${file}`);
  const dir = CACHE_DIR
    ? path.join(CACHE_DIR, 'solc-bin')
    : fs.mkdtempSync(path.join(require('os').tmpdir(), 'solc-'));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `soljson-${version}.js`);
  // Atomic write so an interrupted download never leaves a corrupt cache hit.
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, dest);
  return dest;
}

async function loadSolc(version) {
  const wrapper = require('solc/wrapper');
  if (BUNDLED_SOLJSON[version]) {
    return wrapper(require(BUNDLED_SOLJSON[version]));
  }
  const cached = CACHE_DIR
    ? path.join(CACHE_DIR, 'solc-bin', `soljson-${version}.js`)
    : '';
  if (cached && fs.existsSync(cached)) {
    log(`using cached solc ${version}`);
    return wrapper(require(cached));
  }
  log(`downloading solc ${version}...`);
  let downloaded;
  try {
    downloaded = await downloadSoljson(version);
  } catch (error) {
    throw new Error(
      `solc ${version} is not bundled and could not be downloaded ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `Grant the plugin the 'net' permission for one compile so the ` +
        `compiler can be downloaded and cached.`
    );
  }
  return wrapper(require(downloaded));
}

// --- operations ---

function getInfo() {
  return ok(META);
}

function detect() {
  return ok({ detected: findConfigPath() !== null });
}

// Fetch the workspace's Solidity dependencies (e.g. @uniswap/v2-core for
// v2-periphery) so package-style imports resolve at compile time. Dev
// toolchain deps are skipped — the compiler ships in this image. Needs
// hostWrite (granted for install) and network.
async function install() {
  const pkgPath = path.join(WORKSPACE, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return ok({});
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) {
    return ok({});
  }

  const args = ['install', '--omit=dev', '--no-audit', '--no-fund'];
  if (CACHE_DIR) args.push('--cache', path.join(CACHE_DIR, 'npm'));
  log(`$ npm ${args.join(' ')}`);
  const result = await new Promise((resolve) => {
    // Stream npm's output live into the job log; capture the stderr tail for
    // the error response.
    const child = spawn('npm', args, {
      cwd: WORKSPACE,
      env: { ...process.env, HOME: CACHE_DIR || '/tmp' },
    });
    let stderrTail = '';
    child.stdout.on('data', (c) => process.stdout.write(c));
    child.stderr.on('data', (c) => {
      process.stdout.write(c);
      stderrTail = (stderrTail + c.toString()).slice(-2000);
    });
    child.on('error', (error) =>
      resolve({ code: -1, stderrTail: String(error) })
    );
    child.on('close', (code) => resolve({ code, stderrTail }));
  });
  if (result.code !== 0) {
    return fail(
      'INSTALL_FAILED',
      `npm install exited with ${result.code}. If this is a network error, ` +
        `grant the plugin the 'net' permission.`,
      { stderr: result.stderrTail }
    );
  }
  return ok({});
}

async function compile() {
  const config = loadConfig();
  if (!config) {
    return fail(
      'CONFIG_NOT_FOUND',
      'No .waffle.json or waffle.json found in the workspace'
    );
  }

  const version = resolveSolcVersion(config);
  if (!version) {
    return fail(
      'SOLC_VERSION_UNRESOLVED',
      'Could not determine the solc version: set compilerVersion in the ' +
        'waffle config to an exact version (e.g. "0.6.6") or pin "solc" in ' +
        'package.json'
    );
  }

  let solc;
  try {
    solc = await loadSolc(version);
  } catch (error) {
    return fail(
      'SOLC_UNAVAILABLE',
      error instanceof Error ? error.message : String(error)
    );
  }

  const srcDir = resolveInWorkspace(config.sourceDirectory);
  if (!fs.existsSync(srcDir)) {
    return fail(
      'SOURCE_DIR_NOT_FOUND',
      `Source directory not found: ${config.sourceDirectory}`
    );
  }

  const sources = collectSources(srcDir, WORKSPACE);
  if (Object.keys(sources).length === 0) {
    return fail(
      'NO_SOURCES',
      `No .sol files found under ${config.sourceDirectory}`
    );
  }

  const settings = {
    // Request everything listArtifacts/getArtifactData need; metadata carries
    // the compiler version, settings, and compilationTarget.
    outputSelection: {
      '*': { '*': ['abi', 'metadata', 'evm.bytecode', 'evm.deployedBytecode'] },
    },
  };
  if (config.evmVersion) settings.evmVersion = config.evmVersion;
  if (config.optimizer) settings.optimizer = config.optimizer;

  // solc resolves relative imports against source unit names itself; only
  // package-style imports (@scope/pkg/...) reach this callback. They resolve
  // from the workspace's node_modules, populated by the install operation.
  const nodeModules = path.join(WORKSPACE, 'node_modules');
  const importCallback = (importPath) => {
    const abs = path.resolve(nodeModules, importPath);
    if (!abs.startsWith(nodeModules + path.sep)) {
      return { error: `Import escapes node_modules: ${importPath}` };
    }
    try {
      return { contents: fs.readFileSync(abs, 'utf8') };
    } catch {
      return {
        error:
          `Import not found: ${importPath} — run the plugin's install ` +
          `operation to fetch workspace dependencies`,
      };
    }
  };

  const input = { language: 'Solidity', sources, settings };
  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: importCallback })
  );

  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length > 0) {
    return fail(
      'COMPILATION_FAILED',
      errors.map((e) => e.formattedMessage || e.message).join('\n')
    );
  }

  // Write one artifact per contract, Waffle "multiple" style: the raw solc
  // contract output as <ContractName>.json in the output directory.
  const outDir = resolveInWorkspace(config.outputDirectory);
  fs.mkdirSync(outDir, { recursive: true });
  let written = 0;
  for (const contractsByName of Object.values(output.contracts || {})) {
    for (const [name, contract] of Object.entries(contractsByName)) {
      fs.writeFileSync(
        path.join(outDir, `${name}.json`),
        JSON.stringify(contract, null, 2)
      );
      written++;
    }
  }
  log(`compiled ${written} contracts with solc ${version}`);
  return ok({});
}

// Workspace-relative locations core stat-fingerprints on the host to decide
// when a recompile is needed. Resolved from the waffle config since source
// and output directories are user-configurable; package.json is included
// because it pins the solc version and the Solidity dependencies.
function getWatchPaths() {
  const stripDotSlash = (p) => p.replace(/^\.\//, '');
  const config = loadConfig();
  const configFiles = [];
  const found = findConfigPath();
  if (found) configFiles.push(path.basename(found));
  else configFiles.push(...CONFIG_FILES);
  configFiles.push('package.json');
  return ok({
    config: configFiles,
    sources: [stripDotSlash(config ? config.sourceDirectory : './contracts')],
    artifacts: [
      stripDotSlash(config ? config.outputDirectory : './build'),
    ],
  });
}

function listArtifacts() {
  const config = loadConfig();
  if (!config) return ok({ artifacts: [] });

  const outDir = resolveInWorkspace(config.outputDirectory);
  if (!fs.existsSync(outDir)) return ok({ artifacts: [] });

  const artifacts = [];
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    let artifact;
    try {
      artifact = JSON.parse(
        fs.readFileSync(path.join(outDir, entry.name), 'utf8')
      );
    } catch {
      continue;
    }

    // Skip non-deployable outputs (interfaces/abstract contracts) and files
    // that are not solc contract outputs (e.g. Combined-Json.json).
    const creation = artifact && artifact.evm && artifact.evm.bytecode;
    if (!creation || !creation.object) continue;

    const fallbackName = entry.name.replace(/\.json$/, '');
    const metadata = parseMetadata(artifact);
    const target =
      metadata && metadata.settings && metadata.settings.compilationTarget;
    const sourcePath = target ? Object.keys(target)[0] || '' : '';
    const contractName = target && sourcePath ? target[sourcePath] : fallbackName;

    artifacts.push({
      contractName,
      sourcePath,
      artifactPath: path
        .join(config.outputDirectory, entry.name)
        .replace(/^\.\//, ''),
    });
  }
  return ok({ artifacts });
}

function getArtifactData(options) {
  const artifactPath = options && options.artifactPath;
  if (!artifactPath) {
    return fail('INVALID_OPTIONS', 'artifactPath is required');
  }

  const absPath = resolveInWorkspace(artifactPath);
  if (!fs.existsSync(absPath)) {
    return fail('ARTIFACT_NOT_FOUND', `Artifact file not found: ${artifactPath}`);
  }

  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return fail('ARTIFACT_PARSE_ERROR', `Failed to parse artifact: ${artifactPath}`);
  }

  const metadata = parseMetadata(artifact);
  const settings = (metadata && metadata.settings) || {};
  const compiler = (metadata && metadata.compiler) || {};
  const evm = artifact.evm || {};
  const creation = evm.bytecode || {};
  const deployed = evm.deployedBytecode || {};

  const hex = (obj) => (obj && obj.object ? `0x${obj.object}` : '0x');

  const creationCodeLinkReferences = normalizeLinkReferences(
    creation.linkReferences
  );
  const deployedBytecodeLinkReferences = normalizeLinkReferences(
    deployed.linkReferences
  );

  const data = {
    solidityVersion: compiler.version || 'unknown',
    optimizer: (settings.optimizer && settings.optimizer.enabled) || false,
    optimizerRuns: (settings.optimizer && settings.optimizer.runs) || 0,
    evmVersion: settings.evmVersion,
    viaIR: false,
    // solc 0.5.x always embeds a bzzr1 swarm hash; the bytecodeHash setting
    // only exists from 0.6 onward.
    bytecodeHash:
      (settings.metadata && settings.metadata.bytecodeHash) || 'bzzr1',
    abi: artifact.abi || [],
    creationCode: hex(creation),
    deployedBytecode: hex(deployed),
  };
  if (creationCodeLinkReferences) {
    data.creationCodeLinkReferences = creationCodeLinkReferences;
  }
  if (deployedBytecodeLinkReferences) {
    data.deployedBytecodeLinkReferences = deployedBytecodeLinkReferences;
  }
  return ok(data);
}

// --- CLI runner ---

function readOptions() {
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {
    input = '';
  }
  if (!input.trim()) return {};
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

const OPERATIONS = {
  getInfo,
  detect,
  install,
  compile,
  listArtifacts,
  getArtifactData,
  getWatchPaths,
};

async function main() {
  const op = process.argv[process.argv.length - 1];
  const handler = OPERATIONS[op];
  let response;
  if (!handler) {
    response = fail('UNSUPPORTED_OPERATION', `Unknown operation: ${op}`);
  } else {
    const options = readOptions();
    try {
      response = await handler(options);
    } catch (error) {
      response = fail(
        'PLUGIN_ERROR',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  process.stdout.write(
    `\n${RESULT_BEGIN}${JSON.stringify(response)}${RESULT_END}\n`
  );
}

main();
