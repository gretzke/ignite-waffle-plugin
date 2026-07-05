# ignite-waffle-plugin

A third-party [Ignite](https://github.com/gretzke/ignite) compiler plugin for
[Waffle](https://getwaffle.io/) projects such as
[Uniswap v2-core](https://github.com/Uniswap/v2-core).

The plugin bundles **solc-js 0.5.16** inside its Docker image and compiles the
workspace directly via solc standard JSON, using the repository's
`.waffle.json` / `waffle.json` for compiler settings (`evmVersion`,
`optimizer`, source/output directories). Nothing is installed into the
workspace and no network access is needed at runtime — compiling v2-core this
way reproduces the canonical `UniswapV2Pair` init code hash
(`0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f`).

## Layout

| File | Purpose |
| --- | --- |
| `Dockerfile` | Builds the plugin image: `node:22-slim` + `npm ci` (solc) + entrypoint at `/plugin/index.js` |
| `index.cjs` | Self-contained entrypoint implementing the Ignite plugin protocol |
| `scripts/smoke.sh` | Exercises every operation against a local Waffle repo without Ignite |

## Protocol

Ignite execs `node /plugin/index.js <operation>` inside the container, writes
an options JSON object to stdin, and parses a single response object from
stdout: `{ "success": true, "data": ... }` or
`{ "success": false, "error": { "code", "message" } }`. The repository is
mounted at `/workspace`.

Implemented operations:

- `getInfo` — plugin metadata (`id: waffle`, `type: compiler`)
- `detect` — true if `.waffle.json` or `waffle.json` exists in the workspace
- `install` — no-op (the toolchain ships in the image)
- `compile` — solc standard JSON build; writes one artifact per contract to
  the configured output directory (default `build/`), Waffle "multiple" style
- `listArtifacts` — deployable contracts, with source paths recovered from
  solc metadata (`compilationTarget`)
- `getArtifactData` — normalized artifact info (abi, creation/deployed
  bytecode, compiler settings, link references)

## Permissions

- `compile` / `install` require the **Host Write** grant (the workspace volume
  is mounted read-only without it).
- **Network** is never required — the compiler is baked into the image.

## Installing into Ignite

- **Local path (dev mode):** run Ignite with `--dev`, then Settings → Plugins
  → `+` → *From Local Path* and select this directory.
- **Git URL:** Settings → Plugins → `+` → *From GitHub* once this repo is
  pushed. The image builds inside Ignite's isolated builder; `npm ci` works
  there because npm honors the injected proxy env.

After installing, grant *Host Write* when prompted (or via the Plugins tab),
open a Waffle repository, and compile.

## Smoke test

```sh
./scripts/smoke.sh /path/to/v2-core
```

Builds the image and runs every operation against the given repo with
`--network none`, including a read-only compile that demonstrates the
`hostWrite` failure mode.
