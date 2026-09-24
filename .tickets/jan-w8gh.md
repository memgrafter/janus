---
id: jan-w8gh
status: in-progress
open: true
deps: []
links: []
created: 2026-09-24T20:32:04Z
type: feature
priority: 3
assignee: memgrafter
tags: [decisions, systemone, kev]
---
# Decision routing: add kev as a /v1/systemone decision source

Route kev (github.com/jaredpalmer/kev, a drop-in Jev implementation) through the existing /v1/systemone transparent router alongside djev/gliner2/jev. kev.serve exposes the same TypeSafe contract behind model kev-latest, so no janus code change is needed - only a decisions.json source entry. Also adds unit coverage for decisions.ts (loadDecisions + routeDecision) which previously had none.

## Design

1) decisions.json: add `{ "kev": { "baseUrl": "http://127.0.0.1:8009", "model": "kev-latest" } }` — the model override mirrors the jev-prod→jev-latest pattern: the client sends `model: "kev"`, janus rewrites it to `kev-latest` before forwarding (kev echoes the field back, keeping response bodies consistent). 2) kev.serve hardcoded `host="127.0.0.1"`; patched `kev/serve.py` to add `--host` (`KEV_HOST` env, default `0.0.0.0`) and `--port` default 8009 so it can serve on the LAN for the k3s-janus deployment (there the baseUrl is the Mac's LAN IP, not 127.0.0.1). 3) No janus server.ts/routeDecision/control-plane change — the router already forwards verbatim, rewrites `model`, and injects an upstream Bearer key via `$ENV` resolve.

## Acceptance Criteria

a) `curl POST /v1/systemone` with `model: "kev"` returns a kev answer (model echoed as `kev-latest`) and logs a `pi-janus: decision kev -> 200` line. b) Existing sources (djev/gliner2/jev-prod) still route. c) `test/unit/decisions.test.ts` covers loadDecisions parsing/`$ENV`/skip-bad + routeDecision model-rewrite/404/502/bearer. d) tsc + full unit+integration green.

## Notes

**2026-09-24** Implemented + verified: kev-4b (`jaredpalmer/kev-4b`, MLX bf16, temp 2.41) serving on 0.0.0.0:8009; decisions.json updated; janus restarted with the new source. End-to-end through janus returned `model: kev-latest`, correct answers, 1.5s hot (83s was the MLX first-run JIT). Memory headroom: 57% free RAM with djev (~16.5 GB) + gliner2 + kev-4b (~8 GB) resident. For the k3s deployment point the kev baseUrl at the Mac LAN IP (e.g. 192.168.1.173:8009); add `apiKey: "$KEV_API_KEY"` if KEV_API_KEY is set on the kev server.
**2026-09-24** Model size: kev-4b measured 17.2 GB resident + 17.4 GB swapped on the 24 GB Mac (MLX backend merges LoRA in fp32 -> ~34 GB allocation during load; djev is already 17.1 GB resident), swapping the box (25.4 GB swap). Dropped to **jaredpalmer/kev-0.8b**: 3.9 GB resident, 0 swap, 365 ms hot. Accuracy tradeoff documented (0.8b 0.648/0.697 vs 4b 0.817/0.838 on new sources) — revisit if a GPU host (k3s node w/ L4, L40S) becomes the kev home; on a 24 GB Mac only 0.8b fits alongside djev.
