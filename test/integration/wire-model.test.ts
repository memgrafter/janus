import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createServer, type ServerHandle } from "../../src/server.ts";

let upstream: ReturnType<typeof Bun.serve>;
let handle: ServerHandle;
let root: string;
let dir: string;
const upstreamBodies: Record<string, unknown>[] = [];

function completionStream(model: string): string {
	return [
		`data: ${JSON.stringify({ id: "chatcmpl-wire", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "alias ok" }, finish_reason: null }] })}\n\n`,
		`data: ${JSON.stringify({ id: "chatcmpl-wire", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}\n\n`,
		"data: [DONE]\n\n",
	].join("");
}

beforeAll(async () => {
	upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = await req.json() as Record<string, unknown>;
			upstreamBodies.push(body);
			return new Response(completionStream(String(body.model)), {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	dir = mkdtempSync(join(tmpdir(), "janus-wire-model-"));
	const modelsPath = join(dir, "models.json");
	writeFileSync(modelsPath, JSON.stringify({
		providers: {
			upstream: {
				baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
				api: "openai-completions",
				apiKey: "test",
				models: [{
					id: "public-alias",
					wireModel: "real-upstream-model",
					contextWindow: 8192,
					maxTokens: 1024,
				}],
			},
		},
	}));
	handle = await createServer(loadConfig({ JANUS_MODELS_JSON: modelsPath }), 0);
	root = `http://127.0.0.1:${handle.port}/v1`;
});

afterAll(async () => {
	await handle.close();
	upstream.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

describe("models.json wireModel integration", () => {
	it("rewrites Chat Completions model ids before sending upstream", async () => {
		const res = await fetch(`${root}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "upstream/public-alias", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as { choices: { message: { content: string } }[] };
		expect(body.choices[0]?.message.content).toBe("alias ok");
		expect(upstreamBodies.at(-1)?.model).toBe("real-upstream-model");
	});

	it("rewrites Responses model ids before sending upstream", async () => {
		const res = await fetch(`${root}/responses`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "upstream/public-alias", input: "hi" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as { status: string };
		expect(body.status).toBe("completed");
		expect(upstreamBodies.at(-1)?.model).toBe("real-upstream-model");
	});
});
