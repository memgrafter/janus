import { describe, expect, it } from "bun:test";
import { Ledger } from "../../src/ledger.ts";
import { InMemoryTelemetry } from "../../src/telemetry.ts";

describe("Ledger", () => {
	it("allows when no bucket is configured (inert)", () => {
		const l = new Ledger([]);
		expect(l.check("anything").allowed).toBe(true);
		expect(l.check(undefined).allowed).toBe(true);
	});

	it("denies when the token quota would be exceeded", () => {
		const l = new Ledger([{ id: "b", limitTokens: 100 }]);
		l.record("b", { totalTokens: 90 });
		expect(l.check("b", 20).allowed).toBe(false); // 90 + 20 > 100
		expect(l.check("b", 10).allowed).toBe(true); // 90 + 10 <= 100
	});

	it("denies when the cost quota is exceeded", () => {
		const l = new Ledger([{ id: "b", limitCost: 1.0 }]);
		l.record("b", { totalTokens: 10, cost: { total: 1.0 } });
		expect(l.check("b").allowed).toBe(false);
	});

	it("folds rate-limit headers and denies at zero remaining", () => {
		const t = new InMemoryTelemetry();
		const l = new Ledger([{ id: "b" }], t);
		l.observeRateLimit("b", { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "60" });
		const res = l.check("b");
		expect(res.allowed).toBe(false);
		expect(res.reason).toContain("rate limited");
		expect(l.get("b")?.rateLimitRemaining).toBe(0);
		expect(l.get("b")?.rateLimitResetAt).toBeGreaterThan(Date.now());
		// observable via telemetry
		expect(t.where("quota.ratelimit")).toHaveLength(1);
		expect(t.where("quota.denied")).toHaveLength(1);
	});

	it("exposes deadlineMs per bucket", () => {
		const l = new Ledger([{ id: "b", deadlineMs: 5000 }]);
		expect(l.deadlineMs("b")).toBe(5000);
		expect(l.deadlineMs("nope")).toBeUndefined();
	});

	it("accumulates consumed tokens across records", () => {
		const l = new Ledger([{ id: "b", limitTokens: 1000 }]);
		l.record("b", { totalTokens: 100 });
		l.record("b", { totalTokens: 200 });
		expect(l.get("b")?.consumedTokens).toBe(300);
	});
});
