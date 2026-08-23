/**
 * Intelligence category registry & quota/deadline binding (pj-1uyc). A category
 * maps one or more pi-ai model refs to a quota bucket + deadline policy. The
 * model catalog itself comes from pi-ai; this adds the proxy's category layer
 * and the category-to-quota/deadline binding.
 */

import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { resolveModel } from "./models.ts";

export interface CategoryConfig {
  id: string;
  name?: string;
  /** Underlying pi-ai model refs ("provider/id"). First resolvable wins. */
  models: string[];
  /** Quota bucket this category is bound to. */
  quotaBucketId?: string;
  /** Per-request deadline (ms) for this category. */
  deadlineMs?: number;
  capabilities?: Record<string, unknown>;
}

export interface Category {
  id: string;
  name: string;
  models: string[];
  quotaBucketId?: string;
  deadlineMs?: number;
  capabilities?: Record<string, unknown>;
  /** Whether the category currently resolves to a known model. */
  available: boolean;
}

export interface ResolvedCategory {
  category: Category;
  model: Model<Api>;
  quotaBucketId?: string;
  deadlineMs?: number;
}

export class CategoryRegistry {
  private categories = new Map<string, CategoryConfig>();

  constructor(configs: CategoryConfig[] = []) {
    for (const c of configs) this.categories.set(c.id, c);
  }

  /** List categories with live availability (does the first model ref resolve?). */
  list(models: Models): Category[] {
    return [...this.categories.values()].map((c) => this.toCategory(c, models));
  }

  get(id: string): CategoryConfig | undefined {
    return this.categories.get(id);
  }

  has(id: string): boolean {
    return this.categories.has(id);
  }

  private toCategory(c: CategoryConfig, models: Models): Category {
    return {
      id: c.id,
      name: c.name ?? c.id,
      models: c.models,
      quotaBucketId: c.quotaBucketId,
      deadlineMs: c.deadlineMs,
      capabilities: c.capabilities,
      available: this.pickModel(c.models, models) !== undefined,
    };
  }

  /** Pick the first model ref that resolves to a known model. */
  pickModel(refs: string[], models: Models): Model<Api> | undefined {
    for (const ref of refs) {
      try {
        return resolveModel(models, ref);
      } catch {
        // try the next ref
      }
    }
    return undefined;
  }

  /**
   * Resolve a requested id to a concrete model + binding. Accepts a category id
   * or a raw "provider/id" / bare model id. Throws if nothing resolves.
   */
  resolve(requested: string, models: Models): ResolvedCategory {
    const cfg = this.categories.get(requested);
    if (cfg) {
      const model = this.pickModel(cfg.models, models);
      if (!model) throw new Error(`Category "${requested}" has no resolvable model (tried: ${cfg.models.join(", ")})`);
      return { category: this.toCategory(cfg, models), model, quotaBucketId: cfg.quotaBucketId, deadlineMs: cfg.deadlineMs };
    }
    // Not a category: treat as a raw model ref.
    const model = resolveModel(models, requested);
    const synthetic: Category = { id: requested, name: requested, models: [requested], available: true };
    return { category: synthetic, model, quotaBucketId: undefined, deadlineMs: undefined };
  }
}
