/**
 * pi-ai client layer: own the Models collection and resolve requested model
 * ids to concrete pi-ai Models.
 */

import { createModels, fauxAssistantMessage, fauxProvider, type Api, type Model, type Models, type MutableModels } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ClineCredentialStore } from "./cline-credentials.ts";
import { CLINE_PASS_PROVIDER_ID, registerClinePass } from "./cline-pass.ts";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { registerZcode, zcodeDeps } from "./zcode.ts";
import { registerModelsJson } from "./custom-providers.ts";
import { FileCredentialStore, RoutingCredentialStore } from "./credentials.ts";
import type { Config } from "./config.ts";

export interface Client {
	models: Models;
	/** Resolve a requested model id ("provider/model" or "model") to a Model. Throws if unknown. */
	resolveModel(modelId: string): Model<Api>;
}

export async function createClient(config: Config): Promise<Client> {
	// Statically embed the OAuth flows (openai-codex, github-copilot, xai, ...) so
	// they resolve in the compiled binary. pi-ai normally loads them via a
	// bundler-opaque dynamic relative import that `bun build --compile` cannot
	// resolve at runtime; registerBunOAuthFlows() replaces that with statically
	// bundled loaders. Idempotent; a no-op in source mode where the dynamic import
	// already works.
	registerBunOAuthFlows();
	const authStore = new FileCredentialStore(config.authJsonPath, config.authNoLock);
	// A single Models collection has one credential store. Route the cline-pass
	// provider to the Cline CLI's providers.json and everything else to auth.json
	// so a cline-pass token refresh persists the rotated tokens back to
	// providers.json (in sync with the Cline CLI) instead of auth.json.
	const clineStore = new ClineCredentialStore(config.clineProvidersPath, config.authNoLock);
	const credentials = config.clinePass
		? new RoutingCredentialStore(authStore, { [CLINE_PASS_PROVIDER_ID]: clineStore })
		: authStore;
	const models: MutableModels = config.faux
		? fauxModels(config)
		: builtinModels({ credentials });
	if (config.modelsJsonPath) {
		const registered = registerModelsJson(models, config.modelsJsonPath);
		if (registered.length > 0) console.log(`pi-janus: registered custom providers: ${registered.join(", ")}`);
	}
	if (config.clinePass) {
		// Register the ClinePass provider only when a usable Cline credential is
		// present in providers.json.
		const clineModels = createModels({ credentials: clineStore });
		if (registerClinePass(clineModels, { providersPath: config.clineProvidersPath, apiBaseUrl: config.clineApiBaseUrl })) {
			const cp = clineModels.getProvider(CLINE_PASS_PROVIDER_ID);
			if (cp) {
				models.setProvider(cp);
				console.log("pi-janus: registered ClinePass provider (Cline OAuth)");
			}
		}
	}
	if (config.zcode) {
		// ZCode (Z.AI GLM) providers: credentials live in zcode.conf (hot-read).
		// Both providers are always registered; each is available (listed by
		// /v1/models) only while its credential is present in the conf, so
		// adding/rotating credentials needs no restart. The Coding Plan provider
		// wraps pi-ai's anthropic-messages impl with the ZCode fingerprint
		// headers + captcha-aware fetch; the API-key provider uses the stock impl
		// with x-api-key auth.
		const baseApi = getApiProvider("anthropic-messages");
		if (!baseApi) throw new Error('pi-ai: no API implementation registered for "anthropic-messages"');
		const deps = zcodeDeps(config.zcodeConfPath);
		const registered = registerZcode(models, baseApi, deps);
		console.log(`pi-janus: registered ZCode providers: ${registered.join(", ")} (zcode.conf: ${config.zcodeConfPath})`);
	}
	return { models, resolveModel: (id) => resolveModel(models, id) };
}

function fauxModels(config: Config): MutableModels {
	const faux = fauxProvider({
		models: [{ id: "faux", name: "Faux Model", contextWindow: 8192, maxTokens: 2048 }],
	});
	// The faux provider is a finite one-shot queue (one response per request). Queue a
	// generous number so the always-respond demo/test mode serves many requests.
	faux.setResponses(Array.from({ length: 10_000 }, () => fauxAssistantMessage(config.fauxResponse)));
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}

export function resolveModel(models: Models, modelId: string): Model<Api> {
	// "provider/model" form
	const slash = modelId.indexOf("/");
	if (slash > 0) {
		const provider = modelId.slice(0, slash);
		const id = modelId.slice(slash + 1);
		const m = models.getModel(provider, id);
		if (m) return m;
	}
	// plain id: search across providers
	for (const m of models.getModels()) {
		if (m.id === modelId) return m;
	}
	const available = models
		.getModels()
		.map((m) => `${m.provider}/${m.id}`)
		.join(", ");
	throw new Error(`Unknown model "${modelId}". Available: ${available}`);
}
