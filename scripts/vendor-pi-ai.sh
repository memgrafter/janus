#!/usr/bin/env bash
# Vendor the local pi-mono branch build of pi-ai into vendor/pi-ai/ so the
# Docker build can overlay it. The docker build context cannot reach
# ~/clones/pi-mono, so we copy the built dist into the repo first.
#
# Run before `docker build`:
#   ./scripts/vendor-pi-ai.sh
#
# Requires the local pi-ai to be built:
#   (cd $PI_MONO_AI && npm run build)
#
# PI_MONO_AI defaults to ~/clones/pi-mono/packages/ai (your branch).
set -euo pipefail
SRC="${PI_MONO_AI:-$HOME/clones/pi-mono/packages/ai}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DST="${ROOT}/vendor/pi-ai"
[ -f "$SRC/dist/api/openai-completions.js" ] || { echo "error: $SRC/dist missing — run: (cd $SRC && npm run build)" >&2; exit 1; }
rm -rf "$DST"
mkdir -p "$DST"
rsync -a "$SRC/dist/" "$DST/dist/"
cp "$SRC/package.json" "$DST/package.json"
echo "vendored pi-ai $(python3 -c "import json;print(json.load(open('$SRC/package.json'))['version'])") from $SRC -> $DST"
