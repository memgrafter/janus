---
id: jan-v39j
status: open
open: true
deps: []
links: [jan-hop4]
created: 2026-09-05T20:57:32Z
type: feature
priority: 2
assignee: memgrafter
tags: [auth, token, rotation, k3s]
---
# Inbound Janus bearer-token hot rotation (file-mounted, no restart)

JANUS_TOKEN is cached by loadConfig() at startup, so rotating the inbound bearer token requires a pod restart. Handle this separately from provider credentials: mount the token Secret as a projected file and read it per request (or reload when the file changes). Optionally support old/new token overlap during rotation. k3s projected-file env mounts DO update on Secret change, but a plain env var does not, so the file is the mechanism.

## Design

Chart: mount the token Secret as a file (e.g. /etc/janus/token) instead of/in addition to the env var; Janus: read+trim the file per request when present, falling back to the JANUS_TOKEN env for backward compatibility; validate Authorization against current contents (optionally an allowlist of previous values for overlap). Keep the token token-less mode (unset = no auth) working.

## Acceptance Criteria

Rotating the k3s Secret changes the accepted bearer token without a restart; old token still accepted during an optional overlap window; JANUS_TOKEN env fallback unchanged; tests cover per-request read + overlap.
