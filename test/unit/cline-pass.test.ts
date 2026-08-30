import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import {
	CLINE_PASS_MODELS,
	CLINE_PASS_PROVIDER_ID,
	DEFAULT_CLINE_API_BASE_URL,
	clineGatewayBaseUrl,
	clinePassWireModelId,
	createClinePassProvider,
	refreshClinePassCredential,
	registerClinePass,
	withClinePassWireModel,
} from "../../src/cline-pass.ts";
import { ClineCredentialStore } from "../../src/cline-credentials.ts";
import type { OAuthCredential } from "@earendil-works/pi-ai";

const AUTH = {
	accessToken: "workos:abc123",
	refreshToken: "refresh-1",
	expiresAt: Date.now() + 3_600_000,
	accountId: "acct-1",
};

function tempProvidersJson(auth: Record<string, unknown> | undefined): string {
	const dir = mkdtempSync(join(tmpdir(), "janus-clinepass-"));
	const path = join(dir, "providers.json");
	const providers: Record<string, unknown> = {};
	if (auth) providers.cline = { settings: { provider: "cline", auth }, updatedAt: "2026-01-01T00:00:00.000Z", tokenSource: "oauth" };
	writeFileSync(path, JSON.stringify({ version: 1, modes: {}, providers }, null, 2));
	return path;
}

describe("clinePassWireModelId", () => {
	it("prefixes short ids with cline-pass/", () => {
		expect(clinePassWireModelId({ id: "glm-5.3" })).toBe("cline-pass/glm-5.3");
	});
	it("leaves already-prefixed ids alone", () => {
		expect(clinePassWireModelId({ id: "cline-pass/glm-5.3" })).toBe("cline-pass/glm-5.3");
	});
	it("uses the explicit wireModel override when present", () => {
		expect(clinePassWireModelId({ id: "z-ai/glm-5.3-flash", wireModel: "z-ai/glm-5.3-flash" })).toBe("z-ai/glm-5.3-flash");
	});
});

describe("withClinePassWireModel", () => {
	it("rewrites the wire model to the full slug", () => {
		expect(withClinePassWireModel({ model: "glm-5.3", messages: [] }, { id: "glm-5.3" })).toEqual({ model: "cline-pass/glm-5.3", messages: [] });
	});
	it("uses the wireModel override for non-ClinePass models", () => {
		expect(withClinePassWireModel({ model: "z-ai/glm-5.3-flash" }, { id: "z-ai/glm-5.3-flash", wireModel: "z-ai/glm-5.3-flash" })).toBeUndefined();
	});
	it("does not double-prefix", () => {
		expect(withClinePassWireModel({ model: "cline-pass/glm-5.3" }, { id: "cline-pass/glm-5.3" })).toBeUndefined();
	});
	it("returns undefined for non-object payloads or missing model", () => {
		expect(withClinePassWireModel(null, { id: "glm-5.3" })).toBeUndefined();
		expect(withClinePassWireModel("str", { id: "glm-5.3" })).toBeUndefined();
		expect(withClinePassWireModel({}, { id: "glm-5.3" })).toBeUndefined();
	});
});

describe("clineGatewayBaseUrl", () => {
	it("appends /api/v1 and strips trailing slashes", () => {
		expect(clineGatewayBaseUrl()).toBe("https://api.cline.bot/api/v1");
		expect(clineGatewayBaseUrl("https://api.cline.bot/")).toBe("https://api.cline.bot/api/v1");
	});
});

describe("refreshClinePassCredential", () => {
	it("POSTs the refresh token and maps the response", async () => {
		let captured: { url?: string; body?: any; method?: string } = {};
		const realFetch = globalThis.fetch;
		const expiresIso = new Date(Date.now() + 3_600_000).toISOString();
		globalThis.fetch = (async (input: any, init: any) => {
			captured = { url: String(input), body: JSON.parse(init.body), method: init.method };
			return new Response(
				JSON.stringify({
					success: true,
					data: { accessToken: "workos:new", refreshToken: "refresh-2", tokenType: "Bearer", expiresAt: expiresIso, userInfo: {} },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		try {
			const cred: OAuthCredential = { type: "oauth", access: "workos:abc123", refresh: "refresh-1", expires: Date.now() + 60_000 };
			const out = await refreshClinePassCredential(cred);
			expect(captured.url).toBe("https://api.cline.bot/api/v1/auth/refresh");
			expect(captured.method).toBe("POST");
			expect(captured.body).toEqual({ refreshToken: "refresh-1", grantType: "refresh_token" });
			expect(out.access).toBe("workos:new");
			expect(out.refresh).toBe("refresh-2");
			expect(out.expires).toBe(Date.parse(expiresIso));
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it("throws on a non-2xx response", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as typeof fetch;
		try {
			const cred: OAuthCredential = { type: "oauth", access: "workos:abc", refresh: "r", expires: Date.now() + 60_000 };
			await expect(refreshClinePassCredential(cred)).rejects.toThrow(/refresh failed: 400/);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it("falls back to the previous refresh token when the response omits one", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ success: true, data: { accessToken: "workos:new", tokenType: "Bearer", expiresAt: new Date().toISOString() } }), {
				status: 200,
			})) as unknown as typeof fetch;
		try {
			const cred: OAuthCredential = { type: "oauth", access: "workos:abc", refresh: "keep-me", expires: Date.now() + 60_000 };
			const out = await refreshClinePassCredential(cred);
			expect(out.refresh).toBe("keep-me");
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("createClinePassProvider", () => {
	it("registers the ClinePass models + glm-5.3-flash with the gateway base URL", () => {
		const provider = createClinePassProvider();
		expect(provider.id).toBe(CLINE_PASS_PROVIDER_ID);
		const models = provider.getModels();
		expect(models).toHaveLength(14);
		expect(models.map((m) => m.id)).toContain("glm-5.3");
		expect(models.map((m) => m.id)).toContain("z-ai/glm-5.3-flash");
		expect(models.every((m) => m.provider === "cline-pass")).toBe(true);
		expect(models.every((m) => m.baseUrl === "https://api.cline.bot/api/v1")).toBe(true);
		expect(models.every((m) => m.api === "openai-completions")).toBe(true);
		expect(models.every((m) => m.reasoning)).toBe(true);
		// glm-5.3-flash keeps its own gateway slug on the wire.
		const flash = models.find((m) => m.id === "z-ai/glm-5.3-flash");
		expect(clinePassWireModelId(flash!)).toBe("z-ai/glm-5.3-flash");
	});

	it("catalog ids match the Cline CLI slugs (no duplicates, all reasoning)", () => {
		const ids = CLINE_PASS_MODELS.map((m) => m.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual(
			expect.arrayContaining(["glm-5.3", "glm-5.2", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "deepseek-v4-pro", "deepseek-v4-flash", "mimo-v2.5-pro", "mimo-v2.5", "minimax-m3", "qwen3.8-max", "qwen3.7-max", "qwen3.7-plus"]),
		);
	});

	it("resolves auth to the stored workos: token (Bearer key) via Models.getAuth", async () => {
		const path = tempProvidersJson(AUTH);
		const store = new ClineCredentialStore(path);
		const models = createModels({ credentials: store });
		models.setProvider(createClinePassProvider());
		const auth = await models.getAuth("cline-pass");
		expect(auth?.auth.apiKey).toBe("workos:abc123");
		expect(auth?.source).toBe("OAuth");
	});

	it("refreshes an expired token via the store and persists it back to providers.json", async () => {
		const path = tempProvidersJson({ ...AUTH, expiresAt: Date.now() - 1000 }); // expired
		const store = new ClineCredentialStore(path);
		const models = createModels({ credentials: store });
		models.setProvider(createClinePassProvider());

		const realFetch = globalThis.fetch;
		const expiresIso = new Date(Date.now() + 3_600_000).toISOString();
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ success: true, data: { accessToken: "workos:refreshed", refreshToken: "refresh-2", tokenType: "Bearer", expiresAt: expiresIso, userInfo: {} } }), {
				status: 200,
			})) as unknown as typeof fetch;
		try {
			const auth = await models.getAuth("cline-pass");
			expect(auth?.auth.apiKey).toBe("workos:refreshed");
			// Rotated tokens persisted back to the Cline file.
			const data = JSON.parse(await Bun.file(path).text()) as any;
			expect(data.providers.cline.settings.auth.accessToken).toBe("workos:refreshed");
			expect(data.providers.cline.settings.auth.refreshToken).toBe("refresh-2");
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("registerClinePass", () => {
	it("registers when a credential is present", () => {
		const path = tempProvidersJson(AUTH);
		const models = createModels();
		expect(registerClinePass(models, { providersPath: path })).toBe(true);
		expect(models.getProvider(CLINE_PASS_PROVIDER_ID)).toBeDefined();
	});

	it("does not register when no credential is present", () => {
		const path = tempProvidersJson(undefined);
		const models = createModels();
		expect(registerClinePass(models, { providersPath: path })).toBe(false);
		expect(models.getProvider(CLINE_PASS_PROVIDER_ID)).toBeUndefined();
	});

	it("does not register for a missing file", () => {
		const models = createModels();
		expect(registerClinePass(models, { providersPath: join(tmpdir(), "nope-xyz.json") })).toBe(false);
	});
});

describe("DEFAULT_CLINE_API_BASE_URL", () => {
	it("is the production Cline API", () => {
		expect(DEFAULT_CLINE_API_BASE_URL).toBe("https://api.cline.bot");
	});
});
