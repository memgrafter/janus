---
id: jan-uzgv
status: closed
open: false
deps: []
links: []
created: 2026-09-04T20:17:14Z
type: bug
priority: 1
assignee: memgrafter
tags: [observability, oauth, k3s]
---
# Preserve provider errors and OAuth credentials across k3s restarts

## Notes

**2026-09-04T20:22:38Z**

Implemented provider-error logging for chat, Responses, and queued work; changed Helm OAuth seeding to preserve rotated PVC credentials and enforce mode 0600. Updated the cluster Secret from the current local OpenAI credential, rolled out release 27, and verified openai-codex/gpt-5.6-sol end-to-end. Logging exposed Cline's exact 429 5-hour ClinePass limit.
