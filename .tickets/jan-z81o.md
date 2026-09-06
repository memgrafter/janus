---
id: jan-z81o
status: open
open: true
deps: [jan-hop4]
links: [pj-gxgm]
created: 2026-08-30T21:47:10Z
type: feature
priority: 2
assignee: memgrafter
tags: [health, auth, credentials]
---
# Credential health in /health (generic across providers)

Extend /health (or add a sibling endpoint) to report credential health per provider, generically — not ClinePass-specific.

Motivation: with auto-refreshing OAuth credentials (ClinePass), the failure mode is a dead refresh token discovered mid-conversation. Want a glanceable status (phone, cron, uptime check) instead.

Design sketch:
- For each provider janus serves, report: credential present? kind (api-key / oauth / env)? for oauth: access-token expiry (if known), last successful refresh, last refresh error, and an overall state: ok | expiring-soon | refresh-failed | re-auth-required | missing.
- Generic mechanism: pi-ai's CredentialStore/ProviderAuth exposes the credential; the ClinePass store already tracks last-refresh state. Define a small CredentialHealth interface that stores/providers can optionally implement; default implementation derives state from the credential type + expiry fields where available.
- Output: JSON in /health (e.g. "credentials": {"cline-pass": {"state":"ok","accessExpiresInMin":41,"lastRefresh":"..."}, "openai": {"state":"ok","kind":"api-key"}, ...}) and/or a human line in the existing text health.
- Non-goals: no proactive background refresh (keep refresh lazy, on-request); no alerting (that's for the user's monitoring).

Acceptance:
- /health shows per-provider credential state for api-key, env-var, and oauth providers.
- A ClinePass credential with a dead refresh token reports re-auth-required (test with a mock gateway returning invalid_grant).
- No behavior change for request handling; health is read-only.

## Notes

**2026-09-05T20:57:32Z**

2026-09-11: keep scope (credential health read-only, no proactive refresh). Depends on jan-hop4 so health can report source/kind uniformly across stored, env, and catalog-literal credentials (including custom providers), not just OAuth.
