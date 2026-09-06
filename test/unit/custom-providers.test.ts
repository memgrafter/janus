import { describe, expect, it } from "bun:test";
import { createModels, createProvider, type Api } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerModelsJson, withWireModel } from "../../src/custom-providers.ts";
import { resolveModel } from "../../src/models.ts";

const FIXTURE = new URL("../fixtures/custom-models.json", import.meta.url).pathname;

function tempModelsJson(json: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "janus-"));
	const path = join(dir, "models.json");
	writeFileSync(path, JSON.stringify(json));
	return path;
}

describe("registerModelsJson", () => {
	it("registers a provider and its models", () => {
		const models = createModels();
		const registered = registerModelsJson(models, FIXTURE);
		expect(registered).toEqual(["testprov"]);
		expect(models.getModels().some((m) => m.provider === "testprov" && m.id === "test-model")).toBe(true);
		const m = resolveModel(models, "testprov/test-model");
		expect(m.id).toBe("test-model");
		expect(m.baseUrl).toBe("http://localhost:9999/v1");
		expect(m.api).toBe("openai-completions");
	});

	it("skips a self-nested model id (own provider prefix) to prevent routing loops", () => {
		const path = tempModelsJson({
			providers: {
				"janus-k3s": {
					baseUrl: "http://janus:8787/v1",
					api: "openai-completions",
					apiKey: "k",
					models: [
						{ id: "janus-k3s/openai/gpt-6-astra", contextWindow: 100, maxTokens: 10 },
						{ id: "openai/gpt-6-astra", contextWindow: 100, maxTokens: 10 },
					],
				},
			},
		});
		const models = createModels();
		registerModelsJson(models, path);
		// the self-nested id is dropped; the clean id still registers
		expect(models.getModels().some((m) => m.provider === "janus-k3s" && m.id === "janus-k3s/openai/gpt-6-astra")).toBe(false);
		expect(models.getModels().some((m) => m.provider === "janus-k3s" && m.id === "openai/gpt-6-astra")).toBe(true);
		// a slash in the id is fine when it is NOT the own-provider prefix
		const m = resolveModel(models, "janus-k3s/openai/gpt-6-astra");
		expect(m.id).toBe("openai/gpt-6-astra");
	});

	it("skips providers with an unknown api (non-fatal)", () => {
		const path = tempModelsJson({
			providers: {
				badprov: { baseUrl: "http://x/v1", api: "not-a-real-api", apiKey: "k", models: [{ id: "m", contextWindow: 100, maxTokens: 10 }] },
				goodprov: { baseUrl: "http://y/v1", api: "openai-completions", apiKey: "k", models: [{ id: "m2", contextWindow: 100, maxTokens: 10 }] },
			},
		});
		const models = createModels();
		const registered = registerModelsJson(models, path);
		expect(registered).toEqual(["goodprov"]);
		expect(models.getModels().some((m) => m.provider === "badprov")).toBe(false);
		expect(models.getModels().some((m) => m.provider === "goodprov")).toBe(true);
	});

	it("attaches a wireModel alias to a model (id != upstream wire id)", () => {
		const path = tempModelsJson({
			providers: {
				cer: { baseUrl: "http://c/v1", api: "openai-completions", apiKey: "k", models: [{ id: "qwen-3.8-27b-free", wireModel: "qwen-3.8-27b", contextWindow: 65536, maxTokens: 32768 }] },
			},
		});
		const models = createModels();
		registerModelsJson(models, path);
		const m = resolveModel(models, "cer/qwen-3.8-27b-free");
		expect(m.id).toBe("qwen-3.8-27b-free");
		expect((m as { wireModel?: string }).wireModel).toBe("qwen-3.8-27b");
		// a model without wireModel has none
		const path2 = tempModelsJson({
			providers: { cer2: { baseUrl: "http://c/v1", api: "openai-completions", apiKey: "k", models: [{ id: "plain", contextWindow: 100, maxTokens: 10 }] } },
		});
		const models2 = createModels();
		registerModelsJson(models2, path2);
		expect((resolveModel(models2, "cer2/plain") as { wireModel?: string }).wireModel).toBeUndefined();
	});

	describe("withWireModel", () => {
		it("rewrites the payload model to wireModel when it differs", () => {
			const out = withWireModel({ model: "qwen-3.8-27b-free", messages: [] }, { wireModel: "qwen-3.8-27b" });
			expect(out).toEqual({ model: "qwen-3.8-27b", messages: [] });
		});

		it("returns undefined when wireModel is absent", () => {
			expect(withWireModel({ model: "x" }, {})).toBeUndefined();
		});

		it("returns undefined when the payload model already equals wireModel", () => {
			expect(withWireModel({ model: "qwen-3.8-27b" }, { wireModel: "qwen-3.8-27b" })).toBeUndefined();
		});

		it("returns undefined for non-object payloads", () => {
			expect(withWireModel(null, { wireModel: "y" })).toBeUndefined();
			expect(withWireModel([1, 2], { wireModel: "y" })).toBeUndefined();
		});
	});

	it("resolveModel rejects a self-nested model (defense in depth against routing loops)", () => {
		// Bypass registration: put a self-nested model straight on the Models
		// collection, as a future code path might. resolveModel must refuse it.
		const model = {
			id: "janus-k3s/openai/gpt-6-astra",
			name: "Self Nested",
			api: "openai-completions" as Api,
			provider: "janus-k3s",
			baseUrl: "http://janus:8787/v1",
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100,
			maxTokens: 10,
		};
		const provider = createProvider({
			id: "janus-k3s",
			baseUrl: "http://janus:8787/v1",
			auth: { apiKey: { name: "k", resolve: async () => undefined } },
			models: [model],
			api: { stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); } },
		});
		const models = createModels();
		models.setProvider(provider);
		expect(() => resolveModel(models, "janus-k3s/janus-k3s/openai/gpt-6-astra")).toThrow(/Self-referential model/);
		// the plain-id lookup path is guarded too
		expect(() => resolveModel(models, "janus-k3s/openai/gpt-6-astra")).toThrow(/Self-referential model/);
	});

	it("marks a $ENV_VAR provider available only when the env var is set", async () => {
		const path = tempModelsJson({
			providers: {
				envprov: { baseUrl: "http://z/v1", api: "openai-completions", apiKey: "$JANUS_TEST_KEY", models: [{ id: "m", contextWindow: 100, maxTokens: 10 }] },
			},
		});
		process.env["JANUS_TEST_KEY"] = "secret";
		const withKey = createModels();
		registerModelsJson(withKey, path);
		expect((await withKey.getAvailable()).some((m) => m.provider === "envprov")).toBe(true);

		delete process.env["JANUS_TEST_KEY"];
		const noKey = createModels();
		registerModelsJson(noKey, path);
		expect((await noKey.getAvailable()).some((m) => m.provider === "envprov")).toBe(false);
	});
});
