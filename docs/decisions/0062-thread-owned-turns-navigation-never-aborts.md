# 0062 — A turn belongs to its thread, not to the view: navigation never aborts, only stop does

- **Status:** accepted
- **Date:** 2026-09-03
- **Task:** TASK-20260903-build-thread-continuity

## Context

Since TASK-20260804-hub-polish the builder chat hook (`useBuilderChat`) has kept every piece of turn state — messages, busy flag, step timeline, the in-flight `AbortController` — in React component state, and its last effect aborted the request on unmount under the rule "never leave a request running headless". The LLM round-trip inspector followed the same shape: a per-mount reducer, in memory only (AC14), dying with the view.

React Router unmounts the view on every route change, so leaving `/build` for "your apps" killed a build mid-flight: the user bubble had been persisted, the assistant row (written only after the stream ends) never was, and the audit trail was gone. The same cleanup fires under `StrictMode`'s simulated unmount, which is why the hub→build `?idea=` handoff was known-broken in dev since 2026-08-06. The build page also knew exactly one thread id and could not reach any earlier conversation, although every one survives in the user DB.

Long builds are the product (48-iteration ceiling, 30-minute server lifetimes — TASK-20260803-hub-ops). A 30-minute build that cannot survive a click on the nav is not one the user can leave alone.

## Decision

1. **Turn state lives in a per-thread session store that outlives every view** (`apps/playground/src/agent/threadSessions.ts`): a module-level registry keyed by thread id, built on the existing hand-rolled `createStore`. The hook `useBuilderChat` keeps its public API but reads and writes the session; the `send()` closure keeps streaming into the store after the view that called it is gone. The round-trip inspector state is part of the session — still in memory, still bounded (60 entries / 8 MB per session, idle sessions evicted LRU beyond a fixed count), still redacted; AC14's byte-level guarantee is re-asserted across a navigation round-trip.
2. **The only abort is the user's explicit stop, or a user-DB swap seam.** The unmount abort is removed. The two tests that pinned it (`useBuilderChat` "fix 9", `chatRouterLifecycle` "unmounting aborts a classifier") are inverted, not deleted. The "headless" concern is answered by visibility instead: the build page's thread sidebar shows every thread with a live badge while it runs, so a running turn is always one click away.
3. **Swap seams reset the registry** (lesson 2026-08-20): user-file import / sync pull, backup restore, recover-fresh, and app delete abort their in-flight turns and drop the affected sessions, next to the existing sidecar-identity reset at the same call sites.
4. **The hub create bar mints a fresh thread.** Before, the idea typed on "your apps" continued the tab's stored thread — and silently became an edit of whatever app that thread was pinned to.
5. **Several threads may be in flight at once.** The busy guard is per thread. The hub server's per-thread 409 lock is unchanged and unaffected — parallel threads have distinct ids.

## Alternatives considered

- **Keep the abort, persist a resumable job on the server.** Would only help the subscription lane (byok/local/webllm turns run in the browser), needs a job registry the zero-backend hub (ADR-0013) will never host, and still loses the in-browser inspector.
- **Keep BuilderView mounted across routes (hide instead of unmount).** Fixes `/build` ⇄ `/` only; the run view's chat rail shares the hook and would still abort; hidden trees keep rendering and violate the router's ownership of the tree.
- **A React context at the app root.** Same lifetime as a module store but couples the store to the tree; the repo already standardises on `createStore` + `useSyncExternalStore` for cross-view state (theme, mode, rail layout, net).
- **Persist round trips to the user DB so they survive a reload.** Reverses AC14 (a doctrine with a byte-level test), needs a migration, and would put whole prompts — app HTML, full conversations — in the portable file. Out of scope; a separate ADR if ever wanted.

## Consequences

- A build survives any in-app navigation and any thread switch; a page reload still drops the in-flight request (the persisted user bubble remains, as today).
- `useBuilderChat` callers must not assume unmount cleans up: `stop` is the user's affordance and the seams are the system's.
- The per-thread session registry is module-global state derived from a swappable store, so every future swap/wipe seam must call `resetThreadSessions` — the module doc carries the list, and a test asserts a wiped session stays wiped.
- Memory: N idle sessions retain their inspector ring buffers until evicted; the bound is explicit and tested.
