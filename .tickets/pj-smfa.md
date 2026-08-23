---
id: pj-smfa
status: open
open: true
deps: []
links: []
created: 2026-08-23T17:02:48Z
type: review
priority: 1
assignee: memgrafter
parent: pj-gvlk
tags: [pi-janus, review, control-plane]
---
# Review: inference control plane (ledger, categories, queue, events, responses)

Review the inference control plane implementation (commit 993e4a6). This ticket is self-contained — everything a reviewer needs is below. No prior context required.

## What was built

The control plane sits above the core's three-layer design (wire-format / pi-ai mapping / transport), which is left intact. It adds: quota/deadline ledger, category registry, priority queue + allocator, event intake + project routing, and the OpenAI Responses API. New endpoints: /v1/categories, /v1/events, /v1/work/:id, /v1/telemetry, /v1/responses. Config via PI_JANUS_CONFIG (JSON) + PI_JANUS_ALLOC_MS; the plane is inert when unset.

## Scope (what to review)

- New (6): src/control.ts (the spine), src/ledger.ts, src/categories.ts, src/queue.ts, src/telemetry.ts, src/responses.ts
- Modified (3): src/server.ts (pipeline + 5 endpoints + allocator timer — the biggest change), src/config.ts (plane-config loading), src/openai.ts (1 line: export parseMessage)
- Untouched: src/bridge.ts, src/sse.ts, src/models.ts, src/index.ts. The original 27 core tests pass unchanged.

Review surface = 6 new files + server.ts. Everything else is additive.

## Intentional decisions (do NOT "fix" these — they are deliberate)

1. Inert by default: no PI_JANUS_CONFIG -> no buckets/categories/projects -> everything admitted, queue empty. The core behaves exactly as before; quotas only engage once a bucket is configured.
2. Sync is inline, events are queued. /v1/chat/completions + /v1/responses dispatch immediately (priority band sync); /v1/events enqueues (band event) and a timer allocates. "Sync pre-empts background" is satisfied by sync never waiting in the queue — there is no pre-emption mechanism.
3. Quota is a soft cap (check-before, no reservation). check() runs pre-dispatch with estTokens=0; record() runs post. A bucket at exactly its limit still admits one more request, which then pushes it over. estTokens is in the API but always called with 0 (estimation deferred).
4. Project overrides model: if X-Project / metadata.project names a configured project, the project's category/quotaBucketId/deadlineMs win over the request's model. A raw model with no category/project binding has no quota bucket (unbounded).
5. Telemetry is port-first: a local Telemetry interface + in-memory ring at /v1/telemetry; pi-telemetry is a later adapter, not a dependency.

## Focus areas (highest risk — scrutinize these)

- queue.ts:runAllocator — the trickiest code. A quota-blocked top item is popped, held, and re-enqueued after the pass. Check: busy-loop when everything is blocked (bounded by the timer, but no back-off); and that re-enqueue preserves enqueuedAt (FIFO within a band).
- Fire-and-forget async dispatch: tick() -> drive() does `void this.dispatchWork(item)`. The allocator does not await complete(), so a tick can start the next allocation before the previous dispatch resolves. No double-dispatch (the item leaves the queue on pop) but there is NO in-flight cap.
- Unbounded Control.completed map: completed/expired work items are never evicted, so memory grows with total events processed. Fine for minimal; a real follow-up.
- server.ts stream path: confirm usage is recorded on the done event (once), not per-chunk.

## Intentionally NOT there (deferred — do not flag as bugs)

- No persistence (restart resets quotas/queue).
- No real deferred handles: pi-ai's DeferredHandle is faux-only, so fetchDeferred/cancelDeferred are not exercisable end-to-end; the queue runs on plain requests + client-side expiresAt.
- No custom createProvider categories (shape only; categories bind to real or faux models).
- No worker threads (cooperative single event loop).
- No push delivery for events (poll GET /v1/work/:id).
- Responses API is minimal: message / function_call / function_call_output + text; no reasoning, previous_response_id, or file search.

## Coverage gaps (unit-tested, NOT end-to-end)

- Rate-limit folding: ledger.observeRateLimit is unit-tested, but no test drives a provider that actually emits x-ratelimit-* via onResponse (faux doesn't). The server.ts onResponse wiring is untested e2e.
- Deadline shedding: runAllocator expiry is unit-tested; no integration/live test where an event expires before allocation.
- Tool round-trip: the Responses wire mapping (parse function_call_output, emit function_call item) is unit-tested, but there is no e2e tool-call round-trip (faux doesn't emit tool calls).
- Sync-preempts-event: queue ordering is unit-tested; no e2e "sync completes while an event is queued."

## Where to look (in order)

1. src/control.ts — the spine: admit / enqueueEvent / tick / dispatchWork.
2. src/queue.ts — runAllocator (riskiest logic).
3. src/server.ts — pipeline + 5 endpoints + allocator timer.
4. src/ledger.ts, src/categories.ts — straightforward.
5. test/integration/control.test.ts + test/live/live.test.ts — the behavioral contract.

## How to verify

Full suite (build + typecheck + unit + integration + live), 79 tests:
    ./scripts/test.sh

Smoke test:
    cd ~/code/pi-janus && export PATH="$HOME/.bun/bin:$PATH"
    ./scripts/build.sh
    PI_JANUS_FAUX=1 PI_JANUS_CONFIG=test/fixtures/plane.json PI_JANUS_ALLOC_MS=50 ./dist/pi-janus &
    curl -s localhost:8787/v1/categories
    curl -s localhost:8787/v1/chat/completions -H 'content-type: application/json' \
      -d '{"model":"fast","messages":[{"role":"user","content":"hi"}]}'
    curl -s localhost:8787/v1/events -H 'content-type: application/json' \
      -d '{"project":"demo","messages":[{"role":"user","content":"hi"}]}'   # -> 202 {id}
    curl -s localhost:8787/v1/work/<id>    # -> completed after ~50ms
    curl -s localhost:8787/v1/telemetry

## Related

Implements (code committed, tickets still open): pj-xe41 (ledger), pj-1uyc (categories), pj-1s1x (queue), pj-gz47 (events/routing), pj-q1fg (Responses API). Each carries a "Minimal implementation (selected)" section describing the agreed design.

## Acceptance Criteria

Approval requires all of the following:
- The 5 intentional decisions (inert-by-default, sync-inline/event-queued, soft-cap quota, project-overrides-model, port-first telemetry) are accepted as-is, or explicit changes are requested.
- The 4 focus areas (runAllocator hold/re-enqueue, fire-and-forget dispatch with no in-flight cap, unbounded completed map, stream usage recorded once) are confirmed correct or have fixes.
- The coverage gaps are acknowledged and, if desired, turned into follow-up tickets (not required to close for approval).
- ./scripts/test.sh is green (79/79).
