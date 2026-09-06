/**
 * OpenAI Responses API wire-format layer (pj-q1fg). A protocol surface parallel
 * to openai.ts: maps a Responses request to the shared InternalRequest, and an
 * InternalResponse to a Responses object / response.* stream events. Reuses the
 * core's pi-ai mapping (bridge.ts) and transport (sse.ts) — no changes there.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { InternalMessage, InternalRequest, InternalResponse, InternalTool, InternalUsage } from "./openai.ts";
import { OpenAIError } from "./openai.ts";

// --- local helpers (kept here so the core openai.ts stays untouched) ---

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
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

function toInternalUsage(u: Usage): InternalUsage {
  return { input: u.input, output: u.output, totalTokens: u.totalTokens, cacheRead: u.cacheRead };
}

function textFromResponsesContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p === "string" ? p : p && typeof p === "object" && typeof (p as any).text === "string" ? (p as any).text : ""))
    .join("");
}

// --- request parsing ---

export function parseResponsesRequest(body: unknown): InternalRequest {
  const b = body as Record<string, any> | null;
  if (typeof b?.model !== "string" || b.model === "") throw new OpenAIError(400, "`model` is required");
  const messages: InternalMessage[] = [];
  if (typeof b.instructions === "string" && b.instructions) messages.push({ role: "system", content: b.instructions });
  const input = b.input;
  if (typeof input === "string") {
    if (input) messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) messages.push(...responsesItemToMessages(item));
  }
  const tools = Array.isArray(b.tools) && b.tools.length > 0 ? b.tools.map(parseResponsesTool) : undefined;
  return {
    model: b.model,
    messages,
    tools,
    temperature: typeof b.temperature === "number" ? b.temperature : undefined,
    maxTokens: typeof b.max_output_tokens === "number" ? b.max_output_tokens : undefined,
    stream: b.stream === true,
  };
}

function responsesItemToMessages(item: any): InternalMessage[] {
  switch (item?.type) {
    case "message": {
      const content = textFromResponsesContent(item.content);
      const role = item.role;
      if (role === "system" || role === "user") return [{ role, content }];
      if (role === "assistant") return [{ role: "assistant", content }];
      throw new OpenAIError(400, `unsupported message role "${role}"`);
    }
    case "function_call":
      return [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: item.call_id ?? item.id ?? "", name: item.name ?? "", arguments: safeParseObject(item.arguments) ?? {} }],
        },
      ];
    case "function_call_output":
      return [
        {
          role: "tool",
          toolCallId: item.call_id ?? "",
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
        },
      ];
    default:
      return []; // skip reasoning / unknown items for minimal
  }
}

function parseResponsesTool(t: any): InternalTool {
  return {
    name: typeof t?.name === "string" ? t.name : "",
    description: typeof t?.description === "string" ? t.description : undefined,
    parameters: t?.parameters && typeof t.parameters === "object" ? t.parameters : undefined,
  };
}

// --- response builders ---

export function responseToOpenAI(resp: InternalResponse, model: string): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];
  if (resp.thinking) {
    output.push({
      type: "reasoning",
      id: `rs-${randomId()}`,
      status: "completed",
      summary: [{ type: "summary_text", text: resp.thinking }],
    });
  }
  if (resp.content) {
    output.push({
      type: "message",
      id: `msg-${randomId()}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: resp.content, annotations: [] }],
    });
  }
  for (const tc of resp.toolCalls) {
    output.push({
      type: "function_call",
      id: `fc-${randomId()}`,
      call_id: tc.id,
      name: tc.name,
      arguments: JSON.stringify(tc.arguments),
      status: "completed",
    });
  }
  return {
    id: `resp-${randomId()}`,
    object: "response",
    status: resp.errorMessage ? "failed" : "completed",
    model,
    output,
    usage: {
      input_tokens: resp.usage.input,
      output_tokens: resp.usage.output,
      total_tokens: resp.usage.totalTokens,
    },
  };
}

/**
 * Stateful builder of `response.*` SSE events, one instance per streamed
 * Responses request. Mirrors the shape of openai.ts's StreamChunker.
 */
export class ResponsesChunker {
  private readonly id = `resp-${randomId()}`;
  private readonly messageId = `msg-${randomId()}`;
  private readonly reasoningId = `rs-${randomId()}`;
  private messageAdded = false;
  private reasoningAdded = false;
  private textBuf = "";
  private reasoningBuf = "";
  private readonly toolIndex = new Map<number, number>();
  private readonly toolCalls: { id: string; name: string; argsRaw: string }[] = [];

  constructor(private readonly model: string) {}

  private resp(status: string, output: unknown[], usage?: Record<string, unknown>, error?: string): Record<string, unknown> {
    return { id: this.id, object: "response", status, model: this.model, output, ...(usage ? { usage } : {}), ...(error ? { error: { message: error, type: "provider_error" } } : {}) };
  }

  private messageItem(status: string): Record<string, unknown> {
    return {
      type: "message",
      id: this.messageId,
      role: "assistant",
      status,
      content: [{ type: "output_text", text: this.textBuf, annotations: [] }],
    };
  }

  private functionCallItem(tc: { id: string; name: string; argsRaw: string }, status: string): Record<string, unknown> {
    return { type: "function_call", id: `fc-${tc.id}`, call_id: tc.id, name: tc.name, arguments: tc.argsRaw, status };
  }

  private reasoningItem(status: string): Record<string, unknown> {
    return {
      type: "reasoning",
      id: this.reasoningId,
      status,
      summary: [{ type: "summary_text", text: this.reasoningBuf }],
    };
  }

  /** Current output index for a new item (reasoning, then message, then tool calls). */
  private nextOutputIndex(): number {
    let idx = 0;
    if (this.reasoningAdded) idx++;
    if (this.messageAdded) idx++;
    return idx + this.toolCalls.length;
  }

  start(): Record<string, unknown>[] {
    return [
      { type: "response.created", response: this.resp("in_progress", []) },
      { type: "response.in_progress", response: this.resp("in_progress", []) },
    ];
  }

  text(delta: string): Record<string, unknown>[] {
    this.textBuf += delta;
    const out: Record<string, unknown>[] = [];
    if (!this.messageAdded) {
      this.messageAdded = true;
      out.push({ type: "response.output_item.added", output_index: this.nextOutputIndex(), item: this.messageItem("in_progress") });
      out.push({
        type: "response.content_part.added",
        item_id: this.messageId,
        output_index: this.nextOutputIndex(),
        content_index: 0,
        part: { type: "output_text", text: "" },
      });
    }
    out.push({ type: "response.output_text.delta", item_id: this.messageId, output_index: this.nextOutputIndex(), content_index: 0, delta });
    return out;
  }

  thinking(delta: string): Record<string, unknown>[] {
    this.reasoningBuf += delta;
    const out: Record<string, unknown>[] = [];
    if (!this.reasoningAdded) {
      this.reasoningAdded = true;
      out.push({ type: "response.output_item.added", output_index: this.nextOutputIndex(), item: this.reasoningItem("in_progress") });
      out.push({
        type: "response.reasoning_summary_part.added",
        item_id: this.reasoningId,
        output_index: this.nextOutputIndex(),
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
    }
    out.push({ type: "response.reasoning_summary_text.delta", item_id: this.reasoningId, output_index: this.nextOutputIndex(), summary_index: 0, delta });
    return out;
  }

  toolCallStart(piContentIndex: number, id: string, name: string): Record<string, unknown>[] {
    const idx = this.toolCalls.length;
    this.toolIndex.set(piContentIndex, idx);
    this.toolCalls.push({ id, name, argsRaw: "" });
    const outputIndex = this.nextOutputIndex();
    return [{ type: "response.output_item.added", output_index: outputIndex, item: this.functionCallItem(this.toolCalls[idx], "in_progress") }];
  }

  toolCallDelta(piContentIndex: number, delta: string): Record<string, unknown>[] {
    const idx = this.toolIndex.get(piContentIndex);
    if (idx === undefined) return [];
    this.toolCalls[idx].argsRaw += delta;
    return [];
  }

  done(usage: InternalUsage, errorMessage?: string): Record<string, unknown>[] {
    if (errorMessage) {
      return [{ type: "response.failed", response: this.resp("failed", [], undefined, errorMessage) }];
    }
    const out: Record<string, unknown>[] = [];
    const output: Record<string, unknown>[] = [];
    let outputIndex = 0;
    if (this.reasoningAdded) {
      out.push({ type: "response.reasoning_summary_text.done", item_id: this.reasoningId, output_index: outputIndex, summary_index: 0, text: this.reasoningBuf });
      out.push({ type: "response.reasoning_summary_part.done", item_id: this.reasoningId, output_index: outputIndex, summary_index: 0, part: { type: "summary_text", text: this.reasoningBuf } });
      out.push({ type: "response.output_item.done", output_index: outputIndex, item: this.reasoningItem("completed") });
      output.push(this.reasoningItem("completed"));
      outputIndex++;
    }
    if (this.messageAdded) {
      out.push({ type: "response.output_text.done", item_id: this.messageId, output_index: outputIndex, content_index: 0, text: this.textBuf });
      out.push({
        type: "response.content_part.done",
        item_id: this.messageId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: this.textBuf },
      });
      out.push({ type: "response.output_item.done", output_index: outputIndex, item: this.messageItem("completed") });
      output.push(this.messageItem("completed"));
      outputIndex++;
    }
    for (const tc of this.toolCalls) {
      out.push({ type: "response.output_item.done", output_index: outputIndex, item: this.functionCallItem(tc, "completed") });
      output.push(this.functionCallItem(tc, "completed"));
      outputIndex++;
    }
    out.push({
      type: "response.completed",
      response: this.resp("completed", output, {
        input_tokens: usage.input,
        output_tokens: usage.output,
        total_tokens: usage.totalTokens,
      }),
    });
    return out;
  }
}
