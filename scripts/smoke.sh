#!/usr/bin/env bash
# Smoke-test the plugin against a Waffle repo without going through Ignite:
#   ./scripts/smoke.sh /path/to/v2-core
#
# Builds the image, then exercises every operation the way Ignite does:
# operation as last argv, options JSON on stdin, one JSON response on stdout,
# a per-plugin cache volume mounted at /cache (IGNITE_PLUGIN_CACHE), and the
# workspace at /workspace. Compile runs with --network none; only the install
# operation (workspace npm deps) gets network, mirroring a 'net' grant.
set -euo pipefail

REPO="${1:?usage: smoke.sh /path/to/waffle-repo}"
IMAGE=ignite-waffle-plugin:smoke
CACHE_VOLUME=ignite-waffle-plugin-smoke-cache

cd "$(dirname "$0")/.."
docker build -t "$IMAGE" .

run_op() {
  local op="$1" options="${2:-{\}}" mount="${3:-rw}" network="${4:-none}"
  echo "--- $op (workspace $mount, network $network) ---" >&2
  echo "$options" | docker run --rm -i --network "$network" \
    -v "$REPO:/workspace:$mount" \
    -v "$CACHE_VOLUME:/cache" -e IGNITE_PLUGIN_CACHE=/cache \
    "$IMAGE" node /plugin/index.js "$op"
  echo >&2
}

run_op getInfo
run_op detect
run_op getWatchPaths
run_op install '{}' rw bridge
# First compile downloads the repo's solc version into /cache (network);
# the second proves the cached compiler works offline.
run_op compile '{}' rw bridge
run_op compile
run_op listArtifacts

ARTIFACT=$(echo '{}' | docker run --rm -i --network none \
  -v "$REPO:/workspace:ro" -v "$CACHE_VOLUME:/cache" -e IGNITE_PLUGIN_CACHE=/cache "$IMAGE" \
  node -e '
    const out = require("child_process").execSync(
      "echo {} | node /plugin/index.js listArtifacts").toString();
    const m = out.match(/<<<IGNITE_RESULT_BEGIN>>>([\s\S]*?)<<<IGNITE_RESULT_END>>>/);
    const a = JSON.parse(m[1]).data.artifacts[0];
    if (a) process.stdout.write(a.artifactPath);
  ')
if [ -n "$ARTIFACT" ]; then
  run_op getArtifactData "{\"artifactPath\":\"$ARTIFACT\"}" ro
fi

# Prove the permission model maps correctly: compile against a read-only
# workspace must fail (this is what an ungranted repoWrite looks like).
echo "--- compile (workspace ro, expected to fail) ---" >&2
echo '{}' | docker run --rm -i --network none \
  -v "$REPO:/workspace:ro" -v "$CACHE_VOLUME:/cache" -e IGNITE_PLUGIN_CACHE=/cache "$IMAGE" \
  node /plugin/index.js compile
echo >&2
