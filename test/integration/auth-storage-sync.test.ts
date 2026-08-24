import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "../../src/credentials.ts";
import type { Credential } from "@earendil-works/pi-ai";

/**
 * Cross-package sync test: pi-janus's FileCredentialStore must stay format-compatible
 * with pi's coding-agent AuthStorage, because they share the SAME auth.json file.
 *
 * We import coding-agent's AuthStorage BY SOURCE PATH (bun runs TS natively; its
 * proper-lockfile dep resolves from coding-agent's own node_modules). If the
 * pi-mono worktree isn't present, the whole suite skips so a fresh clone stays green.
 *
 * The invariant we guard: for the same mock refresh-token data, both stores must
 * (a) produce byte-identical on-disk output, and (b) read back what the other wrote.
 */

const CODEX_AUTH_STORAGE =
	"/Users/trentrobbins/clones/pi-mono-dev/packages/coding-agent/src/core/auth-storage.ts";

const hasWorktree = existsSync(CODEX_AUTH_STORAGE);

/** Minimal surface of coding-agent's AuthStorage that this test exercises. */
interface CodexAuthStorage {
	create(path: string): {
		read(providerId: string): Promise<Credential | undefined>;
		modify(
			providerId: string,
			fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		): Promise<Credential | undefined>;
	};
}

// Import is top-level per repo convention. It only resolves when the pi-mono
// worktree is present AND its node_modules are installed (bun test does not fall
// back to the global cache the way `bun run` does). If either is missing, we skip
// the whole suite so a fresh clone / CI stays green.
let AuthStorage: CodexAuthStorage | undefined;
try {
	if (hasWorktree) AuthStorage = (await import(CODEX_AUTH_STORAGE)).AuthStorage;
} catch {
	AuthStorage = undefined;
}

const skipReason = !hasWorktree
	? "pi-mono worktree not present"
	: !AuthStorage
		? "pi-mono worktree node_modules not installed (run `bun install` in the worktree)"
		: undefined;

describe.skipIf(Boolean(skipReason))(`auth.json format sync with pi coding-agent${skipReason ? ` [SKIP: ${skipReason}]` : ""}`, () => {
	// skipReason is undefined only when AuthStorage resolved, so this is safe.
	const AS = AuthStorage!;

	function tempAuthPath(): string {
		return join(mkdtempSync(join(tmpdir(), "janus-sync-")), "auth.json");
	}

	const MOCK: Credential = {
		type: "oauth",
		access: "ACCESS_TOKEN_1",
		refresh: "REFRESH_TOKEN_1",
		expires: Date.now() + 3_600_000,
		accountId: "acct-1",
	} as Credential;

	const ROTATED: Credential = {
		type: "oauth",
		access: "ACCESS_TOKEN_2",
		refresh: "REFRESH_TOKEN_2",
		expires: Date.now() + 3_600_000,
		accountId: "acct-1",
	} as Credential;

	it("produces byte-identical on-disk output for the same refresh data", async () => {
		const expected = tempAuthPath();
		const actual = tempAuthPath();
		// Seed both with the same pre-refresh state.
		const seed = JSON.stringify({ "openai-codex": MOCK }, null, 2);
		writeFileSync(expected, seed);
		writeFileSync(actual, seed);

		// coding-agent's store performs the refresh (the reference implementation).
		await AS.create(expected).modify("openai-codex", async () => ROTATED);
		// pi-janus's store performs the same refresh.
		await new FileCredentialStore(actual).modify("openai-codex", async () => ROTATED);

		expect(readFileSync(actual, "utf-8")).toBe(readFileSync(expected, "utf-8"));
	});

	it("reads back what coding-agent wrote", async () => {
		const path = tempAuthPath();
		writeFileSync(path, JSON.stringify({ "openai-codex": MOCK }, null, 2));
		// coding-agent writes a refresh.
		await AS.create(path).modify("openai-codex", async () => ROTATED);
		// pi-janus reads it.
		const c = await new FileCredentialStore(path).read("openai-codex");
		expect(c).toEqual(ROTATED);
	});

	it("coding-agent reads back what pi-janus wrote", async () => {
		const path = tempAuthPath();
		writeFileSync(path, JSON.stringify({ "openai-codex": MOCK }, null, 2));
		// pi-janus writes a refresh.
		await new FileCredentialStore(path).modify("openai-codex", async () => ROTATED);
		// coding-agent reads it.
		const c = await AS.create(path).read("openai-codex");
		expect(c).toEqual(ROTATED);
	});

	it("both stores serialize a concurrent refresh against the same file (no lost update)", async () => {
		const path = tempAuthPath();
		writeFileSync(path, JSON.stringify({ "openai-codex": MOCK }, null, 2));
		const janus = new FileCredentialStore(path);
		const codex = AS.create(path);
		// Two independent store instances (different processes in reality) refresh
		// concurrently; the cross-process lock must serialize them.
		await Promise.all([
			janus.modify("openai-codex", async (cur) => ({
				type: "oauth",
				access: (cur as { access: string }).access + "A",
				refresh: (cur as { refresh: string }).refresh,
				expires: (cur as { expires: number }).expires,
			} as Credential)),
			codex.modify("openai-codex", async (cur) => ({
				type: "oauth",
				access: (cur as { access: string }).access + "B",
				refresh: (cur as { refresh: string }).refresh,
				expires: (cur as { expires: number }).expires,
			} as Credential)),
		]);
		const c = await janus.read("openai-codex");
		expect((c as { access: string }).access).toMatch(/^ACCESS_TOKEN_1[AB][AB]$/);
	});
});
