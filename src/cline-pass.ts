/**
 * ClinePass provider for pi-janus.
 *
 * Serves the ClinePass subscription (https://api.cline.bot/api/v1, OpenAI
 * Chat Completions) using the OAuth credential the Cline CLI stores in
 * ~/.cline/data/settings/providers.json. This lets a user log in ONCE (via
 * `cline auth cline-pass` on any machine with a browser) and run pi-janus on
 * every machine without a per-machine login — pi-janus reads the shared file
 * and auto-refreshes the token.
 *
 * Wire details (verified against the Cline CLI / @cline/llms):
 *   - base URL: https://api.cline.bot/api/v1
 *   - auth:     Authorization: Bearer <accessToken>   (the stored token,
 *               normalized to the `workos:`-prefixed form — the gateway
 *               returns the raw JWT on refresh, the CLI stores/sends prefixed)
 *   - model:    the FULL slug, e.g. "cline-pass/glm-5.3"
 *   - refresh:  POST https://api.cline.bot/api/v1/auth/refresh
 *               body { refreshToken, grantType: "refresh_token" }
 *               -> { success, data: { accessToken, refreshToken, tokenType,
 *                  expiresAt: <ISO string>, userInfo } }
 *
 * pi-ai sends `model.id` verbatim as the wire `model` field, so we register the
 * models with SHORT ids (e.g. "glm-5.3") and rewrite the wire model to the full
 * slug via the `onPayload` hook (see wireModelId / clinePassWireModelId).
 */

import { createProvider, type Api, type Model, type MutableModels, type OAuthCredential, type ProviderStreams } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { readClineCredential, withWorkosPrefix } from "./cline-credentials.ts";

/** Provider id used for ClinePass in pi-janus. */
export const CLINE_PASS_PROVIDER_ID = "cline-pass";

/** Cline API base URL (production). Overridable via JANUS_CLINE_API_BASE_URL. */
export const DEFAULT_CLINE_API_BASE_URL = "https://api.cline.bot";

/** OpenAI-compatible gateway base URL. */
export function clineGatewayBaseUrl(apiBaseUrl: string = DEFAULT_CLINE_API_BASE_URL): string {
	return `${apiBaseUrl.replace(/\/$/, "")}/api/v1`;
}

/** Token refresh endpoint. */
export function clineRefreshUrl(apiBaseUrl: string = DEFAULT_CLINE_API_BASE_URL): string {
	return `${apiBaseUrl.replace(/\/$/, "")}/api/v1/auth/refresh`;
}

/**
 * The wire `model` value the Cline gateway expects for a registered model id.
 * ClinePass models use the `cline-pass/<id>` slug; other Cline-gateway models
 * (e.g. `z-ai/glm-5.3-flash`) use their own slug, captured in `wireModel`.
 */
export function clinePassWireModelId(model: { id: string; wireModel?: string }): string {
	if (model.wireModel) return model.wireModel;
	return model.id.startsWith(`${CLINE_PASS_PROVIDER_ID}/`) ? model.id : `${CLINE_PASS_PROVIDER_ID}/${model.id}`;
}

/**
 * onPayload hook that rewrites the wire `model` field to the gateway slug for a
 * Cline model. pi-ai sends `model.id` verbatim, but the Cline gateway requires
 * the full slug (e.g. `cline-pass/glm-5.3` or `z-ai/glm-5.3-flash`). Returns
 * undefined (no change) for payloads that are not a plain object.
 */
export function withClinePassWireModel(payload: unknown, model: { id: string; wireModel?: string }): unknown | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const p = payload as Record<string, unknown>;
	if (typeof p.model !== "string") return undefined;
	const full = clinePassWireModelId(model);
	if (full === p.model) return undefined;
	return { ...p, model: full };
}

/**
 * Refresh a Cline OAuth credential via the Cline token-refresh endpoint.
 * Returns a new OAuthCredential with rotated tokens. Throws on failure
 * (invalid_grant, network, 5xx) — pi-ai preserves the stored credential on
 * throw so the next request retries.
 */
export async function refreshClinePassCredential(
	credential: OAuthCredential,
	options: { apiBaseUrl?: string; signal?: AbortSignal } = {},
): Promise<OAuthCredential> {
	const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_CLINE_API_BASE_URL;
	const url = clineRefreshUrl(apiBaseUrl);
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ refreshToken: credential.refresh, grantType: "refresh_token" }),
		signal: options.signal,
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Cline token refresh failed: ${response.status}${text ? ` - ${text.slice(0, 300)}` : ""}`);
	}
	const json = (await response.json()) as any;
	const data = json?.data;
	const accessToken = typeof data?.accessToken === "string" ? data.accessToken : "";
	if (!accessToken) throw new Error("Cline token refresh response did not include an access token");
	const refreshToken = typeof data?.refreshToken === "string" && data.refreshToken ? data.refreshToken : credential.refresh;
	const expires = typeof data?.expiresAt === "string" ? Date.parse(data.expiresAt) : credential.expires;
	return {
		type: "oauth",
		// The gateway returns the raw JWT; normalize to the prefixed form the
		// Bearer header expects (idempotent if it ever returns prefixed).
		access: withWorkosPrefix(accessToken),
		refresh: refreshToken,
		expires: Number.isFinite(expires) ? expires : credential.expires,
		accountId: typeof credential.accountId === "string" ? credential.accountId : undefined,
	};
}

/**
 * ClinePass model catalog. Model ids are the SHORT form (pi-ai sends them
 * verbatim); the wire model is rewritten to `cline-pass/<id>` by
 * withClinePassWireModel. Specs (contextWindow / maxTokens / pricing) are
 * mirrored from the Cline CLI catalog
 * (sdk/packages/llms/src/catalog/catalog.generated.ts "cline-pass" block).
 */
export interface ClinePassModelSpec {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/**
	 * The exact `model` value to send to the Cline gateway. Defaults to
	 * `cline-pass/<id>`. Set for non-ClinePass models served through the same
	 * Cline credential (e.g. `z-ai/glm-5.3-flash`).
	 */
	wireModel?: string;
	/**
	 * Input modalities. Defaults to `["text"]`. Set to `["text", "image"]` for
	 * multimodal models (Cline lists glm-5.3-flash as images+video).
	 */
	input?: ("text" | "image")[];
}

export const CLINE_PASS_MODELS: ClinePassModelSpec[] = [
	{ id: "glm-5.3", name: "GLM-5.3", contextWindow: 1048576, maxTokens: 131072, cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } },
	{ id: "glm-5.2", name: "GLM-5.2", contextWindow: 1048576, maxTokens: 262144, cost: { input: 1.19, output: 3.74, cacheRead: 0.221, cacheWrite: 0 } },
	{ id: "kimi-k3", name: "Kimi K3", contextWindow: 1048576, maxTokens: 943718, cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0 } },
	{ id: "kimi-k2.7-code", name: "Kimi K2.7 Code", contextWindow: 262144, maxTokens: 235929, cost: { input: 0.66, output: 3.4, cacheRead: 0.18, cacheWrite: 0 } },
	{ id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 262144, maxTokens: 235929, cost: { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0 } },
	{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1048576, maxTokens: 384000, cost: { input: 0.87, output: 1.74, cacheRead: 0.0725, cacheWrite: 0 } },
	{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindow: 1048576, maxTokens: 384000, cost: { input: 0.088606, output: 0.177212, cacheRead: 0.017721, cacheWrite: 0 } },
	{ id: "mimo-v2.5-pro", name: "MiMo-V2.5-Pro", contextWindow: 1050000, maxTokens: 131072, cost: { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 } },
	{ id: "mimo-v2.5", name: "MiMo-V2.5", contextWindow: 1050000, maxTokens: 131072, cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } },
	{ id: "minimax-m3", name: "MiniMax-M3", contextWindow: 1048576, maxTokens: 512000, cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 } },
	{ id: "qwen3.8-max", name: "Qwen3.8 Max", contextWindow: 1000000, maxTokens: 131072, cost: { input: 2.0, output: 6.0, cacheRead: 0.25, cacheWrite: 2.5 } },
	{ id: "qwen3.7-max", name: "Qwen3.7 Max", contextWindow: 1000000, maxTokens: 131072, cost: { input: 1.475, output: 4.425, cacheRead: 0.295, cacheWrite: 1.84375 } },
	{ id: "qwen3.7-plus", name: "Qwen3.7 Plus", contextWindow: 1000000, maxTokens: 131072, cost: { input: 0.32, output: 1.28, cacheRead: 0.064, cacheWrite: 0.4 } },
	// Served through the same Cline credential but billed as a regular Cline
	// gateway model (not a ClinePass subscription model), so it keeps its own
	// `z-ai/...` slug on the wire. Specs mirror the Cline catalog
	// (sdk/packages/llms/src/catalog/catalog.generated.ts "z-ai/glm-5.3-flash").
	{ id: "z-ai/glm-5.3-flash", name: "GLM-5.3 Flash (Cline)", contextWindow: 1310720, maxTokens: 131072, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, wireModel: "z-ai/glm-5.3-flash", input: ["text", "image"] },
];

function clinePassModels(apiBaseUrl: string): Model<Api>[] {
	const baseUrl = clineGatewayBaseUrl(apiBaseUrl);
	return CLINE_PASS_MODELS.map((spec) => ({
		id: spec.id,
		name: spec.name,
		api: "openai-completions" as Api,
		provider: CLINE_PASS_PROVIDER_ID,
		baseUrl,
		reasoning: true,
		input: (spec.input ?? ["text"]) as ("text" | "image")[],
		cost: spec.cost,
		contextWindow: spec.contextWindow,
		maxTokens: spec.maxTokens,
		wireModel: spec.wireModel,
	}));
}

/**
 * Build the ClinePass pi-ai provider. `auth.oauth.toAuth` derives the Bearer
 * key from the stored credential (the `workos:`-prefixed access token, verbatim);
 * `auth.oauth.refresh` calls the Cline refresh endpoint. pi-ai runs refresh
 * under the credential-store lock and persists the rotated credential.
 */
export function createClinePassProvider(options: { apiBaseUrl?: string } = {}): ReturnType<typeof createProvider> {
	const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_CLINE_API_BASE_URL;
	const apiImpl = getApiProvider("openai-completions") as unknown as ProviderStreams | undefined;
	if (!apiImpl) throw new Error('pi-ai: no API implementation registered for "openai-completions" (import "@earendil-works/pi-ai/compat" first)');
	return createProvider({
		id: CLINE_PASS_PROVIDER_ID,
		name: "ClinePass",
		baseUrl: clineGatewayBaseUrl(apiBaseUrl),
		auth: {
			oauth: {
				name: "ClinePass (Cline OAuth)",
				isSubscription: true,
				loginLabel: "Sign in with ClinePass",
				// Not used by pi-janus (login is done by the Cline CLI); present
				// to satisfy the OAuthAuth contract.
				login: async () => {
					throw new Error("ClinePass login is performed by the Cline CLI (`cline auth cline-pass`), not pi-janus");
				},
				refresh: (credential, signal) => refreshClinePassCredential(credential, { apiBaseUrl, signal }),
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		models: clinePassModels(apiBaseUrl),
		api: apiImpl,
	});
}

/**
 * Register the ClinePass provider on `models` when a usable Cline credential is
 * present in the providers.json file. Returns true when registered.
 */
export function registerClinePass(
	models: MutableModels,
	options: { providersPath: string; apiBaseUrl?: string },
): boolean {
	const credential = readClineCredential(options.providersPath);
	if (!credential) return false;
	models.setProvider(createClinePassProvider({ apiBaseUrl: options.apiBaseUrl }));
	return true;
}

/** The wire-model override for a model, if it has one (else undefined). */
export function wireModelFor(model: { id: string; wireModel?: string }): string | undefined {
	return model.wireModel;
}
