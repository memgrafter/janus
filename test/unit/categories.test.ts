import { describe, expect, it } from "bun:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { CategoryRegistry } from "../../src/categories.ts";

function fauxModels() {
	const faux = fauxProvider({ models: [{ id: "faux", name: "Faux", contextWindow: 8192, maxTokens: 2048 }] });
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}

describe("CategoryRegistry", () => {
	it("lists categories with live availability", () => {
		const models = fauxModels();
		const reg = new CategoryRegistry([
			{ id: "fast", models: ["faux/faux"], quotaBucketId: "b1" },
			{ id: "ghost", models: ["faux/nope"] },
		]);
		const list = reg.list(models);
		const fast = list.find((c) => c.id === "fast")!;
		const ghost = list.find((c) => c.id === "ghost")!;
		expect(fast.available).toBe(true);
		expect(ghost.available).toBe(false);
		expect(fast.quotaBucketId).toBe("b1");
	});

	it("resolves a category to a concrete model + binding", () => {
		const models = fauxModels();
		const reg = new CategoryRegistry([{ id: "fast", models: ["faux/faux"], quotaBucketId: "b1", deadlineMs: 1000 }]);
		const r = reg.resolve("fast", models);
		expect(r.model.id).toBe("faux");
		expect(r.model.provider).toBe("faux");
		expect(r.quotaBucketId).toBe("b1");
		expect(r.deadlineMs).toBe(1000);
	});

	it("resolves a raw model ref (not a category) with no binding", () => {
		const models = fauxModels();
		const reg = new CategoryRegistry([]);
		const r = reg.resolve("faux/faux", models);
		expect(r.model.id).toBe("faux");
		expect(r.quotaBucketId).toBeUndefined();
	});

	it("throws for an unknown model", () => {
		const models = fauxModels();
		const reg = new CategoryRegistry([]);
		expect(() => reg.resolve("nope/nope", models)).toThrow();
	});

	it("picks the first resolvable model in a category", () => {
		const models = fauxModels();
		const reg = new CategoryRegistry([{ id: "c", models: ["faux/nope", "faux/faux"] }]);
		const r = reg.resolve("c", models);
		expect(r.model.id).toBe("faux");
	});
});
