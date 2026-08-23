/**
 * Quota & deadline ledger (pj-xe41). In-memory, per-bucket tracking of consumed
 * tokens/cost, provider rate-limit signals, and pre-dispatch admission checks.
 * No persistence — a restart resets every bucket.
 */

import type { Telemetry } from "./telemetry.ts";

/** Anything carrying a token total (and optionally a cost total). Satisfied by both
 *  pi-ai's `Usage` and the internal `InternalUsage`. */
export interface UsageLike {
  totalTokens: number;
  cost?: { total?: number };
}

export interface BucketConfig {
  id: string;
  /** Hard cap on total tokens consumed by this bucket. */
  limitTokens?: number;
  /** Hard cap on total cost consumed by this bucket. */
  limitCost?: number;
  /** Max duration (ms) a single request under this bucket may run. */
  deadlineMs?: number;
}

export interface Bucket extends BucketConfig {
  consumedTokens: number;
  consumedCost: number;
  /** Last observed provider rate-limit remaining (requests or tokens). */
  rateLimitRemaining?: number;
  /** Wall-clock ms when the provider rate limit resets (if observed). */
  rateLimitResetAt?: number;
}

export interface CheckResult {
  allowed: boolean;
  reason?: string;
}

export class Ledger {
  private buckets = new Map<string, Bucket>();

  constructor(configs: BucketConfig[] = [], private readonly telemetry?: Telemetry) {
    for (const c of configs) this.buckets.set(c.id, { ...c, consumedTokens: 0, consumedCost: 0 });
  }

  get(id: string): Bucket | undefined {
    return this.buckets.get(id);
  }

  ids(): string[] {
    return [...this.buckets.keys()];
  }

  /**
   * Pre-dispatch admission check. An unknown/absent bucket is allowed (no quota
   * configured) so the plane stays inert until buckets are defined.
   */
  check(id: string | undefined, estTokens = 0): CheckResult {
    if (!id) return { allowed: true };
    const b = this.buckets.get(id);
    if (!b) return { allowed: true };
    if (b.limitTokens !== undefined && b.consumedTokens + estTokens > b.limitTokens) {
      const reason = `quota exceeded: bucket "${id}" token limit ${b.limitTokens} (consumed ${b.consumedTokens})`;
      this.telemetry?.emit("quota.denied", { bucket: id, reason });
      return { allowed: false, reason };
    }
    if (b.limitCost !== undefined && b.consumedCost >= b.limitCost) {
      const reason = `quota exceeded: bucket "${id}" cost limit ${b.limitCost} (consumed ${b.consumedCost})`;
      this.telemetry?.emit("quota.denied", { bucket: id, reason });
      return { allowed: false, reason };
    }
    if (b.rateLimitRemaining !== undefined && b.rateLimitRemaining <= 0) {
      const reason = `rate limited: bucket "${id}" (resets ${b.rateLimitResetAt ? new Date(b.rateLimitResetAt).toISOString() : "unknown"})`;
      this.telemetry?.emit("quota.denied", { bucket: id, reason });
      return { allowed: false, reason };
    }
    this.telemetry?.emit("quota.allowed", { bucket: id });
    return { allowed: true };
  }

  /** Record consumed usage for a bucket after a completed request. */
  record(id: string | undefined, usage: UsageLike): void {
    if (!id) return;
    const b = this.buckets.get(id);
    if (!b) return;
    b.consumedTokens += usage.totalTokens ?? 0;
    b.consumedCost += usage.cost?.total ?? 0;
    this.telemetry?.emit("quota.record", { bucket: id, tokens: usage.totalTokens, cost: usage.cost?.total });
  }

  /** Fold provider rate-limit headers (from StreamOptions.onResponse) into a bucket. */
  observeRateLimit(id: string | undefined, headers: Record<string, string>): void {
    if (!id) return;
    const b = this.buckets.get(id);
    if (!b) return;
    const remaining = firstNum(headers, ["x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens"]);
    if (remaining !== undefined) b.rateLimitRemaining = remaining;
    const reset = firstNum(headers, ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]);
    if (reset !== undefined) b.rateLimitResetAt = Date.now() + reset * 1000;
    this.telemetry?.emit("quota.ratelimit", { bucket: id, remaining: b.rateLimitRemaining, resetAt: b.rateLimitResetAt });
  }

  /** Max request duration (ms) for a bucket, or undefined if unset. */
  deadlineMs(id: string | undefined): number | undefined {
    if (!id) return undefined;
    return this.buckets.get(id)?.deadlineMs;
  }
}

function firstNum(headers: Record<string, string>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = headers[k];
    if (v !== undefined) {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}
