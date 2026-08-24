/**
 * pi-ai client layer: own the Models collection and resolve requested model
 * ids to concrete pi-ai Models.
 */

import { createModels, fauxAssistantMessage, fauxProvider, type Api, type Model, type Models, type MutableModels } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { registerModelsJson } from "./custom-providers.ts";
import { FileCredentialStore } from "./credentials.ts";
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
	const models: MutableModels = config.faux
		? fauxModels(config)
		: builtinModels({ credentials: new FileCredentialStore(config.authJsonPath) });
	if (config.modelsJsonPath) {
		const registered = registerModelsJson(models, config.modelsJsonPath);
		if (registered.length > 0) console.log(`pi-janus: registered custom providers: ${registered.join(", ")}`);
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
