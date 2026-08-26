/**
 * OpenAI wire-format layer: parse an OpenAI Chat Completions request into an
 * internal representation, and build OpenAI response bodies / stream chunks
 * from an internal response. Also defines the internal types shared by the
 * three layers (wire-format / pi-ai mapping / transport).
 */

// ---------------------------------------------------------------------------
// Internal representation (wire-agnostic, provider-agnostic)
// ---------------------------------------------------------------------------

export interface InternalToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type InternalMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| { role: "assistant"; content: string; toolCalls?: InternalToolCall[] }
	| { role: "tool"; toolCallId: string; content: string };

export interface InternalTool {
	name: string;
	description?: string;
	/** JSON Schema for the tool parameters. */
	parameters?: Record<string, unknown>;
}

export interface InternalRequest {
	model: string;
	messages: InternalMessage[];
	tools?: InternalTool[];
	temperature?: number;
	maxTokens?: number;
	/**
	 * Reasoning effort requested by the client (e.g. "low"|"medium"|"high").
	 * Set from `reasoning_effort` or `chat_template_kwargs.enable_thinking`.
	 * Forwarded to pi-ai as options.reasoningEffort, which gates thinking on
	 * for providers that key off it (e.g. qwen-chat-template enable_thinking).
	 */
	reasoningEffort?: string;
	/**
	 * Per-request reasoning token budget. Set from `thinking_token_budget`
	 * (vLLM) or `thinking_budget_tokens` (llama.cpp). Forwarded to the
	 * downstream payload so the backend can cap reasoning length.
	 */
	thinkingTokenBudget?: number;
	stream: boolean;
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface InternalUsage {
	input: number;
	output: number;
	totalTokens: number;
	cacheRead?: number;
}

export interface InternalResponse {
	content: string;
	toolCalls: InternalToolCall[];
	/** Reasoning/thinking text, when the model produced it. */
	thinking?: string;
	stopReason: StopReason;
	usage: InternalUsage;
	model: string;
	errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OpenAIError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
	toBody(): Record<string, unknown> {
		return { error: { message: this.message, type: "invalid_request_error", code: null } };
	}
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

export function parseChatRequest(body: unknown): InternalRequest {
	const b = body as Record<string, any> | null;
	if (typeof b?.model !== "string" || b.model === "") throw new OpenAIError(400, "`model` is required");
	const messages = Array.isArray(b.messages) ? b.messages.map(parseMessage) : [];
	return {
		model: b.model,
		messages,
		tools: Array.isArray(b.tools) && b.tools.length > 0 ? b.tools.map(parseTool) : undefined,
		temperature: typeof b.temperature === "number" ? b.temperature : undefined,
		maxTokens:
			typeof b.max_tokens === "number"
				? b.max_tokens
				: typeof b.max_completion_tokens === "number"
					? b.max_completion_tokens
					: undefined,
		reasoningEffort: parseReasoningEffort(b),
		thinkingTokenBudget: parseThinkingTokenBudget(b),
		stream: b.stream === true,
	};
}

/**
 * Derive a reasoning-effort hint from the OpenAI request body. pi-ai gates
 * thinking on `options.reasoningEffort` being truthy (e.g. qwen-chat-template
 * sets `enable_thinking: !!reasoningEffort`), so we must surface the client's
 * intent. Accepts the OpenAI-standard `reasoning_effort` string, or vllm's
 * `chat_template_kwargs.enable_thinking` boolean (mapped to "medium").
 */
function parseReasoningEffort(b: Record<string, any> | null): string | undefined {
	if (typeof b?.reasoning_effort === "string" && b.reasoning_effort) return b.reasoning_effort;
	const enable = b?.chat_template_kwargs?.enable_thinking;
	if (enable === true) return "medium";
	if (enable === false) return undefined;
	return undefined;
}

/**
 * Read the reasoning token budget from the request body. Accepts both
 * `thinking_token_budget` (vLLM sampling param) and `thinking_budget_tokens`
 * (llama.cpp) so the same client field works across backends.
 */
function parseThinkingTokenBudget(b: Record<string, any> | null): number | undefined {
	if (typeof b?.thinking_token_budget === "number") return b.thinking_token_budget;
	if (typeof b?.thinking_budget_tokens === "number") return b.thinking_budget_tokens;
	return undefined;
}

export function parseMessage(m: any): InternalMessage {
	const content = typeof m.content === "string" ? m.content : m.content ? textFromContent(m.content) : "";
	switch (m.role) {
		case "system":
		case "developer": // OpenAI's successor to "system"; treat as the instruction/system prompt
			return { role: "system", content };
		case "user":
			return { role: "user", content };
		case "assistant": {
			const toolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0 ? m.tool_calls.map(parseToolCall) : undefined;
			return { role: "assistant", content, toolCalls };
		}
		case "tool":
			return { role: "tool", toolCallId: typeof m.tool_call_id === "string" ? m.tool_call_id : "", content };
		default:
			throw new OpenAIError(400, `unsupported message role "${m.role}"`);
	}
}

function textFromContent(content: unknown[]): string {
	return content
		.map((p) => (typeof p === "string" ? p : p && typeof p === "object" && (p as any).type === "text" ? (p as any).text : ""))
		.join("");
}

function parseTool(t: any): InternalTool {
	const fn = t && typeof t === "object" && t.function ? t.function : t;
	return {
		name: typeof fn?.name === "string" ? fn.name : "",
		description: typeof fn?.description === "string" ? fn.description : undefined,
		parameters: fn?.parameters && typeof fn.parameters === "object" ? fn.parameters : undefined,
	};
}

function parseToolCall(tc: any): InternalToolCall {
	return {
		id: typeof tc?.id === "string" ? tc.id : "",
		name: typeof tc?.function?.name === "string" ? tc.function.name : "",
		arguments: safeParseObject(tc?.function?.arguments) ?? {},
	};
}

function safeParseObject(s: unknown): Record<string, unknown> | undefined {
	if (s && typeof s === "object") return s as Record<string, unknown>;
	if (typeof s !== "string" || s === "") return undefined;
	try {
		const v = JSON.parse(s);
		return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

export function modelListToOpenAI(entries: { id: string; provider: string }[]): Record<string, unknown> {
	return {
		object: "list",
		data: entries.map((e) => ({ id: e.id, object: "model", created: 0, owned_by: e.provider })),
	};
}

export function completionToOpenAI(resp: InternalResponse): Record<string, unknown> {
	const message: Record<string, unknown> = { role: "assistant", content: resp.content || null };
	if (resp.thinking) message.reasoning_content = resp.thinking;
	if (resp.toolCalls.length > 0) {
		message.tool_calls = resp.toolCalls.map((tc) => ({
			id: tc.id,
			type: "function",
			function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
		}));
	}
	return {
		id: `chatcmpl-${randomId()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: resp.model,
		choices: [{ index: 0, message, finish_reason: finishReason(resp.stopReason) }],
		usage: usageToOpenAI(resp.usage),
	};
}

export function usageToOpenAI(u: InternalUsage): Record<string, unknown> {
	const out: Record<string, unknown> = {
		prompt_tokens: u.input,
		completion_tokens: u.output,
		total_tokens: u.totalTokens,
	};
	if (u.cacheRead) out.prompt_tokens_details = { cached_tokens: u.cacheRead };
	return out;
}

export function finishReason(r: StopReason): string {
	switch (r) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "toolUse":
			return "tool_calls";
		case "error":
			return "error";
		case "aborted":
			return "aborted";
	}
}

function randomId(): string {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// Streaming chunk builder (stateful, one instance per streamed response)
// ---------------------------------------------------------------------------

export class StreamChunker {
	private toolIndex = new Map<number, number>();
	private nextToolIndex = 0;

	constructor(
		private model: string,
		private id: string = `chatcmpl-${randomId()}`,
	) {}

	private base(): Record<string, unknown> {
		return { id: this.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: this.model };
	}

	private choice(delta: Record<string, unknown>, finish: string | null = null): Record<string, unknown> {
		return { ...this.base(), choices: [{ index: 0, delta, finish_reason: finish }] };
	}

	start(): Record<string, unknown> {
		return this.choice({ role: "assistant", content: "" });
	}

	text(delta: string): Record<string, unknown> {
		return this.choice({ content: delta });
	}

	/**
	 * Reasoning/thinking delta. Emitted in the `reasoning_content` field — the
	 * canonical OpenAI-compatible reasoning field that pi-ai's client reads first
	 * (OPENAI_COMPLETIONS_REASONING_FIELDS = [reasoning_content, reasoning, ...]).
	 * vllm/qwen emit thinking in `reasoning`; we normalize to `reasoning_content`
	 * so any OpenAI-compatible client (incl. pi) picks it up.
	 */
	thinking(delta: string): Record<string, unknown> {
		return this.choice({ reasoning_content: delta });
	}

	toolCallStart(piContentIndex: number, id: string, name: string): Record<string, unknown> {
		const idx = this.nextToolIndex++;
		this.toolIndex.set(piContentIndex, idx);
		return this.choice({ tool_calls: [{ index: idx, id, type: "function", function: { name, arguments: "" } }] });
	}

	toolCallDelta(piContentIndex: number, delta: string): Record<string, unknown> | null {
		const idx = this.toolIndex.get(piContentIndex);
		if (idx === undefined) return null;
		return this.choice({ tool_calls: [{ index: idx, function: { arguments: delta } }] });
	}

	done(reason: StopReason, usage: InternalUsage): Record<string, unknown> {
		return { ...this.base(), choices: [{ index: 0, delta: {}, finish_reason: finishReason(reason) }], usage: usageToOpenAI(usage) };
	}
}
