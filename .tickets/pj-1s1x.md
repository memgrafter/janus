---
id: pj-1s1x
status: closed
open: false
deps: [pj-vwed, pj-xe41]
links: []
created: 2026-08-23T12:59:09Z
type: feature
priority: 2
assignee: memgrafter
parent: pj-gvlk
tags: [pi-janus, priority-queue, allocation, deferred]
---
# Priority queue & expiring-work allocation

Take a priority queue (or set) of available work for streams of inference that are set to expire, and allocate them. The expiring-work primitive comes from pi-ai (DeferredHandle with expiresAt/pollAfterMs + fetchDeferred/cancelDeferred); the queue, priority, and allocation logic do not come from pi-ai and are built here.

## Scope
- A priority queue of inference work items. Each item references a DeferredHandle (provider, modelId, api, id, expiresAt, pollAfterMs, data) or a queued request, plus a priority and a target project/category.
- Expiry: items carry an expiration (DeferredHandle.expiresAt). Expired items are dropped/cancelled (cancelDeferred) and surfaced.
- Allocation: pick the highest-priority non-expired item whose quota/deadline allows it, and drive the inference (fetchDeferred to poll an in-flight deferred response, or dispatch a new stream).
- Backpressure/shedding: when no capacity (quota/deadline) is available, keep items queued up to their expiry or shed them.
- Telemetry: emit spans/attributes for enqueue, allocate, expire, shed, and complete.

## Minimal implementation (selected)

- **`WorkItem = { id, priority, project, category, quotaBucket, deadline, expiresAt, pollAfterMs?, deferredHandle? | request, enqueuedAt, status }`.**
- **Heap** keyed by `(priority, enqueuedAt)` — highest priority first, FIFO within a band. Small hand-rolled heap (Bun has none); sort-on-pop is fine at minimal scale.
- **Allocator:** a timer-driven loop (event-loop, cooperative — no worker threads) that pops the highest-priority non-expired item passing `ledger.check`, then drives it: `fetchDeferred(model, handle)` if it has a handle, else `stream(model, …)` for a plain queued request.
- **Expiry sweeper:** drops items past `expiresAt`, calls `cancelDeferred` when there's a handle, emits an `expire` event.
- **Constraint:** pi-ai's `DeferredHandle` is only implemented by the faux provider (no real upstream yet). The queue must be useful *without* real deferred — it queues **plain requests** with a client-side `expiresAt`; the deferred-handle path is exercised via faux. Real-provider deferred is a pi-ai gap to watch.

## Depends on
- Core proxy (needs the pi-ai client + request path).
- Quota & deadline ledger (allocation must respect quotas/deadlines).

## Acceptance
- Enqueued work is allocated in priority order.
- A work item past its expiresAt is cancelled/dropped and reported.
- Allocation never dispatches work that would exceed the target quota/deadline.

## Notes

**2026-08-23T16:03:03Z**

Implemented: PriorityQueue (binary max-heap) + runAllocator (expire/hold/drive) + server timer. Unit (queue.test.ts) + integration + live. Real-provider deferred (cancelDeferred) not exercisable (faux-only).
