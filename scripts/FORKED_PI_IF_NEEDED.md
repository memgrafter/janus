# Local pi-ai development

Janus pins a published `@earendil-works/pi-ai` in `package.json` and `bun.lock`.
For an unpublished upstream branch, build pi-ai in your own checkout and specify
its package directory explicitly:

```bash
export PI_MONO_AI=/path/to/pi-mono/packages/ai
(cd "$PI_MONO_AI" && npm run build)
./scripts/sync-pi-ai.sh
./scripts/build.sh --skip-deps
```

`build.sh` normally installs the registry pin. `--skip-deps` preserves the explicit
local overlay; reinstalling dependencies may replace it. Re-run the sync after an
install. Both sync and vendor scripts require a built `dist/` directory.

To package that local build intentionally:

```bash
./scripts/vendor-pi-ai.sh
./scripts/release.sh --vendor linux-x64
```

Default releases use the frozen published pin and ignore local vendor artifacts.
Deployments, service restarts, registries, and site-specific smoke tests are owned
by your infrastructure repository, not by this development workflow.
