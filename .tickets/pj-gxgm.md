---
id: pj-gxgm
status: open
open: true
deps: [pj-fdxw]
links: [jan-hop4, jan-z81o]
created: 2026-08-25T13:10:59Z
type: feature
priority: 1
assignee: memgrafter
parent: pj-0x3c
tags: [auth, oauth, seeding, helm]
---
# Credential sync: safe k3s -> PVC credential sync tool (replaces importer-pod design)

NEVER IMPLEMENTED as originally designed (no script or manifest in the repo); rescope per 2026-09-11 finding. New scope: a `scripts/k3s-sync-credentials.sh <provider> <source-file>` command (e.g. `k3s-sync-credentials.sh openai-codex ~/.pi/agent/auth.json`) that:

- validates the credential (shape, provider supported);
- merges ONLY the selected providers into the live auth.json, preserving unrelated credentials;
- updates the live PVC atomically, ideally through a small authenticated Janus admin endpoint backed by `CredentialStore.modify()` (reaches the pod via kubectl port-forward) so it can't race an OAuth refresh or lose concurrent changes; a direct PVC-file fallback may be acceptable for v1 but must not clobber rotated tokens;
- updates the bootstrap Kubernetes Secret to match (Secret stays bootstrap-only; PVC is authoritative — see durability policy note on this ticket and jan-hop4);
- verifies hashes and /v1/models before reporting success;
- requires NO restart, Helm operation, or image build (Janus rereads auth.json per request).

Include a Cline adapter: `k3s-sync-credentials.sh cline-pass <source>` handling ClinePass credentials (OAuth providers.json or a static API key per jan-krpn), updating the cline Secret + PVC file.

## Design (superseded)

Original importer-pod/rsync scratch-dir design was never implemented and is superseded by the sync-command scope above. It is kept for history; do not implement this version.

## Acceptance

- `scripts/k3s-sync-credentials.sh openai-codex ~/.pi/agent/auth.json` validates the local credential, merges only openai-codex into the live PVC auth.json (other providers untouched), updates the bootstrap Secret, verifies hashes + /v1/models, and succeeds with no restart/Helm/image operation.
- A chat completion through the freshly synced credential succeeds immediately.
- The Cline adapter syncs a ClinePass credential (OAuth or static key) the same way.
- Re-running is idempotent; unrelated credentials are never modified.

## Notes

**2026-09-05T20:57:32Z**

Reopened 2026-09-11 after investigation: the importer-pod/rsync design was never implemented (no script/manifest in repo). Rescoped to a k3s-sync-credentials.sh tool that validates, merges only selected providers, atomically updates the live PVC (ideally via an authenticated Janus admin endpoint backed by CredentialStore.modify()), updates the bootstrap Secret, and verifies hashes + /v1/models with no restart. Cline adapter included. Durability policy: PVC authoritative, Secret bootstrap-only.
