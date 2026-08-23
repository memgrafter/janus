import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "bun:test";
import { assistantMessageToInternal, toPiContext, toPiStreamOptions } from "../../src/bridge.ts";

const model = { id: "gpt-4o", provider: "openai", api: "openai-responses" } as unknown as Model<Api>;

describe("toPiContext", () => {
	it("extracts system prompt and user messages", () => {
		const ctx = toPiContext(
			{ model: "m", messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], stream: false },
			model,
		);
		expect(ctx.systemPrompt).toBe("sys");
		expect(ctx.messages).toHaveLength(1);
		expect(ctx.messages[0]).toMatchObject({ role: "user", content: "hi" });
	});

	it("maps tools", () => {
		const ctx = toPiContext(
			{ model: "m", messages: [{ role: "user", content: "hi" }], tools: [{ name: "f", parameters: { type: "object" } }], stream: false },
			model,
		);
		expect(ctx.tools).toHaveLength(1);
		expect(ctx.tools![0].name).toBe("f");
	});

	it("maps assistant tool calls and tool results", () => {
		const ctx = toPiContext(
			{
				model: "m",
				messages: [
					{ role: "user", content: "hi" },
					{ role: "assistant", content: "", toolCalls: [{ id: "t1", name: "f", arguments: { a: 1 } }] },
					{ role: "tool", toolCallId: "t1", content: "result" },
				],
				stream: false,
			},
			model,
		);
		const assistant = ctx.messages[1] as AssistantMessage;
		expect(assistant.content).toEqual([{ type: "toolCall", id: "t1", name: "f", arguments: { a: 1 } }]);
		expect(assistant.stopReason).toBe("toolUse");
		expect(ctx.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "t1" });
	});
});

describe("toPiStreamOptions", () => {
	it("passes temperature and maxTokens", () => {
		const opts = toPiStreamOptions({ model: "m", messages: [], temperature: 0.3, maxTokens: 55, stream: false });
		expect(opts.temperature).toBe(0.3);
		expect(opts.maxTokens).toBe(55);
	});
});

describe("assistantMessageToInternal", () => {
	it("maps text and usage", () => {
		const msg = {
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4o",
			usage: { input: 3, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 0,
		} as unknown as AssistantMessage;
		const r = assistantMessageToInternal(msg);
		expect(r.content).toBe("hello");
		expect(r.stopReason).toBe("stop");
		expect(r.usage).toEqual({ input: 3, output: 4, totalTokens: 7, cacheRead: 2 });
	});
});
