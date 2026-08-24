import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore, DEFAULT_AUTH_PATH } from "../../src/credentials.ts";
import type { Credential } from "@earendil-works/pi-ai";

function tempAuthPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "janus-auth-"));
	return join(dir, "auth.json");
}

const OAUTH: Credential = {
	type: "oauth",
	access: "ACCESS_1",
	refresh: "REFRESH_1",
	expires: Date.now() + 3_600_000,
} as Credential;

describe("FileCredentialStore", () => {
	it("defaults to ~/.pi/agent/auth.json", () => {
		expect(DEFAULT_AUTH_PATH.endsWith(".pi/agent/auth.json")).toBe(true);
		expect(new FileCredentialStore().path).toBe(DEFAULT_AUTH_PATH);
	});

	it("expands a leading ~ in the path", () => {
		const store = new FileCredentialStore("~/x/auth.json");
		expect(store.path.startsWith("/")).toBe(true);
		expect(store.path.endsWith("x/auth.json")).toBe(true);
	});

	it("reads undefined when the file is missing (inert)", async () => {
		const store = new FileCredentialStore(tempAuthPath());
		expect(await store.read("openai-codex")).toBeUndefined();
		expect(await store.list()).toEqual([]);
	});

	it("reads a stored credential", async () => {
		const path = tempAuthPath();
		writeFileSync(path, JSON.stringify({ "openai-codex": OAUTH }, null, 2));
		const store = new FileCredentialStore(path);
		const c = await store.read("openai-codex");
		expect(c).toEqual(OAUTH);
		expect(await store.read("nope")).toBeUndefined();
	});

	it("modify persists a rotated token to disk in pi's format (2-space JSON, 0600)", async () => {
		const path = tempAuthPath();
		writeFileSync(path, JSON.stringify({ "openai-codex": OAUTH }, null, 2));
		const store = new FileCredentialStore(path);
		const rotated: Credential = {
			type: "oauth",
			access: "ACCESS_2",
			refresh: "REFRESH_2",
			expires: Date.now() + 3_600_000,
		} as Credential;
		const result = await store.modify("openai-codex", async () => rotated);
		expect(result).toEqual(rotated);
		// On-disk format matches coding-agent: JSON.stringify(merged, null, 2).
		expect(readFileSync(path, "utf-8")).toBe(JSON.stringify({ "openai-codex": rotated }, null, 2));
		// Mode 0600.
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("modify(fn -> undefined) leaves the file unchanged", async () => {
		const path = tempAuthPath();
		const before = JSON.stringify({ "openai-codex": OAUTH }, null, 2);
		writeFileSync(path, before);
		const store = new FileCredentialStore(path);
		const result = await store.modify("openai-codex", async () => undefined);
		expect(result).toEqual(OAUTH); // returns the current credential
		expect(readFileSync(path, "utf-8")).toBe(before);
	});

	it("modify adds a new provider without clobbering existing ones", async () => {
		const path = tempAuthPath();
		writeFileSync(path, JSON.stringify({ "openai-codex": OAUTH }, null, 2));
		const store = new FileCredentialStore(path);
		const other: Credential = { type: "api_key", key: "sk-1" } as Credential;
		await store.modify("xai", async () => other);
		const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, Credential>;
		expect(data["openai-codex"]).toEqual(OAUTH);
		expect(data["xai"]).toEqual(other);
	});

	it("delete removes only the named provider", async () => {
		const path = tempAuthPath();
		writeFileSync(path, JSON.stringify({ "openai-codex": OAUTH, xai: { type: "api_key", key: "k" } }, null, 2));
		const store = new FileCredentialStore(path);
		await store.delete("openai-codex");
		const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		expect(data["openai-codex"]).toBeUndefined();
		expect(data["xai"]).toEqual({ type: "api_key", key: "k" });
	});

	it("list returns provider metadata without secrets", async () => {
		const path = tempAuthPath();
		writeFileSync(path, JSON.stringify({ "openai-codex": OAUTH, xai: { type: "api_key", key: "k" } }, null, 2));
		const store = new FileCredentialStore(path);
		const list = await store.list();
		expect(list).toEqual([
			{ providerId: "openai-codex", type: "oauth" },
			{ providerId: "xai", type: "api_key" },
		]);
	});

	it("serializes concurrent modify calls (no lost update)", async () => {
		const path = tempAuthPath();
		writeFileSync(path, JSON.stringify({ "openai-codex": OAUTH }, null, 2));
		const store = new FileCredentialStore(path);
		// Two concurrent refreshes that each bump the access token based on the
		// current value. Without serialization one would be lost.
		await Promise.all([
			store.modify("openai-codex", async (cur) => ({
				type: "oauth",
				access: (cur as { access: string }).access + "A",
				refresh: (cur as { refresh: string }).refresh,
				expires: (cur as { expires: number }).expires,
			} as Credential)),
			store.modify("openai-codex", async (cur) => ({
				type: "oauth",
				access: (cur as { access: string }).access + "B",
				refresh: (cur as { refresh: string }).refresh,
				expires: (cur as { expires: number }).expires,
			} as Credential)),
		]);
		const c = await store.read("openai-codex");
		// Both mutations applied, in some order.
		expect((c as { access: string }).access).toMatch(/^ACCESS_1[AB][AB]$/);
		expect((c as { access: string }).access).not.toBe("ACCESS_1A");
		expect((c as { access: string }).access).not.toBe("ACCESS_1B");
	});

	it("respects an abort signal", async () => {
		const path = tempAuthPath();
		writeFileSync(path, JSON.stringify({ "openai-codex": OAUTH }, null, 2));
		const store = new FileCredentialStore(path);
		const ac = new AbortController();
		ac.abort();
		await expect(store.read("openai-codex", { signal: ac.signal })).rejects.toBeDefined();
	});

	it("creates the parent directory and an empty file on first write", async () => {
		const dir = mkdtempSync(join(tmpdir(), "janus-auth-"));
		const path = join(dir, "nested", "auth.json");
		expect(existsSync(path)).toBe(false);
		const store = new FileCredentialStore(path);
		await store.modify("openai-codex", async () => OAUTH);
		expect(existsSync(path)).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});
});
