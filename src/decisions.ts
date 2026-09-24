/**
 * Decision routing for the djev API (POST /v1/systemone).
 *
 * Jev's /v1/systemone is a proprietary decision endpoint (not OpenAI Chat
 * Completions), so it can't ride janus's model/provider pipeline. Instead this
 * is a thin, transparent decision router: a decisions.json file maps decision
 * model names to /v1/systemone upstreams, and the server's /v1/systemone route
 * forwards the request verbatim to the upstream named by the body's `model`
 * field. Responses are teed into telemetry so the proxy is the measurement
 * choke point for decision sources (latency + success/failure per model).
 *
 * decisions.json shape:
 * {
 *   "decisions": {
 *     "djev":     { "baseUrl": "http://127.0.0.1:8011" },
 *     "gliner2":  { "baseUrl": "http://127.0.0.1:8098" },
 *     "jev-prod": { "baseUrl": "https://api.typesafe.ai", "apiKey": "$TYPESAFE_API_KEY", "model": "jev-latest" },
 *     "kev":      { "baseUrl": "http://127.0.0.1:8009", "model": "kev-latest" }
 *   }
 * }
 *
 * Sources are any TypeSafe-compatible /v1/systemone server: the hosted Jev
 * API, the local djev/gliner2 routers, or kev (github.com/jaredpalmer/kev),
 * which is a drop-in Jev implementation (its kev.serve exposes the same API
 * behind `model: "kev-latest"`).
 *
 * `model` in the request body selects the decision. The forwarded body is
 * unchanged unless the source sets a `model` override (then the body's `model`
 * field is rewritten to that value — e.g. the hosted API expects `jev-latest`).
 */

import { readFileSync } from "node:fs";

export interface DecisionSource {
	/** Upstream base URL (no trailing /v1/systemone). */
	baseUrl: string;
	/** Optional API key: "$ENV_VAR" -> env value, otherwise literal. */
	apiKey?: string;
	/** Extra static headers merged into the forwarded request. */
	headers?: Record<string, string>;
	/**
	 * If set, the request's `model` field is rewritten to this value before
	 * forwarding (the proxy name is the routing key; the upstream may expect a
	 * different model name, e.g. `jev-latest` on the hosted API).
	 */
	model?: string;
}

export interface DecisionsConfig {
	decisions: Record<string, DecisionSource>;
}

/** Resolve a "$ENV_VAR" apiKey to its env value, or pass a literal through. */
function resolveApiKey(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	if (raw.startsWith("$")) return process.env[raw.slice(1)];
	return raw;
}

/** Load + parse a decisions.json file. Missing file -> empty (route inert). */
export function loadDecisions(path?: string): DecisionsConfig {
	if (!path) return { decisions: {} };
	const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	const decisions: Record<string, DecisionSource> = {};
	for (const [name, cfg] of Object.entries((raw.decisions ?? {}) as Record<string, Record<string, unknown>>)) {
		const baseUrl = typeof cfg.baseUrl === "string" ? cfg.baseUrl : undefined;
		if (!baseUrl) {
			console.error(`pi-janus: skipping decision "${name}": baseUrl required`);
			continue;
		}
		decisions[name] = {
			baseUrl: (resolveApiKey(baseUrl) ?? baseUrl).replace(/\/$/, ""),
			apiKey: resolveApiKey(typeof cfg.apiKey === "string" ? cfg.apiKey : undefined),
			headers: cfg.headers as Record<string, string> | undefined,
			model: typeof cfg.model === "string" ? cfg.model : undefined,
		};
	}
	return { decisions };
}

export interface RoutedDecision {
	model: string;
	status: number;
	durationMs: number;
}

/**
 * Forward a /v1/systemone request to the upstream named by `model`. Returns the
 * upstream's response unchanged (status + body + content-type). `onRouted` is
 * invoked with outcome + duration so the caller can record telemetry.
 */
export async function routeDecision(
	body: string,
	model: string,
	config: DecisionsConfig,
	timeoutMs: number,
	onRouted: (r: RoutedDecision) => void,
): Promise<Response> {
	const start = Date.now();
	const note = (status: number) => onRouted({ model, status, durationMs: Date.now() - start });

	const source = config.decisions[model];
	if (!source) {
		note(404);
		return jsonError(404, `unknown decision model "${model}"; available: ${Object.keys(config.decisions).join(", ")}`);
	}

	const headers: Record<string, string> = { "content-type": "application/json", ...(source.headers ?? {}) };
	if (source.apiKey) headers["authorization"] = `Bearer ${source.apiKey}`;

	// Rewrite the model field when this source maps to a different upstream name.
	let fwd = body;
	if (source.model) {
		try {
			const parsed = JSON.parse(body) as Record<string, unknown>;
			parsed.model = source.model;
			fwd = JSON.stringify(parsed);
		} catch {
			// non-JSON body: forward unchanged
		}
	}

	try {
		const res = await fetch(`${source.baseUrl}/v1/systemone`, {
			method: "POST",
			headers,
			body: fwd,
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await res.text();
		note(res.status);
		return new Response(text, {
			status: res.status,
			headers: {
				"content-type": res.headers.get("content-type") ?? "application/json",
			},
		});
	} catch (e) {
		note(502);
		const message = e instanceof Error ? e.message : String(e);
		return jsonError(502, `decision upstream "${model}" failed: ${message}`);
	}
}

function jsonError(status: number, message: string): Response {
	return new Response(
		JSON.stringify({ error: { message, type: status === 404 ? "invalid_request_error" : "upstream_error", code: null } }),
		{ status, headers: { "content-type": "application/json" } },
	);
}
