---
id: pj-eskq
status: in_progress
open: true
deps: []
links: []
created: 2026-08-24T01:20:19Z
type: feature
priority: 2
assignee: memgrafter
parent: pj-gvlk
tags: [auth, oauth, providers]
---
# Use OAuth credentials from pi's auth.json so subscription providers (openai-codex) work through the proxy

pi-janus builds createModels() with the default empty InMemoryCredentialStore, so OAuth-only providers (openai-codex, github-copilot, xai) are unusable: checkProviderAuth finds no credential, they are filtered out of /v1/models, and any request fails auth. pi (the client) already stores valid OAuth credentials in ~/.pi/agent/auth.json (Record<providerId, Credential> — exactly pi-ai's canonical shape). pi-janus should read that file via a CredentialStore and pass it to createModels({ credentials }), so subscription providers work end-to-end through the proxy. First target: openai-codex (api openai-codex-responses, baseUrl chatgpt.com/backend-api, auth OAuth) — a genuinely different provider from the vllm openai-completions models already tested, and a strong cross-check of the thinking-token fix (gpt-5.x codex models are reasoning: true).

## Design

Add src/credentials.ts: a FileCredentialStore implementing pi-ai's CredentialStore interface (read/list/modify/delete) backed by ~/.pi/agent/auth.json. read: parse the JSON, return the provider's Credential or undefined. modify: serialized read-modify-write that persists refreshed tokens back to auth.json (mode 0600) so pi and pi-janus stay in sync — required, because an in-memory-only refresh would trash the on-disk token. Cross-process safety: pi's coding-agent uses proper-lockfile (a coding-agent dep, NOT a pi-ai dep — pi-ai is deliberately lockfile-free and ships only InMemoryCredentialStore). pi-janus is 0-runtime-dep, so either (a) add proper-lockfile as the one new dep, or (b) do a best-effort atomic write (write temp + rename) and accept a small race for a single-user local proxy. Decide during implementation; lean (b) to preserve the 0-dep invariant unless the race is unacceptable. Wire in src/models.ts: createModels({ credentials: new FileCredentialStore(path) }). Path overridable via env (e.g. PI_JANUS_AUTH_JSON, default ~/.pi/agent/auth.json); missing file = inert (no OAuth providers). pi-ai's built-in OAuth double-checked refresh (resolveStoredOAuth -> modify) handles token refresh once the store is wired.

### Decision (2026-08-24): go with (a) proper-lockfile

Chose (a) over (b). Rationale: OAuth refresh ROTATES the refresh token (pi-ai's readTokenResponse requires a fresh refresh_token on every refresh and modify replaces the whole credential). A best-effort atomic write leaves a cross-process double-spend window: pi (coding-agent) and pi-janus share ONE refresh token, and pi-ai's double-checked lock only serializes within a single store instance. If both read the same token just before expiry and both refresh, one invalidates the other's token. proper-lockfile (pinned 4.1.2, matching coding-agent) closes that window and matches pi's own approach. Cost: one small pure-JS runtime dep — an accepted trade for not trashing the token. @types/proper-lockfile@4.1.4 added as devDep.

### Implementation shape

- src/credentials.ts: FileCredentialStore (minimal port of coding-agent's AuthStorage, minus the revision-cache / shared-read-state / command-config-resolution machinery pi-janus doesn't need). read: read file under lock, parse, return credential (or undefined if file missing/empty). modify: acquire proper-lockfile async lock (stale 30s, ELOCKED retry with backoff + abort support), read current, run fn, write JSON.stringify(merged, null, 2) at mode 0600, release. delete: same, removing the key. list: read + map to {providerId, type}. ensureParentDir + ensureFileExists on write. Missing file on read = {} (inert).
- src/config.ts: add authJsonPath (env PI_JANUS_AUTH_JSON, default ~/.pi/agent/auth.json) to Config + loadConfig.
- src/models.ts: createModels({ credentials: new FileCredentialStore(config.authJsonPath) }) for the non-faux path (faux keeps its own createModels()).

### Tests

- Unit (test/unit/credentials.test.ts): read missing file -> undefined; read valid file -> credential; modify persists rotated token to disk (JSON.stringify(merged, null, 2), mode 0600); modify(fn->undefined) leaves file unchanged; delete removes key; list returns metadata; concurrent modify serializes (no lost update).
- Cross-package sync test (test/integration/auth-storage-sync.test.ts): import coding-agent's AuthStorage BY SOURCE PATH (bun runs TS natively; proper-lockfile resolves from coding-agent's own node_modules — verified working). Write the same mock refresh-token data through BOTH pi-janus's FileCredentialStore and coding-agent's AuthStorage, and assert they produce byte-identical on-disk output (JSON.stringify(merged, null, 2)) and each can read what the other wrote. Guards against pi-janus drifting from pi's auth.json format. Skips cleanly (describe.skipIf) if the pi-mono worktree isn't present, so the suite stays green on a fresh clone.

## Acceptance Criteria

openai-codex models appear in GET /v1/models after wiring the store. A non-streaming and a streaming POST /v1/chat/completions (and POST /v1/responses) to openai-codex/gpt-5.5 returns content AND reasoning tokens. A refreshed token is persisted back to auth.json (file mtime/contents change after a refresh) and pi can still read it. Full suite (bunx tsc --noEmit + unit + integration + live) stays green. With no auth.json present, the plane stays inert and the suite still passes.

## Implementation Notes (2026-08-24)

- **CRITICAL gotcha — `bun build --compile` breaks pi-ai's lazy OAuth loading.** pi-ai's `lazyOAuth` defers loading the OAuth module (which contains `toAuth`) via a bundler-opaque dynamic relative import (`import("./openai-codex.ts")`). In the compiled binary that import fails at runtime: `Cannot find module './openai-codex.js' imported from /$bunfs/root/...`. Symptom: every OAuth-provider request returns `finish_reason: "error"`, content null, zero usage — while the SAME code works from source (`bun run`). Fix: call `registerBunOAuthFlows()` from `@earendil-works/pi-ai/bun-oauth` in `createClient` — it statically imports all OAuth flows (openai-codex, github-copilot, xai, anthropic, openrouter, kimi-coding, radius) and registers them as bundled loaders, bypassing the dynamic import. This is exactly what the subpath is documented for ("standalone Bun binaries"). Idempotent; a no-op in source mode.
- **`bun test` does NOT fall back to bun's global install cache the way `bun run` does.** So importing the pi-mono worktree source under `bun test` requires the worktree's own `node_modules` to be installed (`bun install` in the worktree). The cross-package test skips cleanly if the worktree isn't importable.
- **`lsof -ti:PORT` returns connected CLIENTS too, not just the listener.** `kill -9 $(lsof -ti:8787)` will kill pi (the client) if it's connected. Always use `lsof -ti:8787 -sTCP:LISTEN` to target only the server. (This actually killed a pi session during development.)
- **Runtime dep added:** `proper-lockfile@4.1.2` (+ `@types/proper-lockfile@4.1.4` dev). Breaks the 0-runtime-dep invariant — accepted trade for cross-process refresh-token safety (see design).
- **Verified end-to-end (real token):** openai-codex/gpt-5.5 through the built binary — non-stream (content + reasoning_content), stream (reasoning + content deltas), and /v1/responses (non-stream + stream) all return correct answers with real usage. 27*43 -> 1161 with reasoning; bat-and-ball solved correctly.
