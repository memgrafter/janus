#!/usr/bin/env bash
# Cross-platform binary release. chart/ is ONLY a portable template: never
# store site values here or use it as an authoritative cluster deployment.
# Keep cluster release scripts, registries, hosts, and runbooks outside this repo.
#
# Usage:
#   ./scripts/release.sh                              # test + all platforms
#   ./scripts/release.sh [--out DIR] <plat> ...        # selected platforms
#   ./scripts/release.sh --skip-tests <plat> ...       # already tested checkout
#   ./scripts/release.sh --vendor <plat> ...           # explicit local pi-ai overlay
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

OUT="$DIST_DIR"
RUN_TESTS=true
USE_VENDOR=false
SELECTED=()
while [[ $# -gt 0 ]]; do
	case "$1" in
	--out) OUT="$2"; shift 2 ;;
	--skip-tests) RUN_TESTS=false; shift ;;
	--vendor) USE_VENDOR=true; shift ;;
	-h | --help)
		printf '%s\n' 'Usage: scripts/release.sh [--out DIR] [--skip-tests] [--vendor] [platform ...]'
		exit 0 ;;
	-*) echo "unknown option: $1" >&2; exit 2 ;;
	*) SELECTED+=("$1"); shift ;;
	esac
done
if [[ ${#SELECTED[@]} -gt 0 ]]; then
	PLATFORMS=("${SELECTED[@]}")
fi
for platform in "${PLATFORMS[@]}"; do
	case "$platform" in
	darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64 | windows-x64 | windows-arm64) ;;
	*) echo "unsupported platform: $platform" >&2; exit 2 ;;
	esac
done
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

if [[ "$RUN_TESTS" == true ]]; then
	unset_args=()
	while IFS='=' read -r name _; do
		case "$name" in JANUS_* | PI_JANUS_*) unset_args+=( -u "$name" ) ;; esac
	done < <(env)
	env "${unset_args[@]}" "$SCRIPT_DIR/test.sh"
fi

# Build from a clean staging directory and the frozen dependency lock. A stale
# ignored vendor directory must never override the published dependency silently.
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/janus-release.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
BUILD_ROOT="$WORK_DIR/build"
mkdir -p "$BUILD_ROOT"
cp "$JANUS_ROOT/package.json" "$JANUS_ROOT/bun.lock" "$BUILD_ROOT/"
cp -R "$JANUS_ROOT/src" "$JANUS_ROOT/scripts" "$BUILD_ROOT/"
(
	cd "$BUILD_ROOT"
	bun install --frozen-lockfile
)
if [[ "$USE_VENDOR" == true ]]; then
	[[ -f "$JANUS_ROOT/vendor/pi-ai/package.json" && -d "$JANUS_ROOT/vendor/pi-ai/dist" ]] || {
		echo '--vendor requires vendor/pi-ai/package.json and dist/' >&2
		exit 1
	}
	rm -rf "$BUILD_ROOT/node_modules/@earendil-works/pi-ai/dist"
	cp -R "$JANUS_ROOT/vendor/pi-ai/dist" "$BUILD_ROOT/node_modules/@earendil-works/pi-ai/dist"
	cp "$JANUS_ROOT/vendor/pi-ai/package.json" "$BUILD_ROOT/node_modules/@earendil-works/pi-ai/package.json"
fi

for platform in "${PLATFORMS[@]}"; do
	"$BUILD_ROOT/scripts/build.sh" --target "$platform" --out "$OUT/$platform" --skip-deps
	if [[ "$platform" == linux-x64 ]]; then
		BINARY_TYPE="$(file "$OUT/$platform/pi-janus")"
		case "$BINARY_TYPE" in
		*"ELF 64-bit"*"x86-64"*) ;;
		*) echo "expected an x86-64 ELF binary, got: $BINARY_TYPE" >&2; exit 1 ;;
		esac
	fi
done

# Only checksum platforms selected in this invocation; do not delete other
# artifacts or arbitrary files in a caller-supplied output directory.
if command -v shasum >/dev/null 2>&1; then
	HASH_CMD=(shasum -a 256)
else
	HASH_CMD=(sha256sum)
fi
(
	cd "$OUT"
	for platform in "${PLATFORMS[@]}"; do
		"${HASH_CMD[@]}" "$platform/${BINARY_NAME}$(binary_ext "$platform")"
	done > SHA256SUMS
)
echo "==> release artifacts in $OUT"
cat "$OUT/SHA256SUMS"
