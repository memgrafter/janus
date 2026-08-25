---
id: pj-olwn
status: open
open: true
deps: []
links: []
created: 2026-08-25T13:10:59Z
type: task
priority: 2
assignee: memgrafter
parent: pj-0x3c
tags: [test, catalog]
---
# Lock in env-driven catalog behavior (no models.json -> builtins from env keys)

Add a test that locks in the k3s-mode catalog behavior: with no PI_JANUS_MODELS_JSON and env API keys set, /v1/models lists the built-in providers that have keys (and omits those without). This is the foundation for the envvar-driven catalog; verified manually (409 models across openai/deepseek/openrouter/xai/github-copilot) but not yet a regression test.

## Design

In test/integration (or unit): build a client with no modelsJson, set a fake env key for a built-in provider, assert /v1/models includes that provider's models and excludes a provider with no key. Keep it hermetic (no real network) — use the faux provider or a controlled env.

## Acceptance

Test passes in the suite; fails if the env-driven catalog behavior regresses.
