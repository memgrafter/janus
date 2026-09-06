---
id: jan-krpn
status: open
open: true
deps: [jan-hop4]
links: []
created: 2026-08-31T03:53:01Z
type: feature
priority: 2
assignee: memgrafter
tags: [cline, clinesub, auth, api-key]
---
# ClinePass: static API-key auth mode (alternative to OAuth rotation)

Add a static API-key auth mode for the ClinePass provider, as an alternative to the OAuth credential store.

## Motivation
Cline documents the API key (CLINE_API_KEY, created at app.cline.bot -> Settings -> API Keys) as the recommended auth for programmatic access ("Direct API calls, scripts, CI/CD"). It hits the same gateway (https://api.cline.bot/api/v1) with the same cline-pass/<id> model slugs and the same subscription billing. A static key means janus can skip the entire OAuth refresh/rotation machinery for ClinePass: no providers.json, no ClineCredentialStore/RoutingCredentialStore, no PVC, no seed-cline init container, no re-login.

The OAuth path (current) was built to reuse the Cline CLI's credential so no per-machine login is needed; it works and is deployed, but for a headless proxy the API key is the simpler, documented path. Keep OAuth as a fallback (e.g. a machine that only has a CLI login and no key).

## Design sketch
- New env: JANUS_CLINE_API_KEY (or a Secret on k3s). When set, the cline-pass provider uses static apiKey auth (Authorization: Bearer <key>) and does NOT register the ClineCredentialStore / does not require providers.json.
- When unset, fall back to the existing OAuth credential-store path (unchanged behavior).
- Both modes coexist; API key takes precedence when present.
- k3s chart: optional cline.apiKeySecret / cline.apiKeyKey values; when the key is provided, the cline.enabled persistence requirement can be relaxed (no writable providers.json needed) — but keep the guard for the OAuth mode.
- Wire model rewrite (cline-pass/<id>), model catalog, and billing are identical in both modes — only auth differs.

## Notes / gotchas
- The cline-pass/<id> slug is what makes a request bill against the ClinePass subscription; the vendor/<id> slug is usage-billed. Unchanged by this ticket.
- API key is a long-lived secret (valid until rotated) vs the ~1h OAuth access token — acceptable for a key in a k8s Secret on a private cluster, but worth noting.
- The gateway enforces the subscription regardless of auth method (CLINE_NOT_SUBSCRIBED / clinepass limit errors).

## Acceptance
- With JANUS_CLINE_API_KEY set and no providers.json, the cline-pass provider registers and serves cline-pass/* models using the static key.
- With no API key, behavior is identical to today (OAuth store path).
- k3s: a deployment with only the API key (no PVC/seed) serves ClinePass.
- Unit test for the auth-mode selection (key present -> static apiKey; absent -> OAuth store).

**2026-09-05T20:57:32Z**

2026-09-11: scope confirmed as Cline static API key only, but implement it through the unified credential store (jan-hop4) so a static Cline key uses auth.json like other provider keys; jan-gxgm sync command gets a Cline adapter for it.
