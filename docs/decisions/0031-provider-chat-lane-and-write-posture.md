# 0031 — Provider chat lane, inline cards, and the read/write posture reset

- **Status:** accepted (2026-08-15, ships with TASK-20260815-provider-chat-lane — the child A implementation PR; plan-review amendments F1-F12 recorded in that task file; threat surface: `docs/security/threat-model-delta-provider-chat-lane.md`)
- **Date:** 2026-08-15
- **Task:** TASK-20260815-starter-portfolio-revamp (umbrella; children provider-chat-lane / inline-cards / starter-apps-rebuild)
- **Supersedes:** the standing owner decision "Snug crypto starters are read-only" (owner memory, 2026-08-xx; never an ADR). ADR-0016/0019/0022/0026/0028/0030 all stand untouched — this ADR composes them, it does not amend them.

## Context

ADR-0019 gave app-attached chat intent routing with a data lane: LLM-authored SQL runs
on a scratch copy of the app's own DB, writes propose→approve→execute. Data living at a
connected **provider** had no chat path at all — the only consumers of an approved
connection were requests baked into the app's HTML at build time. Meanwhile the
connected-fetch executor (AL-03, ADR-0022/0026) already governs *any* request an app
makes at runtime: the frozen per-connection host ceiling is **host-granular, not
endpoint-granular**, mutating methods pass a user confirm gate before any credential is
read, credentials are injected host-side only, and responses are scrubbed. Separately,
the owner's standing "crypto starters read-only" rule blocked the portfolio's flagship
starter (Trade Copilot smart-order orchestration).

## Decision

1. **Posture reset (owner, 2026-08-15).** Starter and user-authored apps may hold full
   read/write/execute access — via authenticated provider APIs and via DB calls on the
   user's snug file. The invariants are structural, not doctrinal: the sandbox (C2), the
   bridge, and the executor's gates (C1: host ceiling, confirm gate on mutating methods,
   host-side injection, scrub). The "crypto read-only" rule is removed; no per-category
   write bans remain. No NEW approval doctrine is introduced for provider writes — the
   executor's existing session-rememberable confirm gate is the control. ADR-0019's DB
   propose→approve lane is unchanged.

2. **Provider lane.** The chat intent vocabulary gains `provider_read`/`provider_write`
   mapping to a `provider` lane. The lane's turn sees approved-connection *facts* (slot,
   provider name, scope summary, symbolic addressing) — never credential values, never
   resolved LAN hosts — and one tool, `provider_request`, executed through the SAME
   `createConnectedFetch` deps assembly and `netAppId` as app-runtime requests. An LLM
   may compose method/path/body; it may never widen a grant (ADR-0016 stands: zero
   matches → `NET_NOT_APPROVED` + connect CTA), never place a credential (ADR-0022
   stands: placement is registry-pinned), never see one (scrub is what the lane reads).
   Wire protocol v1 unchanged; `chat-intent.ts` additions stay internal-draft like
   ADR-0019; byok/local only (the subscription-twin gap family already recorded).

3. **Inline cards are hub-client UI, not protocol.** Ask/choose/confirm moments in any
   lane render as typed, bounded cards in the chat rail (generalizing ADR-0019's
   write-proposal card); the provider write-confirm becomes a card naming host + method +
   URL. No new frames, no SDK embedded-hooks change; in-app cards ship as a KB pattern.
   If a real app proves a frame is needed, that is a new ADR.

## Consequences

- The portfolio can ship complementary connected starters (Coinbase order orchestration,
  Spotify analytics + actions, Hue match/search actions, GitHub triage) with the wow
  path and the write path both governed by existing, already-tested gates.
- The LLM becomes a request *author* at runtime, not just at build time. The threat
  surface delta is deliberately null at the executor: nothing it enforces changed. What
  changed is upstream — prompts now drive credentialed calls, so classifier/context
  prompts join the C1-adjacent review surface (High tier in child A, negative tests for
  credential presence in LLM-bound strings).
- A rejected alternative: endpoint-granular pinning for LLM-composed requests. Refused
  because the executor's ceiling is deliberately host-granular for apps already, and a
  second, stricter grammar for the same seam would fork the security story into two
  models with one wall between them (ADR-0022's lesson: one reviewed authority).
- Accepted residual: a confused-deputy prompt-injection risk — provider responses and
  stored rows are untrusted input to a turn that holds a write-capable tool. Mitigations
  carried from ADR-0019 (defanged result blocks, "data not instructions" tails) plus the
  confirm gate on every mutating call; revisit at the AL-11 threat-model v1 pass.
