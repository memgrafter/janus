#!/usr/bin/env bash
# Overlay the local pi-mono branch build of pi-ai onto node_modules.
# Run before ./scripts/build.sh --skip-deps so the build bundles your branch.
# (Plain `bun install` would restore the registry version from bun.lock.)
set -euo pipefail
SRC="${PI_MONO_AI:-$HOME/clones/pi-mono/packages/ai}"
DST="$(cd "$(dirname "$0")/.." && pwd)/node_modules/@earendil-works/pi-ai"
[ -f "$SRC/dist/api/openai-completions.js" ] || { echo "error: $SRC/dist missing — run: (cd $SRC && npm run build)" >&2; exit 1; }
rsync -a --delete "$SRC/dist/" "$DST/dist/"
cp "$SRC/package.json" "$DST/package.json"
echo "synced pi-ai $(python3 -c "import json;print(json.load(open('$SRC/package.json'))['version'])") from $SRC"
