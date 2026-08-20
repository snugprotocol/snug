# TASK-20260819-inbox-copilot-fixes: connection-live refresh prompt + Inbox Copilot fixes

- **Status**: in-progress
- **Owner**: Jeetu
- **Risk tier**: **Medium** — `apps/playground` wizard/run logic + `examples/`. NOT High: no `packages/protocol` schema change (the `connection-event` host-event already exists with an open `event` namespace), no `packages/auth` change, no sandbox/CSP change. Escalate if the SDK hooks block is touched (byte-locked across every starter).
- **Branch**: `feat/TASK-20260819-gmail-starter` (continues the Gmail starter branch — these are owner-reported defects against work not yet merged)
- **Packages touched**: `apps/playground` (ConnectionWizardSheet DoneScreen, RunView host registry, new state module), `examples/gmail`
- **Spec impact**: none — `hostEventSchema.event` is `z.string().min(1).max(64)`, an open namespace by design (`packages/protocol/src/frames.ts:226`); adding an event VALUE changes no exported JSON Schema byte, so no spec-sync (C3) obligation. Confirmed against ADR-0026 ("the hostEvent namespace stays open for a future live status event") and ADR-0034.
- **Related**: ADR-0034 (host-event live pump, the precedent), ADR-0038/0039, `docs/next-steps.md:68` (the "third host-event consumer should get a `useHostEvents` hook" standing decision — see D3 below)

## Spec (what & why)

Four owner-reported defects, one architectural and three app-local.

**1 (architectural) — a verified connection leaves stale sample data on screen.**
Today nothing tells a RUNNING app that its connection just went live: the wizard's
probe outcome is local `useState` in `DoneScreen` and is discarded on close
(`ConnectionWizardSheet.tsx:1396`). Inbox Copilot's sample mode is gated on a
*transient* sync phase, so a user completes the wizard and still sees demo data with
no indication that anything changed. The fix is a prompt at the end of the wizard —
after the connection is *verified*, not merely saved — offering to replace the sample
(or stale) data with the user's real data, and a host→app `connection-event` that
makes the running app act on the answer. The sample banner must disappear with it.

**2 — unsubscribe emails bounce.** The `gmail.send` raw message carries `To:` and
`Subject:` but no `From:`, so Gmail sends with an empty envelope sender and receiving
MTAs bounce it. The connected account's own address must populate `From:`.

**3 — the Refresh button is hard-wired to 90 days.** It should default to 90 days and
be overridable: 1 week, 6 months, 1 year, everything.

**4 — "Ask about your inbox" returns a wall of prose.** The answer lane should render
a contextual inline result — the actual senders/counts/rows behind the answer,
formatted for what was asked, not a paragraph.

**Acceptance criteria** (each becomes at least one test):
1. **AC1 — the wizard offers the refresh.** On reaching a *verified* terminal state
   (probe passed, or an OAuth kind whose token round trip already proved it), the
   Done screen offers "load your real data now", stating what it replaces. Declining
   is a first-class choice and leaves the app untouched.
2. **AC2 — the app is told.** Confirming emits `snug:host-event` with event
   `connection-event` and payload `{ slot, verified: true, requestRefresh: true }` to
   the running app for that `appId`. Reuses the EXISTING event name (ADR-0034); no new
   frame type, no protocol change. Emission is a no-op when no app is running.
3. **AC3 — no data rides the event.** The payload is an invalidation hint only —
   never inbox content. (ADR-0034 doctrine: host-event frames carry no `instanceId`,
   so an app cannot verify the sender; and the 256KB frame cap drops oversize frames
   silently.) Negative test: the emitted payload contains no message/row data.
4. **AC4 — Inbox Copilot acts on it.** The listener sits OUTSIDE the sample markers
   (`sample-mode.test.mjs` forbids any bridge reference inside them), filters on
   `payload.slot === 'gmail'`, and triggers the existing sync path. The sample banner
   is gone once real data lands.
5. **AC5 — From: is populated.** Every `gmail.send` raw message carries a `From:`
   header holding the connected account's own address, resolved from
   `users/me/profile` (`emailAddress`) and cached. Unit-tested; negative test that no
   raw message is built without a From line.
6. **AC6 — the window is selectable.** Refresh defaults to 90 days with an explicit
   override: 1 week, 90 days, 6 months, 1 year, everything. The chosen window drives
   the Gmail `q` (`newer_than:`), and "everything" omits the clause. The charts'
   week-window follows the selection rather than staying pinned at 12.
7. **AC7 — answers render as structured results.** The answer lane returns a typed
   result the app renders inline — a sender list with counts, a stat, or prose — and
   the renderer picks the shape from what came back, falling back to prose. Unit-tested
   over the shapes.

**Out of scope**: promoting the hand-rolled host-event listener into a `useHostEvents`
SDK hook (see D3); rolling AC1/AC2 out to the other sample-mode starters (see D4);
web-playground Gmail support; incremental `historyId` sync.

## Decisions

- **D1 — reuse `connection-event`, do not mint a new event name.** It already exists
  (`sidecarLive.ts:110`), already has an app-side consumer (`whatsapp/app.html:841`),
  and the namespace is deliberately open. A new name would need the same handling and
  buy nothing.
- **D2 — gate on VERIFIED, not on "saved".** The Done screen already distinguishes
  these (`awaitingProbe`, TASK-20260815 AC6: "connected" is earned, not declared).
  Prompting after a mere credential save would teach users to trust an unproven row.
- **D3 — do NOT take the `useHostEvents` hook work in this task.** `next-steps.md:68`
  says the third host-event consumer should trigger it. This IS the third. Deferred
  deliberately: the hooks block is byte-locked across all 13 starters and the KB
  template, so promoting it is a mechanical change to every app plus a KB≡SDK sync —
  a task of its own, not a rider on a defect fix. Recorded in next-steps.
- **D4 — implement for Inbox Copilot only; make the host side generic.** The wizard
  emits for any app; only gmail listens today. The other sample-mode starters flip
  automatically and irreversibly on first successful fetch (trade-copilot's persisted
  `connected_once`), so they gain little. Owner asked for "all apps" — the HOST half
  is app-agnostic and delivers that; the per-app listener is a two-line adoption each,
  queued in next-steps rather than done blind across six apps in a defect fix.

## Plan

Tests first per TDD.md.

1. RED: `apps/playground` — the emit path (AC1–AC3) and the host registry.
2. RED: `examples/gmail-analysis.test.mjs` — From-header builder (AC5), window→query
   mapping (AC6), answer-shape renderer selection (AC7).
3. Host: new `apps/playground/src/state/appHosts.ts` registry; `RunView` registers in
   the effect that already wires `controlsRef`; `DoneScreen` renders the prompt and
   emits on confirm.
4. App: `examples/gmail/app.html` — listener outside the sample markers; profile
   fetch + `From:`; window selector; structured answer renderer.
5. Docs: next-steps entries for D3 + D4; ADR only if review says the host registry is
   a decision rather than plumbing.

## Session journal (append-only, newest last)

### 2026-08-19 — Claude (Fable 5) — session
- Done: Gate 1–2. Investigated the wizard→app boundary with a fresh-context agent:
  `connection-event` already exists and needs no protocol change; the real gap is that
  `RunnerHost` lives only in `RunView`'s ref, so the wizard has no path to `notifyEvent`.
- State: plan written; implementing.
- Next step: RED tests for the emit path and the app-side fixes.
