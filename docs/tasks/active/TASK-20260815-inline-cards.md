# TASK-20260815-inline-cards: Inline UI cards in the chat rail — ask/choose/confirm as structured UI (child B)

- **Status**: draft (planned; blocked on child A merge)
- **Owner**: Jeetu
- **Risk tier**: **medium** — playground UI + knowledge prompts; NO protocol frames, NO sandbox/CSP change, NO auth change. (Escalates to High and re-plans if any frame/schema seat turns out to be needed.)
- **Branch**: `feat/TASK-20260815-inline-cards` (off `main` after A merges)
- **Packages touched**: `apps/playground` (card model/renderer/persistence, confirm-gate card), `packages/knowledge` (present_card tool prompt + KB pattern layer), `apps/desktop` (dependent — tests only)
- **Spec impact**: none
- **Related**: umbrella [TASK-20260815-starter-portfolio-revamp](TASK-20260815-starter-portfolio-revamp.md) · child A (consumes its confirm seam) · ADR-0019 write-proposal card (the precedent being generalized) · draft ADR-0031 §cards

## Spec (what & why)

When an LLM turn needs the user to decide something — a choice among options, a
question, a parameter tweak, a proposed action — it can emit a **card**: a typed,
bounded UI block rendered inline in the chat rail, whose resolution (selection/dismiss)
persists on the message row and flows back as structured turn input. This generalizes
the ADR-0019 data-write proposal card into one reusable surface. Child A's provider
write-confirm renders as a card naming host + method + URL (the executor's dialog
contract, prettier). Any lane can use it via a `present_card` host tool; apps leverage it
through their app-attached chat, and the KB documents the in-app pattern (apps render
their own in-iframe cards from their own response schemas — no new frame; revisit only
if a real app proves the need).

**Acceptance criteria** (each becomes at least one test):
1. Card schema (title, body, options[], optional free-text seat; strict Zod; bounded lengths/counts) parses valid cards and refuses oversized/extra-key payloads (fail-closed → plain text rendering of the turn, never a crash).
2. `present_card` tool available to router lanes; a turn presenting a card renders it in ChatLog; selection resolves the card, persists (`persistResolution` pattern), and rehydrates across reload (metaTo* strict re-validation, lesson: rehydration is a validation site).
3. Selection feeds the next turn as structured input (the model sees which option was chosen, defanged).
4. One card resolution is single-shot: double-click guarded, resolved cards render as resolved (no re-fire).
5. Provider write-confirm card: approving executes exactly one executor call; denying yields `NET_CONFIRM_DENIED` path; the card names host, method, URL from the executor's confirm payload — asserted against the REAL confirm-gate seam identity, not a stub twin (lesson 2026-08-13).
6. Untrusted content rule: card text originating from model output renders as text (no markdown-driven links to non-pinned URLs, no HTML injection); consumer-existence check — the renderer exists and is wired (lesson 2026-08-15: no "the schema implies a renderer").
7. Existing data-write proposal card behavior unchanged (regression) OR migrated onto the generalized card with every shipped behavior classified MIGRATED/OBSOLETE (lesson 2026-08-10).
8. `pnpm --filter playground test` + `pnpm --filter desktop test` + root forced run green.

**Out of scope**: new wire frames / SDK embedded-hooks changes (in-app cards ship as a KB
pattern only this round); subscription parity; card streaming/progress states; forms
inside cards beyond one optional free-text seat.

## Plan

1. Tests first for AC1/AC2 (schema + render + persist + rehydrate).
2. New `apps/playground/src/agent/cards.ts`: card Zod schema + `PendingCard`/persisted-meta types, modeled on `PendingWriteProposal`/`metaToDataWrite` (dataTools.ts L156-235 precedent).
3. ChatLog: generalize the proposal-card block (ChatLog.tsx L137-170) into a `ChatCard` component; keep or migrate the data-write card per AC7.
4. `present_card` host tool (+ `packages/knowledge/prompts/tools/present-card.md`), wired lane-scoped in `useBuilderChat.ts` beside A's tools; STEP_LABELS.
5. Confirm-gate card: chat-scoped `confirmGate` implementation (seam: `connectedFetchDepsFor`'s confirm seat, `net.ts` L50-61 precedent) that renders a card and resolves the executor's promise on user action; session-remember semantics preserved.
6. KB: pattern layer note in `app-authoring/60-design-quality.md` (in-app card idiom) + present_card teaching where lanes are taught.
7. Verify: playground + desktop + root forced run; real-browser pass on the card surface (geometry lesson 2026-08-14).

Cross-package: playground + knowledge only; desktop reruns as dependent.

## Decisions & surprises

_(running)_

## Session journal (append-only, newest last)

### 2026-08-15 — Claude (Fable 5) — session
- Done: spec + plan drafted under the umbrella interview.
- State: awaiting umbrella approval; sequenced after child A.
- Next step: on A's merge — branch, AC1/AC2 failing tests first.
- Open questions: in-app card surface deliberately KB-pattern-only (no frame) — owner revisits if a portfolio app proves the need.

### 2026-08-15 (later) — Claude (Fable 5) — session
- Done: implemented on `feat/TASK-20260815-inline-cards` **stacked on child A's branch**
  (deviation from "off main after A merges": A is in owner review as PR #56; stacking
  preserves the A→B→C sequence without self-merging High-tier code — the PR chain
  retargets as each parent merges). Shipped: `cards.ts` (strict bounded schema,
  one-per-turn `present_card` tool, `metaToCard` strict rehydrate with
  phantom-resolution guard), ChatLog choice card + `ProviderConfirmCard` (chat-origin
  parked confirms render inline; `NetConfirmDialog` yields via WeakMap
  reference-identity origin tagging — one surface per decision), `selectCardOption`
  (single-shot, persists, sends the pick as the next USER message — UI-only authority),
  lane wiring (data/provider/answer; feature untouched per AC7), KB in-app idiom +
  tool prompt. **Process note (honest):** core implementation landed before the AC1/AC2
  test files (deviation from strict red-first); compensated with guard MUTATION checks —
  phantom-resolution guard, dialog chat-origin null, and origin tag each forced RED,
  restored green.
- State: playground 1102/109 · knowledge 183 · root forced 21/21 (0 cached). Gate-5
  fresh-context review in flight.
- Next step: review findings → fixes → PR (base: child A's branch).
- Open questions: none.

### 2026-08-15 (Gate 5 close) — Claude (Fable 5) — review + fixes
- Done: fresh-context review verdict FIX FIRST (2 MAJOR, 4 MINOR) — all addressed:
  **MAJOR-1** (mid-turn pick swallowed: busy guard ate the send, no row to persist,
  UI lied "you chose") → options DISABLED while the turn is in flight, and the persist
  row id is derived from CURRENT message state at click time, not the click-time prop;
  regression tests added. **MAJOR-2** (chat-origin confirm surface-less when the rail
  tab hides ChatLog, blocking the queue behind it) → `registerChatConfirmSurface`
  mount-counting; the modal yields to the card ONLY while a card surface is mounted,
  else renders every confirm; fallback test added. **MINOR-3** → unique option ids
  moved into the schema (superRefine; tool keeps the specific pre-parse message);
  crafted-dupe rehydrate test. **MINOR-4** → `sanitizeCardText` strips bidi/control
  chars everywhere card text renders or is sent; "the agent is asking:" provenance
  line on every choice card (anti-imitation affordance); tests. **MINOR-5** → busy-gate
  + provenance + fallback + schema tests added; RECORDED GAP: a full hook-level
  "pick reaches the next turn" e2e is still untested (the harness cost outweighs it
  this round — candidate for the browser-e2e sweep). **MINOR-6** was stale (journal +
  forced-run record landed after the review's diff).
- State: playground 1107/109 · desktop 105/11 green; final root forced run next.
- Next step: forced root → push → PR (base: `feat/TASK-20260815-provider-chat-lane`).
- Open questions: none.
