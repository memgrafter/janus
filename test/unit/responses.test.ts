import { describe, expect, it } from "bun:test";
import { parseResponsesRequest, responseToOpenAI, ResponsesChunker } from "../../src/responses.ts";
import type { InternalResponse } from "../../src/openai.ts";

describe("parseResponsesRequest", () => {
	it("maps a string input to a user message", () => {
		const r = parseResponsesRequest({ model: "m", input: "hello" });
		expect(r.model).toBe("m");
		expect(r.messages).toEqual([{ role: "user", content: "hello" }]);
		expect(r.stream).toBe(false);
	});

	it("maps instructions to a system message", () => {
		const r = parseResponsesRequest({ model: "m", input: "hi", instructions: "be brief" });
		expect(r.messages[0]).toEqual({ role: "system", content: "be brief" });
		expect(r.messages[1]).toEqual({ role: "user", content: "hi" });
	});

	it("maps function_call and function_call_output items", () => {
		const r = parseResponsesRequest({
			model: "m",
			input: [
				{ type: "message", role: "user", content: "what's 2+2?" },
				{ type: "function_call", name: "add", arguments: '{"a":2,"b":2}', call_id: "call_1" },
				{ type: "function_call_output", call_id: "call_1", output: "4" },
			],
		});
		expect(r.messages).toHaveLength(3);
		expect(r.messages[1]).toMatchObject({ role: "assistant", toolCalls: [{ name: "add", arguments: { a: 2, b: 2 } }] });
		expect(r.messages[2]).toEqual({ role: "tool", toolCallId: "call_1", content: "4" });
	});

	it("maps max_output_tokens and tools", () => {
		const r = parseResponsesRequest({ model: "m", input: "hi", max_output_tokens: 42, tools: [{ type: "function", name: "f", parameters: {} }] });
		expect(r.maxTokens).toBe(42);
		expect(r.tools).toEqual([{ name: "f", description: undefined, parameters: {} }]);
	});

	it("requires a model", () => {
		expect(() => parseResponsesRequest({ input: "hi" })).toThrow();
	});
});

describe("responseToOpenAI", () => {
	it("builds a Response with output[] and usage", () => {
		const resp: InternalResponse = {
			content: "hello",
			toolCalls: [],
			stopReason: "stop",
			usage: { input: 5, output: 7, totalTokens: 12 },
			model: "m",
		};
		const out = responseToOpenAI(resp, "m") as any;
		expect(out.object).toBe("response");
		expect(out.status).toBe("completed");
		expect(out.output).toHaveLength(1);
		expect(out.output[0].type).toBe("message");
		expect(out.output[0].content[0].text).toBe("hello");
		expect(out.usage).toEqual({ input_tokens: 5, output_tokens: 7, total_tokens: 12 });
	});

	it("emits function_call output items", () => {
		const resp: InternalResponse = {
			content: "",
			toolCalls: [{ id: "call_1", name: "add", arguments: { a: 2, b: 2 } }],
			stopReason: "toolUse",
			usage: { input: 5, output: 7, totalTokens: 12 },
			model: "m",
		};
		const out = responseToOpenAI(resp, "m") as any;
		expect(out.output[0].type).toBe("function_call");
		expect(out.output[0].name).toBe("add");
		expect(JSON.parse(out.output[0].arguments)).toEqual({ a: 2, b: 2 });
	});
});

describe("ResponsesChunker", () => {
	it("emits response.* events ending in response.completed", () => {
		const c = new ResponsesChunker("m");
		const events: any[] = [];
		for (const e of c.start()) events.push(e.type);
		for (const e of c.text("hel")) events.push(e.type);
		for (const e of c.text("lo")) events.push(e.type);
		for (const e of c.done({ input: 1, output: 2, totalTokens: 3 })) events.push(e.type);
		expect(events[0]).toBe("response.created");
		expect(events).toContain("response.output_text.delta");
		expect(events[events.length - 1]).toBe("response.completed");
	});

	it("emits a function_call item for tool calls", () => {
		const c = new ResponsesChunker("m");
		const events: any[] = [];
		for (const e of c.toolCallStart(0, "call_1", "add")) events.push(e);
		for (const e of c.toolCallDelta(0, '{"a":1}')) events.push(e);
		for (const e of c.done({ input: 1, output: 1, totalTokens: 2 })) events.push(e);
		const completed = events.find((e) => e.type === "response.completed");
		expect(completed.response.output[0].type).toBe("function_call");
		expect(completed.response.output[0].name).toBe("add");
		expect(completed.response.output[0].arguments).toBe('{"a":1}');
	});

	it("emits a reasoning item before the message for thinking", () => {
		const c = new ResponsesChunker("m");
		const types: any[] = [];
		let completed: any;
		for (const e of c.start()) types.push(e.type);
		for (const e of c.thinking("hmm ")) types.push(e.type);
		for (const e of c.thinking("42")) types.push(e.type);
		for (const e of c.text("the answer")) types.push(e.type);
		for (const e of c.done({ input: 1, output: 2, totalTokens: 3 })) {
			types.push(e.type);
			if (e.type === "response.completed") completed = e;
		}
		expect(types).toContain("response.reasoning_summary_text.delta");
		// reasoning item first, then message
		expect(completed.response.output[0].type).toBe("reasoning");
		expect(completed.response.output[0].summary[0].text).toBe("hmm 42");
		expect(completed.response.output[1].type).toBe("message");
		expect(completed.response.output[1].content[0].text).toBe("the answer");
	});
});
