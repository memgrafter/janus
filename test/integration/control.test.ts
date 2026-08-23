import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { loadConfig } from "../../src/config.ts";
import { createServer, type ServerHandle } from "../../src/server.ts";

const basePlane = {
	buckets: [{ id: "b1", limitTokens: 1_000_000, deadlineMs: 30000 }],
	categories: [{ id: "fast", models: ["faux/faux"], quotaBucketId: "b1", deadlineMs: 30000 }],
	projects: [{ id: "demo", category: "fast", quotaBucketId: "b1", deadlineMs: 30000 }],
};

function makeConfig() {
	return loadConfig({ PI_JANUS_FAUX: "1", PI_JANUS_FAUX_RESPONSE: "hello", PI_JANUS_ALLOC_MS: "20" });
}

describe("control plane: categories + project routing", () => {
	let handle: ServerHandle;
	let base: string;
	beforeAll(async () => {
		handle = await createServer(makeConfig(), { port: 0, plane: basePlane });
		base = `http://127.0.0.1:${handle.port}/v1`;
	});
	afterAll(async () => await handle.close());

	it("GET /v1/categories lists the category as available", async () => {
		const body = (await (await fetch(`${base}/categories`)).json()) as any;
		expect(body.object).toBe("list");
		const fast = body.data.find((c: any) => c.id === "fast");
		expect(fast.available).toBe(true);
		expect(fast.quota_bucket).toBe("b1");
	});

	it("a request naming a category resolves and dispatches", async () => {
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.choices[0].message.content).toBe("hello");
	});

	it("routes by X-Project to the project's category", async () => {
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-project": "demo" },
			body: JSON.stringify({ model: "anything", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.choices[0].message.content).toBe("hello");
	});
});

describe("control plane: quota enforcement", () => {
	let handle: ServerHandle;
	let base: string;
	beforeAll(async () => {
		const plane = { ...basePlane, buckets: [{ id: "b1", limitTokens: 1, deadlineMs: 30000 }] };
		handle = await createServer(makeConfig(), { port: 0, plane });
		base = `http://127.0.0.1:${handle.port}/v1`;
	});
	afterAll(async () => await handle.close());

	it("serves the first request, then rejects with 429", async () => {
		const first = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(first.status).toBe(200);
		const second = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(second.status).toBe(429);
		const body = (await second.json()) as any;
		expect(body.error.type).toBe("rate_limit_error");
	});
});

describe("control plane: event intake + allocation", () => {
	let handle: ServerHandle;
	let base: string;
	beforeAll(async () => {
		handle = await createServer(makeConfig(), { port: 0, plane: basePlane });
		base = `http://127.0.0.1:${handle.port}/v1`;
	});
	afterAll(async () => await handle.close());

	it("enqueues an event (202) and completes it via the allocator", async () => {
		const res = await fetch(`${base}/events`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project: "demo", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(202);
		const { id } = (await res.json()) as any;
		expect(id).toBeTruthy();

		let work: any;
		for (let i = 0; i < 100; i++) {
			work = (await (await fetch(`${base}/work/${id}`)).json()) as any;
			if (work.status === "completed" || work.status === "shed") break;
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(work.status).toBe("completed");
		expect(work.result.content).toBe("hello");
		expect(work.project).toBe("demo");
	});

	it("404s for an unknown work id", async () => {
		const res = await fetch(`${base}/work/nope`);
		expect(res.status).toBe(404);
	});
});

describe("control plane: responses api", () => {
	let handle: ServerHandle;
	let base: string;
	beforeAll(async () => {
		handle = await createServer(makeConfig(), { port: 0, plane: basePlane });
		base = `http://127.0.0.1:${handle.port}/v1`;
	});
	afterAll(async () => await handle.close());

	it("non-stream returns a Response with output[] and usage", async () => {
		const res = await fetch(`${base}/responses`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "fast", input: "hi" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.object).toBe("response");
		expect(body.status).toBe("completed");
		expect(body.output[0].type).toBe("message");
		expect(body.output[0].content[0].text).toBe("hello");
		expect(body.usage.total_tokens).toBeGreaterThan(0);
	});

	it("stream emits response.* events ending in response.completed", async () => {
		const res = await fetch(`${base}/responses`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "fast", input: "hi", stream: true }),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const text = await res.text();
		expect(text).toContain("response.created");
		expect(text).toContain("response.output_text.delta");
		expect(text).toContain("response.completed");
	});
});
