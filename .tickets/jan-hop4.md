---
id: jan-hop4
status: open
open: true
deps: []
links: [pj-gxgm, jan-v39j]
created: 2026-09-05T20:56:47Z
type: feature
priority: 1
assignee: memgrafter
tags: [auth, oauth, hot-reload, credentials, custom-providers, cline]
---
# Unified credential hot reload: canonical provider credential store + runtime auth resolution

Make the writable auth.json on the PVC the runtime authority for provider credentials (OAuth, built-in provider API keys, and custom-provider API keys), with environment variables as a backward-compatible fallback. Today built-in provider keys and custom-provider keys are fixed at pod start (env) and never hot-reload; custom-providers.ts ignores any stored credential and resolves only catalog literal/$ENV; ClinePass registration is startup-gated (no usable credential at start => never registered later).

## Design

1) Canonical store: treat /data/auth.json (PI_JANUS_AUTH_JSON) as the live authority for OAuth + API-key credentials; keep env as fallback. 2) custom-providers.ts auth resolution order: stored credential -> environment fallback -> catalog literal. 3) Allow ClinePass (and other) provider registration to succeed BEFORE a credential exists so a credential added later takes effect without restart. 4) OAuth refresh already persists to the PVC; keep that as authoritative and make the bootstrap k8s Secret explicitly bootstrap-only (see durability policy). Durability policy (choose PVC-authoritative): Secret is a bootstrap seed; PVC is authoritative; document + provide a backup step for the PVC. Coordinate with jan-krpn (Cline static key should flow through this same store) and jan-z81o (credential health).

## Acceptance Criteria

a) A custom provider whose apiKey is only in auth.json (not env, not catalog literal) authenticates successfully and picks up a changed key without a restart. b) Resolution order is stored -> env -> literal (covered by a unit test). c) Starting janus with NO ClinePass credential and adding one to providers.json later registers/activates the provider with no restart. d) No change to the inert-by-default behavior (no PI_JANUS_CONFIG).
