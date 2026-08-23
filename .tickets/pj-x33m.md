---
id: pj-x33m
status: closed
open: false
deps: []
links: []
created: 2026-08-23T19:09:21Z
type: bug
priority: 1
assignee: memgrafter
parent: pj-gvlk
tags: [pi-janus, streaming, timeout, bug]
---
# Fix 'terminated' on large contexts: raise Bun.serve idleTimeout + SSE keep-alive

Large-context requests through pi-janus failed with "terminated" after ~12s even though the provider timeout was 600s.

## Symptom
Routing pi through pi-janus with a large context (~99k tokens) failed:
  Error: terminated / Aborted after N retry attempts
The failing assistant messages had a responseId (pi-janus sent the start chunk) but no content, and vllm showed 0 aborts/0 errors.

## Root cause
Bun.serve has a server-side idleTimeout that defaults to 12s: if no bytes are written to the client for 12s, the response is aborted. vllm sends NOTHING during prefill (verified: a 46k-token request was silent for 35.94s before the first byte). So during a slow prefill, pi-janus writes nothing to the client, and Bun.serve kills the downstream response at 12s while the upstream prefill is still in flight. pi (the client) tolerates the same silence via its own 300s httpIdleTimeoutMs, which is why direct pi->vllm works but pi->pi-janus->vllm does not.

## Fix
- server.ts: set Bun.serve idleTimeout to 255 (the max; Bun rejects >255).
- server.ts: makeKeepAlive() emits an SSE comment (": keep-alive\n\n", ignored by spec-compliant clients incl. the OpenAI SDK) every 10s while the upstream prefill is in flight, so the idle timer never trips even for >255s prefills. Wired into handleChat + handleResponses; stopped once the first real chunk is pushed or the stream ends.

## Verified
- Mock slow upstream: 15s/30s/60s prefills now complete cleanly (previously aborted at 12s).
- 25s prefill: keep-alive comments observed at ~10s and ~20s; content + [DONE] clean.
- OpenAI SDK SSE parser confirmed to ignore ':'-prefixed lines.
- 99k-token context through pi-janus (real vllm): 3/3 PASS.
- Suite 85/85.

## Acceptance Criteria

A large-context streaming request through pi-janus completes (no 'terminated') when the upstream prefill exceeds 12s; keep-alive SSE comments are emitted during the prefill and ignored by the client; suite passes.

## Notes

**2026-08-23T19:09:31Z**

Fixed (commit 0563c74): server.ts sets Bun.serve idleTimeout=255 (max) + makeKeepAlive() emits SSE comments every 10s during the prefill (ignored by the OpenAI SDK). Mock slow upstream 15/30/60s prefills now complete; 25s prefill shows keep-alive at ~10s/~20s; 99k-token context through pi-janus (real vllm) 3/3 PASS. Suite 85/85.
