---
id: pj-7ol0
status: closed
open: false
deps: []
links: []
created: 2026-08-23T18:23:02Z
type: feature
priority: 2
assignee: memgrafter
parent: pj-gvlk
tags: [pi-janus, abort, streaming, resilience]
---
# Propagate client abort to the upstream provider stream

Propagate the client's abort/disconnect to the upstream provider stream so a client timeout frees the provider instead of holding the request for pi-janus's full (long) timeout.

## Context
Discovered while live-testing the pi-janus provider in pi: with a large context, vllm (a shared instance) intermittently queues/slow-down, so the first token takes >~15s. pi (the client) owns its own timeout (httpIdleTimeoutMs) and aborts -> "terminated". pi-janus was still holding the upstream vllm request for its full timeout, leaking GPU time.

## Design (agreed)
- vllm queuing is normal, not an error: pi-janus should just wait (be resilient), not fail.
- pi (client) owns the timeout; pi-janus's own timeout stays long as a backstop.
- pi-janus must cancel the upstream when the client aborts.

## Fix
- server.ts: pass req.signal as options.signal to the pi-ai stream/complete in handleChat + handleResponses. pi-ai honors it (cancels the fetch, stopReason "aborted").
- Make the SSE enqueuing safe so a mid-stream client disconnect (cancelling the ReadableStream) doesn't throw an unhandled rejection.

## Verified
- Mock slow upstream: client abort at 1s -> upstream connection ABORTED by pi-janus after ~998ms.
- Integration: aborting a streaming request leaves the server healthy. Suite 84/84.

## Depends on
- Core proxy (pj-vwed).

## Acceptance Criteria

When a client aborts/disconnects mid-stream, pi-janus cancels the upstream pi-ai request (verified via a slow mock upstream seeing the connection drop); pi-janus's own timeout stays long as a backstop; a mid-stream client disconnect does not throw an unhandled rejection and the server stays healthy; suite green.

## Notes

**2026-08-23T18:23:10Z**

Fixed (commit a212cb6): server.ts passes req.signal as options.signal to the pi-ai stream/complete (handleChat + handleResponses); pi-ai cancels the upstream fetch on client abort (stopReason 'aborted'). SSE enqueuing made safe for mid-stream disconnects. Verified: mock slow upstream saw 'connection ABORTED by pi-janus after 998ms' on a 1s client abort. Integration test added (abort leaves server healthy). Suite 84/84.
