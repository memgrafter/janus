import { describe, expect, it } from "bun:test";
import { completionToOpenAI, modelListToOpenAI, OpenAIError, parseChatRequest, StreamChunker } from "../../src/openai.ts";

describe("parseChatRequest", () => {
	it("parses a basic request", () => {
		const r = parseChatRequest({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }], stream: false });
		expect(r.model).toBe("openai/gpt-4o");
		expect(r.messages).toEqual([{ role: "user", content: "hi" }]);
		expect(r.stream).toBe(false);
	});

	it("requires model", () => {
		expect(() => parseChatRequest({ messages: [] })).toThrow(OpenAIError);
	});

	it("treats a developer-role message as system", () => {
		const r = parseChatRequest({ model: "m", messages: [{ role: "developer", content: "be terse" }, { role: "user", content: "hi" }] });
		expect(r.messages).toEqual([{ role: "system", content: "be terse" }, { role: "user", content: "hi" }]);
	});

	it("parses tools, temperature, and max_tokens", () => {
		const r = parseChatRequest({
			model: "m",
			messages: [{ role: "user", content: "hi" }],
			tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
			temperature: 0.5,
			max_tokens: 100,
		});
		expect(r.tools).toEqual([{ name: "f", description: "d", parameters: { type: "object" } }]);
		expect(r.temperature).toBe(0.5);
		expect(r.maxTokens).toBe(100);
	});

	it("accepts max_completion_tokens as maxTokens", () => {
		const r = parseChatRequest({ model: "m", messages: [], max_completion_tokens: 42 });
		expect(r.maxTokens).toBe(42);
	});

	it("parses thinking_token_budget (vLLM)", () => {
		const r = parseChatRequest({ model: "m", messages: [], thinking_token_budget: 1024 });
		expect(r.thinkingTokenBudget).toBe(1024);
	});

	it("parses thinking_budget_tokens (llama.cpp)", () => {
		const r = parseChatRequest({ model: "m", messages: [], thinking_budget_tokens: 2048 });
		expect(r.thinkingTokenBudget).toBe(2048);
	});

	it("prefers thinking_token_budget over thinking_budget_tokens", () => {
		const r = parseChatRequest({ model: "m", messages: [], thinking_token_budget: 1024, thinking_budget_tokens: 2048 });
		expect(r.thinkingTokenBudget).toBe(1024);
	});

	it("ignores non-numeric budget values", () => {
		const r = parseChatRequest({ model: "m", messages: [], thinking_token_budget: "1024" });
		expect(r.thinkingTokenBudget).toBeUndefined();
	});

	it("parses assistant tool_calls with string arguments", () => {
		const r = parseChatRequest({
			model: "m",
			messages: [
				{ role: "assistant", content: "", tool_calls: [{ id: "t1", function: { name: "f", arguments: '{"a":1}' } }] },
				{ role: "tool", tool_call_id: "t1", content: "result" },
			],
		});
		expect(r.messages[1]).toEqual({ role: "tool", toolCallId: "t1", content: "result" });
		expect((r.messages[0] as any).toolCalls).toEqual([{ id: "t1", name: "f", arguments: { a: 1 } }]);
	});
});

describe("completionToOpenAI", () => {
	it("maps a text response with usage", () => {
		const out = completionToOpenAI({
			content: "hello",
			toolCalls: [],
			stopReason: "stop",
			usage: { input: 5, output: 7, totalTokens: 12 },
			model: "m",
		}) as any;
		expect(out.object).toBe("chat.completion");
		expect(out.choices[0].message.content).toBe("hello");
		expect(out.choices[0].finish_reason).toBe("stop");
		expect(out.usage).toEqual({ prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 });
	});

	it("maps tool calls with stringified arguments and tool_calls finish reason", () => {
		const out = completionToOpenAI({
			content: "",
			toolCalls: [{ id: "t1", name: "f", arguments: { a: 1 } }],
			stopReason: "toolUse",
			usage: { input: 1, output: 1, totalTokens: 2 },
			model: "m",
		}) as any;
		expect(out.choices[0].message.tool_calls[0].function.arguments).toBe('{"a":1}');
		expect(out.choices[0].finish_reason).toBe("tool_calls");
	});

	it("carries thinking as reasoning_content on the message", () => {
		const out = completionToOpenAI({
			content: "42",
			toolCalls: [],
			thinking: "let me think...",
			stopReason: "stop",
			usage: { input: 1, output: 1, totalTokens: 2 },
			model: "m",
		}) as any;
		expect(out.choices[0].message.reasoning_content).toBe("let me think...");
		expect(out.choices[0].message.content).toBe("42");
	});

	it("omits reasoning_content when there is no thinking", () => {
		const out = completionToOpenAI({
			content: "hi",
			toolCalls: [],
			stopReason: "stop",
			usage: { input: 1, output: 1, totalTokens: 2 },
			model: "m",
		}) as any;
		expect(out.choices[0].message.reasoning_content).toBeUndefined();
	});

	it("embeds the provider error detail in finish_reason and a top-level error field", () => {
		const detail = "400: This model's maximum context length is 262144 tokens but you requested 262145.";
		const out = completionToOpenAI({
			content: "",
			toolCalls: [],
			stopReason: "error",
			errorMessage: detail,
			usage: { input: 1, output: 0, totalTokens: 1 },
			model: "m",
		}) as any;
		expect(out.choices[0].finish_reason).toContain("262144");
		expect(out.error).toEqual({ message: detail, type: "provider_error", code: null });
	});

	it("falls back to finish_reason=error when there is no error message", () => {
		const out = completionToOpenAI({
			content: "",
			toolCalls: [],
			stopReason: "error",
			usage: { input: 1, output: 0, totalTokens: 1 },
			model: "m",
		}) as any;
		expect(out.choices[0].finish_reason).toBe("error");
		expect(out.error).toBeUndefined();
	});
});

describe("modelListToOpenAI", () => {
	it("maps entries to OpenAI model objects", () => {
		const out = modelListToOpenAI([{ id: "openai/gpt-4o", provider: "openai" }]) as any;
		expect(out.object).toBe("list");
		expect(out.data[0]).toEqual({ id: "openai/gpt-4o", object: "model", created: 0, owned_by: "openai" });
	});
});

describe("StreamChunker", () => {
	it("emits role, text, and done with usage", () => {
		const c = new StreamChunker("m");
		expect((c.start() as any).choices[0].delta.role).toBe("assistant");
		expect((c.text("hi") as any).choices[0].delta.content).toBe("hi");
		const done = c.done("stop", { input: 1, output: 1, totalTokens: 2 }) as any;
		expect(done.choices[0].finish_reason).toBe("stop");
		expect(done.usage.total_tokens).toBe(2);
	});

	it("emits thinking deltas in the reasoning_content field", () => {
		const c = new StreamChunker("m");
		const t = c.thinking("hmm ") as any;
		expect(t.choices[0].delta.reasoning_content).toBe("hmm ");
		expect(t.choices[0].delta.content).toBeUndefined();
	});

	it("done() embeds the provider error detail in finish_reason and a top-level error field", () => {
		const c = new StreamChunker("m");
		const detail = "400: context length exceeded (262144 limit)";
		const done = c.done("error", { input: 1, output: 0, totalTokens: 1 }, detail) as any;
		expect(done.choices[0].finish_reason).toContain("262144");
		expect(done.error).toEqual({ message: detail, type: "provider_error", code: null });
	});

	it("done() leaves finish_reason=error and no error field when no message is given", () => {
		const c = new StreamChunker("m");
		const done = c.done("error", { input: 1, output: 0, totalTokens: 1 }) as any;
		expect(done.choices[0].finish_reason).toBe("error");
		expect(done.error).toBeUndefined();
	});

	it("done() ignores the error message for a non-error stop reason", () => {
		const c = new StreamChunker("m");
		const done = c.done("stop", { input: 1, output: 1, totalTokens: 2 }, "should be ignored") as any;
		expect(done.choices[0].finish_reason).toBe("stop");
		expect(done.error).toBeUndefined();
	});

	it("assigns sequential tool_call indices", () => {
		const c = new StreamChunker("m");
		const a = c.toolCallStart(0, "t1", "f") as any;
		const b = c.toolCallStart(1, "t2", "g") as any;
		expect(a.choices[0].delta.tool_calls[0].index).toBe(0);
		expect(b.choices[0].delta.tool_calls[0].index).toBe(1);
		expect((c.toolCallDelta(0, '{"x":') as any).choices[0].delta.tool_calls[0].index).toBe(0);
		expect(c.toolCallDelta(99, "nope")).toBeNull();
	});
});
