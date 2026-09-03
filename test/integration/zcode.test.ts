import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createServer, type ServerHandle } from "../../src/server.ts";
import { extractContentDeltas } from "../util.ts";

/**
 * End-to-end ZCode (Z.AI GLM) test against a LOCAL mock Anthropic upstream
 * (no network). Verifies the full path:
 *
 *  - Coding Plan provider sends `Authorization: Bearer <jwt>` (NOT x-api-key),
 *    the full ZCode fingerprint, the wire model (glm-5.2 -> GLM-5.2), and the
 *    injected ZCode system prompt.
 *  - A 3007 captcha challenge is transparently retried after a verifyParam is
 *    submitted via /v1/zcode/captcha/submit (the param rides on the retry).
 *  - Credentials are hot-read from zcode.conf (a JWT added after startup is
 *    picked up without a restart; the provider appears in /v1/models only while
 *    its credential is present).
 *  - The API-key provider sends `x-api-key` (no Authorization) to api.z.ai.
 *  - Error taxonomy: 401 -> re-auth, 1113 -> quota, 3010 -> concurrency.
 */

interface Captured {
	path?: string;
	authorization?: string | null;
	xApiKey?: string | null;
	userAgent?: string | null;
	xZCodeAgent?: string | null;
	xTitle?: string | null;
	httpReferer?: string | null;
	xSessionId?: string | null;
	xRequestId?: string | null;
	captchaParam?: string | null;
	captchaRegion?: string | null;
	body?: any;
}

let mock: Bun.Server<unknown>;
let mockBase: string;
let captured: Captured[];
let confPath: string;
let handle: ServerHandle;
let base: string;

// Mock upstream behavior, set per-test.
let nextResponse: (req: Request, body: any) => Response = () => anthropicSse("zcode mock ok");

function sseEvent(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A valid Anthropic streaming response (message_start -> text -> stop). */
function anthropicSse(text: string, model = "GLM-5.2"): Response {
	const body =
		sseEvent("message_start", {
			type: "message_start",
			message: { id: "msg_1", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 5, output_tokens: 1 } },
		}) +
		sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
		sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
		sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
		sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 5, output_tokens: 1 } }) +
		sseEvent("message_stop", { type: "message_stop" });
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonError(status: number, code: number, msg: string): Response {
	return new Response(JSON.stringify({ code, msg }), { status, headers: { "content-type": "application/json" } });
}

beforeAll(async () => {
	captured = [];

	mock = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			const body = await req.json().catch(() => ({}));
			captured.push({
				path: url.pathname,
				authorization: req.headers.get("authorization"),
				xApiKey: req.headers.get("x-api-key"),
				userAgent: req.headers.get("user-agent"),
				xZCodeAgent: req.headers.get("x-zcode-agent"),
				xTitle: req.headers.get("x-title"),
				httpReferer: req.headers.get("http-referer"),
				xSessionId: req.headers.get("x-session-id"),
				xRequestId: req.headers.get("x-request-id"),
				captchaParam: req.headers.get("x-aliyun-captcha-verify-param"),
				captchaRegion: req.headers.get("x-aliyun-captcha-verify-region"),
				body,
			});
			return nextResponse(req, body);
		},
	});
	mockBase = `http://127.0.0.1:${mock.port}`;

	const dir = mkdtempSync(join(tmpdir(), "janus-zcode-e2e-"));
	confPath = join(dir, "zcode.conf");
	// Start with ONLY an API key (no JWT) so the Coding Plan provider is absent.
	writeZcodeConf({ apiKey: "key.secret", captchaAutoOpen: false });

	const config = loadConfig({
		JANUS_FAUX: "0",
		JANUS_ZCODE: "1",
		JANUS_ZCODE_CONF: confPath,
		JANUS_AUTH_JSON: join(dir, "auth.json"),
		// Point both upstreams at the local mock.
	});
	// The conf carries the base-URL overrides to the mock.
	writeZcodeConf({ apiKey: "key.secret", planBaseUrl: mockBase, apiKeyBaseUrl: mockBase, captchaAutoOpen: false });
	handle = await createServer(config, 0);
	base = `http://127.0.0.1:${handle.port}/v1`;
});

function writeZcodeConf(obj: Record<string, unknown>): void {
	writeFileSync(confPath, JSON.stringify(obj, null, 2));
}

afterAll(async () => {
	await handle?.close();
	mock?.stop(true);
});

describe("integration (ZCode Coding Plan via local mock upstream)", () => {
	it("lists only the apikey provider before a JWT is present", async () => {
		const res = await fetch(`${base}/models`);
		const body = (await res.json()) as any;
		const ids = body.data.map((m: any) => m.id);
		expect(ids.some((id: string) => id.startsWith("zcode/"))).toBe(false);
		expect(ids).toContain("zcode-apikey/glm-5.2");
	});

	it("picks up a JWT added to zcode.conf without a restart (hot-read)", async () => {
		writeZcodeConf({ zcodeJwt: "JWT-PLAN-1", apiKey: "key.secret", planBaseUrl: mockBase, apiKeyBaseUrl: mockBase, captchaAutoOpen: false });
		const res = await fetch(`${base}/models`);
		const body = (await res.json()) as any;
		const ids = body.data.map((m: any) => m.id);
		expect(ids).toContain("zcode/glm-5.2");
	});

	it("sends Bearer JWT (not x-api-key) + fingerprint + wire model + ZCode system prompt", async () => {
		captured = [];
		nextResponse = () => anthropicSse("zcode mock ok");
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "zcode/glm-5.2", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.choices[0].message.content).toBe("zcode mock ok");

		const c = captured[0];
		expect(c.path).toBe("/v1/messages");
		expect(c.authorization).toBe("Bearer JWT-PLAN-1");
		expect(c.xApiKey).toBeNull(); // SDK's X-Api-Key suppressed
		expect(c.userAgent).toMatch(/^ZCode\//);
		expect(c.xZCodeAgent).toBe("glm");
		expect(c.xTitle).toBe("Z Code@electron");
		expect(c.httpReferer).toBe("https://zcode.z.ai/");
		expect(c.xSessionId).toMatch(/[0-9a-f-]{36}/);
		expect(c.xRequestId).toMatch(/[0-9a-f-]{36}/);
		// Wire model mapped to the upstream-cased id.
		expect(c.body.model).toBe("GLM-5.2");
		// ZCode system prompt injected; no Claude Code identity.
		const system = c.body.system.map((b: any) => b.text).join("\n");
		expect(system).toContain("You are ZCode, an interactive coding agent");
		expect(system).toContain("# Harness");
		expect(system).not.toContain("You are Claude Code");
	});

	it("transparently retries after a 3007 captcha challenge + submitted verifyParam", async () => {
		captured = [];
		let calls = 0;
		nextResponse = () => {
			calls++;
			// First request: challenged. Second (with the param): success.
			return calls === 1 ? jsonError(400, 3007, "captcha verify failed") : anthropicSse("zcode mock ok");
		};
		// Simulate a connected keeper tab: it long-polls /captcha/poll, which
		// marks a keeper active so the server waits for a solve instead of
		// failing fast (k3s no-keeper path). Fire it and let it register before
		// the request is challenged.
		const keeperPoll = fetch(`${base}/zcode/captcha/poll?wait=1000`);
		await new Promise((r) => setTimeout(r, 30));
		const req = fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "zcode/glm-5.2", messages: [{ role: "user", content: "hi" }] }),
		});
		// Solve the captcha while the request is waiting.
		await new Promise((r) => setTimeout(r, 50));
		const submit = await fetch(`${base}/zcode/captcha/submit`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ verifyParam: "SOLVED-PARAM" }),
		});
		expect(submit.status).toBe(200);
		const res = await req;
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.choices[0].message.content).toBe("zcode mock ok");
		expect(calls).toBe(2);
		// The retry carried the solved param + region.
		expect(captured[1].captchaParam).toBe("SOLVED-PARAM");
		expect(captured[1].captchaRegion).toBe("sgp");
		await keeperPoll; // let the simulated keeper's poll settle
	});

	it("surfaces a clickable captcha URL when the challenge is not solved in time", async () => {
		captured = [];
		writeZcodeConf({ zcodeJwt: "JWT-PLAN-1", apiKey: "key.secret", planBaseUrl: mockBase, apiKeyBaseUrl: mockBase, captchaWaitMs: 200, captchaAutoOpen: false });
		nextResponse = () => jsonError(400, 3007, "captcha verify failed");
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "zcode/glm-5.2", messages: [{ role: "user", content: "hi" }] }),
		});
		// No solve submitted -> the bounded wait elapses and the error surfaces.
		expect(res.status).toBe(502);
		const body = (await res.json()) as any;
		expect(body.error.message).toContain("captcha");
		expect(body.error.message).toContain("/zcode/captcha.html");
		expect(body.error.captcha_url).toContain("/zcode/captcha.html");
	});

	it("maps 401 to a re-auth message", async () => {
		nextResponse = () => jsonError(401, 0, "invalid token");
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "zcode/glm-5.2", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as any;
		expect(body.error.message).toContain("re-authenticate");
	});

	it("maps 1113 to a quota message", async () => {
		nextResponse = () => jsonError(400, 1113, "quota exhausted");
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "zcode/glm-5.2", messages: [{ role: "user", content: "hi" }] }),
		});
		const body = (await res.json()) as any;
		expect(body.error.message).toContain("quota exhausted");
	});

	it("maps 3010 to a concurrency message", async () => {
		nextResponse = () => jsonError(429, 3010, "concurrency limit");
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "zcode/glm-5.2", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(429);
		const body = (await res.json()) as any;
		expect(body.error.message).toContain("concurrency");
	});

	it("surfaces a streaming 3007 as an SSE error chunk with the captcha URL", async () => {
		captured = [];
		writeZcodeConf({ zcodeJwt: "JWT-PLAN-1", apiKey: "key.secret", planBaseUrl: mockBase, apiKeyBaseUrl: mockBase, captchaWaitMs: 200, captchaAutoOpen: false });
		nextResponse = () => jsonError(400, 3007, "captcha verify failed");
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "zcode/glm-5.2", messages: [{ role: "user", content: "hi" }], stream: true }),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const text = await res.text();
		// The error chunk carries the mapped captcha message + clickable URL.
		expect(text).toContain("captcha");
		expect(text).toContain("/zcode/captcha.html");
		expect(text).toContain("captcha_url");
	});
});

describe("integration (ZCode API-key provider)", () => {
	it("sends x-api-key (no Authorization) to the apikey upstream", async () => {
		captured = [];
		nextResponse = () => anthropicSse("apikey mock ok", "glm-5.2");
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "zcode-apikey/glm-5.2", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.choices[0].message.content).toBe("apikey mock ok");
		const c = captured[0];
		expect(c.xApiKey).toBe("key.secret");
		expect(c.authorization).toBeNull();
		expect(c.body.model).toBe("GLM-5.2");
	});
});
