# DEV.md — local development notes

## Building pi-janus against a local pi-mono branch

pi-janus pins `@earendil-works/pi-ai` to a published version in `bun.lock`. To build
against an unpublished pi-mono branch (e.g. `~/clones/pi-mono`), overlay the branch
build onto `node_modules` and build with `--skip-deps`:

```bash
# 1. build the branch (after any pi-ai changes)
(cd ~/clones/pi-mono/packages/ai && npm run build)

# 2. sync it into pi-janus + build
cd ~/code/pi-janus
./scripts/sync-pi-ai.sh          # rsync branch dist/ + package.json -> node_modules
./scripts/build.sh --skip-deps   # compile WITHOUT bun install
```

Restart the running server with the new binary:

```bash
kill $(lsof -ti:8787 -sTCP:LISTEN)
PI_JANUS_MODELS_JSON="$HOME/.pi/agent/models.json" nohup ./dist/pi-janus > /tmp/pi-janus.log 2>&1 &
```

### Why `--skip-deps`

`build.sh` runs `bun install` by default, which reconciles `node_modules` against
`bun.lock` and **restores the registry pi-ai**, silently dropping the branch overlay.
`--skip-deps` skips that step. The overlay is not tracked anywhere — a plain
`bun install` or `build.sh` will always revert it, so re-run `sync-pi-ai.sh` after any
install.

`sync-pi-ai.sh` reads the branch location from `$PI_MONO_AI` (default
`~/clones/pi-mono/packages/ai`) and fails if the branch `dist/` is missing.

### Verify the fix is in the binary

```bash
strings -n 8 ./dist/pi-janus | grep -c 'xhigh: "xhigh", max: "xhigh"'   # expect 1
```
