---
id: pj-fdxw
status: open
open: true
deps: [pj-arr0]
links: []
created: 2026-08-25T13:10:59Z
type: feature
priority: 1
assignee: memgrafter
parent: pj-0x3c
tags: [helm, k3s, deployment]
---
# Helm chart: deploy the proxy as a k3s service (metallb LB + PVC + catalog file + secrets)

New helm chart in ~/code/k3s_maintenance/ (working name janus-inference-control-plane; "pi-janus" naming dropped). Deploys: a 1-replica Deployment (strategy Recreate) running the proxy image with env from Secrets (API keys, PI_JANUS_TOKEN), PI_JANUS_MODELS_JSON -> a mounted catalog file (ConfigMap) for custom providers, PI_JANUS_AUTH_JSON -> a PVC path for durable OAuth; a Service type LoadBalancer with loadBalancerIP (metallb); a PVC (longhorn, ReadWriteOnce) for auth persistence; a ConfigMap holding the catalog file. Match iterarium/ conventions. Default 1 replica; document that >1 replica sharing the PVC is unsafe (proper-lockfile advisory locks unreliable on networked/CSI fs -> refresh-token double-spend).

## Design

values.yaml: image{repository,tag,pullPolicy}, service{type:LoadBalancer,port:8787,loadBalancerIP}, persistence{enabled,storageClass:longhorn,accessMode:ReadWriteOnce,size,mountPath:/data}, auth{existingSecret}, catalog{existingConfigMap or inline}, env apiKeys via secretKeyRef.
deployment: initContainer fix-perms on /data; container env PI_JANUS_AUTH_JSON=/data/auth.json, PI_JANUS_MODELS_JSON=/etc/janus/models.json, PI_JANUS_TOKEN from secret, API keys from secret; volumeMounts /data (PVC) + /etc/janus (ConfigMap).
service: LoadBalancer + loadBalancerIP. pvc: conditional on persistence.enabled.
Catalog file content = custom (non-built-in) providers only (built-ins come from env); can be empty if only built-ins wanted.

## Acceptance

helm install (with a values file + pre-existing Secret + ConfigMap) brings up 1 pod behind a metallb IP; /v1/models shows env-key providers + catalog providers + persisted OAuth providers; a chat completion to each category succeeds via the metallb IP; helm uninstall cleans up (PVC retention documented).

## Notes

**2026-08-25T13:46:05Z**

First version built + verified (commit f868343). chart/ at repo root, name "janus-inference-control-plane" (pi-janus naming dropped; rename if a better name is chosen). Generic/portable — all cluster-specifics are values (see values.example.yaml for a longhorn+metallb instantiation). Resources: 1-replica Deployment (Recreate; 1-replica is REQUIRED — proper-lockfile advisory locks are unsafe across replicas sharing the PVC), metallb LoadBalancer Service (loadBalancerIP value), longhorn PVC (auth, ReadWriteOnce), catalog ConfigMap (custom providers; existing or inline modelsJson), Secrets (API keys via apiKeys list, bearer via auth.existingSecret). initContainer chowns /data to 65532 (distroless nonroot). readiness+liveness probes on /health. Verified: helm lint clean; helm template renders valid YAML for defaults, example values, and inline-catalog path. Next: bring into ~/code/k3s_maintenance/ for instantiation (back-and-forth expected).

**2026-08-25T14:09:18Z**

Renamed chart/service to janus-inference-control-plane (was working name 'inference-proxy') — clearer scope, avoids collision with the user's other proxy projects. Brought into ~/code/k3s_maintenance/janus-inference-control-plane/ with values-europa.yaml. PVC sized 256Mi (only holds auth.json ~KB + lockfile). HA concept agreed: Tier 1 = 1 active replica + RWO longhorn PVC (self-healing via reschedule + longhorn volume migration; single writer avoids refresh-token double-spend). N replicas deferred (needs RWX storage + distributed lock / single-writer — a code change). Awaiting registry decision + user approval before helm install.
