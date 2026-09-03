import { describe, expect, it } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
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
