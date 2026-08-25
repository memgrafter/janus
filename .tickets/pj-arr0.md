---
id: pj-arr0
status: open
open: true
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
