#!/usr/bin/env bash
# The single build entrypoint for pi-janus. Produces a static binary.
#
# Usage:
#   ./scripts/build.sh                    # build for the host platform -> dist/pi-janus
#   ./scripts/build.sh --target <plat>    # build for a platform        -> dist/<plat>/pi-janus
#   ./scripts/build.sh --out <dir>        # custom output directory
#   ./scripts/build.sh --skip-deps        # do not run `bun install`
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

TARGET=""
OUT=""
SKIP_DEPS=false
while [[ $# -gt 0 ]]; do
	case "$1" in
	--target) TARGET="$2"; shift 2 ;;
	--out) OUT="$2"; shift 2 ;;
	--skip-deps) SKIP_DEPS=true; shift ;;
	*) echo "unknown arg: $1" >&2; exit 1 ;;
	esac
done

if [[ "$SKIP_DEPS" == false ]]; then
	ensure_deps
fi

if [[ -n "$TARGET" ]]; then
	build_one "$TARGET" "${OUT:-${DIST_DIR}/${TARGET}}"
else
	host="$(host_platform)"
	build_one "$host" "${OUT:-$DIST_DIR}"
fi
echo "==> build complete"
