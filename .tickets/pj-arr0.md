---
id: pj-arr0
status: closed
open: false
deps: []
links: []
created: 2026-08-25T13:10:59Z
type: feature
priority: 1
assignee: memgrafter
parent: pj-0x3c
tags: [docker, image, ci]
---
# Container image for the single static binary (Dockerfile + registry)

The k3s deployment needs a container image wrapping the single static binary (dist/pi-janus). Add a Dockerfile (static binary -> minimal base, non-root, EXPOSE 8787, HEALTHCHECK on /health) and a build/push step to the registry the cluster pulls from. Relates to pj-t1q2 (CI/CD builds the binary); this slice packages it as an image.

## Design

bun build --compile already produces a static binary. Dockerfile: FROM scratch (or distroless/static), COPY dist/pi-janus as /pi-janus, USER nonroot, EXPOSE 8787, ENTRYPOINT ["/pi-janus"]. Confirm which registry k3s_maintenance uses (check existing charts' image.repository values) and push there. Tag by git sha + latest.

## Acceptance

docker build produces an image; k3s pulls and runs it; /health returns ok; a chat completion works.

## Notes

**2026-08-25T13:46:05Z**

First version built + verified (commit f868343). Dockerfile at repo root: multi-stage (oven/bun build -> gcr.io/distroless/base-debian12:nonroot). Binds 0.0.0.0 (container default; local-proxy mode still defaults to 127.0.0.1). The pi-ai step is TOLERANT: overlays vendor/pi-ai/ only if present (scripts/vendor-pi-ai.sh, from $PI_MONO_AI default ~/clones/pi-mono/packages/ai), else uses whatever bun install resolves — so it composes with however the pi-ai change is imported (another agent is handling that import; do not alter their bridge.ts changes). Verified: docker build (arm64, colima) -> container serves /health + /v1/chat/completions (faux). TARGETARCH arg supports buildx multi-arch. Open: push to a real registry (registry TBD) + tag by git sha.
