---
id: pj-xe41
status: open
open: true
deps: [pj-vwed]
links: []
created: 2026-08-23T12:59:08Z
type: feature
priority: 2
assignee: memgrafter
parent: pj-gvlk
tags: [pi-janus, quota, deadline, telemetry]
---
# Quota & deadline ledger

Track and enforce quotas and deadlines, and emit telemetry on them. This component does not come from pi-ai; pi-ai only provides the raw material (per-request Usage, onResponse rate-limit headers, timeoutMs/maxRetryDelayMs).

## Scope
- A ledger that records, per project/category/quota-bucket: consumed tokens/cost, remaining quota, and deadline.
- Capture provider rate-limit signals via StreamOptions.onResponse(response, model) — read headers like x-ratelimit-remaining-*, x-ratelimit-reset-*, retry-after — and fold them into the ledger.
- Enforce deadlines: apply timeoutMs / maxRetryDelayMs per request; reject or shed work that cannot meet its deadline.
- Enforce quotas: before dispatch, check the ledger; reject/queue when a bucket is exhausted.
- Telemetry: emit pi-telemetry spans/attributes for quota checks, quota exhaustion, deadline set/missed, and rate-limit observations.

## Depends on
- Core proxy (needs the request path + onResponse hook + telemetry context).

## Acceptance
- A request that would exceed a configured quota is rejected/queued with a clear reason.
- Rate-limit headers from a provider update the ledger and are observable via telemetry.
- A request with a deadline that cannot be met is shed/rejected rather than silently delayed.
