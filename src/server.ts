/**
 * HTTP server: routes, auth, and the request pipeline that chains the three
 * layers (openai wire-format -> bridge pi-ai mapping -> models client -> sse transport).
 */

import type { AssistantMessageEvent, ToolCall, Usage } from "@earendil-works/pi-ai";
import { assistantMessageToInternal, toPiContext, toPiStreamOptions } from "./bridge.ts";
import type { Config } from "./config.ts";
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
import { jsonResponse, sseData, sseDone, sseHeaders } from "./sse.ts";

export interface ServerHandle {
	port: number;
	close(): Promise<void>;
}

export async function createServer(config: Config, port?: number): Promise<ServerHandle> {
	const client = await createClient(config);
	const listenPort = port ?? config.port;

	const server = Bun.serve({
		hostname: config.host,
		port: listenPort,
		async fetch(req) {
			try {
				const url = new URL(req.url);
				if (!checkAuth(req, config)) return jsonResponse({ error: { message: "unauthorized", type: "auth_error", code: null } }, 401);
				if (url.pathname === "/health") return new Response("ok", { status: 200 });
				if (url.pathname === "/v1/models" && req.method === "GET") return await handleModels(client);
				if (url.pathname === "/v1/chat/completions" && req.method === "POST") return await handleChat(req, client, config);
				return jsonResponse({ error: { message: `not found: ${url.pathname}`, type: "invalid_request_error", code: null } }, 404);
			} catch (e) {
				if (e instanceof OpenAIError) return jsonResponse(e.toBody(), e.status);
				return jsonResponse({ error: { message: e instanceof Error ? e.message : String(e), type: "server_error", code: null } }, 500);
			}
		},
	});

	return {
		port: server.port ?? listenPort,
		close: () =>
			new Promise<void>((resolve) => {
				server.stop(true);
				resolve();
			}),
	};
}

function checkAuth(req: Request, config: Config): boolean {
	if (!config.token) return true;
	return (req.headers.get("authorization") ?? "") === `Bearer ${config.token}`;
}

async function handleModels(client: Client): Promise<Response> {
	const available = await client.models.getAvailable();
	const list = modelListToOpenAI(available.map((m) => ({ id: `${m.provider}/${m.id}`, provider: m.provider })));
	return jsonResponse(list, 200);
}

async function handleChat(req: Request, client: Client, config: Config): Promise<Response> {
	const body = await req.json().catch(() => {
		throw new OpenAIError(400, "invalid JSON body");
	});
	const internal = parseChatRequest(body);
	const model = client.resolveModel(internal.model);
	const context = toPiContext(internal, model);
	const options = toPiStreamOptions(internal);
	options.timeoutMs = config.requestTimeoutMs;

	if (!internal.stream) {
		const msg = await client.models.complete(model, context, options);
		return jsonResponse(completionToOpenAI(assistantMessageToInternal(msg)), 200);
	}

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const chunker = new StreamChunker(model.id);
			controller.enqueue(encoder.encode(sseData(chunker.start())));
			try {
				const piStream = client.models.stream(model, context, options);
				for await (const event of piStream) {
					const out = mapEventToChunk(chunker, event);
					if (out) controller.enqueue(encoder.encode(sseData(out)));
				}
			} catch (e) {
				controller.enqueue(encoder.encode(sseData({ error: { message: e instanceof Error ? e.message : String(e) } })));
			} finally {
				controller.enqueue(encoder.encode(sseDone()));
				controller.close();
			}
		},
	});
	return new Response(stream, { status: 200, headers: sseHeaders() });
}

function mapEventToChunk(chunker: StreamChunker, event: AssistantMessageEvent): Record<string, unknown> | null {
	switch (event.type) {
		case "text_delta":
			return chunker.text(event.delta);
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

function mapReason(r: "stop" | "length" | "toolUse" | "deferred"): StopReason {
	return r === "deferred" ? "stop" : r;
}

function toInternalUsage(u: Usage): InternalUsage {
	return { input: u.input, output: u.output, totalTokens: u.totalTokens, cacheRead: u.cacheRead };
}
