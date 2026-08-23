---
id: pj-1s1x
status: open
open: true
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

## Depends on
- Core proxy (needs the pi-ai client + request path).
- Quota & deadline ledger (allocation must respect quotas/deadlines).

## Acceptance
- Enqueued work is allocated in priority order.
- A work item past its expiresAt is cancelled/dropped and reported.
- Allocation never dispatches work that would exceed the target quota/deadline.
