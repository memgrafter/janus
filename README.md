# pi-janus

A local, OpenAI-compatible inference proxy built on [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi-mono). It speaks the OpenAI Chat Completions API and routes requests through pi-ai's unified multi-provider client.

## Endpoints

- `POST /v1/chat/completions` — streaming (SSE) and non-streaming.
- `GET /v1/models` — lists available models (auth-configured providers).
- `GET /health` — liveness.

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

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `PI_JANUS_HOST` | `127.0.0.1` | bind host |
| `PI_JANUS_PORT` | `8787` | bind port |
| `PI_JANUS_TOKEN` | _(unset)_ | when set, require `Authorization: Bearer <token>` |
| `PI_JANUS_TIMEOUT_MS` | `120000` | per-request provider timeout |
| `PI_JANUS_FAUX` | _(unset)_ | `1` to use the scripted faux provider (tests/demos) |
| `PI_JANUS_FAUX_RESPONSE` | `pi-janus faux ok` | faux provider response text |

Provider API keys (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) are read from the environment by pi-ai's built-in providers.

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
scripts/       build.sh (single build), test.sh, release.sh, lib.sh
test/          unit/ (pure), integration/ (in-process), live/ (built binary)
```

## Dependencies

Runtime: `@earendil-works/pi-ai` only (pinned exact). pi-ai's transitive provider SDKs are relied on transitively, not re-declared. The release is a single static binary with everything bundled.
