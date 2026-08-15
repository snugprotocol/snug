# 0020 — Multi-option auth: the host defaults, discloses, and the user rebinds

- **Status:** accepted (owner decisions Q1–Q4 + the D3 widening, 2026-08-12; amended by 0023 — lanHost carve-out from D4's hosts-always-entry invariant)
- **Date:** 2026-08-12
- **Task:** TASK-20260812-auth-kind-choice (chained on TASK-20260812-registry-authoritative-auth)

## Context

Some providers genuinely offer more than one way in: Coinbase has an API-key surface
AND retail OAuth; GitHub has personal access tokens AND OAuth apps. The registry-
authoritative fix (parent task) made the host pick the RIGHT single flow per provider —
but silently picking one, even the right default, hides a real decision from the user.
The owner hit this live: a fresh Coinbase app collected API credentials and then
launched an OAuth flow it could never complete (the pre-fix wrong-kind row), and the
commissioning ask was explicit — *"when in doubt or multiple options by provider then
ask the user in a nice UI card ... and let user make the decision."*

## Decision

1. **The host DEFAULTS.** Build-time recovery and inference persist the provider's
   DEFAULT option immediately (registry: the top-level entry; inference: the model's
   primary proposal). An absent user never blocks a build; the app stays connectable.
2. **The host DISCLOSES.** When more than one option exists, a choice card renders the
   options. Registry options come from the pinned registry AT RENDER (the card payload
   is a pointer — the doorbell rule); model-proposed alternatives are bounded (≤3),
   validated exactly like the primary, persisted on message meta, and RE-ADMITTED on
   every read. The card is gated on the LIVE row: once the row is chosen, approved, or
   gone, it renders nothing — a choice surface may never become a dead button.
3. **The USER REBINDS, durably.** Choosing re-persists the row through the full gate
   chain on the `user` channel — the FIRST and ONLY production writer of that channel
   (a hardcoded literal in `state/authKindChoice.ts`, bound to a real gesture, enforced
   by an executable source scan) — and R3 (`user_confirmed` wins) then protects the
   decision against every later inference. Choosing is a rebind, never an approval:
   the strong review still stands between the row and any credential.
4. **Guard 2b becomes matched-option-aware (the widening).** The registry-borrow ban's
   two halves are driven by ONE resolution: the option whose pinned field list a
   declaration matches byte-identically is the option whose flow seats
   (fields/endpoints/registration/params/pkce) substitution honors. Before this, the
   exemption could bless a variant's list while substitution wrote the DEFAULT's fields
   back over it — silently undoing the user's choice (plan-review BLOCKER 1) — or let a
   hostile channel pass one option's list and receive another option's shape
   (BLOCKER 2). Unchanged and load-bearing: hosts and provider name are ALWAYS the
   entry's on every option path (a flow choice never moves which hosts receive the
   credential), and the borrower's KIND is still never substituted (ADR-0017/D6 —
   admission stays kind-agnostic; that follow-up remains queued and separate).

## Consequences

- Registry entries may carry `authOptions` (complete alternate flows, human-authored,
  PR-reviewed — the same trust channel as the entries themselves). Coinbase and GitHub
  ship options first; an entry going multi-option must also label its default.
- The inferrer result gains one uniform `alternatives` seat serving runtime UI and
  dev-time authoring alike; alternatives are candidates for a user decision, never rows.
- Forward-only: the card appears for fresh builds and re-declares. Rows persisted
  before this feature (including wrong-kind rows from before the parent fix) gain the
  card only after their app re-declares its connection.
- Residual risks accepted with disclosure: borrower-declared OAuth `endpoints` still
  survive substitution when the matched option has none (pre-existing; endpoint hosts
  union into the derived ceiling and are shown in the strong review) — queued for the
  threat-model pass rather than silently absorbed here.
