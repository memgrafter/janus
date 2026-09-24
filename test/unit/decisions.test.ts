import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDecisions, routeDecision } from "../../src/decisions.ts";

const dir = join(tmpdir(), "janus-decisions-test");
beforeEach(() => mkdirSync(dir, { recursive: true }));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeConfig(json: string): string {
	const path = join(dir, "decisions.json");
	writeFileSync(path, json);
	return path;
}

describe("loadDecisions", () => {
	it("returns empty when no path", () => {
		expect(loadDecisions()).toEqual({ decisions: {} });
	});

	it("parses sources, resolves $ENV apiKey, strips trailing slash", () => {
		const path = writeConfig(
			JSON.stringify({
				decisions: {
					djev: { baseUrl: "http://127.0.0.1:8011/" },
					jev: { baseUrl: "https://api.typesafe.ai", apiKey: "$FOO_KEY", model: "jev-latest" },
				},
			}),
		);
		const orig = process.env.FOO_KEY;
		process.env.FOO_KEY = "secret";
		try {
			const cfg = loadDecisions(path);
			expect(cfg.decisions.djev).toEqual({ baseUrl: "http://127.0.0.1:8011" });
			expect(cfg.decisions.jev).toEqual({ baseUrl: "https://api.typesafe.ai", apiKey: "secret", model: "jev-latest" });
		} finally {
			if (orig === undefined) delete process.env.FOO_KEY;
			else process.env.FOO_KEY = orig;
		}
	});

	it("skips sources without a baseUrl (non-fatal)", () => {
		const path = writeConfig(JSON.stringify({ decisions: { broken: { apiKey: "x" }, ok: { baseUrl: "http://x" } } }));
		const logs: string[] = [];
		const origErr = console.error;
		console.error = (m: string) => logs.push(m);
		try {
			const cfg = loadDecisions(path);
			expect(Object.keys(cfg.decisions)).toEqual(["ok"]);
			expect(logs.some((l) => l.includes("broken"))).toBe(true);
		} finally {
			console.error = origErr;
		}
	});
});

describe("routeDecision", () => {
	const config = { decisions: { kev: { baseUrl: "http://127.0.0.1:8009", model: "kev-latest" }, plain: { baseUrl: "http://127.0.0.1:8011" } } };
	let fetched: { url: string; init: RequestInit } | undefined;
	const realFetch = globalThis.fetch;

	beforeEach(() => {
		fetched = undefined;
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			fetched = { url: String(url), init: init ?? {} };
			return new Response(JSON.stringify({ model: "kev-latest" }), { status: 200, headers: { "content-type": "application/json" } });
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("404s an unknown model and lists the available ones", async () => {
		const res = await routeDecision("{}", "nope", config, 1000, () => {});
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error.message).toContain("nope");
		expect(body.error.message).toContain("kev");
		expect(body.error.message).toContain("plain");
	});

	it("rewrites the body's model field when the source sets an override", async () => {
		const body = JSON.stringify({ model: "kev", state: "hi" });
		const res = await routeDecision(body, "kev", config, 1000, () => {});
		expect(res.status).toBe(200);
		expect(fetched!.url).toBe("http://127.0.0.1:8009/v1/systemone");
		expect(JSON.parse(fetched!.init.body as string)).toEqual({ model: "kev-latest", state: "hi" });
	});

	it("forwards the body verbatim when the source has no override", async () => {
		await routeDecision('{"model":"plain"}', "plain", config, 1000, () => {});
		expect(fetched!.url).toBe("http://127.0.0.1:8011/v1/systemone");
		expect(fetched!.init.body).toBe('{"model":"plain"}');
	});

	it("sends the upstream bearer key when set", async () => {
		const keyed = { decisions: { k: { baseUrl: "http://127.0.0.1:1", apiKey: "abc" } } };
		await routeDecision("{}", "k", keyed, 1000, () => {});
		expect((fetched!.init.headers as Record<string, string>).authorization).toBe("Bearer abc");
	});

	it("502s when the upstream fails", async () => {
		globalThis.fetch = (() => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const res = await routeDecision("{}", "plain", config, 1000, () => {});
		expect(res.status).toBe(502);
	});

	it("reports the routed outcome via onRouted", async () => {
		const notes: { model: string; status: number }[] = [];
		await routeDecision("{}", "kev", config, 1000, (r) => notes.push(r));
		expect(notes).toEqual([{ model: "kev", status: 200, durationMs: expect.any(Number) } as any]);
	});
});
