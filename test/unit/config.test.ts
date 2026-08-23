import { describe, expect, it } from "bun:test";
import { loadConfig } from "../../src/config.ts";

describe("loadConfig", () => {
	it("uses defaults", () => {
		const c = loadConfig({});
		expect(c.host).toBe("127.0.0.1");
		expect(c.port).toBe(8787);
		expect(c.token).toBeUndefined();
		expect(c.faux).toBe(false);
		expect(c.fauxResponse).toBe("pi-janus faux ok");
	});

	it("reads env overrides", () => {
		const c = loadConfig({ PI_JANUS_PORT: "9999", PI_JANUS_FAUX: "1", PI_JANUS_TOKEN: "secret", PI_JANUS_FAUX_RESPONSE: "hi" });
		expect(c.port).toBe(9999);
		expect(c.faux).toBe(true);
		expect(c.token).toBe("secret");
		expect(c.fauxResponse).toBe("hi");
	});

	it("falls back on invalid port", () => {
		const c = loadConfig({ PI_JANUS_PORT: "not-a-number" });
		expect(c.port).toBe(8787);
	});

	it("reads the provider timeout in seconds (default 600, clamped 0-99999)", () => {
		expect(loadConfig({}).requestTimeoutS).toBe(600);
		expect(loadConfig({ PI_JANUS_TIMEOUT_S: "30" }).requestTimeoutS).toBe(30);
		expect(loadConfig({ PI_JANUS_TIMEOUT_S: "0" }).requestTimeoutS).toBe(0);
		expect(loadConfig({ PI_JANUS_TIMEOUT_S: "99999" }).requestTimeoutS).toBe(99999);
		expect(loadConfig({ PI_JANUS_TIMEOUT_S: "100000" }).requestTimeoutS).toBe(99999); // clamped high
		expect(loadConfig({ PI_JANUS_TIMEOUT_S: "-5" }).requestTimeoutS).toBe(0); // clamped low
		expect(loadConfig({ PI_JANUS_TIMEOUT_S: "not-a-number" }).requestTimeoutS).toBe(600); // fallback
	});
});
