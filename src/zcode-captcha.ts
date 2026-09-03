/**
 * Captcha manager for the ZCode Coding Plan upstream.
 *
 * When Z.AI responds `{"code":3007,"msg":"captcha verify failed"}`, the Coding
 * Plan upstream demands an Aliyun captcha verify param on the next request
 * (header `X-Aliyun-Captcha-Verify-Param`). The param is produced by the
 * Aliyun Captcha 2 SDK running CLIENT-SIDE in a normal browser — pi-janus
 * serves a small page (/zcode/captcha.html) that loads the SDK from Aliyun's
 * CDN, shows the puzzle, and POSTs the solved verifyParam back to
 * /v1/zcode/captcha/submit. No embedded/stealth browser required.
 *
 * A solved param is cached for `captchaTtlMs` (conf-configurable, default
 * 300s). If Z.AI still rejects a cached param with 3007, the cache is dropped
 * (ratchet) and the caller re-challenges — the effective TTL self-tunes to
 * whatever Z.AI honors.
 */

import type { ZcodeConf } from "./zcode-conf.ts";

/** Does this provider error body mean "captcha verify param required/invalid"? */
export function isCaptchaErrorBody(text: string | undefined): boolean {
	if (!text) return false;
	return text.includes('"code":3007') || text.includes("captcha verify failed");
}

export class CaptchaManager {
	private cachedParam: string | undefined;
	private cachedAt = 0;
	private pending: Promise<string> | undefined;
	private resolvePending: ((param: string) => void) | undefined;
	/** Whether a challenge is outstanding and the page should be (re)opened. */
	private challengeWanted = false;
	/** Keepers (long-pollers) woken when a challenge is requested. */
	private challengeWaiters = new Set<() => void>();
	/** Last time a keeper tab long-polled (keeper-tab flow). */
	private lastKeeperPollAt = 0;
	private ttlMs: number;

	constructor(ttlMs = 300_000) {
		this.ttlMs = ttlMs;
	}

	setTtl(ttlMs: number): void {
		if (ttlMs > 0 && ttlMs !== this.ttlMs) {
			this.ttlMs = ttlMs;
			// A TTL change re-validates the current cache age against the new bound.
			if (this.cachedParam && Date.now() - this.cachedAt > this.ttlMs) this.invalidate();
		}
	}

	get ttl(): number {
		return this.ttlMs;
	}

	/** Resolved once a browser submits a fresh verifyParam (or the cache covers it). */
	getVerifyParam(): Promise<string> {
		const cached = this.peekCached();
		if (cached) return Promise.resolve(cached);
		if (this.pending) return this.pending;
		this.challengeWanted = true;
		this.pending = new Promise<string>((resolve) => {
			this.resolvePending = resolve;
		});
		// Wake any keeper tabs waiting for a challenge (k3s keeper-tab flow).
		for (const w of this.challengeWaiters) w();
		return this.pending;
	}

	/**
	 * Resolves true when a challenge is requested (a request needs a fresh
	 * verifyParam), false on timeout. Used by the keeper-tab long-poll endpoint
	 * so a single always-open browser tab can auto-verify on demand (k3s).
	 */
	waitForChallenge(timeoutMs: number): Promise<boolean> {
		if (this.challengeWanted || this.pending) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			const wake = () => {
				clearTimeout(timer);
				this.challengeWaiters.delete(wake);
				resolve(true);
			};
			const timer = setTimeout(() => {
				this.challengeWaiters.delete(wake);
				resolve(false);
			}, timeoutMs);
			this.challengeWaiters.add(wake);
		});
	}

	/** Current cached param if fresh, else undefined. */
	peekCached(): string | undefined {
		if (!this.cachedParam) return undefined;
		if (Date.now() - this.cachedAt > this.ttlMs) {
			this.invalidate();
			return undefined;
		}
		return this.cachedParam;
	}

	/** Browser solved the captcha — resolve the pending request and cache it. */
	submit(param: string): void {
		const trimmed = param.trim();
		if (!trimmed) return;
		this.cachedParam = trimmed;
		this.cachedAt = Date.now();
		this.challengeWanted = false;
		const resolve = this.resolvePending;
		this.pending = undefined;
		this.resolvePending = undefined;
		resolve?.(trimmed);
	}

	/** Z.AI rejected the param (3007 with a param attached) — drop and re-challenge. */
	invalidate(): void {
		this.cachedParam = undefined;
		this.cachedAt = 0;
	}

	get challengeNeeded(): boolean {
		return this.challengeWanted || (!this.peekCached() && !this.pending);
	}

	/** True while a solve is in flight. */
	get solving(): boolean {
		return this.pending !== undefined;
	}

	/**
	 * A keeper tab long-polled recently. Called by the /captcha/poll handler on
	 * every poll so the server knows a keeper is connected and will auto-verify
	 * on demand — in which case it must NOT also auto-open a second tab (two
	 * concurrent traceless verifies from one fingerprint get rejected by Aliyun).
	 */
	noteKeeperPoll(): void {
		this.lastKeeperPollAt = Date.now();
	}

	/** True while a keeper tab has been polling within the last 60s. */
	hasActiveKeeper(): boolean {
		return this.lastKeeperPollAt > 0 && Date.now() - this.lastKeeperPollAt < 60_000;
	}
}

/** Process-wide manager (one cache per process; the param is account-global). */
let manager: CaptchaManager | undefined;

export function captchaManager(conf: ZcodeConf | undefined): CaptchaManager {
	if (!manager) manager = new CaptchaManager();
	if (conf) manager.setTtl(conf.captchaTtlMs);
	return manager;
}
