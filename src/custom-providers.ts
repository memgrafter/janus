/**
 * Load custom providers from a pi models.json file (e.g. ~/.pi/agent/models.json)
 * and register them as pi-ai providers. Uses pi-ai's createProvider + the compat
 * API registry (getApiProvider) — no dependency on the coding-agent package.
 *
 * Importing getApiProvider from "@earendil-works/pi-ai/compat" also registers the
 * built-in API implementations (openai-completions, etc.) at module load.
 */

import {
	createProvider,
	type Api,
	type Model,
	type MutableModels,
	type Provider,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { readFileSync } from "node:fs";

interface ModelsJsonModel {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
	samplingParams?: Record<string, unknown>;
	compat?: Record<string, unknown>;
	/**
	 * Optional: the exact `model` value to send to the upstream, when it differs
	 * from this model's id (e.g. id "qwen-3.8-27b-free" -> wire "qwen-3.8-27b").
	 * pi-ai sends model.id verbatim, so the server rewrites the payload via the
	 * wireModel onPayload hook. Omitted = send the id unchanged.
	 */
	wireModel?: string;
}

interface ModelsJsonProvider {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	models?: ModelsJsonModel[];
}

interface ModelsJson {
	providers?: Record<string, ModelsJsonProvider>;
}

/** Resolve a models.json apiKey: "$ENV_VAR" -> env value, otherwise a literal. */
function resolveApiKey(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	if (raw.startsWith("$")) return process.env[raw.slice(1)];
	return raw;
}

/**
 * Auth resolution for a custom provider: a stored credential in the credential
 * store (auth.json) wins, then the catalog apiKey ("$ENV_VAR" -> env value,
 * otherwise a literal). The store is reread per request, so a key added to or
 * changed in auth.json takes effect without a restart (hot reload); the env
 * var and catalog literal remain backward-compatible fallbacks.
 */
function storedOrCatalogApiKey(credential: { key?: string } | undefined, rawKey: string | undefined): { key: string; source: string } | undefined {
	if (credential?.key) return { key: credential.key, source: "auth.json" };
	const key = resolveApiKey(rawKey);
	if (key === undefined) return undefined;
	return { key, source: "models.json" };
}

function modelFromJson(providerId: string, def: ModelsJsonModel, cfg: ModelsJsonProvider): Model<Api> {
	const api = (def.api ?? cfg.api) as Api | undefined;
	if (!api) throw new Error(`provider "${providerId}", model "${def.id}": no "api" specified`);
	const baseUrl = def.baseUrl ?? cfg.baseUrl;
	if (!baseUrl) throw new Error(`provider "${providerId}": "baseUrl" is required`);
	// wireModel is a janus-internal alias (not a pi-ai Model field), so attach it
	// via a cast — the server's wireModel onPayload hook reads it back.
	return {
		id: def.id,
		name: def.name ?? def.id,
		api,
		provider: providerId,
		baseUrl,
		reasoning: def.reasoning ?? false,
		input: (def.input ?? ["text"]) as ("text" | "image")[],
		cost: def.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: def.contextWindow ?? 128000,
		maxTokens: def.maxTokens ?? 16384,
		samplingParams: def.samplingParams,
		compat: { ...cfg.compat, ...def.compat } as Model<Api>["compat"],
		...(def.wireModel ? { wireModel: def.wireModel } : {}),
	} as Model<Api>;
}

function providerFromJson(providerId: string, cfg: ModelsJsonProvider): Provider {
	const api = cfg.api as Api | undefined;
	if (!api) throw new Error(`provider "${providerId}": no "api" specified`);
	const apiImpl = getApiProvider(api);
	if (!apiImpl) throw new Error(`provider "${providerId}": no API implementation registered for "${api}"`);
	const models = (cfg.models ?? []).map((m) => modelFromJson(providerId, m, cfg));
	const rawKey = cfg.apiKey;
	return createProvider({
		id: providerId,
		name: cfg.name ?? providerId,
		baseUrl: cfg.baseUrl,
		headers: cfg.headers,
		auth: {
			apiKey: {
				name: "API key",
				resolve: async ({ credential }) => {
					const resolved = storedOrCatalogApiKey(credential, rawKey);
					if (resolved === undefined) return undefined;
					return { auth: { apiKey: resolved.key }, source: resolved.source };
				},
			},
		},
		models,
		api: apiImpl as ProviderStreams,
	});
}

/**
 * Rewrite a request payload's `model` field to the model's `wireModel` when it
 * differs from the id. pi-ai sends model.id verbatim, so this is how a
 * janus-facing id (e.g. "qwen-3.8-27b-free") maps to a different upstream id
 * (e.g. "qwen-3.8-27b"). Returns undefined (no change) when the model has no
 * wireModel, it already matches, or the payload is not a plain object.
 */
export function withWireModel(payload: unknown, model: { wireModel?: string }): unknown | undefined {
	const wire = model.wireModel;
	if (!wire) return undefined;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const p = payload as Record<string, unknown>;
	if (typeof p.model !== "string" || p.model === wire) return undefined;
	return { ...p, model: wire };
}

/**
 * Load custom providers from a models.json file and register them on `models`.
 * Returns the ids registered. Providers with no models, no api, or an unknown api
 * are skipped (with a warning) rather than fatal.
 */
export function registerModelsJson(models: MutableModels, path: string): string[] {
	const raw = JSON.parse(readFileSync(path, "utf8")) as ModelsJson;
	const registered: string[] = [];
	for (const [providerId, cfg] of Object.entries(raw.providers ?? {})) {
		try {
			if (!cfg.models?.length) continue;
			models.setProvider(providerFromJson(providerId, cfg));
			registered.push(providerId);
		} catch (e) {
			console.error(`pi-janus: skipping provider "${providerId}": ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return registered;
}
