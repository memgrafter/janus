---
id: jan-7uv8
status: closed
open: false
deps: [jan-j61u]
links: []
created: 2026-09-02T22:52:00Z
type: feature
priority: 2
assignee: memgrafter
parent: jan-j61u
tags: [providers, zai, glm, oauth]
---
# ZCode/Z.AI provider: zcode.conf (hot-read), dual-upstream GLM provider, captcha page + 300s cache

Implement the ZCode/Z.AI (GLM Coding Plan) provider in pi-janus per research ticket jan-j61u. Scope: (1) zcode.conf hot-readable credential/config file via PI_JANUS_ZCODE_CONF (mtime check, no restart; fields: zcodeJwt, apiKey, refreshToken, clientSecret, captchaTtlMs default 300000, appVersion); all optional, independently absent-able. (2) ZCode provider with two Anthropic-format upstreams: Coding Plan (zcode.z.ai, JWT Bearer + ZCode fingerprint headers + system-prompt injection + model mapping, captcha-gated) and API-key (api.z.ai, x-api-key, no captcha). (3) Captcha flow: static captcha.html page served by janus + /config + /submit endpoints, verifyParam cached with conf-configurable TTL (default 300s), ratchet on 3007-with-cached-param (drop cache, re-challenge). Local: auto-open browser on 3007; k3s: include captcha URL in the 3007 error response. (4) Error taxonomy mapped to body codes (401 re-OAuth, 3007 captcha, 1113 quota, 3010 concurrency). No ZCode install required. Acceptance: unit + integration + live tests per repo conventions; chat completions through both upstreams where creds available; conf edits take effect without restart.

## Notes

**2026-09-03T03:41:18Z**

Implemented + tested (unit 27 + integration 10 + full suite 198/198 + live 9/9). Files: src/zcode.ts (dual providers: zcode Coding Plan + zcode-apikey; JWT Bearer auth with x-api-key null-suppressed; ZCode fingerprint headers; full ZCode system-prompt injection; glm->GLM wire mapping; captcha-aware fetch that reads the SDK's ReadableStream body so a 3007 retry resends the identical payload; error taxonomy on body codes), src/zcode-conf.ts (hot-read mtime/size cache; captchaTtlMs default 300000, captchaWaitMs default 120000), src/zcode-captcha.ts (verifyParam cache + ratchet + deduped waiters), src/zcode-captcha-page.txt (served at /zcode/captcha.html). Both providers always registered; each available only while its credential is present in the hot-read conf (no restart). Server: /zcode/captcha.html + /v1/zcode/captcha/config + /v1/zcode/captcha/submit (unauthenticated for browser solve); zcode error events + non-stream error messages mapped through the taxonomy with a clickable captcha_url (live bound port via setZcodeCaptchaUrl, or JANUS_PUBLIC_URL for k3s); non-zcode error behavior unchanged. No ZCode install required; no local credentials hardcoded (conf path only).

**2026-09-03T13:57:14Z**

KEEPER-TAB (k3s) — WORKING. Design: one always-open browser tab (the captcha page) long-polls /v1/zcode/captcha/poll; when a request 3007s, janus signals the keeper (CaptchaManager.waitForChallenge + challengeWaiters), the keeper does a FULL location.reload() (fresh-load traceless verify — the path that produces an accepted param, with a fresh securityToken), and POSTs the new verifyParam. Live-verified end-to-end: initial verify -> 200; subsequent requests 3007 -> 'keeper connected — waiting' (election suppressed the auto-open second tab) -> keeper reload -> fresh securityToken -> retry -> 200 (or 3009 throttle, never 3007 after re-verify). Two bugs fixed: (1) two-tab race — auto-open spawned a competing tab that ran a concurrent traceless verify from the same fingerprint, which Aliyun rejected; fixed via keeper election (CaptchaManager.hasActiveKeeper/noteKeeperPoll, autoOpen suppressed when a keeper is connected). (2) reload storm — the backoff var was page-local and reset on every location.reload(), so a failing verify reloaded in a tight loop; fixed by persisting backoff + a 3-strike circuit breaker in sessionStorage, and never reloading while a verify is in flight. Remaining: free-tier 3009 model-concurrency throttle (separate known issue, not captcha) + the 200-with-empty-SSE free-tier quirk.

**2026-09-03T14:39:37Z**

DEPLOYED TO K3S (europa). Image 192.168.1.208:5000/janus-inference-control-plane:0c85c77-dirty-6b00221c (cross-compiled linux-x64 natively on the ARM host — the Dockerfile's in-container 'bun install' segfaults under QEMU, so I built the binary with build.sh --target linux-x64 and a runtime-only distroless image). Helm rev 13. Chart gained a zcode block (values: zcode{enabled,existingSecret,publicUrl}; deployment: seed-zcode init container seeds zcode.conf into the PVC only-if-absent, env JANUS_ZCODE=1 + JANUS_ZCODE_CONF=/data/zcode.conf + JANUS_PUBLIC_URL). Secret janus-zcode holds zcode.conf with captchaAutoOpen=false (no browser in the container — the keeper tab is the user's browser). Verified via LB 192.168.1.206:8787: /health ok, /zcode/captcha.html 200 (new keeper page w/ storm protection), /v1/zcode/captcha/config enabled, /v1/models lists all 5 zcode models. Pod Running 1/1, ZCode providers registered, zcode.conf seeded on PVC. NEXT: user opens the keeper tab at http://192.168.1.206:8787/zcode/captcha.html in their trusted browser and makes requests.

**2026-09-03T16:12:20Z**

ADDED glm-5.3-flash. 9router registry (master, open-sse/providers/registry/glm.js) confirms Z.AI's model slug 'glm-5.3-flash' (name 'GLM 5.3 Flash (Vision)') on the api-key upstream (lowercase). Added to BOTH providers in src/zcode.ts: plan wire id 'GLM-5.3-Flash' (upper-cased to match the plan's GLM-5.3/GLM-5-Turbo casing convention — VERIFY on first use; if the plan 3006s it, the wire id may differ) and apikey wire id 'glm-5.3-flash' (lowercase, per 9router). Rebuilt + redeployed to k3s (image 0c85c77-dirty-a5d678a2, helm rev 14); /v1/models now lists zcode/glm-5.3-flash. Added zcode/glm-5.3 + zcode/glm-5.3-flash to ~/.pi/agent/models.json under the janus-k3s provider (reasoning:true, input:[text], contextWindow:1000000, maxTokens:128000, cost 0). The Mac resolves 'janus'->192.168.1.206 so the provider baseUrl http://janus:8787/v1 works.

**2026-09-03T16:27:21Z**

3012 RISK-CONTROL BLOCK. After the earlier reload storm + rapid testing, Z.AI/Aliyun risk control started returning 405 {"code":3012,"msg":"request has been blocked due to unusual activity."} — an account/IP-level block, distinct from 3007 (captcha) and 3009 (model throttle). This is the consequence of the storm: many rapid traceless verifies from one fingerprint trip Aliyun's anomaly detection. Added 3012 to the zcodeErrorMessage taxonomy (message tells the user to stop + cool down, NOT retry in a loop). The deployed k3s image (a5d678a2) predates this message fix — the raw 405/3012 still surfaces there until redeployed. ACTION: stop sending zcode requests; let the block cool down (minutes to hours). The keeper tab is safe to leave open (it only long-polls, fires no verifies while idle). Do NOT re-test until the block clears, and space requests widely.

**2026-09-03T16:41:22Z**

FAIL-FAST 3007 (k3s UX + anti-3012). Previously, with no keeper connected and auto-open off (k3s), a 3007 made the request hang the full captchaWaitMs (120s) before surfacing the link — the silent hang invited retry-in-a-loop, which is what trips the 3012 risk-control block. Now captchaAwareFetch branches: (a) auto-open on (local, no keeper) -> open tab + wait; (b) keeper connected -> wait for keeper; (c) NO keeper + auto-open off (k3s) -> FAIL FAST, return the 3007 immediately with the clickable keeper-tab URL. The 3007 message now says: 'Open the keeper tab at <url> in your browser and keep it open — it verifies automatically and serves the request. Do not retry in a loop; that trips risk control (3012).' Integration test 'transparently retries after 3007' now simulates a connected keeper by long-polling /v1/zcode/captcha/poll first (noteKeeperPoll). Full suite green (197+9). Redeployed k3s rev 16 (image 0c85c77-dirty-009b03c3).
