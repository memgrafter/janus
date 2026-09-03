import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PlaneConfig } from "./control.ts";

export interface Config {
  host: string;
  port: number;
  /** When set, requests must carry `Authorization: Bearer <token>`. */
  token?: string;
  /**
   * Per-request provider timeout in SECONDS (0 = disabled: wait for the client to
   * abort). Clamped to 0-99999. pi owns the real timeout; this is a long backstop
   * so a slow/queued upstream (e.g. a 250s prefill) doesn't get cut off.
   */
  requestTimeoutS: number;
  /** Use the scripted faux provider instead of real providers (tests / demos). */
  faux: boolean;
  /** Response text returned by the faux provider. */
  fauxResponse: string;
  /** Path to a JSON control-plane config (buckets / categories / projects). */
  planeConfigPath?: string;
  /** Path to a pi models.json file with custom providers to register. */
  modelsJsonPath?: string;
  /**
   * Path to pi's auth.json (OAuth credentials for subscription providers like
   * openai-codex). Read/written by the FileCredentialStore. Defaults to
   * ~/.pi/agent/auth.json. Set to a non-existent path to disable OAuth providers.
   */
  authJsonPath: string;
  /**
   * Skip the cross-process auth.json lock (JANUS_AUTH_NO_LOCK=1). Safe when a
   * single process owns the file (e.g. a container); avoids lock-file I/O on
   * network filesystems.
   */
  authNoLock: boolean;
  /**
   * Enable the ClinePass provider (serves the Cline subscription using the
   * Cline CLI's OAuth credential). Off by default; set JANUS_CLINE_PASS=1 to
   * enable. The credential is read from clineProvidersPath.
   */
  clinePass: boolean;
  /**
   * Path to the Cline CLI's providers.json (OAuth credential for ClinePass).
   * Defaults to ~/.cline/data/settings/providers.json. Set to a non-existent
   * path to disable ClinePass even when clinePass is enabled.
   */
  clineProvidersPath: string;
  /**
   * Cline API base URL (production default https://api.cline.bot). Override for
   * staging/local. The gateway is <base>/api/v1 and refresh is <base>/api/v1/auth/refresh.
   */
  clineApiBaseUrl: string;
  /** Enable the ZCode (Z.AI GLM) providers, reading credentials from zcodeConfPath. */
  zcode: boolean;
  /**
   * Path to zcode.conf (hot-readable; edited without restart). Holds the Coding
   * Plan JWT and/or biz apiKey, captcha TTL (default 300s), and overrides.
   * Defaults to ~/.janus/zcode.conf when zcode is enabled.
   */
  zcodeConfPath?: string;
  /**
   * Public origin (scheme + host[:port]) for URLs surfaced to clients — e.g. the
   * ZCode captcha page. Set for k3s/remote deployments where 127.0.0.1 is not
   * reachable from the user's browser. Unset = http://127.0.0.1:<bound port>.
   */
  publicUrl?: string;
  /** Allocator tick interval in milliseconds. */
  allocMs: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    host: env["JANUS_HOST"] ?? "127.0.0.1",
    port: intEnv(env["JANUS_PORT"], 8787),
    token: env["JANUS_TOKEN"] || undefined,
    requestTimeoutS: intEnvClamped(env["JANUS_TIMEOUT_S"], 600, 0, 99999),
    faux: env["JANUS_FAUX"] === "1" || env["JANUS_FAUX"] === "true",
    fauxResponse: env["JANUS_FAUX_RESPONSE"] ?? "pi-janus faux ok",
    planeConfigPath: env["JANUS_CONFIG"] || undefined,
    modelsJsonPath: env["JANUS_MODELS_JSON"] || undefined,
    authJsonPath: env["JANUS_AUTH_JSON"] || join(homedir(), ".pi", "agent", "auth.json"),
    authNoLock: env["JANUS_AUTH_NO_LOCK"] === "1" || env["JANUS_AUTH_NO_LOCK"] === "true",
    clinePass: env["JANUS_CLINE_PASS"] === "1" || env["JANUS_CLINE_PASS"] === "true",
    clineProvidersPath: env["JANUS_CLINE_PROVIDERS_JSON"] || join(homedir(), ".cline", "data", "settings", "providers.json"),
    clineApiBaseUrl: env["JANUS_CLINE_API_BASE_URL"] || "https://api.cline.bot",
    zcode: env["JANUS_ZCODE"] === "1" || env["JANUS_ZCODE"] === "true",
    zcodeConfPath: env["JANUS_ZCODE_CONF"] || join(homedir(), ".janus", "zcode.conf"),
    publicUrl: env["JANUS_PUBLIC_URL"] || undefined,
    allocMs: intEnv(env["JANUS_ALLOC_MS"], 1000),
  };
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function intEnvClamped(value: string | undefined, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, intEnv(value, fallback)));
}

/** Parse a control-plane config JSON string. Pure — unit-testable. */
export function parsePlaneConfig(json: string): PlaneConfig {
  const raw = JSON.parse(json) as Record<string, unknown>;
  return {
    buckets: asArray(raw.buckets),
    categories: asArray(raw.categories),
    projects: asArray(raw.projects),
  };
}

/** Load a control-plane config from a file path. Returns an empty (inert) plane if unset. */
export function loadPlaneConfig(path?: string): PlaneConfig {
  if (!path) return { buckets: [], categories: [], projects: [] };
  return parsePlaneConfig(readFileSync(path, "utf8"));
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
