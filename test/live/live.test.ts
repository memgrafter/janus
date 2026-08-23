import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { extractContentDeltas } from "../util.ts";

// The live test runs the BUILT BINARY (output of scripts/build.sh) as a local
// process. It must be built first (scripts/test.sh does this).
const BINARY = new URL("../../dist/pi-janus", import.meta.url).pathname;
const PORT = 18923;
const ROOT = `http://127.0.0.1:${PORT}`;
const BASE = `${ROOT}/v1`;

let proc: Bun.Subprocess;

async function waitReady(deadlineMs: number): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${ROOT}/health`);
			if (r.ok) return;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("server did not become ready in time");
}

beforeAll(async () => {
	if (!(await Bun.file(BINARY).exists())) throw new Error(`built binary not found at ${BINARY}; run scripts/build.sh first`);
	proc = Bun.spawn([BINARY], {
		env: { ...process.env, PI_JANUS_FAUX: "1", PI_JANUS_PORT: String(PORT), PI_JANUS_FAUX_RESPONSE: "live faux ok" },
		stdout: "pipe",
		stderr: "pipe",
	});
	await waitReady(15_000);
});

afterAll(() => {
	proc?.kill("SIGTERM");
});

describe("live (built binary, local process)", () => {
	it("serves /v1/models", async () => {
		const body = (await (await fetch(`${BASE}/models`)).json()) as any;
		expect(body.object).toBe("list");
		expect(body.data.some((m: any) => m.id === "faux/faux")).toBe(true);
	});

	it("completes a non-stream chat", async () => {
		const body = (
			await (
				await fetch(`${BASE}/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ model: "faux/faux", messages: [{ role: "user", content: "hi" }] }),
				})
			).json()
		) as any;
		expect(body.object).toBe("chat.completion");
		expect(body.choices[0].message.content).toBe("live faux ok");
	});

	it("streams a chat to [DONE]", async () => {
		const res = await fetch(`${BASE}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "faux/faux", messages: [{ role: "user", content: "hi" }], stream: true }),
		});
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const text = await res.text();
		expect(extractContentDeltas(text)).toBe("live faux ok");
		expect(text.trim().endsWith("data: [DONE]")).toBe(true);
	});
});
