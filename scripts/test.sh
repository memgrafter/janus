#!/usr/bin/env bash
# Build, then run unit + integration + live tests.
#   - builds first (via build.sh) so there is one way to build
#   - unit + integration tests run against source (bun test)
#   - live tests run the BUILT BINARY as a local process
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "==> [1/4] build"
"$SCRIPT_DIR/build.sh"

echo "==> [2/4] typecheck"
( cd "$JANUS_ROOT" && bunx tsc --noEmit )

echo "==> [3/4] unit + integration tests"
( cd "$JANUS_ROOT" && bun test test/unit test/integration )

echo "==> [4/4] live tests (built binary)"
( cd "$JANUS_ROOT" && bun test test/live )

echo "==> all tests passed"
