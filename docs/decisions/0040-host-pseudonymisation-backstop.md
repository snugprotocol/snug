# 0040 — Host-enforced third-party pseudonymisation backstop (R-9)

- **Status:** **accepted** (2026-08-20, owner-approved at Gate 2; shipped with
  TASK-20260820-host-pseudonymisation, PR #86). Threat surface: `docs/threat-model.md`
  R-9 + the §5 invariant row; delta addendum in
  `docs/security/threat-model-delta-whatsapp-sidecar.md`.
- **Date:** 2026-08-20
- **Task:** TASK-20260820-host-pseudonymisation

## Context

Threat-model v1 (TASK-20260820-threat-model-v1) named R-9 the residual a reviewer weighs
most heavily: third-party pseudonymisation — keeping other people's names, jids and phone
numbers out of LLM-bound payloads — existed only inside the sandboxed example app's HTML.
An app-layer convention, not a boundary: the host scrubbed nothing, any other app holding
a sidecar connection could forward raw identities to a model, and the shipped app's own
copy was rewritable by the feature lane (the weakest write gate, R-7).

## Decision

1. **Egress backstop, not full host takeover** (owner-chosen). Both shapes can only
   redact identities the host has observed plus the jid/dialable primitives — takeover
   sees no more names, it just owns the labels — while costing a C3 schema change, a
   reverse-map surface, a host-side label-stability store, and a duplicate scrub on
   `/invoke`. The app keeps its stable P-label scrub as defense in depth (a UX property
   only the app can own); the host boundary binds every app regardless.
2. **Ingress harvest at the one governed seat.** `state/sidecarIdentity.ts` extracts
   contact names + jids from `/chats` bodies at `sidecarAppFetch` — extraction IS the
   scrub (known fields of the one name-bearing route; message text and previews never
   enter). Memory-synchronous before the body returns (no first-wire race); persistence
   is ready-gated fire-and-forget (awaiting a db boot at the seat would hold reads
   hostage). Directory persisted under ONE `snug_settings` key
   (`@snugprotocol/db` `sidecar-identity-keys.ts`) — a namespaced key, deliberately NOT a
   new `snug_` table, which would be a spec-normative portable-format change (the
   ADR-0036 D2 reasoning).
3. **Egress scrub for the sidecar connection FACT in any status**, guarded per send
   inside BOTH leaf transports (BYOK/local/webllm and subscription `/invoke`) and applied
   to sidecar-class provider-lane tool results (classified via the canonical
   `parseConnectionUrl` grammar with the executor's own normalization). Any-status
   matters: import demotes rows to `declared` while the replayable app data rides the
   same file — an approved-only predicate left every imported `.snug` unscrubbed.
   Redaction: compiled longest-first case-insensitive word-boundary directory alternation
   + jid pattern + ≥7-digit dialability rule over the parsed envelope, values and keys —
   EXCEPT envelope ids (verbatim; mangling real UUIDs breaks the model's requestId echo)
   and `responseSchema` keys/`required` (untouched, directory matched case-sensitively —
   a contact saved as "Home" must not break a `home` property). Fails closed on an
   unreadable directory; malformed wires take a commutation-tested unescape-normalised
   raw path. P-labels/`YOU` never rewritten.
4. **Lifecycle (owner-decided).** The directory is a persisted third-party-PII asset:
   wiped (in-transaction, dirty-marking owned by the wipe) when the last APPROVED
   sidecar-ceiling connection is revoked or its app deleted; it deliberately SURVIVES
   import. The in-memory harvest is scoped to one user-file identity —
   `resetSidecarIdentitySession()` runs on import/pull/restore/revoke/deleteApp so one
   file's contacts can never re-persist into another and a wipe stays wiped.
5. **The honest class, stated in the threat model:** anti-default and anti-naive, not
   anti-adversarial. Disclosed residuals: obfuscation (homoglyphs/base64/glued
   spellings), numeric smuggling (phones as JSON numbers — `ts` is legitimately ten
   digits), the ≤128-char id channel, identities never surfaced through the sidecar
   seam, the chat data lane's replay of app-persisted rows, and message content itself
   reaching the provider by design.

## Alternatives considered

- **Full host takeover** (host mints labels, de-anonymises replies, exposes the map) —
  rejected: identical observed-identity coverage at the cost of protocol schema churn
  pre-launch and a much larger reviewable surface.
- **Ingress-side scrubbing** (pseudonymise bodies before they enter the iframe) —
  rejected: breaks the core UX (the chat UI must show real names) and contradicts the
  delivery seat's documented pass-through invariant.
- **Wipe-on-import** — rejected in review: it would strip the scrub directory exactly
  where the replay risk travels.

## Consequences

- The egress guard adds a per-send user-DB read to every app turn; transports now
  require an installed page DB even in tests (the `getKey` precedent).
- Two populations now exist by design and must not be conflated: pump eligibility
  (`resolveSidecarSlot`, approved-only — it reads on the user's behalf) vs scrub
  population (`appHasSidecarFact`, any status — it only redacts).
- The wizard's Rust route table grants `sidecar_wizard_fetch` a `GET /chats` capability
  no TS caller uses; if a wizard surface ever uses it, that read bypasses the harvest —
  route it through the governed executor instead (noted in `sidecarIdentity.ts`).
- Post-revoke, the directory is gone while app data may persist: primitives still scrub,
  harvested names do not — the privacy-vs-coverage trade the owner chose, disclosed.
