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

export function toPiStreamOptions(
	req: InternalRequest,
	model: Model<Api>,
	extraOnPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined,
): StreamOptions {
	const opts: StreamOptions = {};
	if (req.temperature !== undefined) opts.temperature = req.temperature;
	if (req.maxTokens !== undefined) opts.maxTokens = req.maxTokens;
	if (req.reasoningEffort !== undefined) {
		// reasoningEffort lives on the API-specific options (OpenAICompletionsOptions),
		// not on the base StreamOptions, but models.stream accepts it via the
		// ModelsApiStreamOptions cast. pi-ai gates thinking on it being truthy.
		(opts as { reasoningEffort?: string }).reasoningEffort = req.reasoningEffort;
	}
	// Arm the qwen hook for qwen-chat-template models even when the client sent no
	// reasoning signal: an instruct model (reasoning: false) must explicitly set
	// enable_thinking to false, because pi-ai emits no thinking control for
	// non-reasoning models and the upstream qwen template then defaults to thinking
	// on. For a normal (reasoning) model with no signal the hook is a no-op, so
	// pi-ai's own enable_thinking behavior is preserved.
	const mcompat = (model as Model<"openai-completions">).compat;
	const isQwen = mcompat?.thinkingFormat === "qwen-chat-template";
	if (req.reasoningEffort !== undefined || req.thinkingTokenBudget !== undefined || isQwen) {
		opts.onPayload = (payload, m) => addQwenReasoningControls(payload, m, req.reasoningEffort, req.thinkingTokenBudget);
	}
	if (extraOnPayload) {
		const qwen = opts.onPayload;
		opts.onPayload = (payload, model) => {
			// A hook returning undefined means "no change" (pi-ai onPayload
			// convention), so fall back to the original payload rather than
			// forwarding undefined to the next hook. Otherwise a no-op qwen
			// hook would starve the downstream wire-model rewrite (e.g. the
			// ClinePass slug) whenever reasoning_effort is present.
			const next = qwen ? qwen(payload, model) : undefined;
			return extraOnPayload(next ?? payload, model);
		};
	}
	return opts;
}

/**
 * onPayload that adds backend-specific reasoning controls for qwen-chat-template
 * models: a top-level reasoning_effort (when the client requested effort and the
 * model advertises supportsReasoningEffort) and/or the reasoning token budget
 * field explicitly advertised by the upstream model. Budget fields are off by
 * default because unsupported sampling parameters make some servers terminate
 * the stream with finish_reason=error.
 * Returns undefined (payload unchanged) when nothing applies.
 */
function addQwenReasoningControls(
	payload: unknown,
	model: Model<Api>,
	effort: string | undefined,
	budget: number | undefined,
): unknown | undefined {
	if (!payload || typeof payload !== "object") return;
	const m = model as Model<"openai-completions">;
	if (m.compat?.thinkingFormat !== "qwen-chat-template") return;
	const out = { ...(payload as Record<string, unknown>) };

	// Whether the template must be forced off. Two cases, both of which pi-ai gets
	// wrong and that the upstream qwen template otherwise answers by thinking:
	//  - the client explicitly disabled it (reasoning_effort "off"; vLLM's
	//    chat_template_kwargs.enable_thinking false is normalized to undefined by
	//    parseReasoningEffort, but for a non-reasoning model the model flag below
	//    already forces it off);
	//  - the model is non-reasoning (e.g. an instruct alias): pi-ai emits no
	//    thinking control at all, so we must say "off" explicitly.
	// pi-ai's own qwen path computes `enable_thinking: !!reasoningEffort`, so the
	// literal string "off" is truthy and it turns thinking ON — we override that.
	const wantsOff = effort === "off" || !m.reasoning;
	let ctkChanged = false;
	if (wantsOff) {
		const ctk =
			typeof out.chat_template_kwargs === "object" && out.chat_template_kwargs !== null
				? (out.chat_template_kwargs as Record<string, unknown>)
				: {};
		if (ctk.enable_thinking !== false) {
			out.chat_template_kwargs = { ...ctk, enable_thinking: false };
			ctkChanged = true;
		}
	}

	// Effort and budget only apply to reasoning models; a non-reasoning model
	// cannot meaningfully think, so its effort/budget are ignored (no-op).
	let changed = ctkChanged;
	if (m.reasoning && effort && effort !== "off" && m.compat.supportsReasoningEffort) {
		const mapped = m.thinkingLevelMap?.[effort as ModelThinkingLevel] ?? QWEN_EFFORT[effort];
		if (mapped != null) {
			out.reasoning_effort = mapped;
			changed = true;
		}
	}
	if (m.reasoning && budget !== undefined) {
		const field = m.compat.thinkingTokenBudgetField ?? (m.compat.supportsThinkingTokenBudget ? "thinking_token_budget" : undefined);
		if (field) {
			out[field] = budget;
			changed = true;
		}
	}
	return changed ? out : undefined;
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
