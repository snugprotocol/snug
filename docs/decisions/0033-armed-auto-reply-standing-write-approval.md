# 0033 — Armed auto-reply: the first standing, scoped write approval

- **Status:** proposed (drafted at Gate 2 of TASK-20260816-whatsapp-twin; accepted at that task's close if the plan survives review)
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
3. **The gate order does not change.** An armed send traverses the SAME executor pipeline;
   the confirm gate consults the standing scope instead of prompting — armed is a recorded
   answer, not a bypass. Anything outside the frozen scope (different thread, different
   host, rate exceeded, quiet hours) prompts or refuses exactly as today.
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
