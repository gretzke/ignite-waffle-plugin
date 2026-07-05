#!/usr/bin/env node
// Ignite third-party compiler plugin for Waffle projects (e.g. Uniswap v2-core).
//
// Protocol (see Ignite's PluginExecutionUtils / finalizeImage):
//   - The operation name is the last argv element.
//   - Options arrive as a JSON object on stdin (read to EOF).
//   - Exactly one PluginResponse JSON object is written to stdout:
//       { success: true, data } | { success: false, error: { code, message } }
//   - Diagnostics go to stderr only.
//   - The repository under compilation is mounted at /workspace.
//
// The solc toolchain (solc-js 0.5.16) is bundled in the plugin image, so
// compilation works without network access and without installing anything
// into the workspace.

const fs = require('fs');
const path = require('path');

const PLUGIN_VERSION = '0.1.0';
const META = {
  id: 'waffle',
  type: 'compiler',
  name: 'Waffle',
  version: PLUGIN_VERSION,
  baseImage: `ignite/installed_waffle:${PLUGIN_VERSION}`,
};

const WORKSPACE = process.env.WORKSPACE_PATH || '/workspace';
const CONFIG_FILES = ['.waffle.json', 'waffle.json'];

function ok(data) {
  return { success: true, data };
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
      // resolve within the source set without an import callback.
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

// --- operations ---

function getInfo() {
  return ok(META);
}

function detect() {
  return ok({ detected: findConfigPath() !== null });
}

function install() {
  // The compiler ships inside the plugin image; there is nothing to install
  // into the workspace.
  return ok({});
}

function compile() {
  const config = loadConfig();
  if (!config) {
    return fail(
      'CONFIG_NOT_FOUND',
      'No .waffle.json or waffle.json found in the workspace'
    );
  }

  const solc = require('solc');
  const solcVersion = solc.version();
  if (
    typeof config.compilerVersion === 'string' &&
    /^\d+\.\d+\.\d+$/.test(config.compilerVersion) &&
    !solcVersion.startsWith(config.compilerVersion)
  ) {
    process.stderr.write(
      `warning: config requests solc ${config.compilerVersion}, ` +
        `plugin bundles ${solcVersion}\n`
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

  const input = { language: 'Solidity', sources, settings };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));

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
  process.stderr.write(`compiled ${written} contracts with ${solcVersion}\n`);
  return ok({});
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
      artifact = JSON.parse(fs.readFileSync(path.join(outDir, entry.name), 'utf8'));
    } catch {
      continue;
    }

    // Skip non-deployable outputs (interfaces/abstract contracts) and files
    // that are not solc contract outputs (e.g. Combined-Json.json).
    const creation = artifact && artifact.evm && artifact.evm.bytecode;
    if (!creation || !creation.object) continue;

    const fallbackName = entry.name.replace(/\.json$/, '');
    const metadata = parseMetadata(artifact);
    const target = metadata && metadata.settings && metadata.settings.compilationTarget;
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

  const creationCodeLinkReferences = normalizeLinkReferences(creation.linkReferences);
  const deployedBytecodeLinkReferences = normalizeLinkReferences(deployed.linkReferences);

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
};

function main() {
  const op = process.argv[process.argv.length - 1];
  const handler = OPERATIONS[op];
  let response;
  if (!handler) {
    response = fail('UNSUPPORTED_OPERATION', `Unknown operation: ${op}`);
  } else {
    const options = readOptions();
    try {
      response = handler(options);
    } catch (error) {
      response = fail(
        'PLUGIN_ERROR',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  process.stdout.write(JSON.stringify(response));
}

main();
