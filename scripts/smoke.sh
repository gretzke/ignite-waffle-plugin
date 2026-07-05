#!/usr/bin/env bash
# Smoke-test the plugin against a Waffle repo without going through Ignite:
#   ./scripts/smoke.sh /path/to/v2-core
#
# Builds the image, then exercises every operation the way Ignite does:
# operation as last argv, options JSON on stdin, one JSON response on stdout.
# All ops run with --network none to prove no network is needed at runtime.
set -euo pipefail

REPO="${1:?usage: smoke.sh /path/to/waffle-repo}"
IMAGE=ignite-waffle-plugin:smoke

cd "$(dirname "$0")/.."
docker build -t "$IMAGE" .

run_op() {
  local op="$1" options="${2:-{\}}" mount="${3:-rw}"
  echo "--- $op (workspace $mount) ---" >&2
  echo "$options" | docker run --rm -i --network none \
    -v "$REPO:/workspace:$mount" "$IMAGE" node /plugin/index.js "$op"
  echo >&2
}

run_op getInfo
run_op detect
run_op install
run_op compile
run_op listArtifacts

ARTIFACT=$(echo '{}' | docker run --rm -i --network none -v "$REPO:/workspace:ro" "$IMAGE" \
  node -e '
    const r = JSON.parse(require("child_process").execSync(
      "echo {} | node /plugin/index.js listArtifacts").toString());
    const a = r.data.artifacts[0];
    if (a) process.stdout.write(a.artifactPath);
  ')
if [ -n "$ARTIFACT" ]; then
  run_op getArtifactData "{\"artifactPath\":\"$ARTIFACT\"}" ro
fi

# Prove the permission model maps correctly: compile against a read-only
# workspace must fail (this is what an ungrated hostWrite looks like).
echo "--- compile (workspace ro, expected to fail) ---" >&2
echo '{}' | docker run --rm -i --network none -v "$REPO:/workspace:ro" "$IMAGE" \
  node /plugin/index.js compile
echo >&2
