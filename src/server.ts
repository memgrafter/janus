/**
 * HTTP server: routes, auth, and the request pipeline. Chains the control layer
 * (admit / queue / reject + quota/deadline) with the core's three layers
 * (openai wire-format -> bridge pi-ai mapping -> sse transport).
 */

import type { AssistantMessageEvent, ToolCall, Usage } from "@earendil-works/pi-ai";
import { assistantMessageToInternal, toPiContext, toPiStreamOptions } from "./bridge.ts";
import { loadPlaneConfig, type Config } from "./config.ts";
import { Control, type Dispatcher, type PlaneConfig } from "./control.ts";
import { createClient, type Client } from "./models.ts";
import {
	completionToOpenAI,
	modelListToOpenAI,
	OpenAIError,
	parseChatRequest,
	StreamChunker,
	type InternalUsage,
	type StopReason,
} from "./openai.ts";
import { parseResponsesRequest, responseToOpenAI, ResponsesChunker } from "./responses.ts";
import { jsonResponse, sseData, sseDone, sseHeaders } from "./sse.ts";
import { InMemoryTelemetry } from "./telemetry.ts";

export interface ServerHandle {
	port: number;
	/** The control plane (exposed for tests / introspection). */
	control: Control;
	close(): Promise<void>;
}

export async function createServer(
	config: Config,
	portOrOpts?: number | { port?: number; plane?: PlaneConfig },
): Promise<ServerHandle> {
	const client = await createClient(config);
	const opts = typeof portOrOpts === "number" ? { port: portOrOpts } : (portOrOpts ?? {});
	const listenPort = opts.port ?? config.port;
	const plane = opts.plane ?? loadPlaneConfig(config.planeConfigPath);
	const telemetry = new InMemoryTelemetry();
	const control = new Control(client.models, plane, telemetry, makeDispatcher(client));

	const server = Bun.serve({
		hostname: config.host,
		port: listenPort,
		// Bun.serve's server-side idle timeout defaults to 12s: if no bytes are
		// written to the client for 12s, the response is aborted. A large-context
		// prefill on a shared vllm can be silent for well over 12s (vllm sends
		// nothing until the first token), so raise it to the max (255s). The
		// keep-alive pings in handleChat/handleResponses cover the >255s tail.
		idleTimeout: 255,
		async fetch(req) {
			try {
				const url = new URL(req.url);
				if (!checkAuth(req, config)) return jsonResponse({ error: { message: "unauthorized", type: "auth_error", code: null } }, 401);
				const path = url.pathname;
				if (path === "/health") return new Response("ok", { status: 200 });
				if (path === "/v1/models" && req.method === "GET") return await handleModels(client);
				if (path === "/v1/categories" && req.method === "GET") return handleCategories(control, client);
				if (path === "/v1/telemetry" && req.method === "GET") return handleTelemetry(telemetry);
				if (path === "/v1/chat/completions" && req.method === "POST") return await handleChat(req, client, control, config);
				if (path === "/v1/responses" && req.method === "POST") return await handleResponses(req, client, control, config);
				if (path === "/v1/events" && req.method === "POST") return await handleEvent(req, control);
				const workMatch = path.match(/^\/v1\/work\/([^/]+)$/);
				if (workMatch && req.method === "GET") return handleWork(control, decodeURIComponent(workMatch[1]));
				return jsonResponse({ error: { message: `not found: ${path}`, type: "invalid_request_error", code: null } }, 404);
			} catch (e) {
				if (e instanceof OpenAIError) return jsonResponse(e.toBody(), e.status);
				return jsonResponse({ error: { message: e instanceof Error ? e.message : String(e), type: "server_error", code: null } }, 500);
			}
		},
	});

	// Allocator: drives queued (event) work on a timer.
	const allocTimer = setInterval(() => {
		try {
			control.tick();
		} catch (e) {
			console.error("allocator tick failed:", e);
		}
	}, config.allocMs);

	return {
		port: server.port ?? listenPort,
		control,
		close: () =>
			new Promise<void>((resolve) => {
				clearInterval(allocTimer);
				server.stop(true);
				resolve();
			}),
	};
}

function makeDispatcher(client: Client): Dispatcher {
	return {
		async complete(model, req, timeoutMs) {
			const context = toPiContext(req, model);
			const options = toPiStreamOptions(req);
			if (timeoutMs) options.timeoutMs = timeoutMs;
			return client.models.complete(model, context, options);
		},
	};
}

function checkAuth(req: Request, config: Config): boolean {
	if (!config.token) return true;
	return (req.headers.get("authorization") ?? "") === `Bearer ${config.token}`;
}

/** Route a request to a project via the X-Project header or body.metadata.project. */
function projectFromRequest(req: Request, body: unknown): string | undefined {
	const h = req.headers.get("x-project");
	if (h) return h;
	const m = (body as Record<string, any> | null)?.metadata;
	if (m && typeof m === "object" && typeof m.project === "string") return m.project;
	return undefined;
}

/** Convert the (seconds) config timeout to ms; 0 = disabled (very large backstop). */
function timeoutMsFromConfig(config: Config): number {
	return config.requestTimeoutS > 0 ? config.requestTimeoutS * 1000 : 2_147_483_647;
}

/**
 * Keep the downstream SSE connection warm during a long upstream prefill.
 * Bun.serve's server-side idleTimeout (capped at 255s) aborts a response that
 * writes no bytes for that long, and a large-context prefill on a shared vllm
 * can be silent well past that (vllm sends nothing until the first token).
 * While running, an SSE comment (ignored by spec-compliant clients) is
 * enqueued every `intervalMs` so the idle timer never trips. Call stop() once
 * the first real chunk is pushed or the stream ends.
 */
function makeKeepAlive(
	controller: ReadableStreamDefaultController<Uint8Array>,
	encoder: TextEncoder,
	intervalMs = 10_000,
) {
	let timer: ReturnType<typeof setInterval> | undefined;
	return {
		start() {
			if (timer) return;
			timer = setInterval(() => {
				try { controller.enqueue(encoder.encode(": keep-alive\n\n")); } catch { /* client gone */ }
			}, intervalMs);
		},
		stop() {
			if (timer) { clearInterval(timer); timer = undefined; }
		},
	};
}

async function handleModels(client: Client): Promise<Response> {
	const available = await client.models.getAvailable();
	const list = modelListToOpenAI(available.map((m) => ({ id: `${m.provider}/${m.id}`, provider: m.provider })));
	return jsonResponse(list, 200);
}

function handleCategories(control: Control, client: Client): Response {
	const cats = control.categories.list(client.models);
	return jsonResponse({
		object: "list",
		data: cats.map((c) => ({
			id: c.id,
			object: "category",
			name: c.name,
			models: c.models,
			available: c.available,
			quota_bucket: c.quotaBucketId ?? null,
			deadline_ms: c.deadlineMs ?? null,
		})),
	});
}

function handleTelemetry(telemetry: InMemoryTelemetry): Response {
	return jsonResponse({ object: "list", data: telemetry.events() });
}

async function handleEvent(req: Request, control: Control): Promise<Response> {
	const body = await req.json().catch(() => {
		throw new OpenAIError(400, "invalid JSON body");
	});
	const b = body as Record<string, any>;
	if (!Array.isArray(b.messages) || b.messages.length === 0) throw new OpenAIError(400, "`messages` is required");
	const item = control.enqueueEvent({
		project: typeof b.project === "string" ? b.project : undefined,
		category: typeof b.category === "string" ? b.category : undefined,
		model: typeof b.model === "string" ? b.model : undefined,
		messages: b.messages,
		tools: Array.isArray(b.tools) ? b.tools : undefined,
		priority: typeof b.priority === "number" ? b.priority : undefined,
		deadlineMs: typeof b.deadline_ms === "number" ? b.deadline_ms : undefined,
	});
	return jsonResponse({ id: item.id, object: "work", status: item.status }, 202);
}

function handleWork(control: Control, id: string): Response {
	const item = control.work(id);
	if (!item) return jsonResponse({ error: { message: `work not found: ${id}`, type: "invalid_request_error", code: null } }, 404);
	return jsonResponse({
		id: item.id,
		object: "work",
		status: item.status,
		project: item.project ?? null,
		category: item.category ?? null,
		result: item.result ?? null,
		error: item.error ?? null,
	});
}

async function handleChat(req: Request, client: Client, control: Control, config: Config): Promise<Response> {
	const body = await req.json().catch(() => {
		throw new OpenAIError(400, "invalid JSON body");
	});
	const internal = parseChatRequest(body);
	const project = projectFromRequest(req, body);
	const decision = control.admit(internal, project);
	if (decision.action === "reject") {
		return jsonResponse({ error: { message: decision.reason, type: "rate_limit_error", code: "quota_exceeded" } }, decision.status);
	}
	const ctx = decision.context;
	const context = toPiContext(internal, ctx.model);
	const options = toPiStreamOptions(internal);
	options.timeoutMs = ctx.deadlineMs ?? timeoutMsFromConfig(config);
	options.onResponse = (response) => control.ledger.observeRateLimit(ctx.quotaBucketId, response.headers);
	// Propagate the client's abort/disconnect to the upstream pi-ai stream so a
	// client timeout frees the provider instead of holding the request for the full
	// (long) pi-janus timeout. pi owns the timeout; pi-janus just follows it.
	options.signal = req.signal;
	if (ctx.project) options.metadata = { project: ctx.project };

	if (!internal.stream) {
		const msg = await client.models.complete(ctx.model, context, options);
		control.ledger.record(ctx.quotaBucketId, msg.usage);
		return jsonResponse(completionToOpenAI(assistantMessageToInternal(msg)), 200);
	}

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const chunker = new StreamChunker(ctx.model.id);
			// Once the client disconnects the stream is cancelled and enqueue throws;
			// swallow it (the upstream is already cancelled via options.signal).
			const push = (chunk: Record<string, unknown>) => {
				try { controller.enqueue(encoder.encode(sseData(chunk))); } catch { /* client gone */ }
			};
			const keepAlive = makeKeepAlive(controller, encoder);
			push(chunker.start());
			keepAlive.start();
			try {
				const piStream = client.models.stream(ctx.model, context, options);
				for await (const event of piStream) {
					if (event.type === "done") control.ledger.record(ctx.quotaBucketId, event.message.usage);
					const out = mapEventToChunk(chunker, event);
					if (out) { push(out); keepAlive.stop(); }
				}
			} catch (e) {
				push({ error: { message: e instanceof Error ? e.message : String(e) } });
			} finally {
				keepAlive.stop();
				try { controller.enqueue(encoder.encode(sseDone())); controller.close(); } catch { /* client gone */ }
			}
		},
	});
	return new Response(stream, { status: 200, headers: sseHeaders() });
}

async function handleResponses(req: Request, client: Client, control: Control, config: Config): Promise<Response> {
	const body = await req.json().catch(() => {
		throw new OpenAIError(400, "invalid JSON body");
	});
	const internal = parseResponsesRequest(body);
	const project = projectFromRequest(req, body);
	const decision = control.admit(internal, project);
	if (decision.action === "reject") {
		return jsonResponse({ error: { message: decision.reason, type: "rate_limit_error", code: "quota_exceeded" } }, decision.status);
	}
	const ctx = decision.context;
	const context = toPiContext(internal, ctx.model);
	const options = toPiStreamOptions(internal);
	options.timeoutMs = ctx.deadlineMs ?? timeoutMsFromConfig(config);
	options.onResponse = (response) => control.ledger.observeRateLimit(ctx.quotaBucketId, response.headers);
	// Propagate the client's abort/disconnect to the upstream pi-ai stream.
	options.signal = req.signal;

	if (!internal.stream) {
		const msg = await client.models.complete(ctx.model, context, options);
		control.ledger.record(ctx.quotaBucketId, msg.usage);
		return jsonResponse(responseToOpenAI(assistantMessageToInternal(msg), ctx.model.id), 200);
	}

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const chunker = new ResponsesChunker(ctx.model.id);
			const push = (chunk: Record<string, unknown>) => {
				try { controller.enqueue(encoder.encode(sseData(chunk))); } catch { /* client gone */ }
			};
			const keepAlive = makeKeepAlive(controller, encoder);
			for (const e of chunker.start()) push(e);
			keepAlive.start();
			let pushed = false;
			try {
				const piStream = client.models.stream(ctx.model, context, options);
				for await (const event of piStream) {
					if (event.type === "done") control.ledger.record(ctx.quotaBucketId, event.message.usage);
					for (const e of mapResponsesEvent(chunker, event)) { push(e); pushed = true; }
					if (pushed) keepAlive.stop();
				}
			} catch (e) {
				push({ type: "response.failed", response: { status: "failed", error: { message: e instanceof Error ? e.message : String(e) } } });
			} finally {
				keepAlive.stop();
				try { controller.close(); } catch { /* client gone */ }
			}
		},
	});
	return new Response(stream, { status: 200, headers: sseHeaders() });
}

function mapEventToChunk(chunker: StreamChunker, event: AssistantMessageEvent): Record<string, unknown> | null {
	switch (event.type) {
		case "text_delta":
			return chunker.text(event.delta);
		case "thinking_delta":
			return chunker.thinking(event.delta);
		case "toolcall_start": {
			const tc = event.partial.content[event.contentIndex] as ToolCall | undefined;
			return chunker.toolCallStart(event.contentIndex, tc?.id ?? "", tc?.name ?? "");
		}
		case "toolcall_delta":
			return chunker.toolCallDelta(event.contentIndex, event.delta);
		case "done":
			return chunker.done(mapReason(event.reason), toInternalUsage(event.message.usage));
		case "error":
			return chunker.done(event.reason === "aborted" ? "aborted" : "error", toInternalUsage(event.error.usage));
		default:
			return null;
	}
}

function mapResponsesEvent(chunker: ResponsesChunker, event: AssistantMessageEvent): Record<string, unknown>[] {
	switch (event.type) {
		case "text_delta":
			return chunker.text(event.delta);
		case "thinking_delta":
			return chunker.thinking(event.delta);
		case "toolcall_start": {
			const tc = event.partial.content[event.contentIndex] as ToolCall | undefined;
			return chunker.toolCallStart(event.contentIndex, tc?.id ?? "", tc?.name ?? "");
		}
		case "toolcall_delta":
			return chunker.toolCallDelta(event.contentIndex, event.delta);
		case "done":
			return chunker.done(toInternalUsage(event.message.usage));
		case "error":
			return chunker.done(toInternalUsage(event.error.usage));
		default:
			return [];
	}
}

function mapReason(r: "stop" | "length" | "toolUse" | "deferred"): StopReason {
	return r === "deferred" ? "stop" : r;
}

function toInternalUsage(u: Usage): InternalUsage {
	return { input: u.input, output: u.output, totalTokens: u.totalTokens, cacheRead: u.cacheRead };
}
