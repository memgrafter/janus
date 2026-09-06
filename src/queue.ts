/**
 * Priority queue & expiring-work allocation (pj-1s1x). A binary max-heap of work
 * items ordered by (priority desc, enqueuedAt asc), plus a pure allocation pass
 * that expires stale items, skips quota-blocked items, and drives the rest.
 */

import type { InternalRequest } from "./openai.ts";

export type WorkStatus = "queued" | "allocated" | "completed" | "failed" | "expired" | "shed";

export interface WorkItem {
  id: string;
  /** Higher = more urgent. */
  priority: number;
  project?: string;
  category?: string;
  quotaBucketId?: string;
  deadlineMs?: number;
  /** Wall-clock ms after which the item expires. */
  expiresAt?: number;
  pollAfterMs?: number;
  /** pi-ai DeferredHandle (expiring in-flight work). */
  deferredHandle?: unknown;
  /** A plain queued request to dispatch. */
  request?: InternalRequest;
  enqueuedAt: number;
  status: WorkStatus;
  result?: unknown;
  error?: string;
}

export class PriorityQueue {
  private heap: WorkItem[] = [];
  private byId = new Map<string, WorkItem>();

  get size(): number {
    return this.heap.length;
  }

  /** True if `a` should be ordered before `b`. */
  private higher(a: WorkItem, b: WorkItem): boolean {
    if (a.priority !== b.priority) return a.priority > b.priority;
    return a.enqueuedAt < b.enqueuedAt;
  }

  enqueue(item: WorkItem): void {
    if (this.byId.has(item.id)) throw new Error(`duplicate work id ${item.id}`);
    this.byId.set(item.id, item);
    this.heap.push(item);
    this.bubbleUp(this.heap.length - 1);
  }

  peek(): WorkItem | undefined {
    return this.heap[0];
  }

  pop(): WorkItem | undefined {
    const top = this.heap[0];
    if (!top) return undefined;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    this.byId.delete(top.id);
    return top;
  }

  get(id: string): WorkItem | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Remove a specific item by id (heap-safe). Returns it, or undefined. */
  remove(id: string): WorkItem | undefined {
    const idx = this.heap.findIndex((w) => w.id === id);
    if (idx === -1) return undefined;
    const item = this.heap[idx];
    this.heap.splice(idx, 1);
    this.byId.delete(id);
    if (idx < this.heap.length) {
      this.bubbleUp(idx);
      this.sinkDown(idx);
    }
    return item;
  }

  /** All items in priority order (snapshot, does not mutate the queue). */
  sorted(): WorkItem[] {
    return [...this.heap].sort((a, b) => (this.higher(a, b) ? -1 : this.higher(b, a) ? 1 : 0));
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.higher(this.heap[i], this.heap[parent])) {
        [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
        i = parent;
      } else break;
    }
  }

  private sinkDown(i: number): void {
    const n = this.heap.length;
    for (;;) {
      const l = i * 2 + 1;
      const r = i * 2 + 2;
      let biggest = i;
      if (l < n && this.higher(this.heap[l], this.heap[biggest])) biggest = l;
      if (r < n && this.higher(this.heap[r], this.heap[biggest])) biggest = r;
      if (biggest === i) break;
      [this.heap[i], this.heap[biggest]] = [this.heap[biggest], this.heap[i]];
      i = biggest;
    }
  }
}

export interface AllocateResult {
  allocated: string[];
  expired: string[];
  blocked: string[];
}

/**
 * One allocation pass: walk the queue in priority order, expiring stale items,
 * holding (skipping) items that can't be allocated now, and driving the rest.
 * Held items are re-enqueued after the pass. Pure w.r.t. the queue except for
 * the items it allocates or expires.
 */
export function runAllocator(
  queue: PriorityQueue,
  canAllocate: (item: WorkItem) => boolean,
  drive: (item: WorkItem) => void,
  now = Date.now(),
  onExpire?: (item: WorkItem) => void,
): AllocateResult {
  const res: AllocateResult = { allocated: [], expired: [], blocked: [] };
  const held: WorkItem[] = [];
  for (;;) {
    const top = queue.peek();
    if (!top) break;
    if (top.expiresAt !== undefined && top.expiresAt <= now) {
      queue.pop();
      top.status = "expired";
      res.expired.push(top.id);
      onExpire?.(top);
      continue;
    }
    if (!canAllocate(top)) {
      held.push(queue.pop()!);
      res.blocked.push(top.id);
      continue;
    }
    queue.pop();
    top.status = "allocated";
    drive(top);
    res.allocated.push(top.id);
  }
  for (const h of held) queue.enqueue(h);
  return res;
}
