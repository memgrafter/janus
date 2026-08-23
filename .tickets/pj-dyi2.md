---
id: pj-dyi2
status: closed
open: false
deps: []
links: []
created: 2026-08-23T20:29:49Z
type: bug
priority: 1
assignee: memgrafter
parent: pj-gvlk
tags: [pi-janus, thinking, reasoning, streaming, bug]
---
# Surface thinking/reasoning tokens through the proxy (vllm qwen)

Thinking/reasoning tokens did not appear when pi routed through pi-janus to a real vllm qwen backend.

## Symptom
With a reasoning model (vllm qwen3.8-27b, thinkingFormat qwen-chat-template), streaming through pi-janus returned only content — zero thinking/reasoning tokens. Direct pi->vllm (and a raw vllm call) did emit thinking, so the loss was in the proxy path.

## Root cause (two parts)
1. pi-janus dropped pi-ai's thinking events. mapEventToChunk (server.ts) only handled text_delta / toolcall_* / done / error; there was no thinking_delta case and StreamChunker/ResponsesChunker had no thinking method, so every thinking event returned null and was discarded.
2. pi-ai only enables thinking upstream when options.reasoningEffort is truthy (qwen-chat-template sets chat_template_kwargs.enable_thinking = !!reasoningEffort). pi-janus never set reasoningEffort, so pi-ai always sent enable_thinking:false and vllm emitted no thinking.
3. (surfaced during verification) The vllm model entry advertised supportsThinkingTokenBudget:true, so pi-ai also sent a top-level thinking_token_budget. This vllm runs the V2 model runner, which rejects that param ("thinking_token_budget is not yet supported by the V2 model runner"), so the request errored before any tokens.

## Fix
- openai.ts: InternalRequest.reasoningEffort + parseReasoningEffort() (reads reasoning_effort string, or chat_template_kwargs.enable_thinking true->"medium"); InternalResponse.thinking; StreamChunker.thinking() emits reasoning_content; completionToOpenAI adds message.reasoning_content when thinking present.
- bridge.ts: toPiStreamOptions forwards req.reasoningEffort to options.reasoningEffort; assistantMessageToInternal accumulates thinking blocks.
- server.ts: mapEventToChunk + mapResponsesEvent handle thinking_delta.
- responses.ts: ResponsesChunker.thinking()/reasoningItem()/nextOutputIndex(); done() emits the reasoning item before the message; responseToOpenAI adds a reasoning output item.
- models.json (config, outside repo): removed supportsThinkingTokenBudget + samplingParams.thinking_token_budget from the vllm-8095 entry (and its pi-janus mirror) because the V2 runner rejects thinking_token_budget; thinking still works via enable_thinking.

## Verified
- Mock upstream: client enable_thinking:true / reasoning_effort:high -> upstream chat_template_kwargs.enable_thinking:true; nothing -> false.
- Live pi-janus->vllm (real): 27*43 -> 12 reasoning deltas + 17 content deltas, correct answer; bat-and-ball -> 451 thinking chars + 413 answer chars, correct.
- Suite 89/89 (was 85; +4 thinking tests).

## Acceptance Criteria

A streaming request through pi-janus to a reasoning vllm model returns thinking tokens (reasoning_content deltas) before the answer when the client requests thinking; the request does not error on thinking_token_budget; suite passes.

## Acceptance Criteria

A streaming request through pi-janus to a reasoning vllm model returns thinking tokens (reasoning_content deltas) before the answer when the client requests thinking; the request does not error on thinking_token_budget; suite passes.

## Notes

**2026-08-23T20:30:34Z**

Fixed (commit 04359f0): pi-janus now forwards pi-ai thinking events (StreamChunker/ResponsesChunker.thinking -> reasoning_content / reasoning item) and sets options.reasoningEffort from the client's reasoning_effort / chat_template_kwargs.enable_thinking so pi-ai enables thinking upstream. Also dropped supportsThinkingTokenBudget + samplingParams.thinking_token_budget from the vllm-8095 models.json entry (V2 runner rejects thinking_token_budget). Live pi-janus->vllm now returns thinking tokens before the answer (27*43: 12 reasoning + 17 content deltas; bat-and-ball: 451 thinking + 413 answer chars). Suite 89/89.
