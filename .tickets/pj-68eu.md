---
id: pj-68eu
status: closed
open: false
deps: []
links: []
created: 2026-08-23T17:53:27Z
type: bug
priority: 2
assignee: memgrafter
parent: pj-gvlk
tags: [pi-janus, openai, roles, bug]
---
# Accept the OpenAI 'developer' message role as system

pi-janus's parseMessage only handled system/user/assistant/tool and threw 400 "unsupported message role" for "developer". "developer" is OpenAI's successor to "system" (the instruction role), so an OpenAI-compatible proxy must accept it.

## Symptom
Routing pi through pi-janus failed with: 400 {"message":"unsupported message role \"developer\"","type":"invalid_request_error","code":null}.

## Root cause
With a reasoning model whose compat does not pin supportsDeveloperRole, pi-ai's getCompat falls back to detectCompat, which defaults supportsDeveloperRole to true for non-OpenRouter models. So the client sends the system prompt as role "developer", which pi-janus rejected.

## Fix
- openai.ts parseMessage: accept "developer" and map it to the system prompt.
- (config-side, in the user's models.json) declare supportsDeveloperRole: false on the pi-janus entry so the client sends "system", matching the upstream.

## Depends on
- Core proxy (pj-vwed).

## Acceptance Criteria

A chat completion carrying a developer-role message is accepted (mapped to the system prompt) rather than rejected with 400; system/user/assistant/tool roles are unchanged; no changes to the pi-ai mapping or transport layers.

## Notes

**2026-08-23T17:53:33Z**

Fixed (commit 99e14f6): openai.ts parseMessage now accepts 'developer' -> system prompt. Unit test added (openai.test.ts). Verified end-to-end: a developer-role request through the proxy now returns a real completion. Suite 83/83. Config-side: declared supportsDeveloperRole:false on the pi-janus models.json entry so the client sends 'system'.
