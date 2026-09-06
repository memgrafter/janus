import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createServer, type ServerHandle } from "../../src/server.ts";
import { FileCredentialStore } from "../../src/credentials.ts";
import { extractContentDeltas } from "../util.ts";

/**
 * Credential hot reload (jan-hop4): the credential store is reread per
 * request, so keys added to / changed in auth.json take effect WITHOUT a
 * restart. Covers both auth paths:
 *   - built-in providers (pi-ai's resolver: stored credential -> env)
 *   - custom providers (janus resolution: stored -> catalog $ENV/literal)
 *   - ClinePass: advertised + activates without a restart once a credential
 *     appears in providers.json
 */

const ENV_KEY = "hot-reload-env-key";
const STORED_KEY_1 = "hot-reload-stored-1";
const STORED_KEY_2 = "hot-reload-stored-2";

let dir: string;
let mock: Bun.Server<unknown>;
let mockBase: string;
let seenAuth: string[] = [];
let authJsonPath: string;
let modelsJsonPath: string;
let providersPath: string;
let handle: ServerHandle;
let base: string;

function sseResponse(model: string, text: string): Response {
	const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>) =>
		`data: ${JSON.stringify({ id: "h1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
	const body =
		chunk({ role: "assistant", content: "" }, null) +
		chunk({ content: text }, null) +
		chunk({}, "stop", { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }) +
		"data: [DONE]\n\n";
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "janus-hotreload-"));
	authJsonPath = join(dir, "auth.json");
	modelsJsonPath = join(dir, "models.json");
	providersPath = join(dir, "cline-providers.json");

	// Local mock upstream for the custom provider.
	mock = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			if (url.pathname === "/v1/chat/completions") {
				seenAuth.push(req.headers.get("authorization") ?? "");
				const body = (await req.json()) as any;
				return sseResponse(body.model, "hot reload ok");
			}
			if (url.pathname === "/api/v1/chat/completions") {
				// Cline gateway path
				const body = (await req.json()) as any;
				seenAuth.push(`cline:${req.headers.get("authorization") ?? ""}`);
				return sseResponse(body.model, "clinepass mock ok");
			}
			return new Response("not found", { status: 404 });
		},
	});
	mockBase = `http://127.0.0.1:${mock.port!}`;

	// Custom provider whose key comes from the env var (fallback) — auth.json
	// starts EMPTY so the first request must use the env key. storedprov has NO
	// catalog apiKey at all: its key lives ONLY in auth.json (acceptance (a)).
	writeFileSync(
		modelsJsonPath,
		JSON.stringify({
			providers: {
				hotprov: {
					baseUrl: `${mockBase}/v1`,
					api: "openai-completions",
					apiKey: "$JANUS_HOTRELOAD_KEY",
					models: [{ id: "m1", contextWindow: 1000, maxTokens: 100 }],
				},
				storedprov: {
					baseUrl: `${mockBase}/v1`,
					api: "openai-completions",
					models: [{ id: "m1", contextWindow: 1000, maxTokens: 100 }],
				},
			},
		}),
	);
	process.env.JANUS_HOTRELOAD_KEY = ENV_KEY;

	const config = loadConfig({
		JANUS_FAUX: "0",
		JANUS_AUTH_JSON: authJsonPath,
		JANUS_MODELS_JSON: modelsJsonPath,
		JANUS_CLINE_PASS: "1",
		JANUS_CLINE_PROVIDERS_JSON: providersPath, // does not exist yet
		JANUS_CLINE_API_BASE_URL: mockBase,
	});
	handle = await createServer(config, 0);
	base = `http://127.0.0.1:${handle.port}/v1`;
});

afterAll(async () => {
	await handle?.close();
	mock?.stop(true);
	delete process.env.JANUS_HOTRELOAD_KEY;
	rmSync(dir, { recursive: true, force: true });
});

async function chat(model: string): Promise<Response> {
	return fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: true }),
	});
}

describe("credential hot reload", () => {
	it("custom provider: env fallback when auth.json is empty", async () => {
		const res = await chat("hotprov/m1");
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(extractContentDeltas(text)).toBe("hot reload ok");
		expect(seenAuth[seenAuth.length - 1]).toBe(`Bearer ${ENV_KEY}`);
	});

	it("custom provider: a key that exists ONLY in auth.json (no catalog key, no env) authenticates", async () => {
		writeFileSync(authJsonPath, JSON.stringify({ storedprov: { type: "api_key", key: STORED_KEY_1 } }, null, 2));
		const res = await chat("storedprov/m1");
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(extractContentDeltas(text)).toBe("hot reload ok");
		expect(seenAuth[seenAuth.length - 1]).toBe(`Bearer ${STORED_KEY_1}`);
	});
	it("custom provider: a key added to auth.json wins without a restart", async () => {
		writeFileSync(authJsonPath, JSON.stringify({ hotprov: { type: "api_key", key: STORED_KEY_1 } }, null, 2));
		const res = await chat("hotprov/m1");
		expect(res.status).toBe(200);
		await res.text();
		expect(seenAuth[seenAuth.length - 1]).toBe(`Bearer ${STORED_KEY_1}`);
	});

	it("custom provider: a CHANGED key in auth.json wins without a restart", async () => {
		writeFileSync(authJsonPath, JSON.stringify({ hotprov: { type: "api_key", key: STORED_KEY_2 } }, null, 2));
		const res = await chat("hotprov/m1");
		expect(res.status).toBe(200);
		await res.text();
		expect(seenAuth[seenAuth.length - 1]).toBe(`Bearer ${STORED_KEY_2}`);
	});

	it("built-in provider: stored credential beats env, and rotates without a restart", async () => {
		// DeepSeek is a built-in (openai-completions). Its resolver consults the
		// credential store first, then DEEPSEEK_API_KEY — assert both, plus a
		// live rotation, through the same store janus passes to builtinModels().
		process.env.DEEPSEEK_API_KEY = ENV_KEY;
		try {
			const store = new FileCredentialStore(authJsonPath, true);
			const models = builtinModels({ credentials: store });
			const auth0 = await models.getAuth("deepseek");
			expect(auth0?.auth.apiKey).toBe(ENV_KEY);
			expect(auth0?.source).toBe("DEEPSEEK_API_KEY");

			await store.modify("deepseek", async () => ({ type: "api_key", key: STORED_KEY_1 }));
			const auth1 = await models.getAuth("deepseek");
			expect(auth1?.auth.apiKey).toBe(STORED_KEY_1);
			expect(auth1?.source).toBe("stored credential");

			// Rotate the stored key on disk (as the sync tool / OAuth refresh do).
			const data = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, any>;
			data.deepseek = { type: "api_key", key: STORED_KEY_2 };
			writeFileSync(authJsonPath, JSON.stringify(data, null, 2));
			const auth2 = await models.getAuth("deepseek");
			expect(auth2?.auth.apiKey).toBe(STORED_KEY_2);
		} finally {
			delete process.env.DEEPSEEK_API_KEY;
		}
	});

	it("cline-pass: advertised with NO credential present", async () => {
		expect(existsSync(providersPath)).toBe(false);
		const res = await fetch(`${base}/models`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		const ids = body.data.map((m: any) => m.id);
		expect(ids).toContain("cline-pass/glm-5.3");
	});

	it("cline-pass: request fails cleanly before a credential exists", async () => {
		// Non-streaming: the auth failure happens before any network call, so the
		// server returns a clean JSON provider error (502 + pi-ai's "not configured" message).
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "cline-pass/glm-5.3", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(502);
		const body = (await res.json()) as any;
		expect(body.error.message).toContain("not configured");
	});

	it("cline-pass: a credential added to providers.json activates it without a restart", async () => {
		writeFileSync(
			providersPath,
			JSON.stringify(
				{
					version: 1,
					lastUsedProvider: "cline",
					modes: {},
					providers: {
						cline: {
							settings: {
								provider: "cline",
								auth: {
									accessToken: "workos:late-token",
									refreshToken: "refresh-1",
									expiresAt: Date.now() + 3_600_000,
									accountId: "acct-1",
								},
							},
							updatedAt: new Date().toISOString(),
							tokenSource: "oauth",
						},
					},
				},
				null,
				2,
			),
		);
		const res = await chat("cline-pass/glm-5.3");
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(extractContentDeltas(text)).toBe("clinepass mock ok");
		expect(seenAuth[seenAuth.length - 1]).toBe("cline:Bearer workos:late-token");
	});
});
