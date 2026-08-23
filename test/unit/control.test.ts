import { describe, expect, it } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Control, PRIORITY, type Dispatcher } from "../../src/control.ts";
import { InMemoryTelemetry } from "../../src/telemetry.ts";

function fauxModels() {
	const faux = fauxProvider({ models: [{ id: "faux", name: "Faux", contextWindow: 8192, maxTokens: 2048 }] });
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}

function fakeDispatcher(text = "done"): Dispatcher {
	return {
		async complete() {
			return fauxAssistantMessage(text);
		},
	};
}

const plane = {
	buckets: [{ id: "b1", limitTokens: 1000, deadlineMs: 5000 }],
	categories: [{ id: "fast", models: ["faux/faux"], quotaBucketId: "b1", deadlineMs: 5000 }],
	projects: [{ id: "demo", category: "fast", quotaBucketId: "b1", deadlineMs: 5000 }],
};

describe("Control.admit", () => {
	it("dispatches with the resolved category binding", () => {
		const control = new Control(fauxModels(), plane, new InMemoryTelemetry(), fakeDispatcher());
		const d = control.admit({ model: "fast", messages: [{ role: "user", content: "hi" }], stream: false });
		expect(d.action).toBe("dispatch");
		if (d.action === "dispatch") {
			expect(d.context.category).toBe("fast");
			expect(d.context.quotaBucketId).toBe("b1");
			expect(d.context.deadlineMs).toBe(5000);
			expect(d.context.priority).toBe(PRIORITY.sync);
			expect(d.context.source).toBe("sync-worker");
			expect(d.context.model.id).toBe("faux");
		}
	});

	it("routes by project to the project's category", () => {
		const control = new Control(fauxModels(), plane, new InMemoryTelemetry(), fakeDispatcher());
		const d = control.admit({ model: "ignored", messages: [], stream: false }, "demo");
		expect(d.action).toBe("dispatch");
		if (d.action === "dispatch") {
			expect(d.context.category).toBe("fast");
			expect(d.context.project).toBe("demo");
		}
	});

	it("rejects (429) when the quota is exceeded", () => {
		const control = new Control(fauxModels(), plane, new InMemoryTelemetry(), fakeDispatcher());
		control.ledger.record("b1", { totalTokens: 1001 });
		const d = control.admit({ model: "fast", messages: [], stream: false });
		expect(d.action).toBe("reject");
		if (d.action === "reject") {
			expect(d.status).toBe(429);
			expect(d.reason).toContain("quota exceeded");
		}
	});

	it("rejects (400) for an unknown model", () => {
		const control = new Control(fauxModels(), plane, new InMemoryTelemetry(), fakeDispatcher());
		const d = control.admit({ model: "nope/nope", messages: [], stream: false });
		expect(d.action).toBe("reject");
		if (d.action === "reject") expect(d.status).toBe(400);
	});
});

describe("Control event intake + allocation", () => {
	it("enqueues an event for the correct project and allocates it", async () => {
		const control = new Control(fauxModels(), plane, new InMemoryTelemetry(), fakeDispatcher("event result"));
		const item = control.enqueueEvent({ project: "demo", messages: [{ role: "user", content: "hi" }] });
		expect(item.project).toBe("demo");
		expect(item.category).toBe("fast");
		expect(item.quotaBucketId).toBe("b1");
		expect(item.priority).toBe(PRIORITY.event);
		expect(control.queue.size).toBe(1);

		control.tick();
		await new Promise((r) => setTimeout(r, 15)); // let the async dispatch settle
		const w = control.work(item.id)!;
		expect(w.status).toBe("completed");
		expect((w.result as { content: string }).content).toBe("event result");
	});

	it("sync priority outranks event priority in the queue", () => {
		const control = new Control(fauxModels(), plane, new InMemoryTelemetry(), fakeDispatcher());
		const ev = control.enqueueEvent({ messages: [{ role: "user", content: "hi" }] });
		control.queue.enqueue({
			id: "sync1",
			priority: PRIORITY.sync,
			enqueuedAt: Date.now(),
			status: "queued",
			request: { model: "fast", messages: [], stream: false },
		});
		expect(control.queue.peek()?.id).toBe("sync1");
		expect(ev.priority).toBe(PRIORITY.event);
	});

	it("emits telemetry for enqueue and completion", async () => {
		const t = new InMemoryTelemetry();
		const control = new Control(fauxModels(), plane, t, fakeDispatcher());
		control.enqueueEvent({ category: "fast", messages: [{ role: "user", content: "hi" }] });
		control.tick();
		await new Promise((r) => setTimeout(r, 15));
		expect(t.where("work.enqueue")).toHaveLength(1);
		expect(t.where("work.complete")).toHaveLength(1);
	});
});
