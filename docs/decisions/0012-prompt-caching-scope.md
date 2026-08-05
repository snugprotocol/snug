# 0012 — Prompt caching is a per-turn decision, scoped to builder/agent turns

- **Status:** accepted
- **Date:** 2026-08-05
- **Task:** TASK-20260804-observability-caching

## Context

Snug calls LLMs through one choke point (`runAgentTurn`) but the turns it carries have two very different shapes:

- **Builder/agent turns** — a large system prompt plus a fixed tool list, repeated many times within a single build. Every hub user's builder turns share that prefix.
- **App-frame turns** — a running app's `sendMessage` (a Chess move). Short, self-contained envelopes with no tools and no thread history.

Anthropic prompt caching is a **prefix match** over the render order `tools` → `system` → `messages`, with a **model-dependent minimum cacheable prefix** (512 / 1024 / 2048 / 4096 tokens depending on the model). Below that minimum, the API silently does not cache — no error, no signal. A cache write costs ~1.25× the base input price; a read costs ~0.1×.

That asymmetry is the whole decision. On builder turns the prefix is large and re-read constantly, so caching pays for itself within two requests. On app-frame envelopes the prefix is almost certainly below the minimum, so a breakpoint there buys a write premium on something that is **never read** — a permanent cost increase with no upside, and no error to reveal it.

The first implementation put the opt-in on the adapter (`anthropicAdapter({ cache: true })`). A Gate-5 fresh-context review showed that this cannot express the scope at all: `apps/server` builds **one** adapter instance that serves **both** `/invoke` paths, so an adapter-level flag necessarily applies to both. The result was wrong in both directions simultaneously — app-frame envelopes were cached (forbidden), and direct mode was never wired (required). Every test passed, because every test asserted at the adapter rather than at the call site that decides.

## Decision

**Caching is requested per TURN, not per adapter.**

1. `cache?: boolean` lives on `AdapterRequest` — the per-call object — not on any adapter's construction options. Only the caller knows the shape of the turn it is running.
2. The breakpoint goes on the **last system block**, which caches `tools` + `system` together given the render order. Never on the `messages` tail: a breakpoint on volatile content writes a fresh entry per request and reads none.
3. Adapters refuse caching for endpoints that cannot support it, **even when asked**. `supportsCaching()` gates on the Anthropic hostname; local and OpenAI-compatible endpoints reject unknown fields, and an unknown field on a local turn is fatal (this is the `max_completion_tokens` failure class that broke every local turn in a prior task).
4. Callers derive the flag from a discriminator they already have, rather than introducing a parallel one that can drift:
   - `apps/server/src/routes/invoke.ts` uses `plan.withTools` — `true` is the builder path, `false` is app-frame. The two coincide exactly.
   - `apps/playground/src/agent/builder.ts` (direct-mode builder) opts in; `agent/transport.ts` (app-frame) does not.

## Consequences

- Adding a new `runAgentTurn` call site is now an explicit caching decision. The default is **off**, so forgetting it costs a missed optimization rather than a silent recurring charge — the safe direction.
- Cache effectiveness is observable rather than assumed: `TokenUsage` carries `cacheCreationTokens` / `cacheReadTokens`, surfaced as a cached %. This matters because the minimum-prefix rule means "we sent `cache_control`" proves nothing — only a reported `cache_read_input_tokens` proves a cache was used. Tests assert on a mocked provider response reporting a read, never on the request field alone.
- The per-turn context suffix the builder appends (app code, schema, docs) lands at the **end** of `system`, after the byte-stable base layers, so it does not invalidate the cached prefix. Any future change that prepends per-turn content to `system` silently destroys cache hits and must be caught by the cached-% reporting.
- **Testing rule this establishes:** a conditional behavior must be tested where the condition is evaluated. Route-level tests now assert that each `/invoke` path sets the flag correctly; adapter-level tests only prove the mechanism honors it. See `docs/lessons.md` 2026-08-05.

## Alternatives considered

- **Cache everything.** Rejected: pays the write premium on app-frame envelopes below the cacheable minimum, forever, for prefixes never read.
- **Cache nothing.** Rejected: forgoes the single highest-value cost optimization available, on the most-repeated prompt in the product.
- **Infer from prompt size at the adapter.** Rejected: the minimum is *model*-dependent (512–4096) and the adapter would have to tokenize to guess. The caller already knows what kind of turn it is running — inference would replace a fact with an estimate.
- **A separate `isBuilderTurn` flag on the route plan.** Rejected: `withTools` already encodes exactly this distinction, and a second flag could drift from it.
