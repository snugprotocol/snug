# Requirements — Inbox Copilot

## Must

- **One Gmail account**, connected through the wizard. The manifest is bare; the
  registry supplies scopes, fields and walkthrough on the borrow hit.
- **Metadata-only sync.** 90-day window, `format=metadata` with From, To, Subject, Date,
  List-Unsubscribe. Message bodies are never requested.
- **Pulse lane.** Twelve-week volume trend, top senders, category mix — hand-drawn inline
  SVG, both themes, no chart library. Every message counted exactly once in the mix.
- **Needs-you lane.** Senders with ≥3 received and 0 replies, excluding transactional
  senders and anything starred or marked important. Each flag shows its evidence
  (count, last-seen) so a person can disagree with it.
- **Unsubscribe lane.** Ranked by volume; `mailto:` → one confirmed `gmail.send`;
  `https` → open-url bridge behind an https-only, no-userinfo gate; no header → no
  fabricated endpoint.
- **Do-this lane.** Assistant-proposed cards that run in-page: preview → one confirm.
  Every lane has a local fallback so the app works with no agent at all (ADR-0011).
- **Mass cleanup.** Multi-select senders; trash / file / spam / block. Trash rides
  `batchModify` `addLabelIds:['TRASH']`, chunked at 1000. Block creates a Gmail filter.
- **Preview-then-confirm on every write.** The plan object is both the confirm copy and
  the request body. Empty selection produces no plan.
- **Sample mode.** Deterministic 90-day inbox, RFC 2606 domains, marker-wrapped, every
  lane populated, both unsubscribe channels present, and the two exclusion traps shown.
- **Accessibility and theme.** `data-theme` aware, usable at 375px, ≥44px targets,
  skeletons over spinners, no hover-only affordances, no `window.confirm`.

## Must not

- Request or hold the `https://mail.google.com/` scope, or emit any delete call.
- Claim to "report spam" — the SPAM label moves mail; it is not the classifier signal.
- Fetch any host but `gmail.googleapis.com`, or POST to an unsubscribe endpoint.
- Flag a sender the user has ever replied to, starred, or marked important.
- Blank the app on a failed sync — the previous view survives, the error is shown.

## Acceptance criteria

Each maps to a test in `examples/gmail-analysis.test.mjs` unless noted.

1. Never-replied flag: ≥3 received, 0 replies; a single reply clears it permanently.
2. Transactional senders excluded (address and subject heuristics).
3. Starred/important senders excluded despite zero replies.
4. Unsubscribe ranking by volume; `mailto` preferred when a header offers both.
5. URL gate rejects http, `javascript:`, `data:`, and userinfo authorities.
6. Reducers: weekly buckets ascend, out-of-window messages dropped not folded, category
   mix totals every message once, no reducer mutates its input.
7. Batch planner: names count and senders; trash expressed as a TRASH label move;
   2,500 ids split into three legal chunks; block is a filter; empty selection → null.
8. No plan can express a deletion (negative test).
9. Sample inbox: deterministic across renders, >300 messages, every week populated,
   both unsubscribe channels present, all addresses in reserved domains.
10. Shelf contract via `validate.test.mjs`, `connection-manifests.test.mjs`,
    `sample-mode.test.mjs`; registry pin via `packages/auth` suites.
