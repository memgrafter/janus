---
id: pj-0x3c
status: open
open: true
deps: []
links: []
created: 2026-08-25T13:10:46Z
type: epic
priority: 1
assignee: memgrafter
parent: pj-gvlk
tags: [k3s, helm, deployment, middleware]
---
# Standalone deployment: run the proxy as a k3s service (envvar catalog + durable auth + credential seeding)

pi-janus is currently a local, co-located proxy: it reads ~/.pi/agent/models.json (catalog) and ~/.pi/agent/auth.json (OAuth creds), and pi auto-discovers it as the local "pi-janus" provider. This epic adds a second, first-class mode of operation: run the proxy as a standalone k3s service (metallb LoadBalancer IP) with NO co-located pi.

In k3s-service mode:
- The provider/model catalog is derived from envvars: API keys present in the pod env -> built-in providers auto-offered; a mounted catalog file (PI_JANUS_MODELS_JSON) adds custom (non-built-in) providers.
- OAuth refresh keys persist to a PVC (PI_JANUS_AUTH_JSON -> a durable path).
- Clients are explicitly configured to point at the service (baseUrl + models + bearer token via PI_JANUS_TOKEN) instead of auto-discovering a local proxy.

Both modes (local-proxy and k3s-service) are first-class and must keep working; neither is a special case of the other.

Decisions made:
1. Custom providers: a catalog file included in the helm chart (mounted, PI_JANUS_MODELS_JSON).
2. Credential seeding: import for now — a shell script that runs pi with a scratch agent dir (PI_CODING_AGENT_DIR), the user does the OAuth login, the resulting auth.json is copied into the PVC and the scratch dir deleted. (No self-serve login endpoint in the proxy, for now.)

The helm chart lives in ~/code/k3s_maintenance/ as a NEW chart. The "pi-janus" naming is dropped (more middlewares will be added) — chart/service name TBD (working name: inference-proxy).

## Design

Verified (side-port test, no PI_JANUS_MODELS_JSON): janus already auto-offers built-in providers from env API keys (openai/deepseek/openrouter from OPENAI_API_KEY/DEEPSEEK_API_KEY/OPENROUTER_API_KEY) AND OAuth providers from PI_JANUS_AUTH_JSON (openai-codex/github-copilot/xai) — 409 models. So the core "autodetect from env + persisted auth" already works; this epic packages it as a service.

Key mechanisms (all already exist):
- PI_JANUS_AUTH_JSON is a configurable path (point at a PVC).
- PI_JANUS_MODELS_JSON takes a path (mount a catalog file).
- PI_JANUS_TOKEN (bearer auth) supported.
- pi's agent dir (and thus auth.json) is overridden by PI_CODING_AGENT_DIR (confirmed: coding-agent config.ts ENV_AGENT_DIR = PI_CODING_AGENT_DIR).

Helm conventions to match (from iterarium/ + jellyfin/): Chart.yaml (apiVersion v2); values.yaml (image/service/persistence/auth); templates/{_helpers.tpl,deployment.yaml,service.yaml,pvc.yaml}; StorageClass longhorn; accessMode ReadWriteOnce; Service type LoadBalancer with loadBalancerIP (metallb); auth via pre-existing k8s Secret read via lookup; replicas 1 + strategy Recreate; initContainer to fix perms. Credential seeding reuses the jellyfin importer-pod pattern (temp Pod mounting the PVC + rsync via port-forward, nodeSelector to pin to the RWO node, then delete the pod).

## Acceptance

Both modes work and are documented:
- (a) local-proxy mode (co-located, ~/.pi/agent/) unchanged.
- (b) k3s-service mode: helm install deploys a 1-replica Deployment behind a metallb LoadBalancer with a longhorn PVC for auth, a mounted catalog file for custom providers, and API keys + bearer token from Secrets; /v1/models reflects env keys + catalog + persisted OAuth; a chat completion to an env-key provider and to an OAuth (codex) provider both succeed through the metallb IP; the credential-seeding script imports a freshly-logged-in auth.json into the PVC and deletes the scratch dir.
- The "pi-janus" name is not used in the chart/service.
