/**
 * Transport layer: SSE framing and JSON response headers.
 * Decoupled from any specific OpenAI message shape.
 */

export function sseHeaders(): Record<string, string> {
	return {
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
	return { "Content-Type": "application/json" };
}

export function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: jsonHeaders() });
}
