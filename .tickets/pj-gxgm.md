---
id: pj-gxgm
status: open
open: true
deps: [pj-fdxw]
links: []
created: 2026-08-25T13:10:59Z
type: feature
priority: 1
assignee: memgrafter
parent: pj-0x3c
tags: [auth, oauth, seeding, helm]
---
# Credential seeding workflow: import auth.json via a scratch pi agent dir

A shell script (in the chart context) to seed OAuth credentials into the cluster without a co-located pi: (1) run pi with a scratch agent dir (PI_CODING_AGENT_DIR=<scratch>) so the user does the normal interactive OAuth login (codex/copilot/xai) into <scratch>/auth.json; (2) copy <scratch>/auth.json into the proxy PVC at the PI_JANUS_AUTH_JSON path (reuse the jellyfin importer-pod pattern: temp Pod mounting the PVC + rsync via port-forward, nodeSelector to pin to the RWO node); (3) delete the scratch dir. Import-only for now (no self-serve login endpoint in the proxy).

## Design

Script steps:
- SCRATCH=$(mktemp -d); PI_CODING_AGENT_DIR=$SCRATCH pi   # user logs in interactively
- verify $SCRATCH/auth.json has the expected providers
- apply importer-pod.yaml (mounts the proxy PVC, runs rsync daemon, nodeSelector to the proxy's node)
- kubectl port-forward + rsync $SCRATCH/auth.json -> /data/auth.json in the pod; chown if needed
- kubectl delete -f importer-pod.yaml; rm -rf $SCRATCH
- Optionally scale the proxy to 0 during the copy (RWO) and back to 1.
Idempotent: re-running overwrites the providers in the PVC auth.json.

## Acceptance

Running the script on a workstation with pi: user logs into codex; the script copies auth.json into the PVC and deletes the scratch dir; the proxy exposes openai-codex and a chat completion to gpt-5.5 succeeds; the scratch dir is gone.
