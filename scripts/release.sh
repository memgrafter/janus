#!/usr/bin/env bash
# Cross-platform release: build every platform (via build.sh, the single build
# path) and emit SHA256 checksums.
#
# Usage:
#   ./scripts/release.sh              # build all platforms
#   ./scripts/release.sh <plat> ...   # build only the given platform(s)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

if [[ $# -gt 0 ]]; then
	PLATFORMS=("$@")
fi

ensure_deps
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

for platform in "${PLATFORMS[@]}"; do
	"$SCRIPT_DIR/build.sh" --target "$platform" --skip-deps
done

# Checksums (portable: shasum on macOS, sha256sum on Linux).
if command -v shasum >/dev/null 2>&1; then
	HASH_CMD="shasum -a 256"
else
	HASH_CMD="sha256sum"
fi
(
	cd "$DIST_DIR"
	find . -type f \( -name "pi-janus" -o -name "pi-janus.exe" \) -print0 \
		| xargs -0 $HASH_CMD \
		| sed 's| \./| |' > SHA256SUMS
)

echo "==> release artifacts in $DIST_DIR"
cat "$DIST_DIR/SHA256SUMS"
