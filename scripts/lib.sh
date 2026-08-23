#!/usr/bin/env bash
# Shared helpers for pi-janus build/test/release. Sourced by the other scripts.
set -euo pipefail

# Repo root (parent of scripts/).
PI_JANUS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY_NAME="pi-janus"
DIST_DIR="${PI_JANUS_ROOT}/dist"
ENTRY="${PI_JANUS_ROOT}/src/index.ts"

# All supported release platforms.
PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)

# Map a platform name to its bun compile target.
bun_target_for() {
	local platform="$1"
	local target="bun-${platform}"
	if [[ "$platform" == *-x64 ]]; then
		target="${target}-baseline"
	fi
	echo "$target"
}

# File extension for a platform's binary.
binary_ext() {
	case "$1" in
	windows-*) echo ".exe" ;;
	*) echo "" ;;
	esac
}

# Detect the current host as a platform name (e.g. darwin-arm64).
host_platform() {
	local os arch
	os="$(uname -s | tr '[:upper:]' '[:lower:]')"
	arch="$(uname -m)"
	case "$os" in
	darwin | linux) ;;
	*) echo "unsupported OS: $os" >&2; return 1 ;;
	esac
	case "$arch" in
	arm64 | aarch64) arch="arm64" ;;
	x86_64 | amd64) arch="x64" ;;
	*) echo "unsupported arch: $arch" >&2; return 1 ;;
	esac
	echo "${os}-${arch}"
}

# Install dependencies (idempotent).
ensure_deps() {
	( cd "$PI_JANUS_ROOT" && bun install )
}

# build_one <platform> <out-dir>
# Build a single static binary for <platform> into <out-dir>/<binary>.
build_one() {
	local platform="$1"
	local out_dir="$2"
	local target out
	target="$(bun_target_for "$platform")"
	out="${out_dir}/${BINARY_NAME}$(binary_ext "$platform")"
	mkdir -p "$out_dir"
	echo "==> building ${platform} (${target}) -> ${out}"
	( cd "$PI_JANUS_ROOT" && bun build --compile --no-compile-autoload-bunfig --target="$target" "$ENTRY" --outfile "$out" )
}
