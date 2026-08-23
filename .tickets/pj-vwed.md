---
id: pj-vwed
status: open
open: true
deps: []
links: []
created: 2026-08-23T12:59:03Z
type: feature
priority: 1
assignee: memgrafter
parent: pj-gvlk
tags: [pi-janus, core, proxy]
---
# Core: minimal productionized local inference proxy (pi-ai client, chat-completions API)

Build the minimal productionized local inference proxy. **Wire contract: OpenAI-compatible** — the proxy speaks the OpenAI Chat Completions API so any OpenAI-compatible client (configured with `OPENAI_BASE_URL` / `OPENAI_API_KEY`) can use it. Scope is strictly: use @earendil-works/pi-ai as the inference client behind that OpenAI-compatible endpoint. Do NOT step beyond this minimal proxy — no priority queue, no quota/deadline ledger, no category binding, no event-driven dispatch. Those are separate tickets under the epic. The OpenAI Responses API is a P2 followup (pj-q1fg), not part of this ticket.

## Scope
- A local HTTP server exposing an OpenAI-compatible POST /v1/chat/completions endpoint (streaming SSE + non-streaming).
- Hold a pi-ai Models collection (createModels() + provider registration). Start with a configurable set of providers (env-var API keys).
- Map the incoming chat-completions request (model, messages, tools, temperature, max_tokens, stream) to a pi-ai Context + Model + StreamOptions.
- stream=true: use models.stream() and emit OpenAI-compatible SSE chunks (chat.completion.chunk) from the pi-ai AssistantMessageEvent stream, ending in [DONE].
- stream=false: use models.complete() and return a chat.completion JSON body.
- Return usage (prompt_tokens, completion_tokens, total_tokens) in the response, sourced from AssistantMessage.usage.
- Model selection: accept a model id; resolve via models.getModel(provider, id) or a simple alias map.
- Auth: a single local bearer token (or open on localhost) — minimal.
- Productionized: structured logging, graceful shutdown, health endpoint, config via env, sensible error mapping (4xx/5xx), request timeout.

## Design constraint (keeps the Responses API followup feasible)
Keep three layers separate so pj-q1fg (OpenAI Responses API) can add a new wire-format layer without a rewrite:
1. **OpenAI wire-format mapping** — chat-completions request/response <-> an internal request/response representation.
2. **pi-ai mapping** — internal representation <-> pi-ai `Context` + `Model` + `StreamOptions` (provider-agnostic).
3. **Transport** — SSE emission / JSON response writing + usage accounting, decoupled from any specific OpenAI message shape.
The pi-ai mapping and transport layers must not be entangled with chat-completions-specific field names.

## Out of scope (separate tickets)
- OpenAI Responses API (`/v1/responses`) — P2 followup, pj-q1fg
- Priority queue / expiring-work allocation
- Quota & deadline ledger
- Intelligence category registry & quota/deadline binding
- Event-driven request intake & project routing

## Acceptance
- A non-streaming chat completion against a configured provider returns a correct chat.completion with usage.
- A streaming chat completion returns valid SSE chat.completion.chunk frames ending in [DONE].
- An OpenAI-compatible client (e.g. a coding agent set to `OPENAI_BASE_URL=http://localhost:<port>/v1`) completes a turn against the proxy.
- Health endpoint returns 200; server shuts down gracefully on SIGTERM.
