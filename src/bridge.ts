/**
 * pi-ai mapping layer: convert between the internal representation and pi-ai's
 * Context / StreamOptions (request) and AssistantMessage (response).
 */

import type { Api, AssistantMessage, Context, Model, StreamOptions, TextContent, Tool, ToolCall, TSchema, Usage } from "@earendil-works/pi-ai";
import type { InternalRequest, InternalResponse, InternalToolCall, StopReason } from "./openai.ts";

export function toPiContext(req: InternalRequest, model: Model<Api>): Context {
	const system = req.messages
		.filter((m) => m.role === "system")
		.map((m) => m.content)
		.join("\n\n");

	const messages: Context["messages"] = [];
	const now = Date.now();
	for (const m of req.messages) {
		if (m.role === "system") continue;
		if (m.role === "user") {
			messages.push({ role: "user", content: m.content, timestamp: now });
		} else if (m.role === "assistant") {
			const content: (TextContent | ToolCall)[] = [];
			if (m.content) content.push({ type: "text", text: m.content });
			for (const tc of m.toolCalls ?? []) content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.arguments });
			messages.push({
				role: "assistant",
				content,
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: zeroUsage(),
				stopReason: m.toolCalls && m.toolCalls.length > 0 ? "toolUse" : "stop",
				timestamp: now,
			});
		} else if (m.role === "tool") {
			messages.push({
				role: "toolResult",
				toolCallId: m.toolCallId,
				toolName: "",
				content: [{ type: "text", text: m.content }],
				isError: false,
				timestamp: now,
			});
		}
	}

	const tools: Tool[] | undefined = req.tools
		? req.tools.map((t) => ({ name: t.name, description: t.description ?? "", parameters: (t.parameters ?? {}) as TSchema }))
		: undefined;

	return { systemPrompt: system || undefined, messages, tools };
}

export function toPiStreamOptions(req: InternalRequest): StreamOptions {
	const opts: StreamOptions = {};
	if (req.temperature !== undefined) opts.temperature = req.temperature;
	if (req.maxTokens !== undefined) opts.maxTokens = req.maxTokens;
	return opts;
}

export function assistantMessageToInternal(msg: AssistantMessage): InternalResponse {
	let content = "";
	const toolCalls: InternalToolCall[] = [];
	for (const block of msg.content) {
		if (block.type === "text") content += block.text;
		else if (block.type === "toolCall") toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments });
	}
	return {
		content,
		toolCalls,
		stopReason: mapStopReason(msg.stopReason),
		usage: {
			input: msg.usage.input,
			output: msg.usage.output,
			totalTokens: msg.usage.totalTokens,
			cacheRead: msg.usage.cacheRead,
		},
		model: msg.model,
		errorMessage: msg.errorMessage,
	};
}

function mapStopReason(r: AssistantMessage["stopReason"]): StopReason {
	switch (r) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "toolUse":
			return "toolUse";
		case "error":
			return "error";
		case "aborted":
			return "aborted";
		default:
			return "stop";
	}
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
