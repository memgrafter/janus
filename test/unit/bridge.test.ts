import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "bun:test";
import { assistantMessageToInternal, toPiContext, toPiStreamOptions } from "../../src/bridge.ts";

const gptModel = { id: "gpt-4o", provider: "openai", api: "openai-responses" } as unknown as Model<Api>;

describe("toPiContext", () => {
	it("extracts system prompt and user messages", () => {
		const ctx = toPiContext(
			{ model: "m", messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], stream: false },
			gptModel,
		);
		expect(ctx.systemPrompt).toBe("sys");
		expect(ctx.messages).toHaveLength(1);
		expect(ctx.messages[0]).toMatchObject({ role: "user", content: "hi" });
	});

	it("maps tools", () => {
		const ctx = toPiContext(
			{ model: "m", messages: [{ role: "user", content: "hi" }], tools: [{ name: "f", parameters: { type: "object" } }], stream: false },
			gptModel,
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
			gptModel,
		);
		const assistant = ctx.messages[1] as AssistantMessage;
		expect(assistant.content).toEqual([{ type: "toolCall", id: "t1", name: "f", arguments: { a: 1 } }]);
		expect(assistant.stopReason).toBe("toolUse");
		expect(ctx.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "t1" });
	});
});

describe("toPiStreamOptions", () => {
	it("passes temperature and maxTokens", () => {
		const opts = toPiStreamOptions({ model: "m", messages: [], temperature: 0.3, maxTokens: 55, stream: false }, gptModel);
		expect(opts.temperature).toBe(0.3);
		expect(opts.maxTokens).toBe(55);
	});

	it("omits onPayload for a non-qwen model with no reasoning signal", () => {
		const opts = toPiStreamOptions({ model: "m", messages: [], stream: false }, gptModel);
		expect(opts.onPayload).toBeUndefined();
	});
});

// A qwen-chat-template model factory. `reasoning` can be false to model an
// instruct alias that shares the thinking endpoint.
function qwenModel(overrides: Record<string, unknown> = {}): Model<Api> {
	return {
		id: "qwen3.8-27b",
		provider: "vert",
		api: "openai-completions",
		reasoning: true,
		compat: { thinkingFormat: "qwen-chat-template", supportsReasoningEffort: true },
		...overrides,
	} as unknown as Model<Api>;
}

// Mimic pi-ai's buildParams output for a qwen model: it emits a
// chat_template_kwargs with enable_thinking reflecting !!reasoningEffort.
function qwenPayload(): Record<string, unknown> {
	return { model: "m", messages: [], chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } };
}

// Run the options' onPayload against a qwen-shaped payload and return the
// result.
function transformed(req: { reasoningEffort?: string; thinkingTokenBudget?: number }, model: Model<Api>): unknown {
	const opts = toPiStreamOptions({ model: "m", messages: [], stream: false, ...req }, model);
	expect(opts.onPayload).toBeInstanceOf(Function);
	return opts.onPayload!(qwenPayload(), model);
}

describe("toPiStreamOptions qwen effort (reasoning model)", () => {
	it("adds mapped reasoning_effort for a reasoning model", () => {
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
			// Existing payload fields are preserved (thinking stays on).
			expect(out.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });
		}
	});

	it("prefers thinkingLevelMap over the default mapping", () => {
		const out = transformed({ reasoningEffort: "high" }, qwenModel({ thinkingLevelMap: { high: "custom" } })) as Record<string, unknown>;
		expect(out.reasoning_effort).toBe("custom");
	});

	it("forces enable_thinking off when the client sends reasoning_effort off", () => {
		const out = transformed({ reasoningEffort: "off" }, qwenModel()) as Record<string, unknown>;
		expect(out.chat_template_kwargs).toEqual({ enable_thinking: false, preserve_thinking: true });
		expect(out.reasoning_effort).toBeUndefined();
	});

	it("leaves the payload unchanged when supportsReasoningEffort is false and effort is not off", () => {
		const out = transformed(
			{ reasoningEffort: "high" },
			qwenModel({ compat: { thinkingFormat: "qwen-chat-template", supportsReasoningEffort: false } }),
		);
		// No effort/budget applies and the model is reasoning (not forced off),
		// so the payload is untouched.
		expect(out).toBeUndefined();
	});

	it("leaves the payload unchanged for other thinking formats", () => {
		const out = transformed({ reasoningEffort: "high" }, qwenModel({ compat: { thinkingFormat: "openai", supportsReasoningEffort: true } }));
		expect(out).toBeUndefined();
	});
});

describe("toPiStreamOptions qwen effort (instruct / non-reasoning model)", () => {
	const instruct = () => qwenModel({ reasoning: false, compat: { thinkingFormat: "qwen-chat-template", supportsReasoningEffort: true } });

	it("forces enable_thinking off even when the client sent no reasoning signal", () => {
		const out = transformed({}, instruct()) as Record<string, unknown>;
		expect(out.chat_template_kwargs).toEqual({ enable_thinking: false, preserve_thinking: true });
	});

	it("forces enable_thinking off regardless of effort (ignores effort on a non-reasoning model)", () => {
		for (const effort of ["off", "high"] as const) {
			const out = transformed({ reasoningEffort: effort }, instruct()) as Record<string, unknown>;
			expect(out.chat_template_kwargs).toEqual({ enable_thinking: false, preserve_thinking: true });
			expect(out.reasoning_effort).toBeUndefined();
		}
	});
});

describe("toPiStreamOptions thinking token budget", () => {
	it("does not add a budget field unless the upstream model advertises one", () => {
		const out = transformed({ thinkingTokenBudget: 1024 }, qwenModel());
		expect(out).toBeUndefined();
	});

	it("adds only the budget field advertised by the upstream model", () => {
		for (const field of ["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"] as const) {
			const model = qwenModel({
				compat: { thinkingFormat: "qwen-chat-template", supportsReasoningEffort: true, thinkingTokenBudgetField: field },
			});
			const out = transformed({ thinkingTokenBudget: 1024 }, model) as Record<string, unknown>;
			expect(out[field]).toBe(1024);
			for (const other of ["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"]) {
				if (other !== field) expect(out[other]).toBeUndefined();
			}
		}
	});

	it("supports the legacy vLLM budget capability flag", () => {
		const model = qwenModel({
			compat: { thinkingFormat: "qwen-chat-template", supportsReasoningEffort: true, supportsThinkingTokenBudget: true },
		});
		const out = transformed({ thinkingTokenBudget: 1024 }, model) as Record<string, unknown>;
		expect(out.thinking_token_budget).toBe(1024);
		expect(out.thinking_budget).toBeUndefined();
		expect(out.thinking_budget_tokens).toBeUndefined();
	});

	it("combines a configured budget field with mapped reasoning_effort", () => {
		const opts = toPiStreamOptions(
			{ model: "m", messages: [], stream: false, reasoningEffort: "high", thinkingTokenBudget: 2048 },
			qwenModel({ compat: { thinkingFormat: "qwen-chat-template", supportsReasoningEffort: true, thinkingTokenBudgetField: "thinking_token_budget" } }),
		);
		const out = opts.onPayload!(qwenPayload(), qwenModel({ compat: { thinkingFormat: "qwen-chat-template", supportsReasoningEffort: true, thinkingTokenBudgetField: "thinking_token_budget" } })) as Record<string, unknown>;
		expect(out.reasoning_effort).toBe("xhigh");
		expect(out.thinking_token_budget).toBe(2048);
		expect(out.thinking_budget_tokens).toBeUndefined();
	});

	it("omits onPayload for a non-qwen model with no budget and no effort", () => {
		const opts = toPiStreamOptions({ model: "m", messages: [], stream: false }, gptModel);
		expect(opts.onPayload).toBeUndefined();
	});

	it("ignores the budget on a non-reasoning (instruct) model but still forces thinking off", () => {
		const model = qwenModel({
			reasoning: false,
			compat: { thinkingFormat: "qwen-chat-template", supportsReasoningEffort: true, thinkingTokenBudgetField: "thinking_token_budget" },
		});
		const out = transformed({ thinkingTokenBudget: 1024 }, model) as Record<string, unknown>;
		expect(out.thinking_token_budget).toBeUndefined();
		expect(out.chat_template_kwargs).toEqual({ enable_thinking: false, preserve_thinking: true });
	});

	it("leaves the payload unchanged for other thinking formats", () => {
		const out = transformed({ thinkingTokenBudget: 1024 }, qwenModel({ compat: { thinkingFormat: "openai", supportsReasoningEffort: true } }));
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
