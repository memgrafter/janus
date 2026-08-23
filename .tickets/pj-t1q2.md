---
id: pj-t1q2
status: open
open: true
deps: [pj-vwed]
links: []
created: 2026-08-23T13:20:19Z
type: task
priority: 1
assignee: memgrafter
parent: pj-gvlk
tags: [pi-janus, cicd, release, build]
---
# CI/CD: build, test, and release the single binary

CI/CD for pi-janus: build, test, and release the single static binary.

## Build
- Single static binary via `bun build --compile --target=bun --packages=bundle --minify --no-compile-autoload-bunfig --outfile=pi-janus ./src/index.ts`.
- Cross-compile all 6 platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64 (mirror pi-mono scripts/build-binaries.sh).
- Bake the pi-ai model catalog in at build time (offline/snapshot, pi-mono --offline-model-data style) so the binary is self-contained and knows its intelligence categories without network.

## Test
- Run the test suite in CI using the faux provider (no real provider APIs, keys, or paid tokens) — same discipline as pi-mono.
- Build smoke test: compile the binary and run its health endpoint plus a faux end-to-end chat completion.

## Release
- One static binary per platform, versioned.
- Publish SHA256SUMS for integrity (mirror pi-mono release).
- Per-platform release artifacts (GitHub release or equivalent).

## Dependency pinning (important)
- Hard-pin pi-ai (and pi-telemetry, if referenced directly) to EXACT versions, the same way pi-mono pins its direct external deps (exact versions, package-lock.json as ground truth, `--ignore-scripts`).
- Prefer NOT to depend directly on pi-ai's transitive deps (openai, @anthropic-ai/sdk, @google/genai, @aws-sdk/client-bedrock-runtime, @opentelemetry/api, typebox, partial-json, http/https-proxy-agent). Rely on pi-ai's own pins for those — they arrive transitively and are pinned by pi-ai.
- Only add a direct dependency on a transitive dep if pi-janus must import it directly; then pin it to the exact version pi-ai uses and keep it in lockstep with pi-ai's pin.
- Rationale: avoids version drift between pi-janus and pi-ai's tested provider-SDK versions; keeps the supply chain minimal and auditable.

## Supply chain
- Mirror pi-mono: pinned exact direct deps, package-lock.json as ground truth, `npm ci --ignore-scripts` in CI, no lifecycle scripts.

## Depends on
- Core proxy (pj-vwed) — the release binary is the core proxy (+ components) compiled; CI/CD builds and ships it.

## Acceptance
- `bun build --compile` produces a runnable single binary for the host platform; health endpoint returns 200.
- CI builds all 6 platform binaries from a clean checkout.
- CI runs the faux-provider test suite green with no external API keys.
- Release produces per-platform binaries + SHA256SUMS.
- pi-janus package.json pins pi-ai to an exact version and declares no direct deps on pi-ai's transitive provider SDKs.
