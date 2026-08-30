---
id: jan-mmc0
status: closed
open: false
deps: []
links: []
created: 2026-08-30T17:25:35Z
type: feature
priority: 1
assignee: memgrafter
tags: [cline, clinesub, auth, provider]
---
# ClinePass provider: reuse Cline CLI OAuth credentials (no per-machine login)

Goal: let pi-janus serve the ClinePass subscription using the same credentials the Cline CLI already stores, so a user logs in ONCE (on any machine with a browser) and every machine running pi-janus works without a per-machine login.

## How the Cline CLI does ClinePass (verified in clones/cline)

- ClinePass is a distinct provider id `cline-pass`, but it REUSES the `cline` OAuth login and storage. The auth handler for `cline-pass` has `storageProviderId: "cline"` (sdk/packages/core/src/auth/provider-auth-registry.ts). So there is ONE credential set, stored under the `cline` provider.
- Credentials live in `~/.cline/data/settings/providers.json` (path: `CLINE_PROVIDER_SETTINGS_PATH` env, else `CLINE_DATA_DIR/settings/providers.json`, else `~/.cline/data/settings/providers.json`). File is mode 0600. Shape: `{ version:1, lastUsedProvider?, modes:{}, providers:{ "cline": { settings:{ provider:"cline", auth:{ accessToken, refreshToken, expiresAt, accountId, metadata } }, updatedAt, tokenSource:"oauth" } } }`.
- `accessToken` is stored WITH the `workos:` prefix (e.g. `workos:eyJ...`). `expiresAt` is epoch MILLISECONDS. `refreshToken` is the raw WorkOS refresh token.
- The gateway API key is `formatClineApiKey(access)` = `workos:` + token (idempotent). Requests go to `https://api.cline.bot/api/v1` (OpenAI-compatible Chat Completions) with header `Authorization: Bearer workos:<token>` (the full prefixed string, verbatim).
- Token REFRESH: POST `{apiBaseUrl}/api/v1/auth/refresh` with JSON `{ "refreshToken": <raw>, "grantType": "refresh_token" }` -> `{ success, data:{ accessToken, refreshToken, tokenType, expiresAt: <ISO string>, userInfo } }`. `apiBaseUrl` = `https://api.cline.bot` (production; `CLINE_API_BASE_URL` / `CLINE_ENVIRONMENT` override). The CLI refreshes when `expiresAt - now < 5min` (DEFAULT_REFRESH_BUFFER_MS).
- LOGIN (one-time, needs a browser) is WorkOS DEVICE authorization, no local callback server: (1) POST `https://api.workos.com/user_management/authorize/device` form `client_id=client_01K3A541FN8TA3EPPHTD2325AR` -> `{ device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }`; (2) user opens verification_uri and enters user_code; (3) poll POST `https://api.workos.com/user_management/authenticate` form `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=...&client_id=...` until success -> `{ access_token, refresh_token, token_type }`; (4) POST `{apiBaseUrl}/api/v1/auth/register` JSON `{ accessToken, refreshToken }` -> final Cline credentials. The CLI runs this via `bun run cli auth cline-pass` (or `cline auth cline`).

## pi-janus side (verified in code/janus)

- Local OpenAI-compatible proxy on @earendil-works/pi-ai. `src/models.ts` builds `builtinModels({ credentials: new FileCredentialStore(config.authJsonPath, config.authNoLock) })` (default `~/.pi/agent/auth.json`) and `registerModelsJson(models, config.modelsJsonPath)`.
- `FileCredentialStore` (src/credentials.ts) is a proper-lockfile-protected JSON store; pi-ai's `resolveStoredOAuth` refreshes a stored `oauth` credential under the store lock when `expires` is within 5 min, via the provider's `auth.oauth.refresh(credential, signal)`, then persists the rotated credential. `auth.oauth.toAuth(credential)` derives the per-request `ModelAuth` (apiKey/headers/baseUrl).
- `createProvider({ id, name, baseUrl, auth, models, api })` from pi-ai; `api` is a `ProviderStreams` from `getApiProvider(api)` (compat registry). `openai-completions` is a valid api id (KnownApi). pi-ai sends `model.id` VERBATIM as the wire `model` field.
- No Cline/ClinePass awareness exists in janus today.

## The gap

ClinePass tokens live in `~/.cline/data/settings/providers.json`, but pi-janus only reads `~/.pi/agent/auth.json` (or a models.json with a static `$ENV`/literal apiKey). So pi-janus cannot currently use the subscription, and there is no automatic refresh.

## Plan (recommended: first-class `cline-pass` provider)

1. New `src/cline-pass.ts`:
   - Read `~/.cline/data/settings/providers.json` (path overridable via `JANUS_CLINE_DATA_DIR` / `JANUS_CLINE_PROVIDERS_JSON`), extract `providers.cline.settings.auth` -> `{ accessToken (workos:), refreshToken, expiresAt }`.
   - Register a pi-ai provider `id:"cline-pass"`, `baseUrl:"https://api.cline.bot/api/v1"`, `api:getApiProvider("openai-completions")`, with `auth.oauth`:
     - `toAuth(cred)` -> `{ apiKey: <accessToken as stored, already workos: prefixed> }` (Bearer sent verbatim).
     - `refresh(cred, signal)` -> POST `https://api.cline.bot/api/v1/auth/refresh` `{ refreshToken, grantType:"refresh_token" }`; on success return `{ type:"oauth", access: data.accessToken, refresh: data.refreshToken ?? cred.refresh, expires: Date.parse(data.expiresAt) }`.
   - Persist rotated tokens back into `providers.json` (update `accessToken`, `refreshToken`, `expiresAt`, `updatedAt`; keep file 0600). pi-ai calls `refresh` inside `store.modify`, so the write is serialized.
2. Model catalog: register the 13 cline-pass models with their FULL slugs as the model id (pi-ai sends model.id verbatim, and the gateway expects the full slug): cline-pass/glm-5.3, cline-pass/glm-5.2, cline-pass/kimi-k3, cline-pass/kimi-k2.7-code, cline-pass/kimi-k2.6, cline-pass/deepseek-v4-pro, cline-pass/deepseek-v4-flash, cline-pass/mimo-v2.5, cline-pass/mimo-v2.5-pro, cline-pass/minimax-m3, cline-pass/qwen3.8-max, cline-pass/qwen3.7-max, cline-pass/qwen3.7-plus. (Source of truth: clones/cline sdk/packages/llms/src/catalog/catalog.generated.ts "cline-pass" block, for contextWindow/maxTokens/cost.)
3. Wire into `src/models.ts` (register when the cline providers.json has a cline credential; opt-in flag optional). Add config knobs in `src/config.ts`.
4. Tests: token parse, refresh (mock fetch), Bearer = `workos:<token>` verbatim, model list, and a live integration test guarded by an env var.

## Multi-machine workflow (the actual ask)

1. On ONE machine with a browser: `bun run cli auth cline-pass` (from clones/cline) -> writes `~/.cline/data/settings/providers.json`.
2. Copy that `providers.json` to the same path on each other machine (or point `JANUS_CLINE_DATA_DIR` at a synced dir).
3. pi-janus reads it and auto-refreshes; no per-machine login. (Optional: add a `pi-janus cline-login` subcommand that runs the WorkOS device flow directly so even the one-time login is self-contained.)

## Gotchas / open questions

- The Bearer token MUST be the full `workos:<token>` exactly as stored in the cline file. Do NOT strip or re-add the prefix.
- Refresh ROTATES the refresh token. The Cline CLI does NOT file-lock providers.json (atomic write only), while pi-janus locks auth.json. If the CLI and pi-janus refresh concurrently on the same machine, one could double-spend the rotated refresh token. Mitigation: add a proper-lockfile lock on providers.json in pi-janus, or document "don't run the CLI and pi-janus refresh at the same time".
- `cline-pass` only appears in the CLI provider list when the account has ClinePass enabled, but the token works for the gateway regardless.
- Consider a `CLINE_API_KEY` env fallback (static key, no refresh) for machines that prefer a long-lived key over OAuth.

## Acceptance

- `pi-janus` serves `cline-pass/<model>` chat completions with `Authorization: Bearer workos:<token>` read from `~/.cline/data/settings/providers.json`.
- On token expiry, pi-janus refreshes via `/api/v1/auth/refresh` and persists the rotated tokens back to providers.json (0600).
- `/v1/models` lists the 13 cline-pass slugs.
- Unit tests for token parse + refresh + Bearer format pass; live test passes when a real credential is present.

## Notes

**2026-08-30T17:52:56Z**

**Implemented (local-only, all changes in janus, no pi-ai changes).**

New files:
- `src/cline-credentials.ts` — `ClineCredentialStore` (a pi-ai `CredentialStore` over the Cline CLI's `providers.json`): maps `providers.cline.settings.auth` -> OAuthCredential (workos: token kept verbatim), persists rotated tokens back on refresh (atomic write + 0600 + proper-lockfile). Also `readClineCredential()` + `clineAuthToCredential()` helpers.
- `src/cline-pass.ts` — `createClinePassProvider()` (pi-ai provider `cline-pass`, base `https://api.cline.bot/api/v1`, api `openai-completions`, `auth.oauth.toAuth` = stored workos: token, `auth.oauth.refresh` = POST `/api/v1/auth/refresh`), the 13-model catalog (short ids, full specs from the Cline CLI catalog), and `withClinePassWireModel()` (onPayload rewrite of the wire model to the full `cline-pass/<slug>`).
- `src/credentials.ts` — added `RoutingCredentialStore` (routes `cline-pass` -> Cline store, everything else -> auth.json), since a single `Models` collection has one credential store.

Wired into: `src/config.ts` (JANUS_CLINE_PASS, JANUS_CLINE_PROVIDERS_JSON, JANUS_CLINE_API_BASE_URL), `src/models.ts` (register when a credential is present; routing store), `src/bridge.ts` (toPiStreamOptions now takes an extra onPayload, composed with the qwen hook), `src/server.ts` (applies the wire-model rewrite at the 3 request sites + dispatcher).

Off by default (JANUS_CLINE_PASS=1). Faux path and all other providers unaffected.

Tests (all local, no network): `test/unit/cline-credentials.test.ts`, `test/unit/cline-pass.test.ts`, `test/integration/cline-pass.test.ts` (in-process server + local mock Cline gateway). Full suite: 142 pass / 4 skip (pre-existing, missing pi-mono worktree) / 0 fail + 9/9 live. Also validated the COMPILED binary end-to-end against a local mock gateway: /v1/models lists 13 cline-pass models, chat sends `Bearer workos:<token>` verbatim + full `cline-pass/<slug>` wire model, and a near-expiry token is refreshed via /api/v1/auth/refresh with rotated tokens persisted back to providers.json.

Note: the live test suite inherits process.env, so a leftover JANUS_TOKEN in the shell makes it fail (pre-existing fragility, unrelated to this change) — run with `env -u JANUS_TOKEN`.

**2026-08-30T20:06:55Z**

Added 'ClinePass (Cline subscription)' section to README.md: one-time login via published CLI (bun add -g @cline/cli; cline auth cline-pass), copy providers.json to other machines, JANUS_CLINE_PASS=1 to enable, env var table, refresh/rotation caveat.

**2026-08-30T20:12:30Z**

**k3s/Helm support added (chart/).** ClinePass on the cluster: credential lives in a k8s Secret (key "providers.json"), seeded into the PVC by a `seed-cline` init container ONLY IF ABSENT (so pod restarts don't clobber rotated tokens with the stale Secret snapshot — the PVC is the source of truth after first seed). Sets JANUS_CLINE_PASS=1 + JANUS_CLINE_PROVIDERS_JSON=<mount>/providers.json. Guard: cline.enabled without persistence.enabled fails the render (the file must be writable for token refresh to persist). New values: cline.enabled (default false), cline.existingSecret. Verified: helm lint clean; helm template with values.example.yaml renders the init container + env + secret volume correctly; default values render zero cline refs; the persistence guard fires. README ClinePass section gained "### 4. On the k3s cluster (Helm chart)".

**2026-08-30T21:30:53Z**

**glm-5.3-flash added + e2e verified.** Key finding: the Cline access token expires ~33 min and rotates on refresh, so a static token in pi's models.json is a dead end. Instead, `z-ai/glm-5.3-flash` was added to the Cline provider's model list (auto-refreshing credential) with a `wireModel` override so it keeps its own `z-ai/glm-5.3-flash` gateway slug (vs `cline-pass/<id>` for subscription models). Served as `cline-pass/z-ai/glm-5.3-flash`.

Code: cline-pass.ts model spec gained optional `wireModel`; clinePassWireModelId/withClinePassWireModel now take the model object; server.ts clinePassOnPayload passes the model. Unit + integration tests updated (14 models now).

E2E (real credential, unlimited thinking): restarted the local 8787 janus with JANUS_CLINE_PASS=1 and NO JANUS_TOKEN (user runs token-less; pi's pi-janus provider uses apiKey "0" which works when janus has no token). Verified: 412 models, `cline-pass/z-ai/glm-5.3-flash` present, existing models intact, live chat returned PI-E2E-OK. Added the model to ~/.pi/agent/models.json under pi-janus (backup made).

NOTE: the running janus was restarted by hand (no launchd/tmux service found). If it's normally started by something else, that starter needs JANUS_CLINE_PASS=1 added.
