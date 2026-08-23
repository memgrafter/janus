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

## Depends on
- Core proxy (needs the request path + endpoints).
- Priority queue & expiring-work allocation (event work feeds the queue; sync work pre-empts it).

## Acceptance
- A coding agent pointed at the proxy via OPENAI_BASE_URL completes a synchronous turn.
- An event-based request enqueues work for the correct project.
- A synchronous worker request is allocated ahead of queued background work.
- Requests are routed to the correct project's category/quota/deadline.
