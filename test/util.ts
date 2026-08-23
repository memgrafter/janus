/** Concatenate the `choices[0].delta.content` strings from an SSE body. */
export function extractContentDeltas(sse: string): string {
	let out = "";
	for (const line of sse.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const data = line.slice(6).trim();
		if (data === "[DONE]") continue;
		try {
			const obj = JSON.parse(data) as any;
			const delta = obj?.choices?.[0]?.delta?.content;
			if (typeof delta === "string") out += delta;
		} catch {
			// ignore non-JSON lines
		}
	}
	return out;
}
