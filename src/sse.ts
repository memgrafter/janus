/**
 * Transport layer: SSE framing and JSON response headers.
 * Decoupled from any specific OpenAI message shape.
 */

/**
 * CORS headers for browser clients (e.g. the sitegeist extension).
 * Janus is a LAN proxy authenticated by bearer token, so a static `*` is safe:
 * the token, not the origin, is the credential. Applied to every response so
 * browsers can read errors (401/404/500) and stream SSE cross-origin.
 */
export function corsHeaders(extra?: Record<string, string>): Record<string, string> {
	return { "Access-Control-Allow-Origin": "*", ...extra };
}

export function sseHeaders(): Record<string, string> {
	return {
		...corsHeaders(),
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	};
}

export function sseData(data: unknown): string {
	return `data: ${JSON.stringify(data)}\n\n`;
}

export function sseDone(): string {
	return "data: [DONE]\n\n";
}

export function jsonHeaders(): Record<string, string> {
	return { ...corsHeaders(), "Content-Type": "application/json" };
}

export function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: jsonHeaders() });
}
