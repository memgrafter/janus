---
id: pj-gvlk
status: open
open: true
deps: []
links: []
created: 2026-08-23T12:58:59Z
type: epic
priority: 0
assignee: memgrafter
tags: [pi-janus, proxy, pi-ai]
---
# pi-janus: local inference proxy on pi-ai (initial buildout)

pi-janus is a local inference proxy that unifies LLM inference using @earendil-works/pi-ai (from the pi-mono monorepo) as the inference client. It sits between priority workers (user-driven synchronous coding agents) and event-driven sources on one side, and the many LLM providers pi-ai supports on the other. This epic is the umbrella for the initial buildout; its children are the core proxy plus the components pi-mono does not provide.

## Vision

A single local proxy that:
1. Gathers telemetry on usage, quotas, and deadlines.
2. Receives configuration about which "intelligence types / categories" are available on any particular quota or deadline.
3. Takes a priority queue (or set) of available work for streams of inference that are set to expire, and allocates them.
4. Receives requests from priority synchronous workers (mainly user-driven synchronous coding agents) and from event-based requests, and drives inference to the correct project.

## What pi-mono provides (the client engine)

- @earendil-works/pi-ai (packages/ai): unified multi-provider LLM API. Build a Models collection of providers; call stream()/complete() (and streamSimple()/completeSimple()). Handles auth, model discovery, token/cost accounting, and streaming.
  - Usage: every AssistantMessage.usage carries input, output, cacheRead, cacheWrite, reasoning, totalTokens, and a full cost breakdown (input/output/cacheRead/cacheWrite/total). This is normalized per-request usage telemetry.
  - Model: the category descriptor — id, name, api, provider, reasoning, input (text/image), cost, contextWindow, maxTokens, thinkingLevelMap, samplingParams.
  - getModels()/getAvailable(): enumerate the catalog (available = auth configured).
  - createProvider(): register custom providers/categories (the proxy can expose "intelligence types" that are not a real upstream).
  - Deferred responses: Models.fetchDeferred(model, handle) / cancelDeferred(model, handle) with a DeferredHandle carrying provider, modelId, api, id, expiresAt, pollAfterMs, data. A request can return stopReason "deferred" with a durable handle — a unit of inference work that expires and can be polled/allocated later. NOTE: the contract is fully plumbed through Models/Provider/lazyApi, but only the faux provider implements it today; no real upstream provider does yet.
  - StreamOptions: onResponse(response, model) to read provider rate-limit headers; timeoutMs / maxRetryDelayMs for request deadlines; sessionId for session routing/caching; metadata and headers to carry project/priority/tenant.
- @earendil-works/pi-telemetry (packages/telemetry): vendor-neutral TelemetryContext/TelemetrySpan contract (spans, attributes, events, status) with an in-memory reference adapter and no backend dependency. Pass a telemetryContext into every request.
- @earendil-works/pi-agent (packages/agent): proxy.ts exports streamProxy(model, context, { proxyUrl, authToken, ... }) — the client-side proxy stream function. It POSTs { model, context, options } to ${proxyUrl}/api/stream with Bearer auth, consumes an SSE stream of partial-stripped events, and reconstructs the message client-side. A coding agent plugs it in as streamFn. pi-janus does not use this pi-native path — it builds an OpenAI-compatible server instead (see Target architecture).
- @earendil-works/pi-protocol (packages/protocol): CBOR + byte-stream framing wire protocol (experimental).
- @earendil-works/pi-server (packages/server): experimental session server (Unix socket) — a session server, NOT an inference proxy.

## What pi-mono does NOT provide (the gaps pi-janus must build)

1. The inference proxy server itself (the OpenAI-compatible chat-completions server).
2. The priority queue / work allocation logic.
3. The quota & deadline ledger.
4. The binding of intelligence categories to specific quotas/deadlines.
5. Event-driven request intake and project routing.

## Target architecture

A local HTTP server that:
- Holds a pi-ai Models collection (the inference client).
- Exposes an **OpenAI-compatible** API: `POST /v1/chat/completions` is the primary endpoint (streaming SSE + non-streaming); the OpenAI Responses API (`/v1/responses`) is a P2 followup (pj-q1fg).
- Wraps each request in a pi-telemetry TelemetryContext span; records usage/cost/latency/quota attributes.
- Reads onResponse for provider rate-limit headers to feed the quota/deadline ledger.
- Uses DeferredHandle as the expiring work item it allocates from a priority queue it owns.
- Routes requests to the correct project via sessionId/metadata/headers.

## Ticket breakdown (children of this epic)

- Core buildout: minimal productionized local proxy using pi-ai as the client, exposing an OpenAI-compatible chat-completions API. No scope beyond the minimal proxy.
- OpenAI Responses API (`/v1/responses`): P2 followup on the core's shared design (pj-q1fg).
- Quota & deadline ledger: track/enforce quotas and deadlines; capture rate-limit headers; telemetry on quotas/deadlines.
- Intelligence category registry & quota/deadline binding: configure "intelligence types/categories available" and bind them to specific quotas/deadlines; extend the pi-ai catalog with proxy-owned categories via createProvider.
- Priority queue & expiring-work allocation: priority queue of available work for expiring inference streams (DeferredHandle); allocation to workers respecting quotas/deadlines.
- Event-driven request intake & project routing: accept priority synchronous worker requests (coding agents via OpenAI-compatible client) and event-based requests; drive inference to the correct project.
- CI/CD: build, test, and release the single static binary (pj-t1q2).

## CI/CD & Release

Shipped as a single static binary (see release facts above). The pipeline, cross-platform build, test, and release process are tracked in **pj-t1q2 (CI/CD: build, test, and release the single binary)**. Direct deps are hard-pinned to exact versions: pi-ai is pinned exactly, and pi-ai's transitive provider SDKs are relied on transitively (pinned by pi-ai) rather than re-declared by pi-janus.

## Reference

pi-mono source: /Users/trentrobbins/clones/pi-mono
Key files:
- packages/ai/src/types.ts (Model, Usage, DeferredHandle, StreamOptions, AssistantMessageEvent)
- packages/ai/src/models.ts (Models, createModels, createProvider, complete, fetchDeferred)
- packages/ai/src/api/lazy.ts (lazyStream, lazyApi)
- packages/ai/src/providers/faux.ts (faux provider + deferred implementation for tests)
- packages/agent/src/proxy.ts (streamProxy client)
- packages/telemetry/src/index.ts (TelemetryContext/TelemetrySpan)
- packages/protocol/src (CBOR wire protocol)
- packages/server/src (experimental session server)
