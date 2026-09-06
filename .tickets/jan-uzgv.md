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

**2026-09-05T20:57:32Z**

2026-09-11 (hot-reload finding): current model is PVC-authoritative after seed (seed-cline init container seeds only if absent); OAuth refreshes persist to the PVC only, so the bootstrap k3s Secret goes stale after rotation. Accepted as policy; refresh-back to the Secret is a future mirroring option (needs narrowly scoped Secret-update RBAC). Tracking in jan-hop4.
