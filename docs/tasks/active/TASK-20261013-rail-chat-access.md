# TASK-20261013-rail-chat-access: The app's chat reaches the data other apps share with it, and its composer stays on screen

- **Status**: in-progress
- **Owner**: Jeetu (reported both bugs from a playground walk, 2026-10-13: "fix them all"); implementation by Claude (Opus 5.5)
- **Risk tier**: medium — a classifier prompt (`packages/knowledge`) and the playground's chat routing and rail layout; no schema, no protocol, no runner/auth change. The classifier now names the tables another app shares with this one; that is a subset of what the data lane already sends the same brain under the same grant (see Decisions).
- **Branch**: `fix/TASK-20261013-rail-chat-access`
- **Packages touched**: `knowledge` (the chat-intent classifier prompt + its builder), `playground` (chat router input, the hook's routing call, an access-service read that performs nothing, `RailChat`'s composer + CSS, e2e)
- **Spec impact**: none
- **Related**: ADR-0019 (intent-routed app chat), ADR-0075/ADR-0076 (access between apps; the chat door — TASK-20261010-host-broker PR-2), threat-model delta `threat-model-delta-access-doors.md`

## Spec (what & why)

Two bugs the owner hit walking the playground with a BYOK key after granting Standup read access to another app's data:

1. **The chat cannot reach shared data.** Asked in Standup's chat about the weather app's data, the chat answered *"Standup only has its own tables and a GitHub connection — do you want me to add weather into the Standup briefings…?"*. That is the router's own clarification: `routeChatMessage` builds the classifier prompt from the app's OWN tables and connections only, and the prompt defines `data_read` as "a question the app's OWN stored data can answer". So a question about granted data never routes to the data lane — and the chat door (`useBuilderChat`, which materialises the granted tables) opens only on a data-lane turn. The grant was correct; the router never knew it existed.
2. **The rail chat loses its composer after the first message.** `RailChat` overrides the shared `.composer` (sticky, bottom 0) with an inline `position: static`, inside a `minHeight: 100%` column whose `ChatLog` is `flex: 1`. Once the log renders, the column fills the rail body and the composer sits after it — pushed below the fold by exactly the tab row and the thread picker above it (measured: composer top 1369 px, rail-body visible bottom ≈ 1319 px). The empty state does not grow, which is why the FIRST message still had an input.

**Acceptance criteria** (each becomes at least one test):
1. The classifier prompt carries a `Shared with this app:` line listing each source app the chat may read now — `Source name: table(col, col); …`, names only, never rows — and `(nothing shared with this app)` when there is none; writable tables are marked.
2. The classifier's rules route a question a shared table can answer to `data_read` (and a change to a writable shared table to `data_write`), not to a clarification about the app's own tables.
3. The playground lists those sources with the access policy's own `materialise` admission (owned by this reader, active, unexpired, source not restricted) — performing nothing: no Worker, no history line, no counter. A revoked, expired or other-reader grant is absent.
4. The hook hands that list to the router only where the chat door itself would open (an owned app, a keyed BYOK or local brain); elsewhere the line reads as nothing shared.
5. The rail chat's composer stays inside the visible rail after a conversation exists (sticky at the rail body's bottom, the rail's own background) — proven in a real browser.

**Out of scope**: changing which brains the chat door opens for; the data lane's own context and tools (PR-2/PR-5 already cover the shared tables once routed).

## Plan

Tests first (Opus 5.5), then implementation:
1. `packages/knowledge`: `chat-intent-prompt.test.ts` — the `Shared with this app:` line (present, absent, defanged), the prompt's shared-data rule and example; snapshot updated.
2. `apps/playground`: `chatRouter` test — `sharedSummaries` reaches the classifier's user message; an `accessService` test — `sharedSourceSummaries` lists only admitted grants and performs nothing; a hook test — the summaries ride the routing call only under an open door; `RailChat` test — the composer carries `rail-composer` and no inline `position: static`.
3. e2e (Playwright, demo brain): build → run → the rail composer `toBeInViewport()` with a conversation present (red today).
4. Implement: the prompt + builder (`knowledge`, regenerate content); `sharedSourceSummaries` in `access/service.ts` beside `refreshableReads`; `RouteChatMessageInput.sharedSummaries`; the hook computes it through the existing lazy edge; `RailChat`'s composer class + `.rail-composer` CSS (sticky, `--surface` background) and drop the overflowing `minHeight: 100%`.
5. Gate 5: playground + knowledge + dependents (`desktop`, `host` alias the playground) + the kit check; a fresh-context review of the diff.
6. Docs: the access-doors threat-model delta line (the classifier now names shared tables — same brain, same grant, names only), next-steps if anything is deferred.

## Decisions & surprises

- **Why the classifier may see shared table names (C1/egress):** the classifier runs only where `classifierApplies` (not the host brain), and the list is filled only where `chatDoorOpen` — the same keyed BYOK or local brain that, one step later on a data-lane turn, receives the granted tables' rows under the same grant. Names and columns only (what `grantView` already tells the reader app itself); never rows, never credentials.

## Session journal (append-only, newest last)

### 2026-10-13 — Claude (Opus 5.5) — Gate 1–2 (owner-reported bugs; reproduced; root causes found)
- Done: reproduced issue 2 in a fresh playground on :5199 (demo brain; the composer measured below the rail's fold); traced issue 1 to the classifier's input with the owner's reply text (BYOK brain; the router's clarification).
- State: plan above; the owner's "fix them all" is the approval.
- Next step: tests first.
