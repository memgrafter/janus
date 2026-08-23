---
id: pj-q1fg
status: closed
open: false
deps: [pj-vwed]
links: []
created: 2026-08-23T13:44:51Z
type: feature
priority: 2
assignee: memgrafter
parent: pj-gvlk
tags: [pi-janus, openai, responses-api, followup]
---
# OpenAI Responses API (/v1/responses) endpoint

Add the OpenAI Responses API (POST /v1/responses) as a followup to the chat-completions core. P2 — build on the shared design from the core proxy (pj-vwed); do not duplicate its pi-ai mapping or transport.

## Scope
- POST /v1/responses (streaming + non-streaming), OpenAI Responses API shape:
  - Request: input (string or input-item array), instructions, tools, reasoning, text, temperature, max_output_tokens, stream, previous_response_id (optional).
  - Response: a Response object with output[] (message / reasoning / function_call items), status, usage, id.
  - Streaming emits response.* SSE events (response.created, response.output_item.added, response.content_part.added, response.output_text.delta, response.completed, ...).
- Map the Responses request to the same internal representation the core uses, then to a pi-ai Context + Model + StreamOptions (reuse the core's mapping layer).
- For models whose pi-ai api is "openai-responses", prefer native passthrough where feasible; otherwise translate.
- Reuse the core's SSE transport + usage accounting (AssistantMessage.usage -> Responses usage).

## Design dependency
- Requires the core (pj-vwed) to keep the OpenAI wire-format mapping, the pi-ai Context/StreamOptions mapping, and the SSE transport as separate layers, so this ticket adds a new wire-format layer without touching the others.

## Minimal implementation (selected)

A **protocol surface**, not a control-plane component. New wire-format layer `src/responses.ts` parallel to `openai.ts`, reusing `bridge.ts` (pi-ai mapping) + `sse.ts` (transport) + the control layer. Map the Responses request → the same `InternalRequest` → existing pipeline; emit `response.*` SSE events. Orthogonal to the ledger/queue/events components; build independently whenever.

## Depends on
- Core proxy (pj-vwed).

## Acceptance
- A non-streaming /v1/responses request returns a valid Response object with output[] and usage.
- A streaming /v1/responses request emits valid response.* SSE events ending in response.completed.
- A function/tool call round-trips (response emits a function_call output item; a follow-up carrying the function_call_output continues).
- No changes required to the core's pi-ai mapping or transport layers.

## Notes

**2026-08-23T16:03:03Z**

Implemented: src/responses.ts (parseResponsesRequest/responseToOpenAI/ResponsesChunker) + POST /v1/responses (stream + non-stream). Unit (responses.test.ts) + integration + live. No changes to bridge.ts/sse.ts.
