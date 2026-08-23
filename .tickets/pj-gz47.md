---
id: pj-gz47
status: open
open: true
deps: [pj-vwed, pj-1s1x]
links: []
created: 2026-08-23T12:59:09Z
type: feature
priority: 3
assignee: memgrafter
parent: pj-gvlk
tags: [pi-janus, events, routing]
---
# Event-driven request intake & project routing

Accept requests from priority synchronous workers (mainly user-driven synchronous coding agents) and from event-based sources, and drive inference to the correct project. Coding agents connect as OpenAI-compatible clients (via `OPENAI_BASE_URL` / a custom OpenAI-compatible provider); the server-side intake, event handling, and project routing do not come from pi-ai and are built here.

## Scope
- Synchronous worker intake: accept high-priority synchronous requests from coding agents (OpenAI-compatible clients pointed at the proxy's /v1/chat/completions). These are latency-sensitive and pre-empt background work.
- Event-based intake: accept event-driven requests (e.g., webhooks/queue messages) that request inference for a project; these feed the priority queue.
- Project routing: use sessionId / metadata / headers to route each request to the correct project (its category, quota bucket, deadline, and work queue).
- Priority: synchronous worker requests are prioritized over event/background work in allocation.
- Telemetry: emit spans/attributes for intake source (sync-worker vs event), project, and priority.

## Minimal implementation (selected)

- **Sync workers:** no new transport — coding agents already hit `/v1/chat/completions` via `OPENAI_BASE_URL`. Minimal = tag those as `source: "sync-worker"` + a **higher priority band** so the allocator pre-empts background work.
- **Event intake:** new `POST /v1/events` → `{ project, category, input, priority?, deadline? }` → enqueue a `WorkItem`, return `202` + work id; `GET /v1/work/:id` to poll status/result. (Push/webhook delivery deferred.)
- **Project routing:** `X-Project` header (or `metadata.project`) → project config `{ category, quotaBucket, deadline }`. This is where `sessionId`/`metadata`/`headers` (already in pi-ai's `StreamOptions`) carry the routing.
- **Priority bands:** `sync-worker > event/background`, enforced by the allocator's ordering.

## Depends on
- Core proxy (needs the request path + endpoints).
- Priority queue & expiring-work allocation (event work feeds the queue; sync work pre-empts it).

## Acceptance
- A coding agent pointed at the proxy via OPENAI_BASE_URL completes a synchronous turn.
- An event-based request enqueues work for the correct project.
- A synchronous worker request is allocated ahead of queued background work.
- Requests are routed to the correct project's category/quota/deadline.

## Notes

**2026-08-23T16:03:03Z**

Implemented: POST /v1/events + GET /v1/work/:id + X-Project routing + sync/event priority bands. Unit (control.test.ts) + integration + live.
