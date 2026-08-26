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

	it("omits onPayload when the client sends no reasoning effort", () => {
		const opts = toPiStreamOptions({ model: "m", messages: [], stream: false });
		expect(opts.onPayload).toBeUndefined();
	});
});

describe("toPiStreamOptions qwen reasoning_effort", () => {
	const qwenModel = (overrides: Record<string, unknown> = {}): Model<Api> =>
		({
			id: "qwen3.8-27b",
			provider: "vert-qwen38-dual-fast",
			api: "openai-completions",
			reasoning: true,
			compat: { thinkingFormat: "qwen-chat-template", supportsReasoningEffort: true },
			...overrides,
		}) as unknown as Model<Api>;

	// Run the options' onPayload against a pi-ai-shaped qwen payload (as
	// buildParams would produce it) and return the result.
	function transformed(req: { reasoningEffort?: string }, model: Model<Api>): unknown {
		const opts = toPiStreamOptions({ model: "m", messages: [], stream: false, ...req });
		expect(opts.onPayload).toBeInstanceOf(Function);
		const payload = { model: "m", messages: [], chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } };
		return opts.onPayload!(payload, model);
	}

	it("adds mapped reasoning_effort for qwen-chat-template models", () => {
		for (const [effort, expected] of [
			["minimal", "low"],
			["low", "low"],
			["medium", "medium"],
			["high", "xhigh"],
			["xhigh", "xhigh"],
			["max", "xhigh"],
		] as const) {
			const out = transformed({ reasoningEffort: effort }, qwenModel()) as Record<string, unknown>;
			expect(out.reasoning_effort).toBe(expected);
			// Existing payload fields are preserved.
			expect(out.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });
		}
	});

	it("prefers thinkingLevelMap over the default mapping", () => {
		const out = transformed({ reasoningEffort: "high" }, qwenModel({ thinkingLevelMap: { high: "custom" } })) as Record<string, unknown>;
		expect(out.reasoning_effort).toBe("custom");
	});

	it("leaves the payload unchanged when supportsReasoningEffort is false", () => {
		const out = transformed(
			{ reasoningEffort: "high" },
			qwenModel({ compat: { thinkingFormat: "qwen-chat-template", supportsReasoningEffort: false } }),
		);
		expect(out).toBeUndefined();
	});

	it("leaves the payload unchanged for other thinking formats", () => {
		const out = transformed({ reasoningEffort: "high" }, qwenModel({ compat: { thinkingFormat: "openai", supportsReasoningEffort: true } }));
		expect(out).toBeUndefined();
	});

	it("leaves the payload unchanged for non-reasoning models", () => {
		const out = transformed({ reasoningEffort: "high" }, qwenModel({ reasoning: false }));
		expect(out).toBeUndefined();
	});
});

describe("toPiStreamOptions thinking token budget", () => {
	const qwenModel = (overrides: Record<string, unknown> = {}): Model<Api> =>
		({
			id: "qwen3.8-27b",
			provider: "vert-qwen38-dual-fast",
			api: "openai-completions",
			reasoning: true,
			compat: { thinkingFormat: "qwen-chat-template", supportsReasoningEffort: true },
			...overrides,
		}) as unknown as Model<Api>;

	function transformed(req: { thinkingTokenBudget?: number }, model: Model<Api>): unknown {
		const opts = toPiStreamOptions({ model: "m", messages: [], stream: false, ...req });
		expect(opts.onPayload).toBeInstanceOf(Function);
		const payload = { model: "m", messages: [], chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } };
		return opts.onPayload!(payload, model);
	}

	it("adds both budget fields for qwen-chat-template models", () => {
		const out = transformed({ thinkingTokenBudget: 1024 }, qwenModel()) as Record<string, unknown>;
		expect(out.thinking_token_budget).toBe(1024);
		expect(out.thinking_budget_tokens).toBe(1024);
		expect(out.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });
	});

	it("combines budget with mapped reasoning_effort", () => {
		const opts = toPiStreamOptions({ model: "m", messages: [], stream: false, reasoningEffort: "high", thinkingTokenBudget: 2048 });
		const out = opts.onPayload!({ model: "m", messages: [] }, qwenModel()) as Record<string, unknown>;
		expect(out.reasoning_effort).toBe("xhigh");
		expect(out.thinking_token_budget).toBe(2048);
		expect(out.thinking_budget_tokens).toBe(2048);
	});

	it("omits onPayload when the client sends no budget and no effort", () => {
		const opts = toPiStreamOptions({ model: "m", messages: [], stream: false });
		expect(opts.onPayload).toBeUndefined();
	});

	it("leaves the payload unchanged for other thinking formats", () => {
		const out = transformed({ thinkingTokenBudget: 1024 }, qwenModel({ compat: { thinkingFormat: "openai", supportsReasoningEffort: true } }));
		expect(out).toBeUndefined();
	});

	it("leaves the payload unchanged for non-reasoning models", () => {
		const out = transformed({ thinkingTokenBudget: 1024 }, qwenModel({ reasoning: false }));
		expect(out).toBeUndefined();
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
