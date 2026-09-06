---
id: jan-tvno
status: open
open: true
deps: []
links: []
created: 2026-09-06T04:51:15Z
type: feature
priority: 3
assignee: memgrafter
tags: [routing, loop-guard, control-plane, hardening]
---
# Guard against routing cycles: hop-count header (x-janus-hop) max-hops=1

Add a hop-count guard so a request can never cycle through janus more than once, closing the remaining routing-loop hole left by the self-nested-id guard.

## Background

The self-referential model-id guard (shipped 2026-09-05, see AGENTS.md Gotchas) rejects a model whose id starts with its own provider prefix (e.g. provider `janus-k3s` + id `janus-k3s/openai/gpt-6-astra`), which is the realistic single-provider loop when a custom provider's baseUrl points back at janus. That guard is id-shape-based and does NOT cover a multi-hop cycle: two (or more) distinct custom providers whose baseUrls point back at janus (or at each other via janus) with mutually resolvable ids could still bounce a request around. A hop counter is the URL- and id-shape-agnostic fix.

## Design

1) Inbound check (server.ts request pipeline): if the incoming request carries the internal hop header already set, reject with 400 (loop detected) before admit/dispatch. External clients never send this header.
2) Outbound stamp: when janus dispatches to a provider whose baseUrl points back at janus (i.e. a self-referential / janus-facing custom provider), add/increment the hop header on the upstream request. Implement via the provider/model `headers` or an onPayload hook in custom-providers.ts / server.ts (verify pi-ai actually sends provider-level headers; model-level `headers` is confirmed sent by createClient).
3) Header name: `x-janus-hop` (value = hop count, start at 1). Max allowed = 1 (a request may traverse janus exactly once). Make the max a constant; consider an env override (e.g. PI_JANUS_MAX_HOPS) only if justified.
4) Keep the existing self-nested-id guard (registration skip + resolveModel assert) — the hop counter is defense in depth for cycles the id-shape rule cannot see.

## Acceptance Criteria

a) A request that arrives already carrying `x-janus-hop` is rejected with 400 and a clear "loop detected" message (integration test).
b) A legitimate external request (no header) is unaffected; janus stamps the header only on outbound calls to janus-facing providers (unit test on the header injection).
c) A constructed two-provider cycle through janus terminates with a 400 rather than looping (integration test, faux or local upstream).
d) No behavior change for providers whose baseUrl is a real external upstream (no header added, no rejection).

## Notes

Follow-up to the self-referential model-id guard (2026-09-05). Lower priority because the id-shape guard already covers the realistic misconfiguration; this hardens against arbitrary janus<->janus proxy cycles.
