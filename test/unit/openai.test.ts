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
