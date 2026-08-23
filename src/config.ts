export interface Config {
	host: string;
	port: number;
	/** When set, requests must carry `Authorization: Bearer <token>`. */
	token?: string;
	/** Per-request provider timeout in milliseconds. */
	requestTimeoutMs: number;
	/** Use the scripted faux provider instead of real providers (tests / demos). */
	faux: boolean;
	/** Response text returned by the faux provider. */
	fauxResponse: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
	return {
		host: env["PI_JANUS_HOST"] ?? "127.0.0.1",
		port: intEnv(env["PI_JANUS_PORT"], 8787),
		token: env["PI_JANUS_TOKEN"] || undefined,
		requestTimeoutMs: intEnv(env["PI_JANUS_TIMEOUT_MS"], 120_000),
		faux: env["PI_JANUS_FAUX"] === "1" || env["PI_JANUS_FAUX"] === "true",
		fauxResponse: env["PI_JANUS_FAUX_RESPONSE"] ?? "pi-janus faux ok",
	};
}

function intEnv(value: string | undefined, fallback: number): number {
	if (value === undefined || value === "") return fallback;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : fallback;
}
