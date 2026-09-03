---
id: jan-j61u
status: closed
open: false
deps: []
links: []
created: 2026-09-02T22:27:36Z
type: research
priority: 2
assignee: memgrafter
external-ref: gh-decolua/9router-3614
tags: [providers, zai, glm, oauth, research]
---
# ZCode/Z.AI (GLM Coding Plan) provider: findings from 9router PR #3614 + live local probing

Findings for adding a ZCode / Z.AI (GLM Coding Plan) provider to pi-janus. Based on reverse-engineered implementation in https://github.com/decolua/9router/pull/3614 plus empirical probing against live endpoints using local ZCode install (`~/.zcode/v2`). Two novel results beyond the PR: (1) the Coding Plan JWT has NO `exp` claim and stayed valid 18+ days; (2) the Coding Plan upstream enforces an Aliyun captcha (code `3007`) on every probed request, contrary to the PR treating it as occasional.

## 1. Credential set (from PR #3614, `src/lib/zcode/`)

Four credentials survive the OAuth + exchange chain, with different lifetimes:

| Credential | Source | Lifetime | Refreshable? |
|---|---|---|---|
| `zai access_token` | OAuth (poll or code exchange) | ~1h (`expires_in` 3600, sometimes omitted) | Yes, via refresh_token grant |
| `refresh_token` (zai) | OAuth | Long-lived; rotates on use | — |
| **zcode JWT** (Coding Plan) | OAuth response `token` field | **No `exp` claim**; empirically valid 18+ days | **No — re-OAuth only** |
| biz `apiKey` (`key.secretKey`) | Exchange chain (below) | Long-lived | Re-derivable from any valid zai token |

### OAuth flow (PR version, CLI-style)
- `POST https://zcode.z.ai/api/v1/oauth/cli/init` — `Authorization: Bearer <self-generated 32-byte hex pollToken>`, body `{"provider":"zai"}` → `{flow_id, authorize_url}`. The client mints its own bearer; no client_id involved in authorization.
- User opens `authorize_url`; poll `GET .../oauth/cli/poll/{flowId}` (same Bearer) → `pending`/`failed`/`ready`; `ready` returns `{token: <zcode JWT>, zai: {access_token, refresh_token, expires_in}}`.
- client_id `client_P8X5CMWmlaRO9gyO-KSqtg` is hardcoded in the PR but only used for refresh, which requires a `client_secret` the PR does not ship (empty default, env-gated → refresh silently skipped without it).

### Desktop app flow (observed in local ZCode logs — simpler, not in the PR)
- Authorization-code exchange: `POST https://zcode.z.ai/api/v1/oauth/token` with `{provider, code, redirect_uri: "https://zcode.z.ai/app/oauth/login?redirect=zcode%3A%2F%2Foauth%2Fcallback", state}` → **one-shot** `{token: <JWT>, user: {user_id, email, name}, zai: {access_token}}`. No polling loop. Logs also show `BIGMODEL_OAUTH_APP_SECRET source: fallback` — the desktop binary embeds an OAuth app secret.
- Local artifacts: plaintext JWT in `~/.zcode/v2/config.json` (`provider["builtin:zai-start-plan"].options.apiKey`); encrypted-at-rest tokens (`enc:v1:...`) in `~/.zcode/v2/credentials.json`.

### Exchange chain (zai access_token → biz apiKey)
1. `POST https://api.z.ai/api/auth/z/login` `{token}` → biz JWT.
2. `GET https://api.z.ai/api/biz/customer/getCustomerInfo` → pick org/project (defaults named 默认机构/默认项目, falls back to first).
3. `GET/POST https://api.z.ai/api/biz/v1/organization/{org}/projects/{proj}/api_keys` — create key named `zcode-api-key` if absent; then `GET .../api_keys/copy/{key}` → decrypted `secretKey`.
4. Final credential: `"{apiKey}.{secretKey}"`.

## 2. Upstream endpoints (both Anthropic messages format)

- **Coding Plan**: `POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`, `Authorization: Bearer <zcode JWT>`, plus a strict client fingerprint: `User-Agent: ZCode/<ver>`, `X-ZCode-App-Version`, `X-ZCode-Agent: glm`, `X-Title: Z Code@electron`, `HTTP-Referer: https://zcode.z.ai/`, per-request UUIDs `x-request-id`/`x-zcode-trace-id`/`x-query-id`, stable per-connection `x-session-id`. Also requires ZCode system-prompt injection (identity/harness/environment blocks with `cache_control: ephemeral`, full text in PR's `src/lib/zcode/systemPrompt.js`) and model mapping (`glm-5.2` → `GLM-5.2` etc.).
- **API-key fallback**: `POST https://api.z.ai/api/anthropic/v1/messages?beta=true`, `x-api-key: <key.secretKey>`, `anthropic-version: 2023-06-01`. No captcha observed on this path.

## 3. Empirical results (live probing, 2026-09-02)

- Local JWT decoded: `HS256`, payload only `{user_id, sub, iat}` — **no `exp`**. Issued 2026-08-15, still accepted 18 days later.
- Discriminator test on the Coding Plan upstream (minimal 1-token Anthropic request):
  - Real JWT → `HTTP 400` `{"code":3007,"msg":"captcha verify failed"}` — auth **passed**, blocked at captcha gate.
  - Corrupted JWT → `HTTP 401` (empty body) — auth failure.
  So `401` = dead credential (re-OAuth), `3007` = captcha challenge. Note: 9router matches captcha on HTTP 403; Z.AI has drifted — match on body code `3007` / `captcha` text, not status.
- Captcha (`3007`) returned on every probe: both GLM-5.3 and GLM-5-Turbo, full fingerprint headers, residential IP. The PR's machinery (headless CloakBrowser Aliyun slider solve → `X-Aliyun-Captcha-Verify-Param` header, region `sgp`, 45s cached verify param, retry loop, headed fallback) appears to be load-bearing, not an occasional safety net. Unknown: whether the solve is reusable across minutes (PR's 45s TTL cache suggests yes) and whether challenge frequency varies by session age/IP.
- `billing/balance` endpoint (`GET /zcode-plan/billing/balance?app_version=<ver>`): replayed unauthenticated got `3001 parameter error`, but the desktop log captured a full successful response shape: plans + per-entitlement balances (`remaining_units`, `total_units`, daily vs one-time `period`, `expires_at` per bucket). Cheap plan-quota introspection if the request can be replicated.
- Other error codes (from PR, matched in body): `1113` quota exhausted / no resource package, `3010` concurrency limit.

## 4. Implications / suggestions (not implementation decisions)

- **JWT expiry handling can be minimal**: no `exp` to watch; treat `401` as the only re-OAuth trigger. A no-cost liveness probe can distinguish 401 vs 3007 vs 1113.
- **Captcha is the dominant UX/engineering risk, not token lifetime.** Options (unordered, unchosen): implement a local captcha-solve component (heavy for a zero-dep static binary — the PR needs a stealth Chromium); cache a solved verify param across requests if Z.AI allows (45s-ish TTL per the PR); lean on the API-key upstream (`api.z.ai`, `x-api-key`) as primary and skip Coding Plan; or route Coding-Plan traffic through an existing proxy that already solves the captcha.
- The **biz apiKey path is the durable, boring credential**: no captcha observed, long-lived, re-derivable via the exchange chain. A key-based integration could ship without OAuth entirely (user pastes/copies key from ZCode) — worth weighing against full OAuth.
- If refresh is wanted: test whether `chat.z.ai/api/oauth/token` enforces the client_secret (the PR assumes yes but never tests client_id-only); the desktop binary embeds a secret (`BIGMODEL_OAUTH_APP_SECRET`) that could be extracted.
- pi-ai fit: both upstreams are Anthropic-format; fingerprint headers + system-prompt injection don't come free from pi-ai's stock anthropic provider — would need a custom registered API provider or janus-layer rewriting (similar shape to `custom-providers.ts`).
- Captcha/403-vs-400 drift suggests pinning behavior to body codes, and treating the PR's status-code expectations as stale.

## Notes

**2026-09-02T22:34:00Z**

Design direction discussed: user-in-browser captcha solve. Verified from PR source (public/zcode/captcha.html + captcha-manager.js) that this is viable: the Aliyun captcha SDK runs entirely client-side in any normal browser, config (SceneId/prefix/region) is fetched from zcode.z.ai client/configs (cacheable ~10min), and the success callback yields a verifyParam that is POSTed back and cached ~45s, then attached as X-Aliyun-Captcha-Verify-Param on subsequent upstream requests. So janus only needs to serve one small static HTML page + /config + /submit endpoints (Bun.serve) — no embedded Chromium. Local mode: auto-open browser; k3s mode: include the captcha URL in the 3007 error response so the user can click it.

**2026-09-02T22:46:39Z**

Design direction discussed (2): (a) captcha verifyParam cache TTL planned at 300s, ratcheted down empirically if Z.AI rejects older params. (b) Credentials via a hot-readable zcode.conf file (no hardcoded values, no ZCode install required): janus re-reads the file (mtime check) so credential rotation/editing needs no restart. Conf carries the zcode JWT and/or biz apiKey, optional refresh token + client secret; every field optional and independently absent-able so the conf can start as just a pasted apiKey. Suggested wiring: PI_JANUS_ZCODE_CONF=path env var points at the file; recommend chmod 600 since it holds live credentials. Note: nothing in the ZCode integration actually requires the ZCode app installed — OAuth, exchange chain, and both upstreams are plain HTTPS; ZCode-the-app is only a convenient credential source.

**2026-09-02T22:51:43Z**

Design direction discussed (3): captcha verifyParam cache TTL is a zcode.conf field (default 300s). Ship 300 as the default; if empirical testing finds Z.AI's real acceptance window, update the shipped default — otherwise users can trivially edit the conf. Ratchet behavior on rejection (3007 with cached param): drop cache and re-challenge.
