# TASK-20260903-build-thread-continuity: Build conversations survive navigation, run in parallel, and are listed on the build page

- **Status**: in-review — **PR #159**; owner asked to merge at close of session 2026-09-03
- **Owner**: Jeetu
- **Risk tier**: medium (Playground logic — `apps/playground` only; no `protocol`/`runner`/`auth`/`db` schema change; C1 posture unchanged — see "C1 note" under Plan)
- **Branch**: `fix/TASK-20260903-build-thread-continuity`
- **Packages touched**: `apps/playground` (agent/, views/, run/, state/, theme/app.css, `__tests__/`, `e2e/`); `packages/db` (`deleteThread` — one new repo method + test; dependents `sdk` + `playground` run at Gate 5); docs (architecture.md, code-map.md, next-steps.md, ADR-0062)
- **Spec impact**: none
- **Related**: ADR-0024 (think rail), ADR-0027 (distill), TASK-20260804-hub-polish (build-thread continuity, AC13/AC14 in-memory inspector, AC19/AC20 main-thread rule), TASK-20260803-hub-ops (long-run builds), lessons 2026-08-20 "module-global session state outlives the store it describes", next-steps 2026-08-06 "StrictMode double-mount kills the `?idea=` hub→build handoff on `pnpm dev`"

## Spec (what & why)

Today a build turn lives inside the React component that started it. `useBuilderChat` keeps every piece of turn state (`messages`, `busy`, `steps`, the in-flight `AbortController`) in component state, and its last effect **aborts the in-flight request on unmount** (`useBuilderChat.ts:1062`, "never leave a request running headless"). React Router unmounts `BuilderView` on every route change, so leaving `/build` for "your apps" kills the build mid-flight: the user bubble is already persisted, the assistant row is never written (that write happens only after the stream completes), and the round-trip inspector — deliberately per-mount and in-memory — is gone. The same cleanup fires under React `StrictMode`'s simulated unmount in dev, which is the known-broken hub→build `?idea=` handoff (next-steps 2026-08-06): the effect sends once, the simulated unmount aborts it, and the `sentInitial` ref stops a resend.

The build page also holds exactly **one** thread id (from `sessionStorage['snug:thread']`) and never lists threads: `listThreads()` has one non-test caller in the whole playground (`RunView.tsx:228`). "new app" overwrites the key, and the old conversation is unreachable from `/build` forever even though it survives in the user DB. And the hub create bar continues **whatever thread the tab already holds** — if that thread has an app pinned, a "build me X" typed on "your apps" becomes an *edit* of the previous app rather than a new build.

This task moves turn state out of the component into a **per-thread session store that outlives every view** (in memory, module-level, keyed by thread id), removes the abort-on-navigate rule (an explicit **stop** is the only abort), adds a **thread sidebar** on `/build` listing every conversation in the user DB with live "building…" state, and makes the hub's build button **mint a fresh thread** and hand the idea over robustly. Multiple threads may be in flight at once; switching between them or between pages pauses nothing.

**Acceptance criteria** (each becomes at least one test):

1. **Hub handoff starts a build on a fresh thread.** Typing an idea on "your apps" and pressing build (or Enter, or a chip) navigates to `/build`, shows the idea as the user bubble, and starts the turn exactly once — on a NEW thread, never the tab's previous (possibly app-pinned) thread. Holds under `<StrictMode>` (regression for the dev double-mount).
2. **Navigation never aborts a turn.** Start a build on `/build`, navigate to `/` and back: the same messages are shown, the status line is still rotating (`busy`), the request's `AbortSignal` is **not** aborted, and when the stream completes after the return the reply lands in the UI and the assistant row is persisted with its artifact meta. Same for `/run/:id` (the run-rail chat uses the same hook).
3. **Explicit stop is the only abort.** `stop` aborts exactly the thread it was pressed on; a second in-flight thread is untouched.
4. **Parallel conversations.** Two threads can each be `busy` at the same time; each keeps its own messages/steps/activity/inspector; sending on one while the other streams is allowed (the busy guard is per thread, not per page).
5. **Thread sidebar on `/build`.** Lists every thread in the user DB (build threads and run-view threads alike), newest first, labelled by title → attached app name → a neutral word (never the raw id); the active thread is marked; in-flight threads carry a live badge; "+ new" mints a fresh thread. Selecting a thread switches the chat to it (its persisted messages load). The list refreshes when any turn settles (a new thread gets its row on the first message).
6. **Switching back retains the audit trail.** Round-trip inspector entries, steps, activity and the streaming reply of a thread are intact after switching to another thread and back, or after leaving `/build` and returning — **in memory** for the life of the page; AC14 (nothing from the inspector reaches the user DB, localStorage or sessionStorage) is re-asserted at the byte level across a navigation round-trip.
7. **Memory stays bounded.** Idle sessions' inspector state is evicted beyond a fixed count (busy sessions are never evicted); each session keeps the existing 60-entry / 8 MB ring buffer.
8. **Swap seams reset the sessions** (lesson 2026-08-20): user-file import / sync pull (`afterForeignBytes`), backup restore (`restoreUserDbFromBytes`), `recoverFresh`, and app delete (sessions pinned to the deleted app) abort their in-flight turns and drop the sessions; a hook mounted over a wiped thread hydrates from the (new) DB, not from the old session. A wiped session stays wiped.
9. **Existing continuity holds.** `threadContinuity.test.tsx` (AC19/AC20 main-thread rule), `chatRouterLifecycle`, `buildSteps`, `builderObservability` AC13/AC15 stay green, with the two "unmount aborts" assertions inverted by decision (ADR-0062).
10. **Real-browser proof** (lesson 2026-08-20 "run the product"): a Playwright spec on the demo brain starts a build on `/build`, clicks "your apps", returns to build, and sees the artifact card appear — gated on `SNUG_E2E_HAS_APP` like `build-run.spec.ts`.

11. **The composer keeps its loaded height** (owner follow-up 2026-09-03 #1). Typing the first character into a new conversation must not shrink the textarea: autogrow never sets a height below the height the box rendered with, and a submitted draft returns the box to that natural height.
12. **The build menu opens a NEW conversation** (owner follow-up #2) unless the most recent one has a build/edit in progress: arriving on `/build` with the active thread idle AND holding messages mints a fresh thread (the old one stays one click away in the sidebar); a busy active thread is kept; an empty fresh thread is kept (so the hub's handoff is not double-minted).
13. **The inspector shows the newest round trip on top** (owner follow-up #3), on the build page AND in the run view's think panel, so the latest progress is always in view without scrolling; nothing auto-scrolls. Tool rows stay chronological inside each round trip.

**Out of scope**: persisting round trips/steps to the user DB (would reverse AC14 — flagged as owner decision Q2 below, default keep); thread archive/pin in the sidebar (rename + delete ARE in scope since the owner's Q3 answer — AC5b); a server-side resumable-job registry (the hub `/invoke` 409 per-thread lock and context-only thread store are unchanged — parallel threads have distinct ids and are already admitted); surviving a page reload mid-turn (a reload drops the in-flight request; the persisted user bubble stays, as today); mobile drawer polish beyond a collapsible list; the run view's thread `<select>` (stays; it can read the same session registry later).

## Interview (asked as assumptions — this session is non-interactive; correct any before approving)

- **Q1 Hub build = new thread?** Assumed **yes**: the create bar on "your apps" always mints a fresh thread. The build page's composer continues the *selected* thread; "+ new" in the sidebar is the other way to start fresh.
- **Q2 Retain inspector/audit across navigation only, not across reload?** Assumed **yes** — in-memory session store; AC14 stays. Persisting round trips would be a new ADR reversing AC14 and a DB migration; not done here.
- **Q3 Sidebar lists all threads, including run-view (`app:<id>`, `thr-…` with app pin) threads?** **Owner 2026-09-03: yes, AND add rename + delete.** → AC5b below; `packages/db` gains `deleteThread` (rename uses the existing `upsertThread(id, { title })`).
- **Q4 Client-side concurrency cap?** **Owner: no cap.** The server's per-thread 409 remains the only lock.
- **Q5 The run view's chat also keeps running when you leave the app?** **Owner: yes.**
- Q1 (fresh thread from the hub) and Q2 (in-memory audit trail, AC14 stays): **owner: yes.**

**AC5b — Rename and delete from the sidebar.** Each thread row offers rename (inline, Enter/Escape, non-empty; persists via `upsertThread` title) and delete (confirm first; `db.deleteThread` removes the thread row and its messages, aborts and drops the in-memory session, and never touches the app the thread is pinned to). Deleting the active thread selects the newest remaining thread or mints a fresh one.

## Plan

### Root causes (verified in code)

| Symptom | Cause | Where |
|---|---|---|
| Leaving `/build` loses the build | unmount cleanup aborts the turn; state is component-local | `agent/useBuilderChat.ts:349-358` (state), `:1062` (abort effect), `:930` (assistant row written only after stream end) |
| Hub prompt sometimes does nothing (dev) | StrictMode simulated unmount runs the same abort cleanup; `sentInitial` blocks the resend | `views/BuilderView.tsx:65,79-86` + the effect above |
| Hub prompt edits the previous app | `threadIdForTab()` reuses `sessionStorage['snug:thread']`, which may be app-pinned | `views/BuilderView.tsx:21-32`, `HubView.tsx:201-205` |
| No way back to an old conversation from `/build` | one thread id, no `listThreads()` caller on the build page | `BuilderView.tsx:53-62` |
| Inspector/steps vanish | per-mount `useReducer` + per-mount hook state | `BuilderView.tsx:47`, `useBuilderChat.ts:352` |

### Design

**1. `agent/threadSessions.ts` (new) — the per-thread session registry.** A module-level `Map<threadId, ThreadSession>`; each session is a `createStore<ThreadSessionState>` (the existing hand-rolled `state/store.ts`, no new dependency) holding what the hook holds today — `messages`, `busy`, `activity`, `steps`, `lastArtifact`, `threadAppId`, `knowledgeEpoch`, `hydrated`, plus `llmInspector: LlmInspectorState` (folded with the existing pure `llmInspectorReduce`) and the in-flight `AbortController`. API: `getThreadSession(id)` (create-on-read), `useThreadSession(id)` (useSyncExternalStore), `patchSession`, `listSessions()` (for the sidebar's live badges + a `sessionsChanged` store that ticks on busy transitions), `stopThread(id)`, `resetThreadSessions({ appId? })` (the swap seam; aborts in-flight turns first), `evictIdleSessions()` (LRU beyond `MAX_IDLE_SESSIONS = 8`; busy never evicted). Module doc lists the seam call sites (lesson 2026-08-20). The inspector stays in memory and redacted exactly as now — the reducer is reused, not copied.

**2. `agent/useBuilderChat.ts` — same public API, store-backed.** Replace the seven `useState`s with `useThreadSession(threadId)`; `patchMessage`/`setBusy`/… become session patches, so the `send()` closure keeps writing after every view unmounts. Delete the unmount-abort effect (`:1062`); `stop()` → `stopThread(threadId)`. Hydration effect (`:437-486`) runs only when `session.hydrated` is false (so a return to `/build` does not wipe a streaming session with an empty DB read; a session created by another view is reused as-is). `onTurnStart`/`onLlmEvent` options remain **optional pass-throughs** for RunView (which also feeds app-frame transport events into its own panel); the session itself always folds builder events into `session.llmInspector`, and the hook returns `llmInspector` so BuilderView reads it from the thread rather than from a per-mount reducer. `pinnedAppId` semantics unchanged. The `busy` guard in `send` reads the session, so two threads never block each other.

**3. `state/buildThread.ts` (new) — the active build thread.** A `createStore<string>` seeded from `sessionStorage['snug:thread']` (same key, same best-effort try/catch), with `setActiveBuildThread(id)` and `mintBuildThread()` (`thr-<uuid>`). `threadIdForTab`/`startNewApp` in `BuilderView` move here.

**4. Hub handoff.** `HubView.startBuild` → `mintBuildThread()` + `setActiveBuildThread(minted)` + `navigate('/build?idea=…')` (the `?idea=` contract is kept — deep-linkable, and two suites already drive it). `BuilderView`'s idea effect stays but is now safe: the send lives in the store, the StrictMode re-run finds `sentInitial` set and nothing has been aborted. A test mounts under `<StrictMode>` to lock it.

**5. `views/ThreadSidebar.tsx` (new) + `BuilderView` layout.** Reads `db.listThreads()` (already `updated_at DESC`) joined with `listSessions()` for the live badge, re-read on `sessionsChanged` ticks; labels: `title` → app display name via `getApp(appId)` → `threadId`. `.builder` becomes a two-column grid (`.builder-layout` = sidebar `240px` + the existing 780px-max column) at >760px; at ≤760px the sidebar renders as a `<details>` "conversations · n" disclosure above the chat (the shell's existing mobile breakpoint; jsdom can't prove geometry, so `mobile.spec.ts` gets one assertion that the composer stays visible at 375px with the list collapsed). Selecting → `setActiveBuildThread`; "+ new" → mint. The "this thread keeps building the same app / new app" note stays.

**6. `run/RunView.tsx` — minimal.** Keeps its own reducer for the app-frame transport events, keeps passing `onLlmEvent/onTurnStart` (so the think panel still shows both sources), stops nothing on unmount because the hook no longer does. Its thread `<select>` is untouched (out of scope) — but `appThreads` refresh keys on the session's `busy`, which it already does through `chat.busy`.

**7. Swap seams** (AC8): `state/sync.ts afterForeignBytes` (import + pull), `state/userdb.ts restoreUserDbFromBytes` + `recoverFresh` + `resetUserDbForTests`, `state/library.ts` deleteApp path (`resetThreadSessions({ appId })` after the cascade, next to the existing `resetSidecarIdentitySession()` at `:98`). Same five call sites the sidecar-identity reset uses, plus `recoverFresh`.

**C1 note.** No credential path changes. The inspector entries stored in a session are the *already-redacted* reducer output (`redactCredentialShapes`, `display` mode); the session store never touches `packages/auth`, the envelope, or headers. The AC14 byte test is extended, not weakened.

### Files to touch (in order)

1. `apps/playground/src/__tests__/threadSessions.test.ts` — **new, red first**: AC3, AC4, AC7, AC8 at the store level (hanging SSE stub, two threads).
2. `apps/playground/src/__tests__/builderNavigation.test.tsx` — **new, red first**: AC2 (BuilderView ⇄ HubView in a `MemoryRouter` with `Routes`; assert `seenSignal.aborted === false` after navigation, reply + persisted row after the stream resolves post-return), AC6 (inspector count retained; AC14 bytes re-checked), AC1 under `<StrictMode>` + fresh-thread assertion (`db.getThread(previous).appId` untouched, new thread row created).
3. `apps/playground/src/__tests__/threadSidebar.test.tsx` — **new, red first**: AC5.
4. `apps/playground/src/__tests__/useBuilderChat.test.tsx:157` and `chatRouterLifecycle.test.tsx:209` — invert the two "unmount aborts" cases into "unmount does NOT abort; stop does" (decision recorded in ADR-0062, comments updated to cite it). `builderObservability.test.tsx` AC13 spy assertions retarget to "the surface renders the thread session's inspector" (the handlers are no longer how BuilderView feeds it).
5. `apps/playground/src/agent/threadSessions.ts` — new.
6. `apps/playground/src/state/buildThread.ts` — new.
7. `apps/playground/src/agent/useBuilderChat.ts` — store-backed; delete the unmount abort.
8. `apps/playground/src/views/BuilderView.tsx`, `views/ThreadSidebar.tsx` (new), `views/HubView.tsx`.
9. `apps/playground/src/run/RunView.tsx` — read `chat.llmInspector`? No: keep its reducer (two sources); only comment updates.
10. `apps/playground/src/state/sync.ts`, `state/userdb.ts`, `state/library.ts` — seam calls.
11. `apps/playground/src/theme/app.css` — `.builder-layout`, `.thread-sidebar`, mobile `<details>` rule inside the existing `@media (max-width: 760px)` block.
12. `apps/playground/e2e/build-continuity.spec.ts` — new (AC10); `e2e/mobile.spec.ts` one assertion.
13. Docs in-branch: `architecture.md` (Components → Playground: build view session store, one paragraph), `code-map.md` (new row "Build thread sessions"; amend the "LLM round-trip inspector" and "App-attached chat" rows), `next-steps.md` (strike the 2026-08-06 StrictMode `?idea=` item), `docs/decisions/0062-…` (drafted now as *proposed*, flips to accepted at Gate 6), `lessons.md` at Gate 6 if the work teaches one.

### Cross-package impact

`apps/playground` only. It consumes `@snugprotocol/db` (`listThreads`, `getThread`, `getApp` — all existing) and `@snugprotocol/adapters` types; nothing upstream changes, so Gate 5 = `pnpm --filter playground test` + `test:e2e` (hasApp) — and root `pnpm test` before the PR per the in-doubt rule. Baseline on `main` today: **172 files / 1709 tests green in 53 s** (measured this session).

### Test plan (Gate 3, tests first)

| AC | Test | Kind |
|---|---|---|
| 1 | `builderNavigation` "hub idea → /build sends once, on a fresh thread, under StrictMode" | vitest/jsdom |
| 2 | `builderNavigation` "leave and return: signal not aborted; reply lands after return; row persisted" | vitest |
| 3 | `threadSessions` "stop aborts only its thread" | vitest |
| 4 | `threadSessions` "two threads busy at once, independent state" | vitest |
| 5 | `threadSidebar` list/label/badge/select/+new/refresh-on-settle | vitest |
| 6 | `builderNavigation` inspector retained + AC14 bytes across navigation | vitest |
| 7 | `threadSessions` idle eviction beyond `MAX_IDLE_SESSIONS`; busy never evicted | vitest |
| 8 | `threadSessions` each seam aborts + clears; wiped stays wiped after rehydrate | vitest |
| 9 | existing suites (updated as listed) | vitest |
| 10 | `e2e/build-continuity.spec.ts` | Playwright (demo brain) |

### Spec-sync

Not applicable — `packages/protocol` untouched.

### Rollback

One branch, one PR; no migration; the `snug:thread` sessionStorage key keeps its meaning, so an old tab keeps its thread.

## Decisions & surprises

- **D1 (→ ADR-0062, proposed):** a turn belongs to its thread, not to the view that started it; the *only* abort is the user's explicit stop (or a DB-swap seam). This supersedes the 2026-08 "leaving the view aborts — never leave a request running headless" rule in `useBuilderChat` and the two tests that pinned it. The headless concern is answered by the sidebar's live badge: a running thread is always visible from `/build`.
- **D2:** the hub create bar mints a fresh thread (Q1). Before, the idea silently became an edit of whatever app the tab's thread was pinned to.
- **D3:** the inspector/audit trail stays in memory (Q2). AC14 is a doctrine with a byte-level test; extending its lifetime from "per mount" to "per page session" keeps every guarantee it states.
- **D4 (owner Q3, 2026-09-03):** thread delete removes the thread row + its messages and its in-memory session, and **never the app** — the app is the user's work; a deleted main thread just means `resolveMainThread` falls back to `app:<id>` (rule 2–4). Pinned bootstrap rows are NOT protected from an explicit thread delete (the pin protects against *pruning*, not against the user's own delete — same as the app cascade, which ignores `pinned`). Confirm-before-delete in the UI, same pattern as the hub tile.
- **S1 (surprise):** production `main.tsx` also wraps in `<StrictMode>` — harmless there (double-invoke is dev-only), but it is why the `?idea=` handoff is broken on `pnpm dev` and the desktop dev shell.

## Session journal (append-only, newest last)

### 2026-09-03 12:45 — Claude (for Jeetu) — session (Gates 1–2)
- Done: read PROCESS/TDD/TEMPLATE, architecture status line, code-map rows 25/29/41/44/68-76, lessons (tests + module-global state rules), ADR index; mapped BuilderView/HubView/RunView/useBuilderChat/llmInspector/threads DB API/server invoke lock; ran the playground suite for a baseline (1709 green); created this file, drafted ADR-0062 (proposed), created branch `fix/TASK-20260903-build-thread-continuity`.
- State: **planned — no implementation code written.**
- Next step: owner approves the plan (and the five interview assumptions) → Gate 3: write the four red test files, then implement in the order above.
- Open questions: Q1–Q5 above.

### 2026-09-03 13:15 — Claude (for Jeetu) — session (Gates 3–6)
- Done: **plan approved by owner** (Q1 yes · Q2 yes · Q3 yes + rename & delete · Q4 no cap · Q5 yes). Red tests first: `threadSessions.test.tsx` (AC2 hook-level, AC3/4, AC7, AC8 incl. the two reachable seams), `builderNavigation.test.tsx` (AC1 under StrictMode, AC2 with the artifact landing after the return, AC6/AC14 across navigation and across a thread switch), `threadSidebar.test.tsx` (AC5 list/label/badge/select/+new/refresh + AC5b rename/Escape/delete/delete-active/delete-last/delete-in-flight); the two "unmount aborts" tests inverted (`useBuilderChat.test.tsx`, `chatRouterLifecycle.test.tsx`); `builderObservability` AC13/AC14 retargeted to the session dispatch (plus a real keyless direct-mode turn proving the feed at the wire); `packages/db` `deleteThread` test. **Honest note:** the db test and its implementation were written in one pass, not shown red first (the playground tests WERE red first — every new file failed on import until the modules existed). Implemented: `agent/threadSessions.ts`, `state/buildThread.ts`, `useBuilderChat` store-backed (unmount abort deleted; `llmInspector` on the return), `BuilderView` two-column layout, `views/ThreadSidebar.tsx`, hub mints a fresh thread, five seam calls, `db.deleteThread`, CSS, `e2e/build-continuity.spec.ts` + one mobile assertion. Docs: ADR-0062 accepted, architecture section, code-map row + inspector row amended, next-steps StrictMode item struck, lessons entry.
- Verify: `packages/db` 420/420 · playground **1731/1731 (175 files, was 1709/172)** · sdk 41/41 (db dependents rule). Playwright `build-continuity` + `mobile` run started in-session — result recorded below when it lands.
- Surprise S2: first run of AC7 red for a real reason — the eviction sweep excluded the just-created session from the COUNT, so the bound was off by one; fixed by counting every idle session (the newest is never a victim by recency anyway).
- State: implementation complete; awaiting e2e result, then PR.
- Next step: e2e result → journal → PR → AI review → owner review.
- Open questions: none.

### 2026-09-03 13:40 — Claude (for Jeetu) — session (Gate 5 real-browser + Gate 6 docs)
- Done: Playwright `build-continuity` + `mobile`: **8/8 green** on the second run. The first run failed for a real reason worth keeping (S3): the demo brain's three scripted round trips settle in **~15 ms**, faster than any navigation, so "the build kept running while I was away" was unprovable in a browser. Added the `?demoslow=<ms>` e2e seam in `agent/adapter.ts` (same family as `?demoreq` / `?webllm=1`): paces each demo round trip, read ONCE at adapter creation so the pace survives the navigation that drops the query, capped at 10 s, absent by default; `demoSlow.test.ts` pins absent/junk/cap/pass-through. The second red was a locator strict-mode clash (the sidebar row carries the thread's title, which is the first message's text) — scoped the bubble locator to `.chat-log`. `packages/db` 420 · playground 1731 (+`demoSlow` 5) · sdk 41 · e2e 8/8.
- State: implementation, tests and docs complete on the branch; full e2e suite + root `pnpm test` gate started (result below).
- Next step: gate results → PR → AI review → owner review.

### 2026-09-03 14:20 — Claude (for Jeetu) — review (Gate 5, AI review + full gates)
- Gates: **root `pnpm test` exit 0** (turbo: every package + the root checks; playground 1735). **Full Playwright suite: 80 passed, 2 failed, 1 skipped** — the two failures (`starters-connect` "degraded pre-connect state" github/spotify/weather + read-only route, and `connection-wizard` journey 4 oauth popup) **reproduce identically on a clean `main` worktree** (same specs, same failures, `1 failed / 14 passed` on both), so they are pre-existing/environmental and not this branch's. Every spec that touches the build page (build-run, demo-brain-clarity, mobile, webllm, build-continuity) is green.
- AI review (fresh-context, adversarial) found 6 real items, all addressed in the follow-up commit: (1) the app-delete seam matched on `threadAppId`, which a RunView session on a thread with no row never had → the pin is now mirrored from `pinnedAppId` at hydration AND at send time; (2) the sidebar `<details>` seeded `open` once from `innerWidth`, so a window widened past 760px could show a blank column with its only toggle hidden → driven by `useMediaQuery` (`open={!isMobile || open}`; `useMediaQuery` now tolerates a missing `matchMedia`); (3) RunView's think panel was blind to a turn that survived navigation (its per-mount reducer received the session's events via a dead closure) → RunView no longer takes builder events through the option; it renders `mergeLlmInspectorStates(chat.llmInspector, frameInspector)` — builder trips from the session, app-frame trips from its own reducer, merged after reduction so index matching stays per source; (4) `paced()` ignored the abort signal → it now rejects with `AbortError` on abort; (5) a turn that outlived a deleted thread could resurrect the thread row via `onInstall`'s `upsertThread` → guarded by `peekThreadSession(threadId) === session`, pinned by a new test with the artifact fetch resolving after the delete; (6) `importUserFile` reset sessions only AFTER the import landed → reset also runs before `importUserDb`. Plus the "wiped stays wiped" assertion the ADR claimed now actually exists in the AC8 test.
- Reviewer verified fine (recorded for the human reviewer): send-time captures unchanged vs before except `busy`/`isFirstMessage`/`contextTarget` now read live; StrictMode subscribe/unsubscribe symmetric; no path evicts a subscribed session; all DB-swap seams covered (`pruneChatMessages` has no callers; `revertApp` never touches threads); `?idea=` single mint; C1/C2 unchanged; no vacuous tests.

### 2026-09-03 14:45 — Claude (for Jeetu) — handoff
- Done: review fixes verified (playground **1736/1736**, build-page e2e subset 19/19), committed, branch pushed, **PR #159 opened**. On merge: add the line to `tasks/done/INDEX.md`, delete this file (ADR-0027), and re-run `check-public-scrub` is NOT needed (no flip/release in this task).
- Owner walks worth a minute on the desktop shell (no test covers the WKWebView rendering): the two-column build page at a normal window width, the collapsed "conversations · n" disclosure on a narrow one, and a real-model build left mid-flight for "your apps" and back.
- Next step: owner review → merge → done-index line.

### 2026-09-03 15:30 — Claude (for Jeetu) — session (owner follow-ups #1–#3 → AC11–AC13)
- Owner's three follow-ups after trying the branch. **AC11 composer shrink:** `autogrow` wrote `scrollHeight` back on the first keystroke, and for a one-line draft that number comes in UNDER the rendered single-row height (padding + line-height), so the box shrank on the first character of every new conversation. Fix: capture the box's rendered height on the first autogrow as a floor; never go below it; submitting resets the inline height so a grown multi-line box returns to its CSS natural height. Pinned by two tests that model the real numbers (jsdom has no layout). **AC12 build menu → new conversation:** decided at the header link (`openBuildMenu`, wired on the `build` NavLink and source-pinned), synchronously from the in-memory session: busy → keep; empty → keep (the hub handoff is never double-minted); has messages → mint fresh; no session (a thread stored by a previous page load) → mint fresh. A direct arrival on `/build` (deep link, sidebar pick) still shows the stored thread — which is also why the sidebar/AC6 suites keep their seeded-active-thread setup. **AC13 inspector newest-first:** the owner offered auto-scroll OR newest-on-top; chose newest-on-top (no auto-scroll, top is always in view). One change in `LlmInspectorPanel` serves both the build page and the run rail; tools stay chronological inside an entry; the AC8 keying test's row indices were flipped to match (its assertion — identity keying survives eviction — is unchanged).
- Also: the owner's IDE selection carried what looked like a live API key from `internal-private/.env.local`; not used, not recorded, owner told to rotate if it was ever exposed.
- Verify: playground **1744/1744**, build-page e2e subset 19/19. Committed + pushed to PR #159.

### 2026-09-03 16:30 — Claude (for Jeetu) — session (AC11 was misdiagnosed; fixed for real)
- Owner tested: #2 and #3 work; **#1 did not**. My first fix was a theory about `autogrow` and the box's HEIGHT — the real browser showed the height never moved (52px throughout). Measured instead of guessed: the box that shrinks is the whole build COLUMN, in WIDTH. `.builder` became a **grid item** when the sidebar landed, and a grid item with `margin: 0 auto` and no explicit width is fit-content sized (the auto margins absorb the free space instead of stretching) — so its width followed the widest child: the suggestion chips while the draft was empty, then ~350px once the first keystroke hid them. Static probe against the real stylesheets, both engines: with `width: auto` the column collapses from 780 → **352px (WebKit) / 363px (Chromium)** when the chips go; with `width: 100%` it stays 780 in both. Fix: one line — `width: 100%` on `.builder` (max-width still caps, auto margins still center). Pinned by an e2e in `build-continuity.spec.ts` that types the first character and asserts the textarea's width AND height unchanged and the column > 700px. The height-floor code from the first attempt stays: a true invariant, just not the bug.
- Why the in-app Chromium probe hid it: some wide child kept Chromium's column at 780 in the app (the static page collapses in Chromium too) — the owner is on WebKit (desktop shell), where it always collapsed. Lesson written.
- Headless WebKit cannot open the app's OPFS user file here ("unknown transient reason"), so the WebKit half is proven on the static harness, not on the app.
- Commit `5ec8d0d` (CSS + e2e); this journal/lesson/code-map follow in the next commit.

### 2026-09-03 17:30 — Claude (for Jeetu) — session (Gate 6 close + CI red investigated)
- **CI `workspace` went red on `ded072d`**, and the failure is NOT a failing test: all 1744 passed and the run failed on `Errors 1 error` — an unhandled `ReferenceError: window is not defined` thrown from `RunView.tsx` `setInstalling(false)` (the install chain's `finally`) after vitest tore the jsdom environment down. Vitest fails the whole run on an unhandled error even when every test is green.
- **Verdict: a pre-existing flake, not this branch.** Evidence, in the order it was gathered: (1) the branch does not touch the failing suite (`starterInstallDisclosure.test.tsx`) nor RunView's install path — the only RunView change is the inspector merge, and the only `library.ts` change is on the DELETE seam, which that suite never exercises; (2) it did not reproduce locally in 2 full branch runs, nor in 3 full runs on a clean `main` worktree; (3) **decisive** — CI PASSED twice on this same branch with the identical test files (`ae5b9ab`, `7433d47`) and failed once on `ded072d`, a docs+CSS commit. Same code, different outcome ⇒ load-dependent interleaving on the slower runner.
- **Fixed the real defect anyway** (one line each): `installThisStarter` now guards its two setState calls with a `mounted` ref. The install itself still runs to completion — it is writing the user's app — only the state writes are skipped. This is the line the CI stack names.
- **Honest gap, deliberately shipped without a regression test.** Four attempts at a deterministic test all passed with the guard REMOVED, i.e. proved nothing, so none were kept (never keep a green test that cannot fail): (a) unmount mid-install + listen for errors — the whole install chain resolves inside one `act()` window, so nothing is pending at teardown; (b) same, deleting `globalThis.window` — same reason; (c) gating the last await (`installStarterDocs`) via `vi.mock` so the chain is genuinely parked, then deleting `window` — the released continuation is still queued when the test ends, so `finally` never ran inside the assertion window (instrumented and confirmed: a probe inside `finally` never printed); (d) same with the view left MOUNTED to match the CI shape — same outcome. What would actually pin it is a test that can await the post-teardown continuation, which vitest's environment lifecycle does not expose. Recorded rather than faked.
- Gates re-run after the fix: typecheck clean, install suites 48/48, **playground 1744/1744 with no `Errors` line**.
- Next step: merge PR #159 (owner asked); then move this file to `done/`.

