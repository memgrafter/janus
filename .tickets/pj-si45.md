---
id: pj-si45
status: closed
open: false
deps: []
links: []
created: 2026-08-23T18:28:31Z
type: feature
priority: 2
assignee: memgrafter
parent: pj-gvlk
tags: [pi-janus, config, timeout]
---
# Express the provider timeout in seconds (PI_JANUS_TIMEOUT_S, default 600)

Express the per-request provider timeout in seconds (PI_JANUS_TIMEOUT_S, default 600) instead of milliseconds (PI_JANUS_TIMEOUT_MS, default 120000).

## Why
A large-context prefill can be ~250s plus queue time on the shared vllm instance, so the old 120s default was too short. Seconds are easier to reason about; 600s (10 min) gives headroom.

## Change
- PI_JANUS_TIMEOUT_S: int, clamped 0-99999, default 600.
- 0 = disabled (wait for the client to abort; uses a max-int32 backstop so pi-ai/OpenAI SDK doesn't impose its own short timeout).
- server.ts converts to ms for pi-ai (timeoutMsFromConfig); a control-plane deadline (ctx.deadlineMs) still takes precedence.
- Config field renamed requestTimeoutMs -> requestTimeoutS. Docs updated.

## Depends on
- Core proxy (pj-vwed).

## Acceptance Criteria

PI_JANUS_TIMEOUT_S is parsed as an int clamped to 0-99999 with default 600; 0 disables the timeout (max-int32 backstop); a control-plane deadline still takes precedence; docs updated; suite green.

## Notes

**2026-08-23T18:28:38Z**

Done (commit 901ddf6): PI_JANUS_TIMEOUT_S (int, clamped 0-99999, default 600); 0 = disabled (max-int32 backstop); server.ts timeoutMsFromConfig converts to ms; ctx.deadlineMs still takes precedence. Config field renamed requestTimeoutMs -> requestTimeoutS. AGENTS.md + README.md updated. Unit: config.test.ts (default/override/0/clamp). Suite 85/85. pi-janus restarted with the new binary (600s default).
