---
id: pj-fx5e
status: closed
open: false
deps: []
links: []
created: 2026-08-23T17:28:03Z
type: feature
priority: 2
assignee: memgrafter
parent: pj-gvlk
tags: [pi-janus, providers, models-json]
---
# Register real providers from a pi models.json catalog

Point pi-janus at a pi models.json provider catalog (e.g. ~/.pi/agent/models.json) via PI_JANUS_MODELS_JSON and register those providers alongside the built-ins, so a request can name a catalog model as provider/id (e.g. vert-qwen38-dual-fast/qwen3.8-27b).

## Scope
- New env var PI_JANUS_MODELS_JSON (path to a pi models.json file).
- custom-providers.ts: minimal loader using pi-ai createProvider + getApiProvider (from the /compat subpath, which registers the built-in API impls at module load). No dependency on the coding-agent package.
- resolveApiKey: literal keys ("0") pass through; "$ENV_VAR" refs resolve from the environment.
- Providers with no models / no api / unknown api are skipped with a warning (non-fatal).
- models.ts: createClient registers custom providers after building the base (builtin or faux) models.

## Minimal implementation (selected)
A thin loader on top of pi-ai's public provider API (createProvider + getApiProvider), mirroring the coding-agent's field mapping (modelFromJson/providerFromJson) but without depending on that package. Registers into the same MutableModels the core already owns, so the existing resolveModel / bridge / sse pipeline is untouched.

## Depends on
- Core proxy (pj-vwed).

## Acceptance Criteria

Given PI_JANUS_MODELS_JSON set to a models.json, its providers register and are listed as provider/id; a chat completion (stream + non-stream) and the Responses API against a catalog model return a real completion; a $ENV_VAR provider is available only when the env var is set; providers with no models/api/unknown api are skipped non-fatally; no changes to the core mapping or transport layers.

## Notes

**2026-08-23T17:28:10Z**

Implemented (commit bed8066): src/custom-providers.ts (registerModelsJson via createProvider + getApiProvider from /compat; resolveApiKey for literal + $ENV_VAR keys; non-fatal skip of bad providers) + config.ts modelsJsonPath + models.ts registration in createClient (typed MutableModels). Verified LIVE against a real vllm provider (vert-qwen38-dual-fast/qwen3.8-27b): non-stream ('Hello there friend'), stream (SSE '1..5'), and Responses API ('pong') all return real completions; unknown model 400s. Unit: custom-providers.test.ts (register+resolve, skip unknown api non-fatally, $ENV_VAR availability gated on env). Suite 82/82. AGENTS.md documents PI_JANUS_MODELS_JSON.
