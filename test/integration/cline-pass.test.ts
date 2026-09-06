import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createServer, type ServerHandle } from "../../src/server.ts";
import { extractContentDeltas } from "../util.ts";

/**
 * End-to-end ClinePass test against a LOCAL mock Cline gateway (no network).
 *
 * Verifies the full path: pi-janus reads the Cline CLI's providers.json, lists
 * the cline-pass models, sends `Authorization: Bearer workos:<token>` (verbatim)
 * and the full `cline-pass/<slug>` wire model to the gateway, and — when the
 * token is near expiry — refreshes it via /api/v1/auth/refresh and persists the
 * rotated tokens back to providers.json.
 */

interface Captured {
	authorization?: string | null;
	model?: string;
}

let mock: Bun.Server<unknown>;
let mockPort: number;
let mockBase: string;
let captured: Captured;
let refreshCalls: number;
let providersPath: string;
let handle: ServerHandle;
let base: string;

const INITIAL_TOKEN = "workos:initial-token";
const REFRESHED_TOKEN = "workos:refreshed-token";

function sseResponse(model: string, text: string): Response {
	const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>) =>
		`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
	const body =
		chunk({ role: "assistant", content: "" }, null) +
		chunk({ content: text }, null) +
		chunk({}, "stop", { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }) +
		"data: [DONE]\n\n";
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

beforeAll(async () => {
	captured = {};
	refreshCalls = 0;

	// Local mock Cline gateway.
	mock = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			if (url.pathname === "/api/v1/chat/completions") {
				const body = (await req.json()) as any;
				captured = { authorization: req.headers.get("authorization"), model: body.model };
				if (body.messages?.some((message: any) => message.content === "force provider error")) {
					return new Response(JSON.stringify({ error: { message: "mock provider rejected request" } }), {
						status: 400,
						headers: { "content-type": "application/json" },
					});
				}
				return sseResponse(body.model, "clinepass mock ok");
			}
			if (url.pathname === "/api/v1/auth/refresh") {
				refreshCalls++;
				const reqBody = (await req.json()) as any;
				if (reqBody.grantType !== "refresh_token" || !reqBody.refreshToken) {
					return new Response(JSON.stringify({ error: "bad refresh" }), { status: 400 });
				}
				return new Response(
					JSON.stringify({
						success: true,
						data: {
							accessToken: REFRESHED_TOKEN,
							refreshToken: "refresh-rotated",
							tokenType: "Bearer",
							expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
							userInfo: {},
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		},
	});
	mockPort = mock.port!;
	mockBase = `http://127.0.0.1:${mockPort}`;

	// A Cline providers.json with a VALID (not near-expiry) credential.
	const dir = mkdtempSync(join(tmpdir(), "janus-cline-e2e-"));
	providersPath = join(dir, "providers.json");
	writeClineProviders(INITIAL_TOKEN, "refresh-1", Date.now() + 3_600_000);

	const config = loadConfig({
		JANUS_FAUX: "0",
		JANUS_CLINE_PASS: "1",
		JANUS_CLINE_PROVIDERS_JSON: providersPath,
		JANUS_CLINE_API_BASE_URL: mockBase,
		// Use a throwaway auth.json so the test never touches the real one.
		JANUS_AUTH_JSON: join(dir, "auth.json"),
	});
	handle = await createServer(config, 0);
	base = `http://127.0.0.1:${handle.port}/v1`;
});

function writeClineProviders(accessToken: string, refreshToken: string, expiresAt: number): void {
	writeFileSync(
		providersPath,
		JSON.stringify(
			{
				version: 1,
				lastUsedProvider: "cline",
				modes: {},
				providers: {
					cline: {
						settings: { provider: "cline", auth: { accessToken, refreshToken, expiresAt, accountId: "acct-1" } },
						updatedAt: new Date().toISOString(),
						tokenSource: "oauth",
					},
				},
			},
			null,
			2,
		),
	);
}

afterAll(async () => {
	await handle?.close();
	mock?.stop(true);
});

describe("integration (ClinePass via local mock gateway)", () => {
	it("lists the cline-pass models", async () => {
		const res = await fetch(`${base}/models`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		const ids = body.data.map((m: any) => m.id);
		const clineIds = ids.filter((id: string) => id.startsWith("cline-pass/"));
		// 13 ClinePass subscription models + glm-5.3-flash (served via the same
		// Cline credential, listed as cline-pass/z-ai/glm-5.3-flash).
		expect(clineIds).toHaveLength(14);
		expect(ids).toContain("cline-pass/glm-5.3");
		expect(ids).toContain("cline-pass/kimi-k3");
		expect(ids).toContain("cline-pass/deepseek-v4-flash");
		expect(ids).toContain("cline-pass/z-ai/glm-5.3-flash");
	});

	it("sends the stored workos: token verbatim and the full wire model (non-stream)", async () => {
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "cline-pass/glm-5.3", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.choices[0].message.content).toBe("clinepass mock ok");
		// The gateway must see the full slug and the verbatim workos: token.
		expect(captured.model).toBe("cline-pass/glm-5.3");
		expect(captured.authorization).toBe(`Bearer ${INITIAL_TOKEN}`);
		// No refresh needed (token is valid).
		expect(refreshCalls).toBe(0);
	});

	it("streams a cline-pass completion to [DONE]", async () => {
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "cline-pass/kimi-k3", messages: [{ role: "user", content: "hi" }], stream: true }),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const text = await res.text();
		expect(extractContentDeltas(text)).toBe("clinepass mock ok");
		expect(text.trim().endsWith("data: [DONE]")).toBe(true);
		expect(captured.model).toBe("cline-pass/kimi-k3");
	});

	it("surfaces the underlying provider error detail to the client (streaming)", async () => {
		const errorLog = spyOn(console, "error").mockImplementation(() => {});
		try {
			const res = await fetch(`${base}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "cline-pass/glm-5.3",
					messages: [{ role: "user", content: "force provider error" }],
					stream: true,
				}),
			});
			expect(res.status).toBe(200);
			const text = await res.text();
			// The real provider error detail is now embedded in the final chunk's
			// finish_reason (so pi-ai clients surface it) and in a top-level error field.
			expect(text).toContain("mock provider rejected request");
			expect(text).toContain("provider_error");
			expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("mock provider rejected request"));
			expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("cline-pass/glm-5.3"));
		} finally {
			errorLog.mockRestore();
		}
	});

	it("returns 502 with the provider error detail for a non-streaming failure", async () => {
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "cline-pass/glm-5.3",
				messages: [{ role: "user", content: "force provider error" }],
				stream: false,
			}),
		});
		expect(res.status).toBe(502);
		const body = (await res.json()) as any;
		expect(body.error.type).toBe("provider_error");
		expect(body.error.message).toContain("mock provider rejected request");
	});

	it("still rewrites the wire model to the full slug when reasoning_effort is present", async () => {
		// Regression: the qwen onPayload hook returns undefined for non-qwen
		// models, and the composition must fall back to the original payload so
		// the ClinePass wire-model rewrite still runs. Without that, the gateway
		// receives the bare id (glm-5.3) and the stream ends in finish_reason=error.
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "cline-pass/glm-5.3",
				messages: [{ role: "user", content: "hi" }],
				reasoning_effort: "medium",
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.choices[0].message.content).toBe("clinepass mock ok");
		// The gateway must still see the full slug, not the bare id.
		expect(captured.model).toBe("cline-pass/glm-5.3");
	});

	it("refreshes a near-expiry token and persists the rotated tokens back to providers.json", async () => {
		// Token within the 5-minute refresh buffer -> pi-ai refreshes before the request.
		writeClineProviders(INITIAL_TOKEN, "refresh-1", Date.now() + 60_000);
		refreshCalls = 0;

		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "cline-pass/glm-5.3", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(200);
		expect(refreshCalls).toBe(1);
		// The request used the REFRESHED token.
		expect(captured.authorization).toBe(`Bearer ${REFRESHED_TOKEN}`);
		// Rotated tokens persisted back to the Cline file (in sync with the CLI).
		const data = JSON.parse(readFileSync(providersPath, "utf-8")) as any;
		expect(data.providers.cline.settings.auth.accessToken).toBe(REFRESHED_TOKEN);
		expect(data.providers.cline.settings.auth.refreshToken).toBe("refresh-rotated");
	});
});
