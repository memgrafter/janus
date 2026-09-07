---
id: jan-ppsz
status: open
open: true
deps: []
links: [jan-hop4, jan-v39j, pj-fx5e]
created: 2026-09-07T18:17:07Z
type: feature
priority: 1
assignee: memgrafter
tags: [hot-reload, catalog, models.json, custom-providers, k3s]
---
# Catalog hot reload: reread models.json so provider/model changes apply without a pod restart

The models.json catalog (PI_JANUS_MODELS_JSON / JANUS_MODELS_JSON) is read ONCE at startup: createClient() calls registerModelsJson(models, config.modelsJsonPath) a single time (src/models.ts:42) via one readFileSync (src/custom-providers.ts:164), and the provider/model registry is built and cached. Adding or changing a provider/model in the catalog therefore requires a pod restart (or a full k3s-release.sh). This is the gap left by jan-hop4, which hot-reloads CREDENTIALS (auth.json / providers.json, reread per request) but NOT the catalog. Concretely: adding the 'modal' provider (instruct + reasoning) to the live janus-k3s ConfigMap today forces a pod restart. Goal: make catalog changes take effect without a restart, matching the credential hot-reload contract.

## Design

Approach options (pick during implementation): (1) Per-request mtime check: stat the catalog path each request; if mtime changed, re-run registerModelsJson into a fresh Models collection and atomically swap the client (cheap, no fs.watch needed, robust to k8s ConfigMap volume updates). (2) fs.watch on the catalog file with a debounce + atomic swap. Either way: registration must be idempotent/re-entrant (re-registering a provider that already exists must replace, not duplicate), and the swap must be atomic so in-flight requests keep using the old client. Keep the inert-by-default behavior (no catalog path -> builtins only). Coordinate with jan-v39j (bearer-token rotation) and jan-hop4 (credential store) so the reloaded client still routes credentials through the same per-request FileCredentialStore/RoutingCredentialStore. Note: k8s ConfigMap mounts update the file in place (or via symlink swap) after a sync delay; the mtime/inode check must handle the projected-volume symlink case.

## Acceptance Criteria

a) Editing the catalog file on disk (add a new provider + model) makes the new model appear in GET /v1/models and serve a chat completion WITHOUT a pod restart. b) Changing an existing provider's baseUrl or a model's fields takes effect without restart. c) Removing a provider/model from the catalog removes it from /v1/models without restart. d) No duplicate-provider or duplicate-model registration errors on reload (idempotent re-register). e) In-flight requests during a reload complete against the pre-reload client (atomic swap, no torn state). f) Inert-by-default unchanged (no PI_JANUS_CONFIG / no catalog path -> builtins only). g) Unit + integration tests cover add/change/remove-without-restart and idempotency.
