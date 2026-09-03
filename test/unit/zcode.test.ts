import { describe, expect, it } from "bun:test";
import { parseZcodeConf, ZCODE_APIKEY_BASE_URL, ZCODE_PLAN_BASE_URL } from "../../src/zcode-conf.ts";
import {
	captchaPageUrl,
	injectZcodeSystemPrompt,
	isZcodeProvider,
	wireModelForZcode,
	zcodeApiKeyHeaders,
	zcodeErrorMessage,
	zcodeOnPayload,
	zcodePlanHeaders,
	zcodePlanOnPayload,
} from "../../src/zcode.ts";
import { CaptchaManager, captchaManager, isCaptchaErrorBody } from "../../src/zcode-captcha.ts";

describe("zcode-conf", () => {
	it("applies defaults for absent fields", () => {
		const conf = parseZcodeConf(JSON.stringify({ apiKey: "k.s" }));
		expect(conf.apiKey).toBe("k.s");
		expect(conf.zcodeJwt).toBeUndefined();
		expect(conf.captchaTtlMs).toBe(300_000);
		expect(conf.captchaWaitMs).toBe(120_000);
		expect(conf.captchaAutoOpen).toBe(true);
		expect(conf.captchaRegion).toBe("sgp");
	});

	it("accepts all fields and overrides", () => {
		const conf = parseZcodeConf(
			JSON.stringify({
				zcodeJwt: "jwt",
				apiKey: "k.s",
				refreshToken: "r",
				clientSecret: "c",
				captchaTtlMs: 45_000,
				captchaWaitMs: 30_000,
				captchaAutoOpen: false,
				appVersion: "9.9.9",
				planBaseUrl: "http://localhost:1",
			}),
		);
		expect(conf.zcodeJwt).toBe("jwt");
		expect(conf.captchaTtlMs).toBe(45_000);
		expect(conf.captchaWaitMs).toBe(30_000);
		expect(conf.captchaAutoOpen).toBe(false);
		expect(conf.appVersion).toBe("9.9.9");
		expect(conf.planBaseUrl).toBe("http://localhost:1");
	});

	it("ignores junk ttl/wait values", () => {
		expect(parseZcodeConf(`{"captchaTtlMs":"x"}`).captchaTtlMs).toBe(300_000);
		expect(parseZcodeConf(`{"captchaTtlMs":-5}`).captchaTtlMs).toBe(300_000);
		expect(parseZcodeConf(`{"captchaWaitMs":0}`).captchaWaitMs).toBe(120_000);
	});

	it("exposes both upstream origins", () => {
		expect(ZCODE_PLAN_BASE_URL).toContain("zcode.z.ai");
		expect(ZCODE_APIKEY_BASE_URL).toContain("api.z.ai");
	});
});

describe("zcode headers", () => {
	it("plan headers carry the JWT bearer + full ZCode fingerprint", () => {
		const conf = parseZcodeConf(`{"zcodeJwt":"JWT123"}`);
		const h = zcodePlanHeaders(conf);
		expect(h["Authorization"]).toBe("Bearer JWT123");
		expect(h["x-api-key"]).toBeNull(); // SDK's X-Api-Key suppressed
		expect(h["User-Agent"]).toMatch(/^ZCode\//);
		expect(h["X-ZCode-Agent"]).toBe("glm");
		expect(h["X-Title"]).toBe("Z Code@electron");
		expect(h["HTTP-Referer"]).toBe("https://zcode.z.ai/");
		expect(h["x-request-id"]).toMatch(/[0-9a-f-]{36}/);
		expect(h["x-session-id"]).toMatch(/[0-9a-f-]{36}/);
		// Captcha param absent until a solve exists.
		expect(h["X-Aliyun-Captcha-Verify-Param"]).toBeUndefined();
	});

	it("plan headers attach the verifyParam + region when solved", () => {
		const h = zcodePlanHeaders(parseZcodeConf(`{}`), "PARAM");
		expect(h["X-Aliyun-Captcha-Verify-Param"]).toBe("PARAM");
		expect(h["X-Aliyun-Captcha-Verify-Region"]).toBe("sgp");
	});

	it("apikey headers carry x-api-key and no auth header", () => {
		const h = zcodeApiKeyHeaders(parseZcodeConf(`{}`), "k.secret");
		expect(h["x-api-key"]).toBe("k.secret");
		expect(h["Authorization"]).toBeUndefined();
	});
});

describe("zcode system-prompt injection", () => {
	it("injects ZCode blocks and maps the wire model", () => {
		const out = zcodePlanOnPayload({ model: "glm-5.2", messages: [] }, { id: "glm-5.2" }) as Record<string, unknown>;
		expect(out.model).toBe("GLM-5.2");
		const system = out.system as { text: string }[];
		expect(system.some((b) => b.text.includes("You are ZCode"))).toBe(true);
		expect(system.some((b) => b.text.includes("# Harness"))).toBe(true);
		expect(system.some((b) => b.text.includes("# Environment"))).toBe(true);
	});

	it("replaces Claude Code blocks but preserves caller system text", () => {
		const payload = {
			model: "glm-5.2",
			messages: [],
			system: [
				{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
				{ type: "text", text: "custom user rules" },
			],
		};
		const out = zcodePlanOnPayload(payload, { id: "glm-5.2" }) as Record<string, unknown>;
		const system = out.system as { text: string }[];
		expect(system.some((b) => b.text.includes("Claude Code"))).toBe(false);
		expect(system.some((b) => b.text === "custom user rules")).toBe(true);
	});

	it("is idempotent (no double injection)", () => {
		const once = zcodePlanOnPayload({ model: "glm-5.2", messages: [] }, { id: "glm-5.2" });
		const twice = injectZcodeSystemPrompt(once, "builtin:zai-start-plan/GLM-5.2");
		expect(twice).toBeUndefined();
	});

	it("maps known model ids to wire form and passes unknown through", () => {
		expect(wireModelForZcode("glm-5.2")).toBe("GLM-5.2");
		expect(wireModelForZcode("glm-5.1")).toBe("GLM-5.1");
		expect(wireModelForZcode("glm-5.3")).toBe("GLM-5.3"); // plan wire id (uppercase)
		expect(wireModelForZcode("glm-5.3", "zcode-apikey")).toBe("glm-5.3"); // apikey wire id (lowercase)
		expect(wireModelForZcode("custom-model")).toBe("custom-model"); // unknown -> verbatim
	});

	it("zcodeOnPayload is a no-op for non-zcode providers", () => {
		expect(zcodeOnPayload({ provider: "anthropic", id: "claude-sonnet-4" })).toBeUndefined();
		expect(zcodeOnPayload({ provider: "zcode", id: "glm-5.2" })).toBe(zcodePlanOnPayload);
	});

	it("zcodeOnPayload maps the apikey wire model without a system prompt", () => {
		const hook = zcodeOnPayload({ provider: "zcode-apikey", id: "glm-5.2" });
		expect(hook).toBeDefined();
		const out = hook!({ model: "glm-5.2", messages: [] }, { id: "glm-5.2" }) as Record<string, unknown>;
		expect(out.model).toBe("GLM-5.2");
		expect(out.system).toBeUndefined();
	});
});

describe("zcode error taxonomy (body-code based)", () => {
	it("3007 -> captcha message including the page URL", () => {
		const msg = zcodeErrorMessage(`400 {"code":3007,"msg":"captcha verify failed"}`, "http://x/zcode/captcha.html");
		expect(msg).toContain("captcha");
		expect(msg).toContain("http://x/zcode/captcha.html");
	});

	it("401 -> re-auth message", () => {
		const msg = zcodeErrorMessage(`401 {"error":{"message":"invalid token"}}`);
		expect(msg).toContain("re-authenticate");
	});

	it("1113 -> quota message", () => {
		const msg = zcodeErrorMessage(`400 {"code":1113,"msg":"quota"}`);
		expect(msg).toContain("quota exhausted");
	});

	it("3010 -> concurrency message", () => {
		const msg = zcodeErrorMessage(`429 {"code":3010,"msg":"concurrency limit"}`);
		expect(msg).toContain("concurrency");
	});

	it("3009 -> model concurrency (throttle) message", () => {
		const msg = zcodeErrorMessage(`429 {"code":3009,"msg":"model concurrency limit exceeded"}`);
		expect(msg).toContain("3009");
		expect(msg).toContain("throttling");
	});

	it("3006 -> model not allowed message", () => {
		const msg = zcodeErrorMessage(`400 {"code":3006,"msg":"model not allowed"}`);
		expect(msg).toContain("3006");
		expect(msg).toContain("not in your Coding Plan");
	});

	it("3012 -> risk-control block message (do not retry in a loop)", () => {
		const msg = zcodeErrorMessage(`405 {"code":3012,"msg":"request has been blocked due to unusual activity."}`);
		expect(msg).toContain("3012");
		expect(msg).toContain("risk control");
		expect(msg).toContain("cool down");
	});

	it("falls back to the raw message for unknown codes", () => {
		const msg = zcodeErrorMessage(`500 {"error":{"message":"boom"}}`);
		expect(msg).toContain("boom");
	});

	it("isZcodeProvider matches both zcode providers", () => {
		expect(isZcodeProvider("zcode")).toBe(true);
		expect(isZcodeProvider("zcode-apikey")).toBe(true);
		expect(isZcodeProvider("anthropic")).toBe(false);
	});

	it("isCaptchaErrorBody matches drifted shapes (text fallback)", () => {
		expect(isCaptchaErrorBody(`{"code":3007,"msg":"captcha verify failed"}`)).toBe(true);
		expect(isCaptchaErrorBody(`some text mentioning captcha verify failed`)).toBe(true);
		expect(isCaptchaErrorBody(`{"code":1113,"msg":"quota"}`)).toBe(false);
		expect(isCaptchaErrorBody(undefined)).toBe(false);
	});

	it("captchaPageUrl joins origin + path", () => {
		expect(captchaPageUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/zcode/captcha.html");
		expect(captchaPageUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787/zcode/captcha.html");
	});
});

describe("captcha manager", () => {
	it("caches a submitted param until TTL", async () => {
		const m = new CaptchaManager(60_000);
		expect(m.peekCached()).toBeUndefined();
		m.submit("p1");
		expect(m.peekCached()).toBe("p1");
		// getVerifyParam resolves immediately from cache.
		expect(await m.getVerifyParam()).toBe("p1");
	});

	it("expires a param past the TTL", async () => {
		const m = new CaptchaManager(1);
		m.submit("p1");
		await new Promise((r) => setTimeout(r, 10));
		expect(m.peekCached()).toBeUndefined();
	});

	it("deduplicates concurrent waiters on one pending promise", async () => {
		const m = new CaptchaManager(60_000);
		const a = m.getVerifyParam();
		const b = m.getVerifyParam();
		expect(m.solving).toBe(true);
		m.submit("solved");
		expect(await a).toBe("solved");
		expect(await b).toBe("solved");
		expect(m.solving).toBe(false);
	});

	it("invalidate drops the cache (ratchet)", async () => {
		const m = new CaptchaManager(60_000);
		m.submit("stale");
		m.invalidate();
		expect(m.peekCached()).toBeUndefined();
		const wait = m.getVerifyParam();
		m.submit("fresh");
		expect(await wait).toBe("fresh");
	});

	it("setTtl expires an over-age cache", async () => {
		const m = new CaptchaManager(60_000);
		m.submit("p1");
		m.setTtl(1);
		await new Promise((r) => setTimeout(r, 10));
		expect(m.peekCached()).toBeUndefined();
	});

	it("process-wide manager reflects conf ttl changes", () => {
		const a = captchaManager(parseZcodeConf(`{"captchaTtlMs":123000}`));
		const b = captchaManager(parseZcodeConf(`{"captchaTtlMs":456000}`));
		expect(a).toBe(b);
		expect(a.ttl).toBe(456_000);
	});
});
