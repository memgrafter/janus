import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { loadConfig } from "../../src/config.ts";
import { createServer, type ServerHandle } from "../../src/server.ts";
import { extractContentDeltas } from "../util.ts";

let handle: ServerHandle;
let base: string;
let root: string;

beforeAll(async () => {
	const config = loadConfig({ PI_JANUS_FAUX: "1", PI_JANUS_FAUX_RESPONSE: "hello from faux" });
	handle = await createServer(config, 0); // port 0 -> OS-assigned
	root = `http://127.0.0.1:${handle.port}`;
	base = `${root}/v1`;
});

afterAll(async () => {
	await handle.close();
});

describe("integration (in-process, faux provider)", () => {
	it("GET /health returns 200", async () => {
		const res = await fetch(`${root}/health`);
		expect(res.status).toBe(200);
	});

	it("GET /v1/models lists the faux model", async () => {
		const res = await fetch(`${base}/models`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.object).toBe("list");
		expect(body.data.some((m: any) => m.id === "faux/faux")).toBe(true);
	});

	it("POST /v1/chat/completions (non-stream) returns a completion", async () => {
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "faux/faux", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.object).toBe("chat.completion");
		expect(body.choices[0].message.content).toBe("hello from faux");
		expect(body.choices[0].finish_reason).toBe("stop");
		expect(body.usage.total_tokens).toBeGreaterThan(0);
	});

	it("POST /v1/chat/completions (stream) emits SSE chunks and [DONE]", async () => {
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "faux/faux", messages: [{ role: "user", content: "hi" }], stream: true }),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const text = await res.text();
		expect(text).toContain("chat.completion.chunk");
		expect(text.trim().endsWith("data: [DONE]")).toBe(true);
		expect(extractContentDeltas(text)).toBe("hello from faux");
	});

	it("rejects an unknown model with 400/500", async () => {
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "nope/nope", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	it("aborts a streaming request without crashing the server", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 25);
		try {
			await fetch(`${base}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "faux/faux", messages: [{ role: "user", content: "hi" }], stream: true }),
				signal: ac.signal,
			});
		} catch {
			// expected: the request is aborted
		}
		// the server must still be healthy and able to serve a fresh request after the abort
		const res = await fetch(`${root}/health`);
		expect(res.status).toBe(200);
		const again = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "faux/faux", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(again.status).toBe(200);
	});

	it("404 on unknown route", async () => {
		const res = await fetch(`${root}/v1/nope`);
		expect(res.status).toBe(404);
	});
});
