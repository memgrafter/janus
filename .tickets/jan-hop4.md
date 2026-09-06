---
id: jan-hop4
status: closed
open: false
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

## Notes

**2026-09-06T03:50:36Z**

2026-09-11 scope decisions (with user): (1) admin credential-write endpoint is OUT of scope here -> pj-gxgm (this ticket is read-path + registration only). (2) ClinePass models are always advertised in /v1/models when JANUS_CLINE_PASS=1, even before a credential exists (requests fail per-request until one does). (3) Adding a regression test that built-in provider API keys in auth.json hot-reload (pi-ai's resolver already does stored->env; FileCredentialStore rereads per request, so no janus code change needed for built-ins). (4) NO RoutingCredentialStore fall-through for a static Cline api_key in auth.json in this ticket - that is jan-krpn's job (documented there as the chosen approach).

**2026-09-06T04:06:04Z**

Implemented: (1) custom-providers.ts resolve() now does stored credential -> catalog ($ENV/literal) via storedOrCatalogApiKey — hot because FileCredentialStore rereads per request. (2) models.ts: ClinePass registered unconditionally when JANUS_CLINE_PASS=1 (registerClinePass gate removed; dead function deleted from cline-pass.ts). (3) server.ts /v1/models switched from getAvailable() to getModels() so uncredentialed providers stay advertised (per user decision: always advertise, auth can be flaky). (4) AGENTS.md: new 'Credential hot reload' section documenting resolution order + PVC-authoritative/Secret-bootstrap-only policy. Tests: test/unit/custom-provider-auth.test.ts (resolution order incl. hot-reload contract) + test/integration/credential-hot-reload.test.ts (env fallback, stored-only key, key rotation, built-in stored-beats-env via deepseek getAuth, cline-pass advertised/fails-cleanly/activates without restart). All acceptance criteria a-d covered. 190 unit+integration + 9 live pass.
