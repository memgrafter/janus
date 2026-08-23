import { describe, expect, it } from "bun:test";
import { InMemoryTelemetry } from "../../src/telemetry.ts";

describe("InMemoryTelemetry", () => {
	it("records events in order with attrs", () => {
		const t = new InMemoryTelemetry();
		t.emit("a", { x: 1 });
		t.emit("b");
		const ev = t.events();
		expect(ev).toHaveLength(2);
		expect(ev[0].name).toBe("a");
		expect(ev[0].attrs).toEqual({ x: 1 });
		expect(ev[1].name).toBe("b");
		expect(ev[1].attrs).toEqual({});
	});

	it("filters by name", () => {
		const t = new InMemoryTelemetry();
		t.emit("quota.allowed", { bucket: "b1" });
		t.emit("quota.denied", { bucket: "b1" });
		t.emit("quota.allowed", { bucket: "b2" });
		expect(t.where("quota.allowed")).toHaveLength(2);
		expect(t.where("quota.denied")).toHaveLength(1);
	});

	it("caps the ring at the configured size", () => {
		const t = new InMemoryTelemetry(3);
		for (let i = 0; i < 5; i++) t.emit("e", { i });
		const ev = t.events();
		expect(ev).toHaveLength(3);
		expect(ev[0].attrs).toEqual({ i: 2 });
		expect(ev[2].attrs).toEqual({ i: 4 });
	});

	it("clears", () => {
		const t = new InMemoryTelemetry();
		t.emit("a");
		t.clear();
		expect(t.events()).toHaveLength(0);
	});
});
