/**
 * zcode.conf: hot-readable credential/config file for the ZCode (Z.AI GLM)
 * providers. Referenced via JANUS_ZCODE_CONF=<path>; re-stat'd on every access
 * so editing the file takes effect without restarting pi-janus.
 *
 * Shape (every field optional, independently absent-able — the conf can start
 * as just a pasted apiKey):
 *
 * {
 *   "zcodeJwt":     "eyJ...",              // Coding Plan JWT (zcode.z.ai upstream)
 *   "apiKey":       "key.secretKey",       // biz API key (api.z.ai upstream, no captcha)
 *   "refreshToken": "...",                 // optional zai refresh token
 *   "clientSecret": "...",                 // optional; enables zai token refresh
 *   "captchaTtlMs": 300000,                // captcha verifyParam cache TTL (300s default)
 *   "captchaWaitMs": 120000,               // how long a challenged request waits for a solve (local)
 *   "captchaAutoOpen": true,               // auto-open a browser on captcha challenge
 *   "appVersion": "3.7.7",                 // ZCode client fingerprint
 *   "planBaseUrl": "...",                  // override for tests/staging
 *   "apiKeyBaseUrl": "..."                 // override for tests/staging
 * }
 *
 * The file holds live credentials — chmod 600 it. No ZCode app install is
 * required; ZCode is only a convenient credential source.
 */

import { readFileSync, statSync } from "node:fs";

/** Coding Plan upstream origin (Anthropic messages under /v1/messages). */
export const ZCODE_PLAN_BASE_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";
/** API-key upstream origin (Anthropic messages under /v1/messages). */
export const ZCODE_APIKEY_BASE_URL = "https://api.z.ai/api/anthropic";

export interface ZcodeConf {
	zcodeJwt?: string;
	apiKey?: string;
	refreshToken?: string;
	clientSecret?: string;
	/** Cache TTL for a solved captcha verifyParam. Default 300s (planned; ratchet down if Z.AI rejects). */
	captchaTtlMs: number;
	/**
	 * How long a challenged request waits (local/auto-open mode) for a browser
	 * solve before failing with the captcha URL. Default 120s. Bounded so a
	 * never-solved challenge can't hang a request indefinitely.
	 */
	captchaWaitMs: number;
	/** Auto-open the captcha page in a browser when challenged (local UX). Default true. */
	captchaAutoOpen: boolean;
	/** Debug: when true, never attach a cached verifyParam (tests per-session vs per-request captcha). */
	debugNoParam?: boolean;
	/** Aliyun captcha scene config (defaults sniffed from the ZCode client). */
	captchaSceneId: string;
	captchaPrefix: string;
	captchaRegion: string;
	/** ZCode client fingerprint. */
	appVersion: string;
	userAgent: string;
	/** Base-URL overrides (tests/staging). */
	planBaseUrl?: string;
	apiKeyBaseUrl?: string;
}

const DEFAULTS = {
	captchaTtlMs: 300_000,
	captchaWaitMs: 120_000,
	captchaAutoOpen: true,
	captchaSceneId: "11xygtvd",
	captchaPrefix: "no8xfe",
	captchaRegion: "sgp",
	appVersion: "3.7.7",
	userAgent: "ZCode/3.7.7",
} as const;

/** Pure — parse a zcode.conf JSON string with defaults applied. Unit-testable. */
export function parseZcodeConf(json: string): ZcodeConf {
	const raw = JSON.parse(json) as Record<string, unknown>;
	const str = (key: string): string | undefined => {
		const v = raw[key];
		return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
	};
	const ttl = raw["captchaTtlMs"];
	const wait = raw["captchaWaitMs"];
	return {
		zcodeJwt: str("zcodeJwt"),
		apiKey: str("apiKey"),
		refreshToken: str("refreshToken"),
		clientSecret: str("clientSecret"),
		captchaTtlMs: typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULTS.captchaTtlMs,
		captchaWaitMs: typeof wait === "number" && Number.isFinite(wait) && wait > 0 ? wait : DEFAULTS.captchaWaitMs,
		captchaAutoOpen: raw["captchaAutoOpen"] !== false,
		debugNoParam: raw["debugNoParam"] === true,
		captchaSceneId: str("captchaSceneId") ?? DEFAULTS.captchaSceneId,
		captchaPrefix: str("captchaPrefix") ?? DEFAULTS.captchaPrefix,
		captchaRegion: str("captchaRegion") ?? DEFAULTS.captchaRegion,
		appVersion: str("appVersion") ?? DEFAULTS.appVersion,
		userAgent: str("userAgent") ?? DEFAULTS.userAgent,
		planBaseUrl: str("planBaseUrl"),
		apiKeyBaseUrl: str("apiKeyBaseUrl"),
	};
}

interface ConfCacheEntry {
	mtimeMs: number;
	size: number;
	conf: ZcodeConf;
}

const cache = new Map<string, ConfCacheEntry>();

/**
 * Load zcode.conf, re-reading when the file's mtime/size changed (hot reload).
 * A missing/unreadable file yields undefined; a present-but-invalid file throws
 * (loud, so a typo doesn't silently drop credentials).
 */
export function loadZcodeConf(path: string | undefined): ZcodeConf | undefined {
	if (!path) return undefined;
	let st: { mtimeMs: number; size: number };
	try {
		const s = statSync(path);
		st = { mtimeMs: s.mtimeMs, size: s.size };
	} catch {
		cache.delete(path);
		return undefined;
	}
	const hit = cache.get(path);
	if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.conf;
	const conf = parseZcodeConf(readFileSync(path, "utf8"));
	cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, conf });
	return conf;
}
