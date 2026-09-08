---
id: jan-p62w
status: open
open: true
deps: []
links: [jan-ppsz, pj-fx5e]
created: 2026-09-08T02:39:16Z
type: feature
priority: 1
assignee: memgrafter
tags: [catalog, models.json, k3s, aliasing,category-registry,pi-cli,single-source-of-truth]
---
# Model aliasing via the category registry: short pi-CLI names -> long upstream model ids

## Background / incident

When adding the `modal` provider we hit a resolution mismatch. The naming split is **intentional and desired**: the vLLM upstream uses the long id (`qwen3.8-27b-w4a4-dflash2`), and the pi-CLI-facing name should be the short one (`qwen3.8-27b`). But the two layers ended up using different ids with nothing to bridge them:

- **Live k3s catalog** (ConfigMap `janus-inference-control-plane-catalog` -> `models.json`, the authority the k3s janus resolves against): `modal/qwen3.8-27b-w4a4-dflash2` (+ `-instruct`), where the instruct entry carries `wireModel: qwen3.8-27b-w4a4-dflash2`.
- **Local pi-CLI catalog** (`~/.pi/agent/models.json`, what the pi CLI sends): `modal/qwen3.8-27b` (+ `-instruct`).

Result: a request for the short id `modal/qwen3.8-27b-instruct` returns `Unknown model` from the k3s, because `resolveModel` does an **exact** `provider/id` match and the short id isn't registered there. (A side effect: a `k3s-release.sh --smoke-model modal/qwen3.8-27b` run failed "smoke model is not advertised" and auto-rolled back, even though the deploy was fine — the smoke model must be an id the k3s actually resolves.)

## The aliasing method (already in janus)

`CategoryRegistry.resolve` (`src/categories.ts`) is what every sync/event request flows through (`control.admit` -> `categories.resolve(requested, models)`). It resolves a requested id two ways, in order:

1. **Category id** — if `requested` is a registered category, `pickModel(cfg.models)` returns the **first** `provider/id` ref in the category's `models` list that resolves (later refs are fallbacks). **This is the model-aliasing method**: a short/curated name maps to a concrete upstream model, independent of the model's own id.
2. **Raw model ref** — otherwise `resolveModel` does an exact `provider/id` / bare `id` match (no aliasing).

So the clean way to get "pi uses the short name, vLLM uses the long id" is a **category alias**: a category whose `id` is the short name and whose `models` is `[the long provider/id]`. The short id resolves to the long model; that model's `wireModel` then rewrites the outgoing payload to the real upstream id. The two compose: category alias resolves the model, `wireModel` fixes the wire id. (Documented in AGENTS.md, "Model id / category resolution (and model aliasing)".)

Categories come from `PI_JANUS_CONFIG` (`{ categories: [{ id, models, quotaBucketId?, deadlineMs? }] }`) and are **inert by default** — the live k3s currently has no `PI_JANUS_CONFIG`, so only raw `provider/id` refs resolve today.

## Design

RECOMMENDED (Option A) — use the category registry as the alias layer. Add a `PI_JANUS_CONFIG` (ConfigMap + env on the k3s) defining categories that alias the short pi-CLI names to the long catalog models, e.g.:
```json
{ "categories": [
  { "id": "modal/qwen3.8-27b",          "models": ["modal/qwen3.8-27b-w4a4-dflash2"] },
  { "id": "modal/qwen3.8-27b-instruct", "models": ["modal/qwen3.8-27b-w4a4-dflash2-instruct"] }
] }
```
The k3s catalog keeps the long vLLM ids (single source of truth for the real model); the short pi names are pure aliases. No duplicate catalog entries, no id drift. Tradeoffs: (pro) uses the existing, intended mechanism; one authority for real model ids; aliases are declarative and central; composes with `wireModel`; (con) requires standing up `PI_JANUS_CONFIG` on the k3s (currently inert), and category aliases are NOT listed in `/v1/models` (they're resolution-only), so the pi CLI's local list is still how a human discovers the short names.

ALTERNATIVES:
- (B) Duplicate catalog entries: add the short ids to the k3s `modal` provider as extra entries with `wireModel` -> long upstream id. Tradeoffs: (pro) no `PI_JANUS_CONFIG` needed, short ids show in `/v1/models`; (con) two catalog entries for one real model = the duplication/drift this ticket exists to avoid; per-model fields must be kept in sync across the duplicates.
- (C) Generate the local pi-CLI `janus-k3s` block from the live k3s catalog (sync tool). Tradeoffs: (pro) local view can't drift from advertised ids; (con) doesn't solve the short->long alias (it would just copy the long ids, which we don't want pi to use); still a second file to keep in sync; needs k3s reachable + token.
- (D) Revert the local rename so pi uses the long ids. Tradeoffs: (pro) zero new machinery; (con) pi-facing names become the long vLLM ids, which is exactly what we don't want.

RECOMMENDATION: A (category aliases) as the durable alias layer. Note A is orthogonal to jan-ppsz (catalog hot reload) — both read `PI_JANUS_CONFIG`/catalog at startup, so hot-reloading the catalog should also hot-reload categories (coordinate).

## Immediate fix (do now, before the P1 work)

The recent change left the local `~/.pi/agent/models.json` `janus-k3s` block with short ids (`modal/qwen3.8-27b`, `modal/qwen3.8-27b-instruct`) that the k3s does NOT resolve (no `PI_JANUS_CONFIG` yet). To leave a happy state without standing up the category config today: point the local `janus-k3s` block at the ids the k3s actually resolves — the long ones (`modal/qwen3.8-27b-w4a4-dflash2`, `...-instruct`). The top-level local `modal` provider (short ids + `wireModel`) is fine to keep for direct `--provider modal` use. This makes every locally-listed `janus-k3s/*` id resolvable on the k3s. The short-name aliasing itself is deferred to Option A.

## Acceptance Criteria

a) A request for a short pi-CLI name (e.g. `modal/qwen3.8-27b-instruct`) resolves to the long catalog model on the k3s (via a category alias) and completes, with `wireModel` sending the real upstream id. b) The k3s catalog remains the single source of truth for real model ids (no duplicate short-id catalog entries). c) `PI_JANUS_CONFIG` is deployed to the k3s (ConfigMap + env) and the categories resolve. d) The local `~/.pi/agent/models.json` lists only ids the k3s actually resolves (immediate fix) — no `Unknown model` for any listed `janus-k3s/*` id. e) `k3s-release.sh` smoke model is an id the k3s resolves (or validated against the live catalog) so a renamed/aliased id cannot cause a false rollback. f) Documented: category registry = alias layer; k3s catalog = authority for real ids; `wireModel` = outgoing wire-id rewrite (already in AGENTS.md). g) (nice-to-have, with jan-ppsz) a guard that fails if a locally-listed `janus-k3s/*` id is neither a raw k3s model nor a registered category alias.
