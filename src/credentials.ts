/**
 * File-backed CredentialStore for pi-janus, backed by pi's ~/.pi/agent/auth.json.
 *
 * pi-ai ships only an in-memory credential store and is deliberately
 * storage-agnostic (browser-safe, no fs). The file-backed, lock-protected store
 * is a coding-agent concern (see pi-mono packages/coding-agent/src/core/auth-storage.ts).
 * pi-janus sits below coding-agent and talks to pi-ai directly, so it provides
 * its own minimal CredentialStore to make OAuth/subscription providers
 * (openai-codex, github-copilot, xai) usable through the proxy.
 *
 * This is a minimal port of coding-agent's AuthStorage: same on-disk format
 * (JSON.stringify(merged, null, 2), mode 0600) and same proper-lockfile-based
 * cross-process locking, minus the revision cache / shared read state /
 * command-config key resolution that pi-janus does not need.
 *
 * Why the lock matters: OAuth refresh ROTATES the refresh token. pi and
 * pi-janus share one token in this file; without a cross-process lock, a
 * concurrent refresh in both processes would double-spend and invalidate the
 * other's token. proper-lockfile (pinned to coding-agent's version) closes that
 * window.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type AuthData = Record<string, Credential>;

const WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;
/** A lock older than this is considered stale (crashed holder) and is taken over. */
const STALE_MS = 30_000;
/** Cap on backoff delay between lock retries. */
const MAX_DELAY_MS = 2_000;

export const DEFAULT_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

/** Expand a leading `~` and resolve to an absolute path. */
function normalizePath(p: string): string {
	if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
	return resolve(p);
}

function stripBom(s: string): string {
	return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolvePromise, rejectPromise) => {
		if (signal?.aborted) {
			rejectPromise(signal.reason);
			return;
		}
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolvePromise();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			rejectPromise(signal!.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export class FileCredentialStore implements CredentialStore {
	private readonly authPath: string;
	private readonly noLock: boolean;

	constructor(authPath: string = DEFAULT_AUTH_PATH, noLock = false) {
		this.authPath = normalizePath(authPath);
		this.noLock = noLock;
	}

	get path(): string {
		return this.authPath;
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", WRITE_OPTIONS);
			chmodSync(this.authPath, 0o600);
		}
	}

	private parse(content: string | undefined): AuthData {
		if (!content) return {};
		const parsed: unknown = JSON.parse(stripBom(content));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return parsed as AuthData;
	}

	/**
	 * Acquire the cross-process lock, retrying with jittered backoff on ELOCKED
	 * until the stale deadline. Returns the release function.
	 */
	private async acquireLock(signal?: AbortSignal): Promise<() => Promise<void>> {
		const deadline = Date.now() + STALE_MS;
		let retry = 0;
		for (;;) {
			signal?.throwIfAborted();
			try {
				return await lockfile.lock(this.authPath, { realpath: false, retries: 0, stale: STALE_MS });
			} catch (error) {
				signal?.throwIfAborted();
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				const remaining = deadline - Date.now();
				if (code !== "ELOCKED" || remaining <= 0) throw error;
				const base = Math.min(10 * 2 ** retry, MAX_DELAY_MS / 2);
				retry++;
				const delay = Math.min(Math.round(base * (1 + Math.random())), remaining);
				await sleep(delay, signal);
			}
		}
	}

	/**
	 * Run `fn` under the cross-process lock. `fn` receives the current raw file
	 * content (or undefined) and returns a result plus an optional new raw
	 * content to persist. Reads and writes are serialized against pi.
	 */
	private async withLock<T>(
		fn: (current: string | undefined) => Promise<{ result: T; next?: string }>,
		options?: AuthOperationOptions,
	): Promise<T> {
		const signal = options?.signal;
		signal?.throwIfAborted();
		this.ensureParentDir();
		this.ensureFileExists();

		// Single-process mode (e.g. a container with no other writer): skip the
		// cross-process lock. Refreshes still work; concurrent double-spend is
		// not a risk when only this process touches the file.
		if (this.noLock) {
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			signal?.throwIfAborted();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, WRITE_OPTIONS);
				chmodSync(this.authPath, 0o600);
			}
			return result;
		}

		const release = await this.acquireLock(signal);
		try {
			signal?.throwIfAborted();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			signal?.throwIfAborted();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, WRITE_OPTIONS);
				chmodSync(this.authPath, 0o600);
			}
			return result;
		} finally {
			try {
				await release();
			} catch {
				// Ignore unlock errors (e.g. lock already released).
			}
		}
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		return this.withLock(async (current) => ({ result: this.parse(current)[providerId] }), options);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return this.withLock(
			async (current) => ({
				result: Object.entries(this.parse(current)).map(([providerId, credential]) => ({
					providerId,
					type: credential.type,
				})),
			}),
			options,
		);
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.withLock(
			async (current) => {
				const data = this.parse(current);
				const next = await fn(data[providerId]);
				if (next === undefined) return { result: data[providerId] };
				const merged: AuthData = { ...data, [providerId]: next };
				return { result: next, next: JSON.stringify(merged, null, 2) };
			},
			options,
		);
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		await this.withLock<void>(
			async (current) => {
				const data = this.parse(current);
				delete data[providerId];
				return { result: undefined, next: JSON.stringify(data, null, 2) };
			},
			options,
		);
	}
}

/**
 * A CredentialStore that routes a set of provider ids to a dedicated sub-store
 * and everything else to a default store. Used to serve the ClinePass provider
 * from the Cline CLI's providers.json while all other providers keep using
 * auth.json — a single Models collection has one credential store, so the
 * routing store keeps each provider's tokens in the right file.
 */
export class RoutingCredentialStore implements CredentialStore {
	constructor(
		private readonly defaultStore: CredentialStore,
		private readonly routes: Record<string, CredentialStore>,
	) {}

	private storeFor(providerId: string): CredentialStore {
		return this.routes[providerId] ?? this.defaultStore;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		return this.storeFor(providerId).read(providerId, options);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const stores = [this.defaultStore, ...new Set(Object.values(this.routes))];
		const all = await Promise.all(stores.map((s) => s.list(options)));
		return all.flat();
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.storeFor(providerId).modify(providerId, fn, options);
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		await this.storeFor(providerId).delete(providerId, options);
	}
}
