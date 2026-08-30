import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClineCredentialStore, clineAuthToCredential, defaultClineProvidersPath, readClineCredential } from "../../src/cline-credentials.ts";
import { FileCredentialStore, RoutingCredentialStore } from "../../src/credentials.ts";
import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";

function tempProvidersJson(auth: Record<string, unknown> | undefined, extra?: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "janus-cline-"));
	const path = join(dir, "providers.json");
	const providers: Record<string, unknown> = {
		// A second provider that must be preserved on refresh.
		openai: { settings: { provider: "openai", apiKey: "sk-keep-me" }, updatedAt: "2026-01-01T00:00:00.000Z", tokenSource: "manual" },
	};
	if (auth) {
		providers.cline = {
			settings: { provider: "cline", auth },
			updatedAt: "2026-01-01T00:00:00.000Z",
			tokenSource: "oauth",
		};
	}
	writeFileSync(path, JSON.stringify({ version: 1, lastUsedProvider: "cline", modes: {}, providers, ...extra }, null, 2));
	return path;
}

const AUTH = {
	accessToken: "workos:abc123",
	refreshToken: "refresh-1",
	expiresAt: Date.now() + 3_600_000,
	accountId: "acct-1",
	metadata: { provider: "cline" },
};

describe("clineAuthToCredential", () => {
	it("maps a cline auth block to an OAuthCredential (workos: prefix kept verbatim)", () => {
		const cred = clineAuthToCredential(AUTH);
		expect(cred).toEqual({
			type: "oauth",
			access: "workos:abc123",
			refresh: "refresh-1",
			expires: AUTH.expiresAt,
			accountId: "acct-1",
		});
	});

	it("returns undefined when access or refresh token is missing", () => {
		expect(clineAuthToCredential({ accessToken: "workos:abc", refreshToken: "" })).toBeUndefined();
		expect(clineAuthToCredential({ accessToken: "", refreshToken: "r" })).toBeUndefined();
		expect(clineAuthToCredential(undefined)).toBeUndefined();
		expect(clineAuthToCredential("nope")).toBeUndefined();
	});

	it("falls back to now when expiresAt is absent", () => {
		const before = Date.now();
		const cred = clineAuthToCredential({ accessToken: "workos:abc", refreshToken: "r" });
		expect(cred?.expires).toBeGreaterThanOrEqual(before);
	});
});

describe("readClineCredential", () => {
	it("reads the cline credential from a providers.json file", () => {
		const path = tempProvidersJson(AUTH);
		expect(readClineCredential(path)?.access).toBe("workos:abc123");
	});

	it("returns undefined for a missing file", () => {
		expect(readClineCredential(join(tmpdir(), "does-not-exist-xyz.json"))).toBeUndefined();
	});

	it("returns undefined for a malformed file", () => {
		const dir = mkdtempSync(join(tmpdir(), "janus-cline-"));
		const path = join(dir, "providers.json");
		writeFileSync(path, "{ not json");
		expect(readClineCredential(path)).toBeUndefined();
	});

	it("returns undefined when the cline entry has no usable auth", () => {
		const path = tempProvidersJson({ accessToken: "workos:abc" }); // no refreshToken
		expect(readClineCredential(path)).toBeUndefined();
	});
});

describe("ClineCredentialStore", () => {
	it("reads the stored credential", async () => {
		const path = tempProvidersJson(AUTH);
		const store = new ClineCredentialStore(path);
		const cred = await store.read("cline-pass");
		expect(cred?.type).toBe("oauth");
		expect((cred as OAuthCredential).access).toBe("workos:abc123");
	});

	it("persists a rotated credential back to providers.json, preserving other providers", async () => {
		const path = tempProvidersJson(AUTH);
		const store = new ClineCredentialStore(path);
		const rotated: OAuthCredential = {
			type: "oauth",
			access: "workos:rotated",
			refresh: "refresh-2",
			expires: Date.now() + 3_600_000,
			accountId: "acct-1",
		};
		await store.modify("cline-pass", async () => rotated);

		const data = JSON.parse(readFileSync(path, "utf-8")) as any;
		expect(data.providers.cline.settings.auth.accessToken).toBe("workos:rotated");
		expect(data.providers.cline.settings.auth.refreshToken).toBe("refresh-2");
		expect(data.providers.cline.settings.auth.expiresAt).toBe(rotated.expires);
		// Other providers untouched.
		expect(data.providers.openai.settings.apiKey).toBe("sk-keep-me");
		// File shape preserved.
		expect(data.version).toBe(1);
		expect(data.lastUsedProvider).toBe("cline");
		// Read back through the store.
		const again = await store.read("cline-pass");
		expect((again as OAuthCredential).access).toBe("workos:rotated");
	});

	it("keeps the file at mode 0600 after a write", async () => {
		const path = tempProvidersJson(AUTH);
		chmodSync(path, 0o644);
		const store = new ClineCredentialStore(path);
		await store.modify("cline-pass", async (cur) => cur);
		const mode = statSync(path).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("leaves the file unchanged when fn returns undefined", async () => {
		const path = tempProvidersJson(AUTH);
		const before = readFileSync(path, "utf-8");
		const store = new ClineCredentialStore(path);
		await store.modify("cline-pass", async () => undefined);
		expect(readFileSync(path, "utf-8")).toBe(before);
	});

	it("serializes concurrent refreshes (no lost update)", async () => {
		const path = tempProvidersJson(AUTH);
		const a = new ClineCredentialStore(path);
		const b = new ClineCredentialStore(path);
		await Promise.all([
			a.modify("cline-pass", async (cur) => ({
				type: "oauth",
				access: (cur as OAuthCredential).access + "A",
				refresh: (cur as OAuthCredential).refresh,
				expires: (cur as OAuthCredential).expires,
			})),
			b.modify("cline-pass", async (cur) => ({
				type: "oauth",
				access: (cur as OAuthCredential).access + "B",
				refresh: (cur as OAuthCredential).refresh,
				expires: (cur as OAuthCredential).expires,
			})),
		]);
		const cred = await a.read("cline-pass");
		expect((cred as OAuthCredential).access).toMatch(/^workos:abc123[AB][AB]$/);
	});
});

describe("RoutingCredentialStore", () => {
	it("routes the cline-pass provider to the cline store and others to the default store", async () => {
		const authPath = join(mkdtempSync(join(tmpdir(), "janus-route-")), "auth.json");
		const clinePath = tempProvidersJson(AUTH);
		const auth = new FileCredentialStore(authPath);
		const cline = new ClineCredentialStore(clinePath);
		const routing = new RoutingCredentialStore(auth, { "cline-pass": cline });

		// cline-pass -> cline store
		const cp = await routing.read("cline-pass");
		expect((cp as OAuthCredential).access).toBe("workos:abc123");
		// other provider -> auth store (empty)
		expect(await routing.read("openai")).toBeUndefined();

		// A cline-pass refresh writes to providers.json, NOT auth.json.
		const rotated: OAuthCredential = { type: "oauth", access: "workos:new", refresh: "r2", expires: Date.now() + 60_000 };
		await routing.modify("cline-pass", async () => rotated);
		expect(JSON.parse(readFileSync(clinePath, "utf-8")).providers.cline.settings.auth.accessToken).toBe("workos:new");
		expect(JSON.parse(readFileSync(authPath, "utf-8"))).not.toHaveProperty("cline-pass");

		// An auth.json refresh writes to auth.json, NOT providers.json.
		const codex: Credential = { type: "oauth", access: "codex-a", refresh: "codex-r", expires: Date.now() + 60_000 };
		await routing.modify("openai-codex", async () => codex);
		expect(JSON.parse(readFileSync(authPath, "utf-8"))["openai-codex"].access).toBe("codex-a");
		expect(JSON.parse(readFileSync(clinePath, "utf-8")).providers).not.toHaveProperty("openai-codex");
	});
});

describe("defaultClineProvidersPath", () => {
	it("points at ~/.cline/data/settings/providers.json", () => {
		expect(defaultClineProvidersPath()).toContain(".cline");
		expect(defaultClineProvidersPath()).toContain("providers.json");
	});
});
