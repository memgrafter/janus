import { describe, expect, it } from "bun:test";
import { PriorityQueue, runAllocator, type WorkItem } from "../../src/queue.ts";

function item(id: string, priority: number, enqueuedAt: number, extra: Partial<WorkItem> = {}): WorkItem {
	return { id, priority, enqueuedAt, status: "queued", ...extra };
}

describe("PriorityQueue", () => {
	it("orders by priority desc, then enqueuedAt asc", () => {
		const q = new PriorityQueue();
		q.enqueue(item("low", 1, 100));
		q.enqueue(item("high", 10, 200));
		q.enqueue(item("mid", 5, 300));
		q.enqueue(item("high2", 10, 150)); // same priority as high, earlier
		expect(q.sorted().map((w) => w.id)).toEqual(["high2", "high", "mid", "low"]);
	});

	it("peek/pop returns the top", () => {
		const q = new PriorityQueue();
		q.enqueue(item("a", 1, 1));
		q.enqueue(item("b", 2, 2));
		expect(q.peek()?.id).toBe("b");
		expect(q.pop()?.id).toBe("b");
		expect(q.pop()?.id).toBe("a");
		expect(q.pop()).toBeUndefined();
	});

	it("remove by id keeps the heap valid", () => {
		const q = new PriorityQueue();
		q.enqueue(item("a", 1, 1));
		q.enqueue(item("b", 3, 2));
		q.enqueue(item("c", 2, 3));
		q.remove("b");
		expect(q.has("b")).toBe(false);
		expect(q.sorted().map((w) => w.id)).toEqual(["c", "a"]);
	});

	it("rejects duplicate ids", () => {
		const q = new PriorityQueue();
		q.enqueue(item("a", 1, 1));
		expect(() => q.enqueue(item("a", 1, 2))).toThrow();
	});
});

describe("runAllocator", () => {
	it("allocates in priority order", () => {
		const q = new PriorityQueue();
		q.enqueue(item("low", 1, 1, { request: { model: "m", messages: [], stream: false } }));
		q.enqueue(item("high", 10, 2, { request: { model: "m", messages: [], stream: false } }));
		const driven: string[] = [];
		const res = runAllocator(q, () => true, (i) => driven.push(i.id));
		expect(driven).toEqual(["high", "low"]);
		expect(res.allocated).toEqual(["high", "low"]);
		expect(q.size).toBe(0);
	});

	it("expires items past expiresAt and reports them", () => {
		const q = new PriorityQueue();
		q.enqueue(item("stale", 10, 1, { expiresAt: 1000 }));
		q.enqueue(item("fresh", 5, 2, { expiresAt: 9_999_999_999_999 }));
		const expired: string[] = [];
		const driven: string[] = [];
		const res = runAllocator(q, () => true, (i) => driven.push(i.id), 2000, (i) => expired.push(i.id));
		expect(expired).toEqual(["stale"]);
		expect(driven).toEqual(["fresh"]);
		expect(res.expired).toEqual(["stale"]);
	});

	it("holds quota-blocked items and re-enqueues them", () => {
		const q = new PriorityQueue();
		q.enqueue(item("blocked", 10, 1, { quotaBucketId: "full" }));
		q.enqueue(item("ok", 5, 2, { quotaBucketId: "open" }));
		const driven: string[] = [];
		const res = runAllocator(q, (i) => i.quotaBucketId !== "full", (i) => driven.push(i.id));
		expect(driven).toEqual(["ok"]);
		expect(res.blocked).toEqual(["blocked"]);
		expect(q.size).toBe(1);
		expect(q.peek()?.id).toBe("blocked");
	});
});
