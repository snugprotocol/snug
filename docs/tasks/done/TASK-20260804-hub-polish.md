# TASK-20260804-hub-polish: identity & brand, watch-it-think observability, build-fork and thread-continuity fixes

- **Status**: **done** — all phases (A–G) complete, adversarial review round applied, four owner-reported runtime bugs fixed, **Gate 6 closed 2026-08-04** (lessons, doc drift, next-steps; merged to `main` via PR).
- **Owner**: Jeetu
- **Risk tier**: **high** (auto-escalated: `apps/server` auth/session surface + a `users` table migration; `packages/db` sync provider conflict handling. `packages/db` is a widely-depended package)
- **Branch**: `feat/TASK-20260804-hub-polish` — **created 2026-08-04 off `main` at `f37feff`**, after Phase A merged TASK-20260803-hub-ops (see D1)
- **Packages touched**: `apps/playground`, `apps/server`, `packages/db` (sync), `packages/knowledge` (prompts, item 7 only)
- **Spec impact**: **none intended** — no `packages/protocol` schema change (see D2). The server-side `users` table is hub-private, not the portable user DB, so no spec-changelog entry.
- **Related**: TASK-20260803-hub-ops (unmerged, direct parent), ADR-0009 (sync origins), ADR-0010 (native app schemas), ADR-0011 (LLM-optional apps), `docs/lessons.md` 2026-08-03 (pinned rows; shared wire literals)

## Spec (what & why)

Twelve items from one session of using the hub. They resolve into four themes: **identity & brand** (1, 2, 3, 12), **the "watch it think" rail** (4, 5, 6, 10), **build correctness** (7, 8, 9), and **one console error** (11).

Research established that several reported symptoms have causes different from what the symptom suggests. **The single most important finding: items 6, 7 and (partly) 10 depend on which mode the hub runs in.**

### Mode is the crux (items 6, 7, 10)

`apps/server/.env.local` has `SNUG_MODEL=claude-sonnet-5` and `SNUG_AUTH=google` set, which suggests **subscription mode**. In subscription mode:

- **The LLM inspector cannot populate — by design.** `apps/server/src/routes/invoke.ts:185-191` forwards only `tool_call`/`tool_result` as `step` SSE events, with the verbatim comment *"`round_trip` stays server-side."* `createServerBuilder` (`builder.ts:100-167`) contains **zero** `onRoundTrip` references. The direct-mode path is fully wired and works (`builder.ts:240-243` → `useBuilderChat.ts:342` → `RunView.tsx:84-91`). So item 6 is either "you were in subscription mode and it is working as designed" or a genuinely new server capability. **This is Q1 below.**
- **Docs cannot populate — the tool does not exist.** `apps/server/src/tools.ts:22-60` (`buildServerTools`) ships exactly **two** tools (`app_builder`, `artifact_write`). Direct mode's `buildByokTools` ships **four**, adding `schema_apply` and `app_doc_write`. In subscription mode the model is never offered the doc tool, so no doc can ever be written. This is a known gap, previously logged as out-of-scope in `next-steps.md`.

Both are therefore **scope decisions, not bug fixes**, and are gated on Q1.

### Findings that are already precise

- **Item 8 (Chess edit "replaced the factory version") — the DB is correct; the UI forks a second app.** `insertVersion` (`packages/db/src/userdb/userdb.ts:825-843`) is a plain append-only `INSERT`; `saveAppVersion` is strictly N+1 and retention never prunes `pinned=1`. The real mechanism is `RunView.tsx:88`: for a **starter** id (`starter:chess`), `pinnedAppId` is deliberately omitted, so `artifactSink.write()` (`artifactSink.ts:73`) mints a random UUID, finds no row, and takes the `installApp` branch (`:85`) — creating a **brand-new app at pinned v1**. The starter the user is looking at is read-only from `examples/` and is unchanged; the edit landed on an app they cannot see. It reads as "my change replaced the factory version".
- **Item 9 (built app's thread missing from the run view).** The builder writes to `thr-<uuid>` (`BuilderView.tsx:13-24`); the run rail reads `app:${id}`, hardcoded at `RunView.tsx:80`. `onInstall` does set `snug_chat_threads.app_id` (`useBuilderChat.ts:181-183`), which is why the thread appears in the build menu — but nothing ever points `app:<id>` at those messages, and the thread picker is hidden when only one thread matches (`RunView.tsx:272`), so the user has no route to it. `RunView.tsx:100-107` already filters `thread.appId === id`, i.e. the data to fix this is present and unused.
- **Item 11 (`PUT /userdb 412`) is mostly NOT an error.** `sync.ts:72` is the one-line `fetch` wrapper (`apps/playground/src/state/sync.ts`); Chrome logs every non-2xx at the calling frame. 412 is the designed CAS conflict signal, handled as data at `hub-origin.ts:89-91` → `divergence` → the Settings resolver, and **deliberately not auto-retried** (ADR-0009 "LWW only on explicit user action"). **There is one real bug**: `conflictRevision()` (`hub-origin.ts:38-42`) *throws* `SYNC_BAD_RESPONSE` when a 412 carries neither an `etag` header nor a body `revision` — which is exactly what the server sends when `If-Match` is set but no row exists (`stores/userdbs.ts:65-71` returns `current: undefined`, so `routes/userdb.ts:111` omits the etag). Reachable after a server DB reset or a re-login under a new `userId` while the OPFS sidecar still holds a revision. The user then sees a red **error** instead of the **divergence** resolver.
- **Item 2 needs a schema migration.** `apps/server/src/stores/users.ts:41-49` creates `users` with `CREATE TABLE IF NOT EXISTS` and **no migration mechanism**; an existing hub DB will not gain a `picture` column. Google's `picture` claim is already in scope (`'openid email profile'`) but discarded at `auth/oidc.ts` (`completeLogin` returns only `sub`/`email`/`name`).
- **Item 3/12**: the wordmark is text-only at `App.tsx:68-70` (`.brand`, `--text-l` = 1.25rem = 20px, `app.css:26-36`). **No SVG asset exists anywhere in the repo**, `apps/playground/public/` does not exist, and `index.html` has no `<link rel="icon">` — hence the 404.
- **Item 10**: `BuilderView.tsx:32` calls `useBuilderChat(threadId)` with **no options object**, so `onRoundTrip`/`onTurnStart` are `undefined` and round trips are dropped. The build UI has no rail, no tabs, no panels at all.

**Acceptance criteria** (each becomes at least one test):

*Identity & brand (items 1, 2, 3, 12)*
1. The signed-in header chip opens a menu containing **sign out**; invoking it calls the same `signOut()` from `state/sync.ts` (which sequences `logout()` then `initSync()` — never bare `logout()`, per review F14).
2. The menu closes on Escape and on outside-click, returns focus to its trigger, and the trigger carries correct `aria-expanded`/`aria-haspopup`. Keyboard-reachable throughout.
3. Sign out is **removed** from `SettingsView`'s `AccountCard` (item 1 says "move"), and a test asserts the settings page no longer renders a sign-out control while the account identity line remains.
4. `GET /auth/me` returns a `picture` URL when the Google id_token carried one, and omits the field entirely when it did not (asserted against the fake OIDC issuer).
5. ~~An **existing** hub `users` DB created before this change gains the `picture` column on open…~~ **Superseded 2026-08-04 by owner decision (D3): no migration.** The `users` table simply declares `picture` in its `CREATE TABLE`; the existing hub DB file is deleted and rebuilt. Replacement criterion: **a fresh hub DB opens with the `picture` column present and a first Google login populates it** — and, because the schema is now create-only, a test asserts the store opens cleanly against an empty directory.
6. The header chip renders the Google avatar as an `<img>` when `picture` is present and falls back to the current initial-letter circle when absent or when the image fails to load (`onError`).
7. The avatar `<img>` carries `referrerPolicy="no-referrer"` and does not leak the session: a test asserts no credentials are attached. (Google's `lh3.googleusercontent.com` URLs 403 with a referrer in some configurations.)
8. A `snug` logo mark ships as an inline SVG React component + a static `favicon.svg`, both built from the existing ember token palette; `index.html` links the favicon (plus an apple-touch icon), and `apps/playground/public/` is created so vite copies it to `dist/` at build.
9. The header renders the logo mark beside the wordmark, and `.brand` font-size is **doubled to 2.5rem** (from `--text-l` 1.25rem) via a new token, with the header still passing its existing responsive rules at 760px/830px (no overflow, nav still reachable).

*Watch-it-think rail (items 4, 5)*
10. The rail's `llm` and `inspector` tabs are **merged into one surface**: a single tab renders the LLM round-trip section **above** and the bridge/frame inspector **below**, in one scroll container, with each section labelled. `RailTab` loses `'llm'` as a separate value.
11. **`run/inspector.ts` and `__tests__/inspector.test.ts` stay byte-identical** (`git diff` empty) — the structural-only privacy guarantee and its marker assertions are untouched. The merge is presentational only; the two reducers remain separate modules (task D1 of the parent task).
12. Every rail tab header renders an **icon** with the text as its accessible name: `aria-label` (or visually-hidden text) plus a `title` tooltip, so the tabs remain screen-reader- and keyboard-accessible. A test asserts each tab is still findable by its original accessible name (`chat`, `inspector`, `docs`, `versions`).

*Build observability & correctness (items 6, 7, 10)*
13. `BuilderView` renders the LLM round-trip surface for the build turn, fed by the same `useBuilderChat` options the run rail already uses (`onRoundTrip` + `onTurnStart`), in-memory only.
14. **AC14 of the parent task is preserved**: nothing from the round-trip surface is written to the user DB from the builder either — asserted by a byte-level export check, mirroring `llmInspectorPersistence.test.tsx`.
15. **Both** the round-trip surface and the docs panel state plainly, when the active mode cannot produce their data, *why* it is empty and what to switch to — replacing the current misleading *"every call to the model shows up here"* (false in subscription mode) and the bare *"no wiki yet"*. The copy branches on the **mode value**, not a hardcoded string (R4).
16. *(dropped — Q1: no server parity in this task. `app_doc_write`/`schema_apply` server-side and any round-trip wire event are requeued in `next-steps.md`.)*
17. *(dropped — same.)*

*Build correctness (items 8, 9)*
18. An **uninstalled** starter shows an explicit **Install** control and **no chat tab**; installing it navigates to the user's own copy. A starter the user already installed opens **that copy** and never a second one (re-open is idempotent), including via a direct `/run/starter:*` deep link. A test asserts no starter interaction can produce an unreachable app row.
19. After a build completes, opening the new app's run view shows **the build conversation** on the main thread (not an empty one). Asserted end-to-end: build in `BuilderView` → open `/run/:id` → the builder's messages are present.
20. The thread picker is reachable whenever more than one thread exists for the app, and the thread holding the pinned bootstrap turn is labelled as the main thread rather than being unreachable.

*Sync (item 11)*
21. A 412 carrying **neither** an `etag` header **nor** a body `revision` is reported as a **divergence** (the resolver), not as a `SYNC_BAD_RESPONSE` error — the gap the parent task's reviewer flagged as untested.
22. The server sends a machine-readable revision on every 412 it can, so client and server agree on the conflict contract; where no revision exists (no row yet), the client treats it as "origin is empty" and offers the first-write path.
23. No behavior change to the ADR-0009 rule: a conflict is still **never** auto-retried or auto-merged (a test asserts no silent second PUT).

**Out of scope**
- Any `packages/protocol` schema change (D2) — no spec-sync, no spec-changelog.
- `packages/auth` (the v1.1 app-credential broker) — untouched.
- Auto-merge / CRDT for sync conflicts (ADR-0009 explicitly defers this).
- Cost accounting or prompt-caching in the round-trip surface (parent task's out-of-scope, still out).
- Persisting round-trip/inspector data to the user DB — still forbidden (AC14).
- A full design system for the logo (favicon + one header mark only; no marketing pages, no animated splash).
- Rewriting the starter-app model (item 18 fixes the fork; making starters first-class installable apps is a separate task if wanted).

## Plan

### D0 — Owner answers (2026-08-04 interview)

- **Q1 mode → subscription, honest empty states only.** Do **not** add server parity. AC16 and AC17 are **dropped from this task** (requeued in `next-steps.md`): no new server tools, no new SSE event, no change to `invoke.ts`'s boundary. Items 6 and 7 become *truthful, mode-aware empty states* plus item 10's genuine gap. This keeps the task off the wire contract entirely.
- **Q2 logo → ember glyph mark.** Abstract geometric enclosure (warmth/shelter) in the existing ember palette; 2–3 variants shown before wiring. **Resolved 2026-08-04: the owner selected Variant C, "The Ember Niche"** — a filled roundrect tile with an arched niche knocked out of its lower half (warmth is the mass, shelter is the void). Full variants and the 16px rasterization analysis: `docs/tasks/active/TASK-20260804-logo-variants.md`. Two wire-up constraints travel with it: the mark sits **~10% below the wordmark cap height** (a filled tile beside a 2.5rem wordmark otherwise dominates the lockup), and `favicon.svg` **inlines `#e8873a`** rather than using `currentColor`, since a favicon has no CSS context.
- **Q3 starter edit → explicit install, no silent copies.** Owner's exact model: *"if the user does not have that starter already installed then show an Install button and on click of it install the app. Also show the chat tab only after the user has installed the app. If the user already installed and clicks on the starter again for the same app, open only the user-installed copy."*
- **Q4 branch base → close out and merge the parent first**, then branch off the updated `main`.

**Research note on Q3**: `HubView.installStarter` (`HubView.tsx:100-120`) **already** implements install-or-open via `install_source` dedup, and already routes an installed starter to the user's copy (`:104-106`). So the hub tile is 90% correct — but it **auto-installs on click** rather than offering an explicit Install control, and `/run/starter:*` stays directly reachable (bookmark, back button, deep link) where the chat rail forks a hidden app. The work is therefore smaller and more precise than "rewrite starters".

### D1 — Sequencing (Q4)

**Phase A happens first, in its own PR**: `/close-session` on TASK-20260803-hub-ops — lessons entries (the vacuous-test rule; the single-use `Response` SSE trap), doc drift (`architecture.md`, `code-map.md`, `next-steps.md`), flip ADR-0011 draft → accepted, **commit the outstanding `apps/playground/vite.config.ts` change** (it is that task's AC5 proxy timeouts + the `changeOrigin: false` OAuth cookie fix — it belongs to that task, not this one), move the task file to `done/`, merge to `main`. Only then create `feat/TASK-20260804-hub-polish` off the updated `main`.

### D2 — Decisions taken up front
- **No protocol change.** The `picture` column is in the hub-private `users` SQLite DB (`apps/server`), not the portable user DB, so it is not spec surface.
- **The two inspectors stay two modules.** Item 4 asks to merge them *visually*; `inspector.ts`'s value-blind guarantee is a deliberate privacy invariant (parent task D1). The merge is a presentation change only — AC11 locks this with a byte-identity assertion.
- **Icons keep their text as accessible names** (AC12). Replacing label text with bare glyphs would break screen readers and the existing tests that query tabs by name; `title` alone is not an accessible name.
- **D3 — no migration; the hub DB is disposable (owner decision, 2026-08-04).** *"don't worry about data migration. you can simply clear the existing and build new db for now. im ok losing everything."* `picture` is declared directly in `CREATE TABLE`; the existing hub DB file is deleted and rebuilt on next boot. **Scope of the loss, stated plainly for the record: the hub-side `users`, `artifacts`, `thread_messages` and `userdbs` stores** — hub accounts, the artifact cache, server-side thread text, and **any user-DB copy synced to this hub**. This is a local dev hub; the portable user DB in the browser's OPFS is the source of truth and is untouched. R1 is retired by this decision.

### Order of work (tests FIRST at every step, per TDD.md)

**Phase A — close out and merge the parent task** (above). No code from this task until `main` carries it.

**Phase B — sync 412 (`packages/db`, `apps/server`) — AC21–23.** Smallest, highest-confidence, and touches the most widely-depended package, so it lands first and its dependents (`sdk`, `playground`) run early.
1. Failing test: a 412 with neither `etag` nor body `revision` surfaces **divergence**, not `SYNC_BAD_RESPONSE` (`hub-origin.ts:38-42` is the code under test).
2. Failing test: no silent second PUT after any conflict (AC23 — locks ADR-0009).
3. Implement: treat a revision-less 412 as "origin has no row" → first-write path; keep `throw` only for genuinely unreadable responses. Server side, include the revision on every 412 that has one (`routes/userdb.ts:111`).
   - *Dependents (Gate 5): `sdk`, `playground`.*

**Phase C — server identity (`apps/server`) — AC4, AC5.**
4. Failing tests: `/auth/me` carries `picture` when the id_token has it and omits it when not (via `fake-oidc-issuer.ts`); the store opens cleanly against an empty directory with `picture` present in the schema.
5. Implement across the five-place chain: `auth/oidc.ts` (`OidcIdentity` + `completeLogin`), `stores/users.ts` (**`picture` declared in `CREATE TABLE` — no `ALTER TABLE`, per D3**; plus `UserRecord`, all four prepared statements, `toRecord`), `routes/auth.ts:137` (upsert) and `:160` (the `/auth/me` literal). No scope change needed — `profile` already includes `picture`.
6. **Delete the existing hub DB file** as an explicit, announced step (D3) — the server recreates it on next boot. Record the path and the deletion in the journal.

**Phase D — header identity & brand (`apps/playground`) — AC1–3, AC6–9.**
6. Failing tests: chip menu contains sign out and calls `signOut()` from `state/sync.ts`; Escape/outside-click/focus-return/ARIA; settings no longer renders sign-out; avatar `<img>` with initial fallback on absent `picture` and on `onError`; `referrerPolicy="no-referrer"`.
7. Implement `IdentityChip` (`App.tsx:118-139`) as a menu button; extend `HubUser` with `picture?: string`; remove the sign-out control from `AccountCard` (`SettingsView.tsx:229`) keeping the identity line.
8. Logo: design the ember glyph (2–3 variants **shown to the owner first**), ship an inline SVG component + `apps/playground/public/favicon.svg`, link it in `index.html` (+ apple-touch), add the mark beside the wordmark, and double `.brand` to 2.5rem via a new token. Verify the 760px/830px header rules still hold.

**Phase E — the rail (`apps/playground`) — AC10–12.**
9. Failing tests: one merged surface renders LLM section above and frame inspector below, both labelled; `RailTab` no longer has `'llm'`; each tab is still findable by its original accessible name; **`git diff` on `run/inspector.ts` and `__tests__/inspector.test.ts` is empty** (AC11).
10. Implement: merge the two panels into one tab's scroll container (presentation only — the reducers stay separate modules), and swap tab labels for icons carrying `aria-label` + `title`.

**Phase F — build observability (`apps/playground`) — AC13–15.**
11. Failing tests: `BuilderView` renders the round-trip surface fed by `onRoundTrip`/`onTurnStart`; byte-level export check that nothing reaches the user DB from the builder (mirrors `llmInspectorPersistence.test.tsx`, which the parent task found had been vacuous — this one feeds the reducer directly); the empty state is mode-aware.
12. Implement: give `BuilderView.tsx:32` the options object it currently omits, hoist the reducer, and reuse Phase E's surface. Empty-state copy branches on mode instead of claiming "every call to the model shows up here".

**Phase G — starters & threads (`apps/playground`) — AC18–20.**
13. Failing tests: an uninstalled starter shows an explicit **Install** control and **no chat tab**; installing navigates to the user's copy; re-opening an installed starter opens that copy, never a second one; a starter edit never produces an unreachable app row; after a build, `/run/:id` shows the build conversation; the picker is reachable whenever >1 thread exists.
14. Implement: explicit Install button on the starter tile (replacing auto-install-on-click), gate the chat tab on `!isStarterId(id)`, and make `/run/starter:*` redirect to the installed copy when one exists. For item 9, default `RunView.tsx:80`'s thread to the app's existing builder thread (the `listThreads()` row whose `appId === id`, already queried at `:100-107`) instead of unconditionally `app:${id}`, and fix the "main thread" label accordingly.

### Cross-package impact
`db` → `sdk`, `playground` (Phase B). `server` is standalone but shares the `/auth/me` shape with the playground (Phase C/D — the shape is a wire literal; per `lessons.md` 2026-08-03 it is written verbatim in this file: **`{ userId, email?, name?, picture? }`**). Gate 5 runs `pnpm test` at root plus the validator, `pnpm build`, and Playwright.

### Risks
- ~~**R1: the `users` migration.**~~ **Retired by D3** — no migration is attempted; the hub DB is deleted and rebuilt. The residual risk is only that the deletion is done silently: it must be an announced step with the path recorded in the journal.
- **R2: AC11 byte-identity.** Merging two panels visually invites "just refactor inspector.ts a little". The empty-`git diff` assertion is the guard; it must be a real check, not a comment.
- **R3: avatar referrer/CORS.** Google avatar URLs can 403 depending on referrer policy; AC6's `onError` fallback is what keeps the header from showing a broken image.
- **R4: mode-aware copy can go stale.** If subscription mode later gains round trips (the requeued work), the honest empty state becomes a lie in the other direction — the empty state must branch on the mode value, not on a hardcoded assumption.
- **R5: thread-default change (AC19) touches a hot path.** Defaulting to a different thread affects every app open; the pinned-bootstrap machinery exists (`useBuilderChat.ts:357-373`) but nothing reads the pin back today.

### D2 — Decisions taken up front
- **No protocol change.** The `picture` column is in the hub-private `users` SQLite DB (`apps/server`), not the portable user DB, so it is not spec surface.
- **The two inspectors stay two modules.** Item 4 asks to merge them *visually*; `inspector.ts`'s value-blind guarantee is a deliberate privacy invariant (parent task D1). The merge is a presentation change only — AC11 locks this with a byte-identity assertion.
- **Icons keep their text as accessible names** (AC12). Replacing label text with bare glyphs would break screen readers and the existing tests that query tabs by name; `title` alone is not an accessible name.

### Test plan
Tests first at every step (`docs/engineering/TDD.md`). Existing conventions: no Testing Library — `react-dom/client` `createRoot` + `act`, `globalThis.IS_REACT_ACT_ENVIRONMENT = true`, auth mocked by writing to `authStore` directly, `installTestUserDb()` for a live in-memory user DB. Server tests use `app.inject()` against `fake-oidc-issuer.ts`.

Gate 5 will run `pnpm test` at root (the parent task's baseline is **727 tests**, 19/19 tasks), `node --test examples/validate.test.mjs` (18/18), `pnpm build` (9/9), and Playwright (26/26). `packages/db` and `apps/server` changes force their dependents (`sdk`, `playground`) per the dependency graph.

## Decisions & surprises

- Four parallel investigations were run against the actual code; **three of the twelve reported symptoms have causes other than the obvious one** (11 is largely normal traffic, 8 is a UI fork rather than a DB overwrite, 6/7 are mode-dependent by design). Recording this because acting on the symptom alone would have produced the wrong fix in each case.
- The parent task's reviewer had already flagged AC21's exact gap ("no test covers the 412-with-no-etag case") — this task closes it.

## Session journal (append-only, newest last)

### 2026-08-04 — Jeetu — session (Gate 1–2)

- Done: **Gate 1 and Gate 2.** Read PROCESS/architecture/code-map/lessons/ADR-0009 and the actual code across all twelve items (four parallel investigations, every claim verified in-file). Interviewed the owner (Q1–Q4 + one follow-up). Task file written with 21 live ACs (2 dropped by decision) and the phase plan above.
- Interview outcomes: subscription mode → **honest empty states, no server parity** (AC16/17 dropped, requeued); **ember glyph** logo with variants shown first; starters get an **explicit Install control, no chat tab until installed, re-open opens your copy**; **merge the parent task to `main` first** (Phase A).
- Key research findings that changed the work: the DB version path is correct (item 8 is a UI fork via `RunView.tsx:88`, not a DB overwrite); the 412 is mostly normal CAS traffic with one real bug (`hub-origin.ts:38-42`); items 6/7 are subscription-mode-by-design, not defects; `HubView.installStarter` already does install-or-open, so item 8 is a smaller, sharper change than it appeared.
- State: **awaiting plan approval — no implementation code written.** Branch not yet created (Phase A must land first).
- Next step: on approval, Phase A (close out + merge TASK-20260803-hub-ops, including its outstanding `vite.config.ts` change), then branch off the updated `main` and run Phases B→G, tests first. High tier also wants a fresh-context review of this plan before implementation.
- Open questions: none blocking. Logo variants will be shown in Phase D before they are wired in.

### 2026-08-04 — Jeetu — session (plan approved; Phase A done)

- **Plan approved** by the owner with one simplification: **D3 — no data migration.** *"don't worry about data migration. you can simply clear the existing and build new db for now. im ok losing everything."* AC5 is rewritten (schema declares `picture` in `CREATE TABLE`; the hub DB file is deleted and rebuilt), R1 is retired, and the scope of the loss is written into D3 so it is on the record: the hub-side `users`, `artifacts`, `thread_messages` and `userdbs` stores. The portable user DB in browser OPFS — the actual source of truth — is untouched.
- Done: **Phase A.** Closed out TASK-20260803-hub-ops (Gate 6) and merged it to `main`:
  - Re-verified Gate 5 from a clean tree first: **727 tests / 19-of-19 tasks**, validator **18/18**, build **9/9**. ADR-0011 was already accepted.
  - Doc drift fixed in that branch (architecture status, three new code-map rows, every stale per-package test count corrected against a measured run, next-steps entries incl. the reviewer's queued `importUserDb`/`namespaceByFile` item and this task's deferred subscription parity).
  - Promoted **two lessons**: *"would this fail if the code were wrong?"* (three tests passed for the wrong reason in one session) and the single-use `ReadableStream` mock trap.
  - Committed the outstanding `vite.config.ts` **to the parent branch where it belonged** (its AC5 proxy timeouts + the `changeOrigin: false` OAuth cookie fix), rather than letting it leak into this task.
  - Merged with `--no-ff` at `f37feff`, matching how every prior task merged. **`main` re-verified green after the merge (727 tests).** Note: prior task branches were never pushed to `origin` — I followed that established local-merge pattern rather than pushing.
- State: branch `feat/TASK-20260804-hub-polish` cut off `main` at `f37feff`; this task file committed at `fff2632`. No implementation code yet.
- Next step: **Phase B** — sync 412 (AC21–23) in `packages/db`/`apps/server`, tests first. Smallest and highest-confidence, and it touches the most widely-depended package, so its dependents (`sdk`, `playground`) run early.
- Open questions: none blocking.

### 2026-08-04 — Jeetu — session (Phases B–G implemented + adversarial review round)

- Done: **Phases B through G**, then a **five-reviewer adversarial round** (one fresh-context reviewer per phase, each told to falsify rather than confirm and to revert hunks to expose vacuous guards). Suite **727 → 821**; build 9/9; validator 18/18; **Playwright 26/26**.
- **The reviewers earned their place — they found six real defects behind a fully green suite**, and every fix below was mutation-verified by me (revert → RED → restore):
  1. **E2E was RED and the implementer reported it as green.** `pnpm exec playwright test` was **25/1**, not 26/26. `e2e/mobile.spec.ts:60` asserted a `chat` tab on a starter — exactly what Phase G correctly removed (AC18). Fixed the *assertion*, not the feature: it now asserts `chat` has count 0 and the starter shows its single `inspector` tab. **A false "all green" in a report is worse than a red suite**, because it stops anyone looking.
  2. **The headline AC18 guard was vacuous** (Phase G reviewer). It restored the fork end-to-end and all three "unreachable row" tests stayed green. `unreachableRows()` measured the wrong property: a forked app is a normal `snug_apps` row, so the hub lists and links it — it IS reachable; what makes it the bug is that it is a *second, unwanted* row. Replaced with two outcome tests: an uninstalled starter must write **no** row, and every row the library holds must carry an `installSource` (a fork has none, by construction).
  3. **AC15's mode-branching was untested at the seam** (R4, one level up). Every test passed `mode` as a *literal* into the leaf, so the reviewer hardcoded `mode="byok"` at all three real call sites and the whole suite stayed green — precisely the misleading-copy regression AC15 exists to prevent. Added a test mounting the real `BuilderView` against `modeStore`, asserting **both** directions. Mutation-verified: hardcoding the call site now goes RED.
  4. **A resolver button was a silent no-op** (Phase B reviewer, HIGH). Phase B made the empty-origin 412 reachable, which exposed a pre-existing dead end: `applyRemote()` unconditionally wrote `idle` **over** the `ORIGIN_EMPTY` error the loop had just emitted. The banner vanished, nothing synced, and the next 30s tick re-diverged with no explanation — and the detail copy ("the origin no longer has the copy this device synced to") actively invites that click. Now a terminal error we did not clear is never clobbered, and F15 is not armed for bytes that were never imported.
  5. **`role="menu"` promised a keyboard contract that did not exist** (Phase D reviewer). Focus never moved into the menu and arrows were inert — *worse* than plain markup, which Tab handles natively. Took the honest smaller fix: dropped `role="menu"`/`menuitem`, kept `aria-haspopup="true"`. AC2 asks for keyboard-reachable, which Tab satisfies.
  6. **`brandAssets.test.ts` did not parse the SVG** despite being named "well-formed XML" — the reviewer introduced an unescaped `&` (a fatal parse error) and all 11 tests passed while the icon was broken. Now parses via jsdom's native `DOMParser` (no new dependency). Mutation-verified against the reviewer's exact probe.
- **One reported finding did NOT reproduce**: a reviewer claimed the playground suite was flaky/red (`identityMenu`, `railTabs`). I ran it 3× full and 3× targeted — 180/180 and 29/29 every time. The cause was five reviewers mutating one shared working tree concurrently; their probes collided. **That is a flaw in how I designed the workflow, not in the code** — future adversarial rounds should give each reviewer an isolated worktree.
- Logo: owner selected **Variant C "The Ember Niche"**. Both wire-up constraints honored — the mark sits at `0.72em` (the designer's ~10%-below-cap-height note) and `favicon.svg` inlines `#e8873a` rather than `currentColor`, which would render black with no CSS context.
- Verified myself rather than trusting reports: AC11 `git diff --exit-code` on `inspector.ts` + its test is **empty**; the favicon really reaches `dist/` (ran the build); 2.5rem is a token (`--text-brand`) with a `--text-brand-narrow` fallback under 760px.
- State: all phases implemented and reviewed; suite green. **Not yet committed at the time of writing this entry.**
- Next step: commit, then Gate 6 (`/close-session`) — lessons (the vacuous-reachability-probe rule and the shared-tree reviewer collision are both worth promoting), doc drift, and the D3 hub-DB deletion as an announced step.
- Open questions: none blocking.

### 2026-08-04 — Jeetu — session (Gate 6 — closed)

- Done: **Gate 6.** Re-verified Gate 5 from a clean tree first: `pnpm test` **19/19 tasks, 826 tests** (protocol 103 · runner 91 · knowledge 61 · db 168 · adapters 74 · sdk 35 · server 104 · playground 190), validator **18/18**, build **9/9**, Playwright **30/30**.
  - Playwright initially failed to start — a **stale `dist/server.js` from my own earlier build** still held port 8787. Not a test failure; cleared the process and the suite ran clean. Flagging because "port already in use" reads like a broken suite and is one `lsof` away from being obviously not.
- **Two lessons promoted**, both earned by the reviewer round rather than by the suite:
  - *A guard test must assert the OUTCOME, not a property that merely correlates with it* — the AC18 guard measured **reachability**, but a forked app IS reachable; what made it the bug was being a second, unwanted row. Reverting the fix left all three tests green.
  - *Give each adversarial reviewer its own worktree* — five reviewers mutating one shared tree produced a **false** flaky-suite report (3 full + 3 targeted runs were green). That was a flaw in how I ran the review, not in the code, and the dangerous part is that it teaches everyone to discount the next red suite.
- Doc drift fixed in-branch: `architecture.md` status now names hub-polish and its seven additions; `code-map.md` gained rows for the **think panel**, the **identity menu + brand assets**, the **single starter identity rule**, and — most importantly — an explicit row recording that there are **TWO `runAgentTurn` call sites**, because wiring only the builder's is exactly the bug the owner hit; per-package counts re-baselined against a measured run (server 94→104, playground 106→190, Playwright 26→30). `next-steps.md` gained the ✅ line plus two queued items (sync resolver copy; a script to regenerate code-map's test-count column, which drifts every single task).
- **D3 executed**: the hub DB was deleted and rebuilt. Necessary, not merely tidy — the pre-`picture` `users.sqlite` made `createUserStore` throw **in its constructor**, so a stale file meant the server would not boot at all. Backup at `/tmp/snug-hubdb-backup-20260804`.
- **No spec-changelog entry** — `packages/protocol` deliberately untouched.
- State: merged to `main` via PR; task file moved to `docs/tasks/done/`.
- Next step: none for this task. Successor **TASK-20260804-observability-caching** is specced and plan-approved-pending, branching off the updated `main`.
- Open questions: none.
