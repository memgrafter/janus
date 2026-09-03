# AGENTS.md

Guidance for agents working in this repo. Read this first.

## What this is

**pi-janus** — a local, **OpenAI-compatible** inference proxy built on `@earendil-works/pi-ai` (the client engine from the pi-mono monorepo). It speaks the OpenAI Chat Completions API and routes requests through pi-ai's unified multi-provider client.

End-to-end vision is an **inference control plane** (proxy + source/sink router + signal emitter + quota/deadline/priority + telemetry). **Built so far:** the OpenAI-compatible core (`POST /v1/chat/completions`, `GET /v1/models`, `GET /health`) **plus the control plane** — quota/deadline ledger, category registry, priority queue + allocator, event intake + project routing, the OpenAI Responses API (`POST /v1/responses`), and the ZCode/Z.AI (GLM) provider (`zcode` + `zcode-apikey`). The signal emitter (trigger jobs, start/stop streams) is the remaining direction.

## Commands

**One way to build:** `./scripts/build.sh`. `test.sh` and `release.sh` both call it.

```bash
bun install                 # needs bun on PATH (see Gotchas)
./scripts/build.sh          # host platform -> dist/pi-janus (single static binary)
./scripts/build.sh --target linux-x64   # a specific platform -> dist/<plat>/pi-janus
./scripts/test.sh           # build -> typecheck -> unit+integration -> live (built binary)
./scripts/release.sh        # all 6 platforms + SHA256SUMS
```

Individual steps (already wired into `test.sh`):

```bash
bunx tsc --noEmit                       # typecheck (strict)
bun test test/unit test/integration     # source-level tests (in-process server, port 0)
bun test test/live                      # runs the BUILT BINARY as a local process
```

Run the server: `./dist/pi-janus` (listens on `http://127.0.0.1:8787`), or `bun run src/index.ts`.

## Builds

- `scripts/build.sh` is the only binary build entrypoint. Run `scripts/test.sh` before release.
- Container releases use the repository `Dockerfile`. It runs `bun install`, overlays `vendor/pi-ai`, then calls `scripts/build.sh --skip-deps`.
- Refresh `vendor/pi-ai` with `scripts/vendor-pi-ai.sh` only when intentionally updating pi-ai. Do not bypass the overlay with a host-built binary.
- Build k3s images on native AMD64. If Bun fails under QEMU on an ARM host, use a native AMD64 Docker host and transfer the finished image to a registry-capable host for pushing.
- Push both an immutable tag and `latest`. For a dirty tree, include a content hash in the immutable tag. Pin Helm values to the immutable tag.
- After deployment, verify `/health` and run a real pi agent through existing providers and the new provider. A curl-only smoke test is insufficient.

## Architecture

Two tiers. The **core** is a three-layer separation (mandated so new wire formats slot in without a rewrite): `wire-format -> pi-ai mapping -> transport`. The **control plane** sits above the core and is the single place that decides admit / queue / reject and which quota + deadline applies. `server.ts` chains them per request.

```
control plane   (control.ts: ledger + categories + queue + allocator)
      |
wire-format  ->  pi-ai mapping  ->  transport
(openai.ts /    (bridge.ts)        (sse.ts)
 responses.ts)
```

```
src/
  index.ts       entrypoint: loadConfig + createServer + SIGINT/SIGTERM shutdown; import.meta.main guard
  server.ts      Bun.serve: routes, bearer auth, request pipeline, allocator timer
  config.ts      loadConfig(env); parsePlaneConfig/loadPlaneConfig (JSON control-plane config)
  models.ts      createClient(config) -> {models, resolveModel}; builtinModels() or faux; registers custom providers
  custom-providers.ts  registerModelsJson(models, path): load a pi models.json catalog -> createProvider + getApiProvider per provider; resolveApiKey ("$ENV" or literal); skip bad providers non-fatally
  control.ts     Control: composes ledger + categories + queue; admit()/enqueueEvent()/tick(); PRIORITY bands
  ledger.ts      Ledger: per-bucket token/cost/rate-limit tracking; check/record/observeRateLimit/deadlineMs
  categories.ts  CategoryRegistry: category -> models + quotaBucket + deadline; resolve()
  queue.ts       PriorityQueue (binary max-heap) + WorkItem + runAllocator (expire/hold/drive)
  telemetry.ts   Telemetry port + InMemoryTelemetry (bounded ring; exposed via /v1/telemetry)
  responses.ts   OpenAI Responses API wire-format: parseResponsesRequest, responseToOpenAI, ResponsesChunker
  zcode.ts       ZCode/Z.AI (GLM) providers: Coding Plan (JWT + fingerprint + system prompt + captcha) & API-key upstreams, error taxonomy
  zcode-conf.ts  zcode.conf hot-readable credential/config loader (mtime/size cache)
  zcode-captcha.ts  Aliyun captcha verifyParam cache (TTL, ratchet, deduped waiters)
  zcode-captcha-page.txt  the captcha solve page (served at /zcode/captcha.html)
  openai.ts      Chat Completions wire-format + shared Internal* types; parseChatRequest; StreamChunker; OpenAIError
  bridge.ts      toPiContext(req,model), toPiStreamOptions(req), assistantMessageToInternal(msg)
  sse.ts         sseHeaders, sseData, sseDone, jsonHeaders, jsonResponse
scripts/         lib.sh (shared helpers); build.sh; test.sh; release.sh
test/            unit/ (pure), integration/ (in-process server), live/ (built binary), fixtures/ (plane.json), util.ts
```

### Endpoints

- `POST /v1/chat/completions` — streaming (SSE) + non-streaming.
- `POST /v1/responses` — OpenAI Responses API, streaming + non-streaming.
- `GET /v1/models` — pi-ai models as `provider/id`.
- `GET /v1/categories` — intelligence categories + live availability.
- `POST /v1/events` — enqueue async work for a project -> `202 { id }`.
- `GET /v1/work/:id` — poll a work item's status/result.
- `GET /v1/telemetry` — the in-memory telemetry ring (quota/deadline/rate-limit observations).
- `GET /health` — liveness.
- `GET /zcode/captcha.html` — ZCode captcha solve page (unauthenticated; the Aliyun SDK runs client-side).
- `GET /v1/zcode/captcha/config` — captcha scene config for the page (unauthenticated).
- `POST /v1/zcode/captcha/submit` — submit a solved `verifyParam` (unauthenticated).

### Control plane flow

- **Sync** (`/v1/chat/completions`, `/v1/responses`): `control.admit(req, project)` resolves the category (or raw model) -> quota bucket + deadline, checks the ledger, and either dispatches inline (priority band `sync`) or rejects `429`/`400`. Usage is recorded on completion; provider rate-limit headers are folded in via `StreamOptions.onResponse`.
- **Event** (`/v1/events`): enqueues a `WorkItem` (priority band `event`). A timer (`PI_JANUS_ALLOC_MS`) runs `control.tick()` -> `runAllocator`, which expires stale items, holds quota-blocked ones, and drives the rest through the pi-ai client (non-stream `complete`), storing the result for `GET /v1/work/:id`.
- **Project routing**: `X-Project` header (or `body.metadata.project`) -> project config `{ category, quotaBucketId, deadlineMs }`.
- **Inert by default**: with no `PI_JANUS_CONFIG` there are no buckets/categories/projects, so everything is admitted and the queue stays empty — the core behaves exactly as before.

Model id / category resolution: a request's `model` may be a **category id** or a raw `provider/id` / bare `id`. `CategoryRegistry.resolve` handles both; `/v1/models` lists raw pi-ai ids as `provider/id`.

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `PI_JANUS_HOST` | `127.0.0.1` | bind host |
| `PI_JANUS_PORT` | `8787` | bind port |
| `PI_JANUS_TOKEN` | _(unset)_ | when set, require `Authorization: Bearer <token>` |
| `PI_JANUS_TIMEOUT_S` | `600` | per-request provider timeout in seconds (0 = disabled); clamped 0-99999 |
| `PI_JANUS_FAUX` | _(unset)_ | `1`/`true` to use the scripted faux provider (tests/demos) |
| `PI_JANUS_FAUX_RESPONSE` | `pi-janus faux ok` | faux response text |
| `PI_JANUS_CONFIG` | _(unset)_ | path to a JSON control-plane config (buckets/categories/projects); unset = inert plane |
| `PI_JANUS_ALLOC_MS` | `1000` | allocator tick interval (ms) for queued event work |
| `PI_JANUS_MODELS_JSON` | _(unset)_ | path to a pi `models.json` provider catalog (e.g. `~/.pi/agent/models.json`); registers those providers alongside the builtins |
| `JANUS_ZCODE` | _(unset)_ | `1`/`true` to enable the ZCode/Z.AI (GLM) providers (`zcode` Coding Plan + `zcode-apikey`) |
| `JANUS_ZCODE_CONF` | `~/.janus/zcode.conf` | hot-readable ZCode credential/config file (see below); edits take effect without a restart |
| `JANUS_PUBLIC_URL` | _(unset)_ | public origin for URLs surfaced to clients (e.g. the ZCode captcha page); set for k3s/remote where 127.0.0.1 is unreachable |

Provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) are read from the environment by pi-ai's built-in providers — pi-janus does not manage them. When `PI_JANUS_MODELS_JSON` is set, `custom-providers.ts` also registers the providers in that catalog (each with its own `baseUrl`/`apiKey`/`api`); a provider's `apiKey` may be a literal (e.g. `"0"`) or an env ref (`"$OPENROUTER_API_KEY"`). Providers with no models, no `api`, or an unknown `api` are skipped with a warning (non-fatal). Request a catalog model as `provider/id` (e.g. `vert-qwen38-dual-fast/qwen3.8-27b`).

**ZCode/Z.AI (GLM) provider** (`JANUS_ZCODE=1`): two Anthropic-format upstreams, credentials from a hot-readable `zcode.conf` (`JANUS_ZCODE_CONF`, `chmod 600` — it holds live credentials; no ZCode app install required). Both providers are always registered; each is listed by `/v1/models` only while its credential is present, so adding/rotating a credential needs no restart. `zcode` = Coding Plan (`zcode.z.ai`, `Authorization: Bearer <zcodeJwt>` + ZCode fingerprint headers + system-prompt injection + `glm-5.2`→`GLM-5.2` mapping), gated by an Aliyun captcha (body code `3007`): janus serves `/zcode/captcha.html`, the solved `verifyParam` is cached for `captchaTtlMs` (default 300s) and rides on `X-Aliyun-Captcha-Verify-Param`; a rejected cached param is dropped (ratchet) and re-challenged. `zcode-apikey` = `api.z.ai` with `x-api-key` (no captcha). Error taxonomy is matched on body codes: `401` re-authenticate, `3007` captcha (URL surfaced in the error; browser auto-opened locally), `1113` quota, `3010` concurrency. Request models as `zcode/glm-5.2` or `zcode-apikey/glm-5.2`.

## pi-ai API surface used

Pinned to `@earendil-works/pi-ai@0.84.3` (exact). Verified against `~/clones/pi-mono/packages/ai` (main).

- **Main entry** `@earendil-works/pi-ai`: `createModels`, `createProvider`, `fauxProvider`, `fauxAssistantMessage`; types `Model`, `Context`, `StreamOptions`, `AssistantMessage`, `AssistantMessageEvent`, `Usage`, `Tool`, `TSchema`, `Api`.
- **Subpath** `@earendil-works/pi-ai/providers/all`: `builtinModels()` (registers all built-in providers; reads provider keys from env).
- **Subpath** `@earendil-works/pi-ai/compat`: `getApiProvider(api)` -> `{ api, stream, streamSimple }` (the per-API stream impls). Importing this subpath runs `registerBuiltInApiProviders()` at module load, populating the registry with `openai-completions` etc. — this is why `custom-providers.ts` imports from `/compat`.
- `Models` methods: `getModels()`, `getModel(provider,id)`, `getAvailable()`, `stream(model,context,options)`, `complete(model,context,options)`, `setProvider()`.

## Gotchas (will bite you)

- **`bun` must be on PATH.** It's the official Rust build at `~/.bun/bin/bun`, symlinked to `~/.local/bin/bun`. In a bare shell that lacks it: `export PATH="$HOME/.bun/bin:$PATH"`. `~/.bun` is `BUN_INSTALL` (binary + package cache) — **do not delete**.
- **`Model` is generic** — always use `Model<Api>`. Bare `Model` is a type error.
- **`builtinModels()` is a subpath import** (`.../providers/all`), not the main entry.
- **`fauxProvider` is a finite one-shot queue** (`pendingResponses.shift()`; errors "No more faux responses queued" when empty). Faux mode therefore queues **10000** identical responses so it serves many requests.
- **Streaming tests must concatenate deltas** — the faux provider splits text across multiple `text_delta` events. Use `test/util.ts:extractContentDeltas`.
- **Live tests run the built binary** (`dist/pi-janus`), not source. `test.sh` builds first; running `bun test test/live` standalone requires a prior `build.sh`.
- **`bun build --compile` drops `.*.bun-build` temp files** in cwd (gitignored).
- **0 other runtime deps** — only `@earendil-works/pi-ai` (pinned exact). Rely on pi-ai's transitive pins; do **not** re-declare its provider SDKs.

## Conventions

Follow pi-mono's `AGENTS.md` style: concise, no fluff; **top-level imports only** (no inline `import()`); no `any` unless necessary; erasable-TS syntax (no `enum`/`namespace`/parameter properties); strict mode. Tab indentation.

## Tickets / roadmap

Work is tracked with the `tk` CLI (file-based, in-repo `.tickets/`). Key commands: `tk ls`, `tk ready`, `tk blocked`, `tk show <id>`, `tk dep <id> <dep>`, `tk start <id>`, `tk close <id>`.

| ID | P | Title | deps |
|---|---|---|---|
| `pj-gvlk` | 0 | **Epic**: initial buildout | — |
| `pj-vwed` | 1 | Core: minimal OpenAI-compat proxy | — |
| `pj-t1q2` | 1 | CI/CD: build/test/release single binary | core |
| `pj-xe41` | 2 | Quota & deadline ledger | core |
| `pj-1uyc` | 2 | Intelligence category registry & quota/deadline binding | core, quota |
| `pj-1s1x` | 2 | Priority queue & expiring-work allocation | core, quota |
| `pj-gz47` | 3 | Event-driven request intake & project routing | core, priority |
| `pj-q1fg` | 2 | OpenAI Responses API (`/v1/responses`) | core |
| `jan-j61u` | 2 | ZCode/Z.AI (GLM) provider: research (9router PR #3614 + live probing) | — |
| `jan-7uv8` | 2 | ZCode/Z.AI provider: zcode.conf (hot-read), dual-upstream GLM, captcha page + 300s cache | jan-j61u |

**Implemented + tested (unit + integration + live):** core (`pj-vwed`), quota/deadline ledger (`pj-xe41`), category registry (`pj-1uyc`), priority queue + allocation (`pj-1s1x`), event intake + routing (`pj-gz47`), the Responses API (`pj-q1fg`), and the ZCode/Z.AI (GLM) provider (`jan-7uv8`). Remaining: CI/CD (`pj-t1q2`) and the **control-plane signal emitter** (trigger jobs, start/stop streams) — the eventual direction, **not yet a ticket**. Known gap: pi-ai's `DeferredHandle` is only implemented by the faux provider, so real-provider expiring-work (`fetchDeferred`/`cancelDeferred`) is not yet exercisable end-to-end.

## Reference

- pi-mono source: `~/clones/pi-mono` (on `main`, v0.84.3) and `~/clones/pi-mono-dev` (branch `dev`, tracks `upstream/dev`).
- pi-ai source (the dependency): `~/clones/pi-mono-dev/packages/ai`.
- Key pi-ai files: `src/types.ts` (Model, Usage, DeferredHandle, StreamOptions, AssistantMessageEvent), `src/models.ts` (Models, createModels, createProvider, fetchDeferred), `src/providers/faux.ts` (faux provider + deferred impl).
- pi-ai is **client-only** — no HTTP server, no `/v1/models`, no `/v1/chat/completions` anywhere in pi-mono. pi-janus builds the server.
