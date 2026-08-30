/**
 * CredentialStore backed by the Cline CLI's providers.json
 * (~/.cline/data/settings/providers.json).
 *
 * The Cline CLI stores its ClinePass / Cline OAuth credential under the
 * `cline` provider entry (ClinePass reuses the `cline` login + storage). The
 * shape is:
 *
 *   {
 *     "version": 1,
 *     "providers": {
 *       "cline": {
 *         "settings": {
 *           "provider": "cline",
 *           "auth": {
 *             "accessToken": "workos:eyJ...",   // stored WITH the workos: prefix
 *             "refreshToken": "<raw WorkOS refresh token>",
 *             "expiresAt": 1753900000000,       // epoch MILLISECONDS
 *             "accountId": "...",
 *             "metadata": { ... }
 *           }
 *         },
 *         "updatedAt": "<iso>",
 *         "tokenSource": "oauth"
 *       }
 *     }
 *   }
 *
 * pi-ai's OAuth resolution (resolveStoredOAuth) reads a stored `oauth`
 * credential, refreshes it under the store lock when it is within 5 min of
 * expiry, and persists the rotated credential back through `modify`. This store
 * maps that to the Cline file: `read` surfaces the cline credential as an
 * OAuthCredential, and `modify` writes the rotated tokens back into the file
 * (preserving every other provider entry and the file's 0600 mode).
 *
 * The file is shared with the Cline CLI, which does NOT take a lock. We DO take
 * a proper-lockfile lock here (same as FileCredentialStore) so that a pi-janus
 * refresh is a serialized read-modify-write and cannot clobber a concurrent
 * write. (A pi-janus-vs-CLI race on the same machine is still possible; see the
 * ticket — the CLI's atomic write is the only protection on its side.)
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";

const WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;
/** A lock older than this is considered stale (crashed holder) and is taken over. */
const STALE_MS = 30_000;
/** Cap on backoff delay between lock retries. */
const MAX_DELAY_MS = 2_000;

/** The provider id under which the Cline CLI stores its OAuth credential. */
export const CLINE_STORAGE_PROVIDER = "cline";

/**
 * The Cline gateway signs access tokens as WorkOS JWTs. The Cline CLI stores
 * and sends them WITH a `workos:` prefix (see formatClineApiKey in the CLI),
 * but the /auth/refresh endpoint returns the raw JWT. We normalize to the
 * prefixed form on every read and write so the Bearer token sent to the
 * gateway is always the prefixed form, regardless of what a refresh returned.
 * Idempotent: a token that already carries the prefix is returned unchanged.
 */
export const WORKOS_TOKEN_PREFIX = "workos:";
export function withWorkosPrefix(token: string): string {
	return token.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX) ? token : `${WORKOS_TOKEN_PREFIX}${token}`;
}

/** Default location of the Cline CLI's providers.json. */
export function defaultClineProvidersPath(): string {
	return join(homedir(), ".cline", "data", "settings", "providers.json");
}

/** Expand a leading `~` and resolve to an absolute path. */
function normalizePath(p: string): string {
	if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
	return resolve(p);
}

function stripBom(s: string): string {
	return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Write atomically (temp file + rename) so a concurrent reader — notably the
 * Cline CLI, which reads providers.json without taking a lock — never observes
 * a partial file. Matches the CLI's own write strategy.
 */
function atomicWrite(path: string, content: string): void {
	const tempPath = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(tempPath, content, WRITE_OPTIONS);
		renameSync(tempPath, path);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
	try {
		chmodSync(path, 0o600);
	} catch {
		// Ignore — Windows does not support POSIX chmod.
	}
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

/**
 * Map a Cline `auth` block to a pi-ai OAuthCredential, or undefined when it is
 * not a usable OAuth credential (missing access/refresh token).
 *
 * `accessToken` is normalized to the `workos:`-prefixed form (idempotent) so a
 * file written by a refresh that returned a raw JWT still yields a usable
 * Bearer token.
 */
export function clineAuthToCredential(auth: unknown): OAuthCredential | undefined {
	if (!auth || typeof auth !== "object") return undefined;
	const a = auth as Record<string, unknown>;
	const accessToken = typeof a.accessToken === "string" ? a.accessToken.trim() : "";
	const refreshToken = typeof a.refreshToken === "string" ? a.refreshToken.trim() : "";
	if (!accessToken || !refreshToken) return undefined;
	const expires = typeof a.expiresAt === "number" && Number.isFinite(a.expiresAt) ? a.expiresAt : Date.now();
	return {
		type: "oauth",
		access: withWorkosPrefix(accessToken),
		refresh: refreshToken,
		expires,
		accountId: typeof a.accountId === "string" ? a.accountId : undefined,
	};
}

/**
 * Read the Cline OAuth credential from a providers.json file. Returns undefined
 * when the file is missing, malformed, or has no usable cline credential.
 * Pure (no lock) — for status/registration checks.
 */
export function readClineCredential(providersPath: string): OAuthCredential | undefined {
	let raw: string;
	try {
		if (!existsSync(providersPath)) return undefined;
		raw = readFileSync(providersPath, "utf-8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(stripBom(raw)) as any;
		const auth = parsed?.providers?.[CLINE_STORAGE_PROVIDER]?.settings?.auth;
		return clineAuthToCredential(auth);
	} catch {
		return undefined;
	}
}

export class ClineCredentialStore implements CredentialStore {
	private readonly filePath: string;
	private readonly noLock: boolean;

	constructor(providersPath: string = defaultClineProvidersPath(), noLock = false) {
		this.filePath = normalizePath(providersPath);
		this.noLock = noLock;
	}

	get path(): string {
		return this.filePath;
	}

	private ensureParentDir(): void {
		const dir = dirname(this.filePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	}

	private ensureFileExists(): void {
		if (!existsSync(this.filePath)) {
			writeFileSync(this.filePath, "{}", WRITE_OPTIONS);
			chmodSync(this.filePath, 0o600);
		}
	}

	private parse(content: string | undefined): any {
		if (!content) return {};
		try {
			const parsed = JSON.parse(stripBom(content));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
			return parsed;
		} catch {
			return {};
		}
	}

	private async acquireLock(signal?: AbortSignal): Promise<() => Promise<void>> {
		const deadline = Date.now() + STALE_MS;
		let retry = 0;
		for (;;) {
			signal?.throwIfAborted();
			try {
				return await lockfile.lock(this.filePath, { realpath: false, retries: 0, stale: STALE_MS });
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
	 * content to persist. Reads and writes are serialized against other
	 * pi-janus processes.
	 */
	private async withLock<T>(
		fn: (current: string | undefined) => Promise<{ result: T; next?: string }>,
		options?: AuthOperationOptions,
	): Promise<T> {
		const signal = options?.signal;
		signal?.throwIfAborted();
		this.ensureParentDir();
		this.ensureFileExists();

		if (this.noLock) {
			const current = existsSync(this.filePath) ? readFileSync(this.filePath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			signal?.throwIfAborted();
			if (next !== undefined) atomicWrite(this.filePath, next);
			return result;
		}

		const release = await this.acquireLock(signal);
		try {
			signal?.throwIfAborted();
			const current = existsSync(this.filePath) ? readFileSync(this.filePath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			signal?.throwIfAborted();
			if (next !== undefined) atomicWrite(this.filePath, next);
			return result;
		} finally {
			try {
				await release();
			} catch {
				// Ignore unlock errors (e.g. lock already released).
			}
		}
	}

	async read(_providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		return this.withLock(async (current) => ({ result: clineAuthToCredential(this.parse(current)?.providers?.[CLINE_STORAGE_PROVIDER]?.settings?.auth) }), options);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return this.withLock(
			async (current) => {
				const cred = clineAuthToCredential(this.parse(current)?.providers?.[CLINE_STORAGE_PROVIDER]?.settings?.auth);
				return { result: cred ? [{ providerId: CLINE_STORAGE_PROVIDER, type: cred.type }] : [] };
			},
			options,
		);
	}

	async modify(
		_providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.withLock(
			async (current) => {
				const data = this.parse(current);
				const curCred = clineAuthToCredential(data?.providers?.[CLINE_STORAGE_PROVIDER]?.settings?.auth);
				const next = await fn(curCred);
				if (next === undefined) return { result: curCred };
				if (next.type !== "oauth") return { result: curCred };
				// Write the rotated credential back, preserving every other
				// provider entry and the file's overall shape.
				const entry = data?.providers?.[CLINE_STORAGE_PROVIDER];
				const settings = entry?.settings ?? {};
				const prevAuth = (settings.auth ?? {}) as Record<string, unknown>;
				settings.auth = {
					...prevAuth,
					accessToken: withWorkosPrefix(next.access),
					refreshToken: next.refresh,
					expiresAt: next.expires,
					...(typeof next.accountId === "string" ? { accountId: next.accountId } : {}),
				};
				data.providers = data.providers ?? {};
				data.providers[CLINE_STORAGE_PROVIDER] = {
					...entry,
					settings,
					updatedAt: new Date().toISOString(),
					tokenSource: "oauth",
				};
				return { result: next, next: JSON.stringify(data, null, 2) };
			},
			options,
		);
	}

	async delete(_providerId: string, options?: AuthOperationOptions): Promise<void> {
		await this.withLock<void>(
			async (current) => {
				const data = this.parse(current);
				const entry = data?.providers?.[CLINE_STORAGE_PROVIDER];
				if (!entry) return { result: undefined };
				const settings = entry.settings ?? {};
				delete settings.auth;
				entry.settings = settings;
				return { result: undefined, next: JSON.stringify(data, null, 2) };
			},
			options,
		);
	}
}
