/**
 * pi-ai mapping layer: convert between the internal representation and pi-ai's
 * Context / StreamOptions (request) and AssistantMessage (response).
 */

import type { Api, AssistantMessage, Context, Model, ModelThinkingLevel, StreamOptions, TextContent, Tool, ToolCall, TSchema, Usage } from "@earendil-works/pi-ai";
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

// Maps client reasoning-effort values to the top-level reasoning_effort values
// vLLM's qwen chat template accepts. Released pi-ai only sets
// chat_template_kwargs.enable_thinking for qwen-chat-template models and never
// emits reasoning_effort, so the mapped value is added in onPayload.
const QWEN_EFFORT: Record<string, string> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "xhigh",
	xhigh: "xhigh",
	max: "xhigh",
};

export function toPiStreamOptions(req: InternalRequest): StreamOptions {
	const opts: StreamOptions = {};
	if (req.temperature !== undefined) opts.temperature = req.temperature;
	if (req.maxTokens !== undefined) opts.maxTokens = req.maxTokens;
	if (req.reasoningEffort !== undefined) {
		// reasoningEffort lives on the API-specific options (OpenAICompletionsOptions),
		// not on the base StreamOptions, but models.stream accepts it via the
		// ModelsApiStreamOptions cast. pi-ai gates thinking on it being truthy.
		(opts as { reasoningEffort?: string }).reasoningEffort = req.reasoningEffort;
		opts.onPayload = (payload, model) => addQwenReasoningEffort(payload, model, req.reasoningEffort);
	}
	return opts;
}

/**
 * onPayload that adds a top-level reasoning_effort for qwen-chat-template
 * models that advertise supportsReasoningEffort. Returns undefined (payload
 * unchanged) for every other model or when no effort was requested.
 */
function addQwenReasoningEffort(payload: unknown, model: Model<Api>, effort: string | undefined): unknown | undefined {
	if (!effort) return;
	const m = model as Model<"openai-completions">;
	const compat = m.compat;
	if (!m.reasoning || compat?.thinkingFormat !== "qwen-chat-template" || !compat.supportsReasoningEffort) return;
	if (!payload || typeof payload !== "object") return;
	const mapped = m.thinkingLevelMap?.[effort as ModelThinkingLevel] ?? QWEN_EFFORT[effort];
	if (mapped == null) return;
	return { ...(payload as Record<string, unknown>), reasoning_effort: mapped };
}

export function assistantMessageToInternal(msg: AssistantMessage): InternalResponse {
	let content = "";
	let thinking = "";
	const toolCalls: InternalToolCall[] = [];
	for (const block of msg.content) {
		if (block.type === "text") content += block.text;
		else if (block.type === "thinking") thinking += block.thinking;
		else if (block.type === "toolCall") toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments });
	}
	return {
		content,
		toolCalls,
		thinking: thinking || undefined,
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
