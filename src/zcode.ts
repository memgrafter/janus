/**
 * ZCode (Z.AI GLM) provider for pi-janus.
 *
 * Two Anthropic-format upstreams (see research ticket jan-j61u):
 *
 *  - Coding Plan (provider id "zcode"): POST {planBaseUrl}/v1/messages with
 *    `Authorization: Bearer <zcodeJwt>` + a strict ZCode client fingerprint
 *    (User-Agent, X-ZCode-App-Version, X-ZCode-Agent, X-Title, HTTP-Referer,
 *    per-request UUID headers, stable x-session-id) + ZCode system-prompt
 *    injection + upstream model mapping (glm-5.2 -> GLM-5.2). Gated by an
 *    Aliyun captcha (body code 3007): a solve page is served by pi-janus and
 *    the resulting verifyParam rides on X-Aliyun-Captcha-Verify-Param.
 *  - API key (provider id "zcode-apikey"): POST {apiKeyBaseUrl}/v1/messages
 *    with `x-api-key: <key.secretKey>` + fingerprint. No captcha.
 *
 * Credentials come from a hot-readable zcode.conf (JANUS_ZCODE_CONF). Both
 * providers are registered whenever ZCode is enabled; each request re-reads the
 * conf (mtime check) so adding/rotating credentials needs no restart, and a
 * provider is "available" (listed by /v1/models) only while its credential is
 * present. No ZCode app install is required.
 *
 * Error taxonomy is matched on BODY codes, not HTTP statuses (Z.AI drifted
 * from the reference implementation): 401 = dead credential (re-authenticate),
 * 3007 = captcha challenge, 1113 = quota exhausted, 3010 = concurrency limit.
 */

import {
	createProvider,
	type Api,
	type Model,
	type ProviderHeaders,
	type ProviderStreams,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { captchaManager, isCaptchaErrorBody, type CaptchaManager } from "./zcode-captcha.ts";
import { loadZcodeConf, ZCODE_APIKEY_BASE_URL, ZCODE_PLAN_BASE_URL, type ZcodeConf } from "./zcode-conf.ts";

/** Provider ids registered in pi-ai. */
export const ZCODE_PROVIDER_ID = "zcode";
export const ZCODE_APIKEY_PROVIDER_ID = "zcode-apikey";

interface ZcodeModelSpec {
	id: string;
	wireModel: string;
	contextWindow: number;
	maxTokens: number;
}

/** Coding Plan upstream model map (case-sensitive wire ids, from the ZCode client). */
const PLAN_MODELS: ZcodeModelSpec[] = [
	{ id: "glm-5.3", wireModel: "GLM-5.3", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "glm-5.3-flash", wireModel: "GLM-5.3-Flash", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "glm-5.2", wireModel: "GLM-5.2", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "glm-5.1", wireModel: "GLM-5.1", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "glm-5-turbo", wireModel: "GLM-5-Turbo", contextWindow: 200_000, maxTokens: 128_000 },
	{ id: "glm-4.7", wireModel: "GLM-4.7", contextWindow: 200_000, maxTokens: 128_000 },
];

/** API-key upstream (api.z.ai) model catalog. */
const APIKEY_MODELS: ZcodeModelSpec[] = [
	{ id: "glm-5.3", wireModel: "glm-5.3", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "glm-5.3-flash", wireModel: "glm-5.3-flash", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "glm-5.2", wireModel: "GLM-5.2", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "glm-5.1", wireModel: "GLM-5.1", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "glm-5-turbo", wireModel: "GLM-5-Turbo", contextWindow: 200_000, maxTokens: 128_000 },
	{ id: "glm-5", wireModel: "glm-5", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "glm-4.7", wireModel: "GLM-4.7", contextWindow: 200_000, maxTokens: 128_000 },
	{ id: "glm-4.6", wireModel: "glm-4.6", contextWindow: 128_000, maxTokens: 128_000 },
	{ id: "glm-4.6v", wireModel: "glm-4.6v", contextWindow: 128_000, maxTokens: 128_000 },
];

function wireMap(specs: ZcodeModelSpec[]): Record<string, string> {
	return Object.fromEntries(specs.map((m) => [m.id.toLowerCase(), m.wireModel]));
}

const PLAN_WIRE = wireMap(PLAN_MODELS);
const APIKEY_WIRE = wireMap(APIKEY_MODELS);

/**
 * Map a requested model id to its upstream wire id. The Coding Plan and
 * API-key upstreams case the same short id differently (e.g. `glm-5.3` ->
 * `GLM-5.3` on the plan, `glm-5.3` on the apikey upstream), so the provider
 * selects the map. Unknown ids pass through verbatim.
 */
export function wireModelForZcode(modelId: string, provider?: string): string {
	const map = provider === ZCODE_APIKEY_PROVIDER_ID ? APIKEY_WIRE : PLAN_WIRE;
	return map[modelId.toLowerCase()] ?? modelId;
}

// ---------------------------------------------------------------------------
// ZCode client fingerprint headers
// ---------------------------------------------------------------------------

function uuid(): string {
	return crypto.randomUUID();
}

/** Env-gated debug logging (JANUS_ZCODE_DEBUG=1) for the captcha/auth flow. */
function zlog(...args: unknown[]): void {
	if (process.env["JANUS_ZCODE_DEBUG"] === "1") console.error("[zcode]", ...args);
}

/** Stable per-process session id (matches the ZCode client's session affinity). */
const SESSION_ID = uuid();

/**
 * Coding Plan fingerprint headers. The JWT is carried as `Authorization:
 * Bearer` (the SDK's own `X-Api-Key` is suppressed via a null header). When
 * `verifyParam` is present (a solved captcha), it rides on the Aliyun headers.
 */
export function zcodePlanHeaders(conf: ZcodeConf, verifyParam?: string): ProviderHeaders {
	const headers: ProviderHeaders = {
		Authorization: `Bearer ${conf.zcodeJwt ?? ""}`,
		// Suppress the SDK's X-Api-Key (the JWT is a Bearer, not an x-api-key).
		"x-api-key": null,
		"User-Agent": conf.userAgent,
		"X-ZCode-App-Version": conf.appVersion,
		"X-ZCode-Agent": "glm",
		"X-Title": "Z Code@electron",
		"HTTP-Referer": "https://zcode.z.ai/",
		"x-request-id": uuid(),
		"x-zcode-trace-id": uuid(),
		"x-query-id": uuid(),
		"x-session-id": SESSION_ID,
		// The ZCode client sends no anthropic-beta; suppress pi-ai's default.
		"anthropic-beta": null,
	};
	if (verifyParam) {
		headers["X-Aliyun-Captcha-Verify-Param"] = verifyParam;
		headers["X-Aliyun-Captcha-Verify-Region"] = conf.captchaRegion;
	}
	return headers;
}

/** API-key upstream headers (api.z.ai fingerprint). */
export function zcodeApiKeyHeaders(conf: ZcodeConf, apiKey: string): ProviderHeaders {
	return {
		"x-api-key": apiKey,
		"User-Agent": conf.userAgent,
		"X-ZCode-App-Version": conf.appVersion,
		"X-ZCode-Agent": "glm",
		"HTTP-Referer": "https://zcode.z.ai/",
		"anthropic-beta": null,
	};
}

// ---------------------------------------------------------------------------
// ZCode system-prompt injection (Coding Plan upstream requires it)
// ---------------------------------------------------------------------------

export const ZCODE_SYSTEM_IDENTITY = "You are ZCode, an interactive coding agent";

const ZCODE_SYSTEM_HARNESS = `You are an interactive ZCode agent that helps users with software engineering tasks.

IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.

# Harness
- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.
- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.
- \`<system-reminder>\` tags in messages and tool results are injected by the harness, not the user. Hooks may intercept tool calls; treat hook output as user feedback.
- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.
- Reference code as \`file_path:line_number\` — it's clickable.`;

const ZCODE_SYSTEM_GUIDANCE = `Write code that reads like the surrounding code: match its comment density, naming, and idiom.

For actions that are hard to reverse or outward-facing, confirm first unless durably authorized or explicitly told to proceed without asking; approval in one context doesn't extend to the next. Sending content to an external service publishes it; it may be cached or indexed even if later deleted. Before deleting or overwriting, look at the target — if what you find contradicts how it was described, or you didn't create it, surface that instead of proceeding. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.

# Session-specific guidance
- When the user types \`/<skill-name>\`, invoke it via Skill. Only use skills listed in the user-invocable skills section — don't guess.

# Context management
When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue — you don't need to wrap up early or hand off mid-task.`;

const CLAUDE_CODE_MARKERS = ["You are Claude Code", "Anthropic's official CLI for Claude"];

function textOf(block: unknown): string {
	return block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
		? ((block as { text: string }).text)
		: "";
}

function isClaudeCodeBlock(block: unknown): boolean {
	const t = textOf(block);
	return CLAUDE_CODE_MARKERS.some((m) => t.includes(m));
}

function hasZcodeMarker(system: unknown[]): boolean {
	return system.some((b) => textOf(b).includes(ZCODE_SYSTEM_IDENTITY));
}

/** Build the ZCode environment/guidance block (matches the ZCode app shape). */
function zcodeEnvironmentBlock(modelRef: string): string {
	const shell = (process.env["SHELL"] ?? "/bin/sh").split("/").pop() ?? "sh";
	const osVersion = `${process.platform} ${process.arch}`;
	return `${ZCODE_SYSTEM_GUIDANCE}

# Environment
You have been invoked in the following environment:
- Primary working directory: ${process.cwd()}
- Platform: ${process.platform}
- Shell: ${shell}
- OS Version: ${osVersion}
- You are powered by the model named ${modelRef}.`;
}

/**
 * Replace Claude Code's default system prompt with the ZCode identity blocks
 * for the Coding Plan upstream, preserving caller-provided system text.
 * Operates on the wire payload (Anthropic messages body). Pure. Idempotent.
 */
export function injectZcodeSystemPrompt(payload: unknown, modelRef: string): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const body = payload as Record<string, unknown>;
	const existing = Array.isArray(body.system) ? body.system : [];
	if (hasZcodeMarker(existing)) return undefined;
	const cache = { cache_control: { type: "ephemeral" } };
	const preserved = existing.filter((b) => !isClaudeCodeBlock(b));
	const blocks = [
		{ type: "text", text: ZCODE_SYSTEM_IDENTITY, ...cache },
		{ type: "text", text: ZCODE_SYSTEM_HARNESS, ...cache },
		{ type: "text", text: zcodeEnvironmentBlock(modelRef), ...cache },
		...preserved,
	];
	return { ...body, system: blocks };
}

/** onPayload hook for Coding Plan models: wire model + system-prompt injection. */
export function zcodePlanOnPayload(payload: unknown, model: { id: string }): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const body = payload as Record<string, unknown>;
	const wire = wireModelForZcode(model.id);
	let next: Record<string, unknown> = typeof body.model === "string" && body.model !== wire ? { ...body, model: wire } : body;
	const injected = injectZcodeSystemPrompt(next, `builtin:zai-start-plan/${wire}`);
	if (injected !== undefined) next = injected as Record<string, unknown>;
	return next;
}

/**
 * onPayload for a zcode model: the Coding Plan provider gets the wire-model
 * rewrite + ZCode system-prompt injection; the API-key provider gets the
 * wire-model rewrite only (no system prompt). Undefined for other providers.
 */
export function zcodeOnPayload(model: { provider?: string; id: string }): ((payload: unknown, m: { id: string }) => unknown | undefined) | undefined {
	if (model.provider === ZCODE_PROVIDER_ID) return zcodePlanOnPayload;
	if (model.provider === ZCODE_APIKEY_PROVIDER_ID) {
		return (payload, m) => {
			if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
			const body = payload as Record<string, unknown>;
			const wire = wireModelForZcode(m.id, ZCODE_APIKEY_PROVIDER_ID);
			return typeof body.model === "string" && body.model !== wire ? { ...body, model: wire } : undefined;
		};
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Error taxonomy (body-code based)
// ---------------------------------------------------------------------------

/**
 * Turn a raw upstream error (an Anthropic SDK APIError message, of the form
 * "<status> <body>") into a human ZCode message with the body-code taxonomy.
 * `captchaUrl` (when given) is embedded in the 3007 message.
 */
export function zcodeErrorMessage(message: string | undefined, captchaUrl?: string): string {
	const text = message ?? "";
	const code = extractBodyCode(text);
	if (code === "3007" || isCaptchaErrorBody(text)) {
		const hint = captchaUrl
			? ` Open the keeper tab at ${captchaUrl} in your browser and keep it open — it verifies automatically and serves the request. Do not retry in a loop; that trips risk control (3012).`
			: " Open the captcha keeper tab and keep it open; do not retry in a loop.";
		return `ZCode captcha verification required (code 3007).${hint}`;
	}
	if (code === "1113") {
		return "ZCode quota exhausted or no active resource package for this model (code 1113). Check the ZCode plan balance or try glm-5-turbo.";
	}
	if (code === "3010") {
		return "ZCode concurrency limit exceeded (code 3010). Another session is using this account; retry shortly.";
	}
	if (code === "3009") {
		return "ZCode model concurrency limit exceeded (code 3009). The upstream is throttling this model (common on free tiers); wait a bit and retry.";
	}
	if (code === "3006") {
		return "ZCode model not allowed (code 3006). This model is not in your Coding Plan — check which models your plan includes and request one of those.";
	}
	if (code === "3012") {
		return "ZCode request blocked by risk control (code 3012): unusual activity. The account/IP was flagged (often after a burst of captcha verifies or rapid requests). Stop sending requests and let it cool down (minutes to hours); do NOT retry in a loop — that extends the block.";
	}
	if (text.trimStart().startsWith("401")) {
		return "ZCode credential rejected (401). The Coding Plan JWT is dead — re-authenticate and update zcode.conf.";
	}
	return text.trim() || "ZCode upstream error";
}

/** Extract a numeric body `code` (e.g. 3007) from an error message, if present. */
function extractBodyCode(text: string): string | undefined {
	const m = text.match(/"code"\s*:\s*"?(\d+)"?/);
	return m?.[1];
}

/** True when the error is from a ZCode provider (for server-side surfacing). */
export function isZcodeProvider(provider: string | undefined): boolean {
	return provider === ZCODE_PROVIDER_ID || provider === ZCODE_APIKEY_PROVIDER_ID;
}

// ---------------------------------------------------------------------------
// Captcha-aware fetch
// ---------------------------------------------------------------------------

interface CaptchaDeps {
	conf: () => ZcodeConf | undefined;
	manager: CaptchaManager;
	/** Build a fully-qualified captcha page URL for error messages. */
	captchaUrl: () => string;
	autoOpen: () => boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("captcha wait timed out")), ms);
		promise.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Wrap the provider fetch so a 3007 captcha challenge: drops any rejected
 * verifyParam (ratchet), triggers the challenge (auto-open the browser when
 * enabled), waits (bounded) for a fresh param, and transparently retries once
 * with the param attached. If no solve arrives in time (or auto-open is off),
 * the original 3007 response is returned so the SDK surfaces it as a 3007
 * error, which the server maps to the captcha message + clickable URL.
 */
export function captchaAwareFetch(deps: CaptchaDeps): FetchLike {
	return async (input, init) => {
		// The SDK passes a ReadableStream body (from the built Request), which can
		// only be consumed once. Read it to a string so a captcha retry can resend
		// the identical payload.
		const body = await bodyToString(init?.body);
		const send = (headers?: Headers): Promise<Response> =>
			fetch(input, { ...init, ...(body !== undefined ? { body } : {}), ...(headers ? { headers } : {}) });
		const response = await send();
		zlog("upstream status:", response.status);
		if (response.status !== 400 && response.status !== 403) return response;
		const text = await response.clone().text().catch(() => "");
		if (!isCaptchaErrorBody(text)) return response;
		zlog("CAPTCHA CHALLENGE (3007) — ratcheting cache, will re-challenge. body:", text.slice(0, 120));
		// Challenged: ratchet the cache (a cached param was just rejected) and
		// wait for a fresh solve.
		deps.manager.invalidate();
		const conf = deps.conf();
		const url = deps.captchaUrl();
		const keeper = deps.manager.hasActiveKeeper();
		if (deps.autoOpen()) {
			// Local, no keeper: open a background tab and wait for it to solve.
			zlog("no keeper connected — auto-opening captcha tab");
			openBrowser(url);
		} else if (keeper) {
			// A keeper tab is connected and will re-verify on demand.
			zlog("keeper connected — waiting for keeper to verify");
		} else {
			// k3s (auto-open off) with NO keeper connected: there is nothing that
			// can mint a fresh verifyParam, so waiting captchaWaitMs (120s) would
			// just hang the request and invite retry-in-a-loop (-> 3012 block).
			// Fail fast with the clickable link so the user opens the keeper tab.
			zlog("no keeper connected and auto-open off — failing fast with the captcha URL");
			return response;
		}
		const waitMs = conf?.captchaWaitMs ?? 120_000;
		let param: string;
		try {
			param = await withTimeout(deps.manager.getVerifyParam(), waitMs);
		} catch {
			// No solve in time (or auto-open off): surface the original 3007
			// challenge. The SDK turns it into a 3007 APIError, which the server
			// maps to the captcha message + clickable URL.
			return response;
		}
		const headers = new Headers(init?.headers);
		headers.set("X-Aliyun-Captcha-Verify-Param", param);
		headers.set("X-Aliyun-Captcha-Verify-Region", conf?.captchaRegion ?? "sgp");
		zlog("retrying with fresh verifyParam");
		const retry = await send(headers);
		zlog("retry status:", retry.status, retry.ok ? "" : (await retry.clone().text().catch(() => "")).slice(0, 120));
		return retry;
	};
}

/**
 * Open a URL in the default browser (best-effort, local UX only). On macOS,
 * `open -g` opens it WITHOUT bringing the browser to the foreground, so the
 * captcha page loads and auto-solves in a background tab without stealing
 * focus from whatever you are working on.
 */
export function openBrowser(url: string): void {
	try {
		if (process.platform === "darwin") {
			Bun.spawn(["open", "-g", url], { stdout: "ignore", stderr: "ignore" });
		} else if (process.platform === "win32") {
			Bun.spawn(["cmd", "/c", "start", "", url], { stdout: "ignore", stderr: "ignore" });
		} else {
			Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
		}
	} catch {
		// best-effort
	}
}

/** Read a fetch body (string / ReadableStream / Request) to a string for resending. */
async function bodyToString(body: unknown): Promise<string | undefined> {
	if (body == null) return undefined;
	if (typeof body === "string") return body;
	if (typeof Request !== "undefined" && body instanceof Request) return await body.text();
	if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
		const reader = body.getReader();
		const chunks: Uint8Array[] = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) chunks.push(value);
		}
		return new TextDecoder().decode(concatBytes(chunks));
	}
	// Blob / ArrayBuffer / FormData / URLSearchParams — not expected from the
	// Anthropic SDK (always a JSON string); leave the original body untouched.
	return undefined;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.length;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Provider factories
// ---------------------------------------------------------------------------

function toModels(specs: ZcodeModelSpec[], provider: string, baseUrl: string): Model<Api>[] {
	return specs.map((m) => ({
		id: m.id,
		name: m.wireModel,
		api: "anthropic-messages" as Api,
		provider,
		baseUrl,
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		wireModel: m.wireModel,
	}));
}

/**
 * Build the Coding Plan provider. Auth is header-owned: `resolve()` hot-reads
 * the conf and returns the JWT as the apiKey (so pi-ai's auth gate passes and
 * the SDK client is built), while the fingerprint layer injects the real
 * `Authorization: Bearer` header and suppresses the SDK's `X-Api-Key`.
 */
export function createZcodePlanProvider(baseApi: ProviderStreams, deps: CaptchaDeps): ReturnType<typeof createProvider> {
	const planFetch = captchaAwareFetch(deps);
	const api: ProviderStreams = {
		stream: (model, context, options) => baseApi.stream(model, context, withPlanOptions(options, deps, planFetch)),
		streamSimple: (model, context, options) => baseApi.streamSimple(model, context, withPlanOptions(options, deps, planFetch)),
	};
	return createProvider({
		id: ZCODE_PROVIDER_ID,
		name: "ZCode (GLM Coding Plan)",
		baseUrl: ZCODE_PLAN_BASE_URL,
		auth: {
			apiKey: {
				name: "ZCode Coding Plan JWT",
				resolve: async () => {
					const conf = deps.conf();
					if (!conf?.zcodeJwt) return undefined; // unconfigured -> not available
					return { auth: { apiKey: conf.zcodeJwt, baseUrl: conf.planBaseUrl ?? ZCODE_PLAN_BASE_URL }, source: "zcode.conf" };
				},
			},
		},
		models: toModels(PLAN_MODELS, ZCODE_PROVIDER_ID, ZCODE_PLAN_BASE_URL),
		api,
	});
}

function withPlanOptions(options: StreamOptions | undefined, deps: CaptchaDeps, planFetch: FetchLike): StreamOptions {
	const conf = deps.conf();
	// Debug: skip attaching a cached param to test whether the captcha is
	// per-session (a solved session passes with no param) or per-request.
	const noParam = conf?.debugNoParam === true;
	const cached = noParam ? undefined : deps.manager.peekCached();
	zlog("request:", noParam ? "DEBUG no-param mode (sending no verifyParam)" : cached ? `cached verifyParam attached (age ${Date.now() - (deps.manager as any).cachedAt}ms)` : "no cached verifyParam");
	const headers = {
		...(options?.headers ?? {}),
		...zcodePlanHeaders(conf ?? ({ captchaRegion: "sgp" } as ZcodeConf), cached),
	} as ProviderHeaders;
	return {
		...options,
		headers,
		fetch: planFetch as StreamOptions["fetch"],
		maxRetries: 0,
	};
}

/** Build the API-key provider (api.z.ai, x-api-key, no captcha). */
export function createZcodeApiKeyProvider(baseApi: ProviderStreams, deps: CaptchaDeps): ReturnType<typeof createProvider> {
	return createProvider({
		id: ZCODE_APIKEY_PROVIDER_ID,
		name: "ZCode (Z.AI API key)",
		baseUrl: ZCODE_APIKEY_BASE_URL,
		auth: {
			apiKey: {
				name: "Z.AI API key",
				resolve: async () => {
					const conf = deps.conf();
					if (!conf?.apiKey) return undefined; // unconfigured -> not available
					return { auth: { apiKey: conf.apiKey, baseUrl: conf.apiKeyBaseUrl ?? ZCODE_APIKEY_BASE_URL }, source: "zcode.conf" };
				},
			},
		},
		models: toModels(APIKEY_MODELS, ZCODE_APIKEY_PROVIDER_ID, ZCODE_APIKEY_BASE_URL),
		api: baseApi,
	});
}

/** Shared deps wired to the conf loader + shared captcha manager. */
export function zcodeDeps(confPath: string | undefined): CaptchaDeps {
	return {
		conf: () => loadZcodeConf(confPath),
		manager: captchaManager(loadZcodeConf(confPath)),
		captchaUrl: () => captchaUrlFn(),
		// Auto-open a background tab only when NO keeper tab is connected. If a
		// keeper is long-polling it will auto-verify on demand; opening a second
		// tab would run a concurrent traceless verify from the same fingerprint,
		// which Aliyun rejects (the keeper's param then 3007s).
		autoOpen: () =>
			(loadZcodeConf(confPath)?.captchaAutoOpen ?? true) &&
			!captchaManager(loadZcodeConf(confPath)).hasActiveKeeper(),
	};
}

// The captcha page URL is resolved against the live server (actual bound port +
// optional public origin), which is only known after Bun.serve binds. The server
// installs this after binding; the fallback covers the pre-bind window.
let captchaUrlFn: () => string = () => "http://127.0.0.1:8787/zcode/captcha.html";
export function setZcodeCaptchaUrl(fn: () => string): void {
	captchaUrlFn = fn;
}
/** Current captcha page URL (live server origin, or the fallback before bind). */
export function zcodeCaptchaUrl(): string {
	return captchaUrlFn();
}

/**
 * Register the ZCode providers on a Models collection. Both are registered
 * whenever ZCode is enabled; each is "available" (listed by /v1/models) only
 * while its credential is present in the hot-read conf, so adding a JWT or API
 * key after startup takes effect without a restart.
 *
 * Returns the registered provider ids.
 */
export function registerZcode(
	models: { setProvider: (p: ReturnType<typeof createProvider>) => void },
	baseApi: ProviderStreams,
	deps: CaptchaDeps,
): string[] {
	models.setProvider(createZcodePlanProvider(baseApi, deps));
	models.setProvider(createZcodeApiKeyProvider(baseApi, deps));
	return [ZCODE_PROVIDER_ID, ZCODE_APIKEY_PROVIDER_ID];
}

/** Build the fully-qualified captcha page URL from a request origin. */
export function captchaPageUrl(origin: string): string {
	return `${origin.replace(/\/$/, "")}/zcode/captcha.html`;
}
