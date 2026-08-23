---
id: pj-1uyc
status: open
open: true
deps: [pj-vwed, pj-xe41]
links: []
created: 2026-08-23T12:59:09Z
type: feature
priority: 2
assignee: memgrafter
parent: pj-gvlk
tags: [pi-janus, categories, config]
---
# Intelligence category registry & quota/deadline binding

Configure which "intelligence types / categories" are available, and bind them to specific quotas and deadlines. The model catalog itself comes from pi-ai (Model + getModels/getAvailable + createProvider); this component adds the proxy's category layer and the category-to-quota/deadline binding that pi-ai does not provide.

## Scope
- A registry of intelligence categories. Each category maps to one or more pi-ai models (or a custom provider registered via createProvider for proxy-owned "intelligence types" that are not a real upstream).
- Category metadata: id, name, capabilities (reasoning, vision, context window, max tokens, thinking levels), and the underlying model(s)/provider(s).
- Binding: each category is associated with a quota bucket and a deadline policy (from the quota & deadline ledger).
- Expose the available categories (and which are currently available given auth/quota) to clients — e.g., a /v1/categories or /v1/models endpoint that reflects the registry + availability.
- Resolve an incoming request's requested category/model to the concrete pi-ai Model + quota bucket + deadline used for dispatch.

## Minimal implementation (selected)

- **Config-driven** `categoryId → Category` (from the `PI_JANUS_CONFIG` JSON). `Category = { id, name, models: ["prov/id", …], capabilities, quotaBucketId, deadlinePolicy }`.
- **`resolveCategory(id)`** is the routing decision: a request's `model` may be a *category id* or a raw `prov/id`. Category → pick a concrete model (minimal: first `getAvailable()` match) + its `quotaBucket` + `deadlinePolicy`. This turns a request into a full DispatchContext.
- **New endpoint** `GET /v1/categories` (list + which are available now given auth/quota). Leave `/v1/models` as raw pi-ai models for now.
- **Proxy-owned categories** (via `createProvider`): support the *shape* (a category whose `models` point at a custom provider), but defer actually registering custom providers — first cut binds categories to real pi-ai models only.

## Depends on
- Core proxy (needs the Models collection + request path).
- Quota & deadline ledger (binding target).

## Acceptance
- A client can list available intelligence categories and see which are available now.
- A request naming a category resolves to the correct underlying model and is dispatched under that category's quota/deadline.
- A proxy-owned category (registered via createProvider) is selectable and routable.

## Notes

**2026-08-23T16:03:03Z**

Implemented: CategoryRegistry (resolve/list/availability) + GET /v1/categories. Unit (categories.test.ts) + integration + live. Proxy-owned categories via setProvider (faux); createProvider custom providers deferred.
