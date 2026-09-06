---
id: jan-dnsp
status: open
open: true
deps: []
links: []
created: 2026-08-30T23:23:54Z
type: investigation
priority: 2
assignee: memgrafter
tags: [vllm, thinking-budget, reasoning, investigation]
---
# Investigate local vLLM support for thinking token budgets

Investigation only — no conclusion or fix decided yet.

## Symptom
When a client sends a reasoning token budget to a **local vLLM** provider through
janus, the request fails with an error along the lines of "thinking token budgets
weren't yet supported" (vLLM rejects the sampling param). We need to figure out
what local vLLM actually accepts for capping reasoning tokens before we decide
how (or whether) janus should forward a budget to it.

## Context (verified, do not re-derive)
- janus already has budget plumbing:
  - `src/openai.ts` `parseThinkingTokenBudget` reads `thinking_token_budget`
    (vLLM) or `thinking_budget_tokens` (llama.cpp) from the request body.
  - `src/bridge.ts` `addQwenReasoningControls` forwards the budget **only** if the
    model advertises `compat.thinkingTokenBudgetField` or the legacy
    `compat.supportsThinkingTokenBudget` flag; otherwise it is dropped. This was
    the fix for the `finish_reason: error` when unsupported params hit a server.
- Local vLLM serving lives in `~/code/vllm.config` (docker compose, 3x 3090).
  Active profile `config/models/qwen3.6-27b-fp8.json` uses
  `"reasoning_parser": "qwen3"`, `language_model_only: true`, fp8, pp4.
- The vLLM image is a **patched** build (`~/code/vllm.config/docker/`) — so the
  set of accepted sampling params may differ from stock vLLM.

## What we do NOT know (the actual questions)
1. Does the deployed local vLLM version accept a reasoning-budget sampling param
   at all, and under what exact name? (candidates seen in the wild:
   `thinking_token_budget`, `thinking_budget_tokens`, `reasoning_effort`,
   `chat_template_kwargs.enable_thinking`, `extra_body` passthrough, or a
   chat-template-level `thinking_budget`.)
2. Is the "not yet supported" error coming from vLLM's sampling-params
   validation, from the chat template, or from the reasoning parser?
3. Does the patched vLLM build in `~/code/vllm.config/docker/` add or remove any
   budget-related param vs stock?
4. Is there a version/flag gate (e.g. `--reasoning-parser` + a specific vLLM
   version) that must be on for budget support?

## Recommended investigations (NOT conclusions — pick/expand as needed)
- Reproduce: send a minimal `/v1/chat/completions` to the local vLLM with each
  candidate budget field and capture the exact error + which field triggers it.
  (A throwaway capture proxy like `/tmp/janus-capture-proxy.ts` can log the
  outgoing payload so we see exactly what janus sends vs what vLLM rejects.)
- Read the deployed vLLM's accepted sampling params: check the running image's
  `SamplingParams` / OpenAI-compatible server arg validation, and the patched
  build's diff in `~/code/vllm.config/docker/`.
- Check the qwen3 chat template / reasoning parser for a `thinking_budget`
  template variable and how it is populated.
- Confirm the exact vLLM version in the local image and cross-reference its
  reasoning-budget support (changelog / source).
- Determine whether budget is even the right knob for this model, or whether
  `reasoning_effort` / `enable_thinking` is the supported lever.

## Out of scope (for now)
- Implementing the fix / choosing the wire field.
- Changing janus forwarding behavior.
- Touching the ClinePass or other providers.

## Acceptance (for closing the investigation)
- We can state, with evidence (repro + source), exactly what the local vLLM
  accepts for reasoning-token budgeting (field name + how to set it), or that it
  does not support it and what the closest supported alternative is.
- A short write-up (ticket note or doc) capturing the finding so the follow-up
  implementation ticket can be written from it.
