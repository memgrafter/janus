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
  /** Allocator tick interval in milliseconds. */
  allocMs: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    host: env["PI_JANUS_HOST"] ?? "127.0.0.1",
    port: intEnv(env["PI_JANUS_PORT"], 8787),
    token: env["PI_JANUS_TOKEN"] || undefined,
    requestTimeoutS: intEnvClamped(env["PI_JANUS_TIMEOUT_S"], 600, 0, 99999),
    faux: env["PI_JANUS_FAUX"] === "1" || env["PI_JANUS_FAUX"] === "true",
    fauxResponse: env["PI_JANUS_FAUX_RESPONSE"] ?? "pi-janus faux ok",
    planeConfigPath: env["PI_JANUS_CONFIG"] || undefined,
    modelsJsonPath: env["PI_JANUS_MODELS_JSON"] || undefined,
    authJsonPath: env["PI_JANUS_AUTH_JSON"] || join(homedir(), ".pi", "agent", "auth.json"),
    allocMs: intEnv(env["PI_JANUS_ALLOC_MS"], 1000),
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
