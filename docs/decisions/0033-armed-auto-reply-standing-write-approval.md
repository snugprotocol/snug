# 0033 — Armed auto-reply: the first standing, scoped write approval

- **Status:** accepted (2026-08-17, ships with TASK-20260816-whatsapp-twin) — **with the gate
  built and the arming surface deferred.** `createStandingApprovalGate`
  (`packages/auth/src/standing-approval.ts`) implements and enforces everything below and is
  wired into the playground's executor; what is NOT shipped is a way for an app to ARM. An
  app lives in a sandboxed iframe and the frame vocabulary has no seat for a standing
  approval, so arming would have to be either a new protocol frame (C3 spec-sync) or a
  host-rendered control. The owner deferred that choice to a follow-up (2026-08-17), and
  WhatsApp Twin therefore ships manual Reply only, saying so on its own surface rather than
  offering a switch that authorizes nothing. §3's design is what governs when arming lands.
- **Date:** 2026-08-16
- **Task:** TASK-20260816-whatsapp-twin

## Context

The connected-fetch executor's mutating-method gate raises a user confirm before any
credentialed write (ADR-0031 kept it as THE control when the write posture was reset;
session-remember exists but dies with the session). Twin's Auto-reply must send messages
while the user is away from the confirm dialog — an unattended write. "The LLM proposes, the
human approves, the host freezes" needs an answer for approval that happens *ahead of time*.

## Decision

1. **Arming is an explicit, scoped, standing approval** — a user gesture in the app that the
   host records against the connection: slot + thread (chat JID) + trigger scope, frozen at
   arm time. Trigger scope is fixed by thread type: **group = only messages tagging the
   user; DM = every new message.** Widening the scope requires disarm + re-arm.
2. **Guardrails ride the grant**, enforced host-side, not app-side: a rate cap (messages per
   rolling window), quiet hours, and a kill switch that disarms immediately. One thread may
   be armed at a time (v1). The armed state is disclosed wherever the connection is
   disclosed (Settings' connections card) — a standing approval the user cannot see is not
   an approval.
3. **The gate order does not change, and the standing grant is a SEPARATE gate.** An armed
   send traverses the same executor pipeline; armed is a recorded answer, not a bypass.

   The session-remember gate is deliberately NOT widened to carry it. `createSessionConfirmGate`
   (`packages/auth/src/session-confirm.ts:36-55`) keys grants on `(appId, normalizedHost,
   method)` in an in-memory `Set`, and its header pins "lives in MEMORY only (never
   persisted — it dies with the page)" as an intended property. Every armed send is a `POST`
   to the same sidecar host, so **that key cannot tell the armed thread from any other
   thread**: remembering one send would authorize all of them. It also has no clock (needed
   for rate cap and quiet hours), no DB handle, and it is a module-level singleton shared
   with the wizard's probe path (`net.ts:100-118`) — widening it would widen the probe too.

   So a standing grant lives in its own gate, consulted BEFORE the session gate, keyed on
   (appId, slot, threadJid, trigger scope), persisted with the connection, enforcing cap +
   quiet hours + kill switch, and returning "no opinion" outside its frozen scope so the
   normal confirm still runs. The executor's confirm seat sees a URL, not a thread, so the
   thread identity must be derived from the request — itself a security seat: a send whose
   body JID disagrees with its path JID must REFUSE, never pick one.
4. **Every unattended send is journaled** in the app-visible activity feed (what was
   received, what was sent, when) — silent ghostwriting is not offered.
5. **Manual Reply is not armed**: it always shows the draft for one-tap confirm.

## Alternatives considered

- **Draft-first only (no unattended sends)** — honors the existing doctrine unchanged but
  makes Auto-reply a notification inbox; rejected by the owner (interview 2026-08-16).
- **Confirm every send** — auto-reply dead while away; rejected.
- **A general "always allow writes to this host" toggle** — far wider than the need; a
  standing approval must be scoped to the *act* (this thread, this trigger), not the host.

## Consequences

- Precedent: standing approvals exist now, and their shape is set — explicit gesture,
  frozen scope, host-enforced guardrails, visible disclosure, instant revocation. Any
  future "auto-X" feature cites this ADR rather than widening the confirm gate ad hoc.
- The session-confirm seam grows a persisted, scoped variant; its tests join the C1-adjacent
  review surface.
- Residual (stated in the task's threat delta): mimicked replies are unattended speech in
  the user's name — the activity journal and the tagged-only group default are the honesty
  controls; the social risk is the user's informed choice.
- **Implementation residual (2026-08-17): the v1 grant store is IN-MEMORY**, so an armed
  thread does not survive a page reload. §2 wants the grant persisted with the connection.
  A reload is therefore a disarm — the safe direction to fail, and harmless while arming
  itself is deferred — but it is not what this ADR specifies and must not be read as done.
  Persisting it is part of the follow-up that picks the arming surface.
- **What the gate proved in review, worth keeping**: the confirm seat had to grow optional
  `slot` and `body` (`NetConfirmRequest`), because a thread is underivable from a URL alone.
  The ABSENCE of `slot` on the absolute-URL path is what structurally keeps a standing grant
  off the wizard's probe — the shared-singleton hazard §3 names is closed by the shape of the
  data rather than by a check that could be forgotten.
