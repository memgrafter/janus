# pi-janus

A local, OpenAI-compatible inference proxy built on [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi-mono). It speaks the OpenAI Chat Completions API and routes requests through pi-ai's unified multi-provider client.

## Endpoints

- `POST /v1/chat/completions` — streaming (SSE) and non-streaming.
- `POST /v1/systemone` — Jev decision API (see **Decisions** below).
- `GET /v1/models` — lists available models (auth-configured providers).
- `GET /health` — liveness.

## CORS

All responses carry `Access-Control-Allow-Origin: *` and `OPTIONS` preflights are answered (204, allowing `authorization`/`content-type`), so browser clients (e.g. the sitegeist extension) can call the proxy directly. Janus is a LAN proxy authenticated by bearer token, so a static `*` is safe — the token, not the origin, is the credential.

## Quick start

```bash
bun install
export OPENAI_API_KEY=...        # and/or ANTHROPIC_API_KEY, etc.
./scripts/build.sh               # -> dist/pi-janus (single static binary)
./dist/pi-janus                  # listens on http://127.0.0.1:8787
```

Point any OpenAI-compatible client at it:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
```

## Decisions (Jev /v1/systemone)

Janus can proxy Jev decision sources. Jev's `/v1/systemone` is a proprietary endpoint (not OpenAI Chat Completions), so janus routes it with a thin, transparent router instead of the model pipeline: a `decisions.json` file maps short **decision names** to `/v1/systemone` upstreams, and the request's `model` field selects one of them.

Typical `decisions.json` (the repo root has a working one):

```json
{
  "decisions": {
    "djev":        { "baseUrl": "http://127.0.0.1:8011" },
    "gliner2":     { "baseUrl": "http://127.0.0.1:8098" },
    "jev-prod":    { "baseUrl": "https://api.typesafe.ai", "apiKey": "$TYPESAFE_API_KEY", "model": "jev-latest" },
    "jev-preview": { "baseUrl": "https://api.typesafe.ai", "apiKey": "$TYPESAFE_API_KEY", "model": "jev-preview" }
  }
}
```

Point a client at the proxy and pick a decision name:

```bash
curl -s http://127.0.0.1:8787/v1/systemone -H 'content-type: application/json' -d '{
  "model": "jev-prod",
  "state": "Everything is down and we have a demo at noon.",
  "questions": { "urgent": { "type": "noul", "instructions": "Does this need an immediate response?" } }
}'
```

Notes:

- The body is forwarded verbatim; only `model` is special (routing key, rewritten per the source's `model` override when set).
- Upstream API keys stay on the server (`"$ENV_VAR"` resolution) — the client only needs janus's bearer token.
- Unknown name -> `404` listing the available names; upstream unreachable -> `502`; no `JANUS_DECISIONS_JSON` -> `503`.
- Each call is logged as `pi-janus: decision <name> -> <status> in <ms>` (the proxy is the measurement choke point for decision sources).
- On k3s: set the `decisions:` block in your Helm values (see `chart/values.example.yaml`); it renders a ConfigMap and sets `JANUS_DECISIONS_JSON` automatically.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `PI_JANUS_HOST` | `127.0.0.1` | bind host |
| `PI_JANUS_PORT` | `8787` | bind port |
| `PI_JANUS_TOKEN` | _(unset)_ | when set, require `Authorization: Bearer <token>` |
| `PI_JANUS_TIMEOUT_S` | `600` | per-request provider timeout in seconds (0 = disabled); clamped 0-99999 |
| `PI_JANUS_FAUX` | _(unset)_ | `1` to use the scripted faux provider (tests/demos) |
| `PI_JANUS_FAUX_RESPONSE` | `pi-janus faux ok` | faux provider response text |
| `JANUS_DECISIONS_JSON` | _(unset)_ | path to `decisions.json` for `/v1/systemone` routing (see **Decisions**); unset = endpoint returns 503 |

Provider API keys (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) are read from the environment by pi-ai's built-in providers.

## ClinePass (Cline subscription)

Serves the ClinePass models (`cline-pass/glm-5.3`, `cline-pass/kimi-k3`, `cline-pass/deepseek-v4-pro`, … 13 models) through the Cline gateway, using the OAuth credential the Cline CLI stores. Log in **once** on any machine with a browser, copy the credential file to the others, and every machine running pi-janus works without a per-machine login.

### 1. One-time login (any machine with a browser)

```bash
npm install -g cline     # the Cline CLI (v3.x); bun add -g cline also works
cline auth cline-pass
```

This runs a WorkOS device flow: open the printed URL, enter the code, done. The credential (access + refresh token) is written to `~/.cline/data/settings/providers.json` (mode 0600). No Cline monorepo checkout or build is needed — the published CLI is enough.

### 2. On each machine running pi-janus

Copy the credential file to the same path (or sync that directory):

```bash
scp some-machine:~/.cline/data/settings/providers.json ~/.cline/data/settings/providers.json
```

Then start pi-janus with ClinePass enabled:

```bash
JANUS_CLINE_PASS=1 ./dist/pi-janus
```

Use the full model slug in requests:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model": "cline-pass/glm-5.3", "messages": [{"role": "user", "content": "hi"}]}'
```

### 3. How it works

- pi-janus registers a `cline-pass` provider (`https://api.cline.bot/api/v1`, OpenAI-compatible) **only when** a usable credential is present in the Cline file — otherwise it's silently absent.
- The stored `workos:`-prefixed access token is sent verbatim as `Authorization: Bearer <token>`; the wire `model` is the full `cline-pass/<slug>`.
- When the token is within 5 minutes of expiry, pi-janus refreshes it via `POST /api/v1/auth/refresh` and writes the rotated tokens back to `providers.json` (atomic write, 0600, file-locked) — so the Cline CLI and pi-janus stay in sync on the same machine.
- ClinePass tokens are kept in the Cline file; all other providers' tokens stay in `~/.pi/agent/auth.json` (a routing credential store keeps them separate).

| Var | Default | Meaning |
|---|---|---|
| `JANUS_CLINE_PASS` | _(unset)_ | `1` to enable the ClinePass provider |
| `JANUS_CLINE_PROVIDERS_JSON` | `~/.cline/data/settings/providers.json` | path to the Cline CLI credential file |
| `JANUS_CLINE_API_BASE_URL` | `https://api.cline.bot` | Cline API base URL (staging/local) |

### 4. On the k3s cluster (Helm chart)

The chart ships ClinePass support. The credential is stored in a k8s **Secret** and seeded into the **PVC** (not mounted read-only) — because pi-janus must write rotated refresh tokens back to `providers.json`, a read-only Secret mount would break on the first refresh.

```bash
# 1. Create the secret from the credential file (on the machine where you logged in):
kubectl -n <ns> create secret generic janus-inference-control-plane-cline \
  --from-file=providers.json=$HOME/.cline/data/settings/providers.json

# 2. Enable it in your values file:
cline:
  enabled: true
  existingSecret: janus-inference-control-plane-cline

# 3. Deploy (persistence must stay enabled — the chart refuses to render otherwise):
helm upgrade --install janus-inference-control-plane ./chart/ -f <your-values.yaml> -n <ns>
```

**How the seeding works:** init containers copy `auth.json` and `providers.json` from their Secrets into the PVC **only if the corresponding file isn't already there**. After the first seed the PVC is the source of truth (it holds the rotated tokens), so a pod restart does **not** clobber them with stale Secret snapshots. To push a fresh login into the cluster: update the relevant Secret, remove its credential file from the PVC (or replace the file directly), and restart the pod.

**Caveat:** token refresh *rotates* the refresh token. The Cline CLI does not lock `providers.json`, so if the CLI and pi-janus refresh at the exact same moment on the same machine, one can double-spend the rotated token (rare — both only refresh in the final 5 minutes before expiry). Re-running `cline auth cline-pass` fixes it.

## Build / test / release

There is **one way to build**: `scripts/build.sh` (a single `bun build --compile`).

```bash
./scripts/build.sh              # host platform -> dist/pi-janus
./scripts/build.sh --target linux-x64   # a specific platform -> dist/linux-x64/pi-janus
./scripts/test.sh               # build, typecheck, unit + integration + live tests
./scripts/release.sh            # build all 6 platforms + SHA256SUMS
```

`scripts/test.sh` builds first, then runs unit + integration tests against source and **live tests against the built binary** (a local process). `scripts/release.sh` builds every platform via `build.sh` and emits checksums. Shared shell helpers live in `scripts/lib.sh`.

## Layout

```
src/
  index.ts     entrypoint (config + server + shutdown)
  server.ts    HTTP routes + request pipeline
  config.ts    env -> Config
  models.ts    pi-ai client (Models collection + model resolution)
  openai.ts    OpenAI wire-format + internal types
  bridge.ts    pi-ai Context/StreamOptions/AssistantMessage mapping
  sse.ts       SSE/JSON transport helpers
  credentials.ts       file-backed credential store (auth.json) + routing store
  cline-credentials.ts Cline CLI providers.json credential store
  cline-pass.ts        ClinePass provider (gateway, refresh, model catalog)
scripts/       build.sh (single build), test.sh, release.sh, lib.sh
test/          unit/ (pure), integration/ (in-process), live/ (built binary)
```

## Dependencies

Runtime: `@earendil-works/pi-ai` only (pinned exact). pi-ai's transitive provider SDKs are relied on transitively, not re-declared. The release is a single static binary with everything bundled.
