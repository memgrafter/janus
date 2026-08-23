/**
 * Control layer (the shared spine). Composes the ledger, category registry, and
 * priority queue, and is the single place that decides admit / queue / reject and
 * which quota + deadline applies to a request. Sits above the core's three layers
 * (wire-format / pi-ai mapping / transport), which it does not modify.
 */

import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { assistantMessageToInternal } from "./bridge.ts";
import { CategoryRegistry, type CategoryConfig, type ResolvedCategory } from "./categories.ts";
import { Ledger, type BucketConfig } from "./ledger.ts";
import type { InternalMessage, InternalRequest } from "./openai.ts";
import { parseMessage } from "./openai.ts";
import type { AllocateResult, WorkItem } from "./queue.ts";
import { PriorityQueue, runAllocator } from "./queue.ts";
import type { Telemetry } from "./telemetry.ts";

export interface ProjectConfig {
  id: string;
  category?: string;
  quotaBucketId?: string;
  deadlineMs?: number;
}

export interface PlaneConfig {
  buckets: BucketConfig[];
  categories: CategoryConfig[];
  projects: ProjectConfig[];
}

/** Priority bands: synchronous workers pre-empt event/background work. */
export const PRIORITY = {
  sync: 100,
  event: 50,
} as const;

export interface DispatchContext {
  model: Model<Api>;
  category?: string;
  project?: string;
  quotaBucketId?: string;
  deadlineMs?: number;
  priority: number;
  source: "sync-worker" | "event";
}

export type AdmitDecision =
  | { action: "dispatch"; context: DispatchContext }
  | { action: "reject"; status: number; reason: string };

/** Drives queued (non-stream) work through the pi-ai client. */
export interface Dispatcher {
  complete(model: Model<Api>, req: InternalRequest, timeoutMs?: number): Promise<AssistantMessage>;
}

export interface EventInput {
  project?: string;
  category?: string;
  model?: string;
  /** OpenAI-format messages (parsed to internal). */
  messages: unknown[];
  tools?: InternalRequest["tools"];
  priority?: number;
  deadlineMs?: number;
}

let workSeq = 0;
export function nextWorkId(): string {
  workSeq += 1;
  return `work-${Date.now().toString(36)}-${workSeq}`;
}

export class Control {
  readonly ledger: Ledger;
  readonly categories: CategoryRegistry;
  readonly queue = new PriorityQueue();
  private projects = new Map<string, ProjectConfig>();
  private completed = new Map<string, WorkItem>();

  constructor(
    private readonly models: Models,
    plane: PlaneConfig,
    readonly telemetry: Telemetry,
    private readonly dispatcher: Dispatcher,
  ) {
    this.ledger = new Ledger(plane.buckets, telemetry);
    this.categories = new CategoryRegistry(plane.categories);
    for (const p of plane.projects) this.projects.set(p.id, p);
  }

  project(id: string): ProjectConfig | undefined {
    return this.projects.get(id);
  }

  /** Admission decision for a synchronous request. */
  admit(req: InternalRequest, project?: string): AdmitDecision {
    const proj = project ? this.projects.get(project) : undefined;
    const requested = proj?.category ?? req.model;
    let resolved: ResolvedCategory;
    try {
      resolved = this.categories.resolve(requested, this.models);
    } catch (e) {
      return { action: "reject", status: 400, reason: e instanceof Error ? e.message : String(e) };
    }
    const quotaBucketId = proj?.quotaBucketId ?? resolved.quotaBucketId;
    const deadlineMs = proj?.deadlineMs ?? resolved.deadlineMs;
    const check = this.ledger.check(quotaBucketId);
    if (!check.allowed) {
      return { action: "reject", status: 429, reason: check.reason ?? "quota exceeded" };
    }
    const context: DispatchContext = {
      model: resolved.model,
      category: resolved.category.id,
      project,
      quotaBucketId,
      deadlineMs,
      priority: PRIORITY.sync,
      source: "sync-worker",
    };
    this.telemetry.emit("admit", { project, category: context.category, bucket: quotaBucketId, source: "sync-worker" });
    return { action: "dispatch", context };
  }

  /** Enqueue an event-driven work item. Returns the created WorkItem. */
  enqueueEvent(input: EventInput): WorkItem {
    const proj = input.project ? this.projects.get(input.project) : undefined;
    const requested = input.category ?? proj?.category ?? input.model ?? "";
    let quotaBucketId = proj?.quotaBucketId;
    let deadlineMs = proj?.deadlineMs;
    let category = input.category ?? proj?.category;
    if (requested) {
      try {
        const resolved = this.categories.resolve(requested, this.models);
        quotaBucketId = quotaBucketId ?? resolved.quotaBucketId;
        deadlineMs = deadlineMs ?? resolved.deadlineMs;
        category = category ?? resolved.category.id;
      } catch {
        // Unknown category/model: still enqueue; allocation surfaces the error.
      }
    }
    const now = Date.now();
    const messages: InternalMessage[] = (input.messages ?? []).map(parseMessage);
    const item: WorkItem = {
      id: nextWorkId(),
      priority: input.priority ?? PRIORITY.event,
      project: input.project,
      category,
      quotaBucketId,
      deadlineMs,
      expiresAt: deadlineMs ? now + deadlineMs : undefined,
      request: { model: requested, messages, tools: input.tools, stream: false },
      enqueuedAt: now,
      status: "queued",
    };
    this.queue.enqueue(item);
    this.telemetry.emit("work.enqueue", { id: item.id, project: item.project, category, priority: item.priority });
    return item;
  }

  /** Look up a work item (queued or completed) by id. */
  work(id: string): WorkItem | undefined {
    return this.queue.get(id) ?? this.completed.get(id);
  }

  /** One allocation pass: drives queued work through the dispatcher. */
  tick(now = Date.now()): AllocateResult {
    const res = runAllocator(
      this.queue,
      (item) => this.ledger.check(item.quotaBucketId).allowed,
      (item) => {
        this.completed.set(item.id, item);
        void this.dispatchWork(item);
      },
      now,
      (item) => this.completed.set(item.id, item),
    );
    this.telemetry.emit("work.tick", { allocated: res.allocated.length, expired: res.expired.length, blocked: res.blocked.length });
    return res;
  }

  private async dispatchWork(item: WorkItem): Promise<void> {
    try {
      if (!item.request) {
        item.status = "shed";
        item.error = "no drivable request (deferred handles require a provider that implements them)";
        this.telemetry.emit("work.shed", { id: item.id, reason: item.error });
        return;
      }
      const resolved = this.categories.resolve(item.request.model, this.models);
      const msg = await this.dispatcher.complete(resolved.model, item.request, item.deadlineMs);
      this.ledger.record(item.quotaBucketId, msg.usage);
      item.status = "completed";
      item.result = assistantMessageToInternal(msg);
      this.telemetry.emit("work.complete", { id: item.id, tokens: msg.usage.totalTokens });
    } catch (e) {
      item.status = "shed";
      item.error = e instanceof Error ? e.message : String(e);
      this.telemetry.emit("work.error", { id: item.id, error: item.error });
    }
  }
}
