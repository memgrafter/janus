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

New helm chart in ~/code/k3s_maintenance/ (working name inference-proxy; "pi-janus" naming dropped). Deploys: a 1-replica Deployment (strategy Recreate) running the proxy image with env from Secrets (API keys, PI_JANUS_TOKEN), PI_JANUS_MODELS_JSON -> a mounted catalog file (ConfigMap) for custom providers, PI_JANUS_AUTH_JSON -> a PVC path for durable OAuth; a Service type LoadBalancer with loadBalancerIP (metallb); a PVC (longhorn, ReadWriteOnce) for auth persistence; a ConfigMap holding the catalog file. Match iterarium/ conventions. Default 1 replica; document that >1 replica sharing the PVC is unsafe (proper-lockfile advisory locks unreliable on networked/CSI fs -> refresh-token double-spend).

## Design

values.yaml: image{repository,tag,pullPolicy}, service{type:LoadBalancer,port:8787,loadBalancerIP}, persistence{enabled,storageClass:longhorn,accessMode:ReadWriteOnce,size,mountPath:/data}, auth{existingSecret}, catalog{existingConfigMap or inline}, env apiKeys via secretKeyRef.
deployment: initContainer fix-perms on /data; container env PI_JANUS_AUTH_JSON=/data/auth.json, PI_JANUS_MODELS_JSON=/etc/janus/models.json, PI_JANUS_TOKEN from secret, API keys from secret; volumeMounts /data (PVC) + /etc/janus (ConfigMap).
service: LoadBalancer + loadBalancerIP. pvc: conditional on persistence.enabled.
Catalog file content = custom (non-built-in) providers only (built-ins come from env); can be empty if only built-ins wanted.

## Acceptance

helm install (with a values file + pre-existing Secret + ConfigMap) brings up 1 pod behind a metallb IP; /v1/models shows env-key providers + catalog providers + persisted OAuth providers; a chat completion to each category succeeds via the metallb IP; helm uninstall cleans up (PVC retention documented).
