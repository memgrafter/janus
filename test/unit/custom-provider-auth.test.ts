import { describe, expect, it } from "bun:test";
import { InMemoryCredentialStore, createModels, type ApiKeyAuth, type ApiKeyCredential } from "@earendil-works/pi-ai";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerModelsJson } from "../../src/custom-providers.ts";

/**
 * Custom-provider auth resolution order: stored credential (auth.json) ->
 * catalog apiKey ("$ENV_VAR" -> env, else literal). The stored credential is
 * reread per request by the credential store, so these tests double as the
 * hot-reload contract: a key added/changed in the store wins without any
 * re-registration.
 */
function tempModelsJson(json: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "janus-cpauth-"));
	const path = join(dir, "models.json");
	writeFileSync(path, JSON.stringify(json));
	return path;
}

function apiKeyAuthOf(models: { getProvider(id: string): { auth?: { apiKey?: ApiKeyAuth } } | undefined }, providerId: string): ApiKeyAuth {
	const p = models.getProvider(providerId);
	if (!p?.auth?.apiKey) throw new Error(`provider "${providerId}" has no apiKey auth`);
	return p.auth.apiKey;
}

function resolveKey(auth: ApiKeyAuth, credential: ApiKeyCredential | undefined): Promise<{ key?: string; source?: string } | undefined> {
	return auth.resolve({
		ctx: { env: async () => undefined, fileExists: async () => false },
		credential,
		signal: new AbortController().signal,
	}).then((r) => (r ? { key: r.auth.apiKey, source: r.source } : undefined));
}

describe("custom provider auth resolution (stored -> env -> literal)", () => {
	const catalog: Record<string, unknown> = {
		providers: {
			storedprov: { baseUrl: "http://x/v1", api: "openai-completions", apiKey: "literal-key", models: [{ id: "m", contextWindow: 100, maxTokens: 10 }] },
			envprov: { baseUrl: "http://x/v1", api: "openai-completions", apiKey: "$JANUS_TEST_CP_KEY", models: [{ id: "m", contextWindow: 100, maxTokens: 10 }] },
			noprovision: { baseUrl: "http://x/v1", api: "openai-completions", models: [{ id: "m", contextWindow: 100, maxTokens: 10 }] },
		},
	};

	it("stored credential beats a catalog literal", async () => {
		const models = createModels();
		registerModelsJson(models, tempModelsJson(catalog));
		const r = await resolveKey(apiKeyAuthOf(models, "storedprov"), { type: "api_key", key: "stored-key" });
		expect(r).toEqual({ key: "stored-key", source: "auth.json" });
	});

	it("catalog literal is the fallback when nothing is stored", async () => {
		const models = createModels();
		registerModelsJson(models, tempModelsJson(catalog));
		const r = await resolveKey(apiKeyAuthOf(models, "storedprov"), undefined);
		expect(r).toEqual({ key: "literal-key", source: "models.json" });
	});

	it("catalog \"$ENV_VAR\" resolves via env when nothing is stored", async () => {
		process.env.JANUS_TEST_CP_KEY = "env-key";
		try {
			const models = createModels();
			registerModelsJson(models, tempModelsJson(catalog));
			const r = await resolveKey(apiKeyAuthOf(models, "envprov"), undefined);
			expect(r).toEqual({ key: "env-key", source: "models.json" });
		} finally {
			delete process.env.JANUS_TEST_CP_KEY;
		}
	});

	it("stored credential beats the env fallback", async () => {
		process.env.JANUS_TEST_CP_KEY = "env-key";
		try {
			const models = createModels();
			registerModelsJson(models, tempModelsJson(catalog));
			const r = await resolveKey(apiKeyAuthOf(models, "envprov"), { type: "api_key", key: "stored-key" });
			expect(r).toEqual({ key: "stored-key", source: "auth.json" });
		} finally {
			delete process.env.JANUS_TEST_CP_KEY;
		}
	});

	it("unconfigured: no stored credential and no catalog apiKey", async () => {
		const models = createModels();
		registerModelsJson(models, tempModelsJson(catalog));
		expect(await resolveKey(apiKeyAuthOf(models, "noprovision"), undefined)).toBeUndefined();
	});

	it("an InMemoryCredentialStore entry is picked up per request (hot reload contract)", async () => {
		const store = new InMemoryCredentialStore();
		const models = createModels({ credentials: store });
		registerModelsJson(models, tempModelsJson(catalog));
		const auth = apiKeyAuthOf(models, "storedprov");
		// Nothing stored yet -> catalog literal.
		expect(await resolveKey(auth, (await store.read("storedprov")) as ApiKeyCredential | undefined)).toEqual({
			key: "literal-key",
			source: "models.json",
		});
		// A credential added AFTER registration wins on the next read — no restart.
		await store.modify("storedprov", async () => ({ type: "api_key", key: "hot-key" }));
		expect(await resolveKey(auth, (await store.read("storedprov")) as ApiKeyCredential | undefined)).toEqual({
			key: "hot-key",
			source: "auth.json",
		});
	});
});
