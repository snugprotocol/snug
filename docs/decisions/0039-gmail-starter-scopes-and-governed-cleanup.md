# 0039 — Gmail starter: pinned modify/settings/send scopes and governed inbox cleanup

- **Status:** proposed (draft at Gate 2 of TASK-20260819-gmail-starter; plan-review findings folded 2026-08-19; pending owner plan approval)
- **Date:** 2026-08-19
- **Task:** TASK-20260819-gmail-starter

## Context

The shelf's connected starters each complement their provider's own app (ADR-0031).
Gmail's own client reads mail well; what it does not do is *govern bulk hygiene* —
who deserves your attention, what to unsubscribe from, what to auto-trash — with an
agent that sees the whole distribution and an approval channel the user controls.
The `gmail` registry entry has existed since the well-known-provider sweep but is
**wizard-incomplete** (recorded in next-steps item (7)): no pinned scopes, no
credential fields, no registration walkthrough — a Gmail connection today dead-ends,
the exact broken-by-construction failure ADR-0028 was written to end (its Spotify §4
set was the first pin; this is the second).

## Decision

1. **The `gmail` entry pins three scopes (ADR-0028 rule 1), recorded in ADR-0028's
   amendment log:** `gmail.modify` (read, label, trash, mark-spam — the cleanup
   core), `gmail.settings.basic` (auto-trash rules and sender blocking are
   *filters*, not message ops), `gmail.send` (mailto: unsubscribe messages, only as
   confirmed writes). The full-access `https://mail.google.com/` scope is rejected
   (see D3).
2. **The entry gains pinned `fields` and a layman `registration` walkthrough.** The
   wizard renders `requirement.fields ?? []` and `generateAuthUrl` has no
   stored-client_id fallback, so fields are load-bearing: `client_id`, plus
   `client_secret` iff the pre-implementation live probe confirms Google's
   installed-app token exchange requires it even with PKCE (expected yes; Google
   documents the Desktop-client secret as "not treated as a secret", and the GitHub
   `oauth_app` option is the C1-compatible secret-collection precedent — the hub
   holds it in the user's own file, it never enters the iframe or the LLM). The
   walkthrough (console URL + create project → enable Gmail API → consent screen →
   Desktop-app client → copy credentials) is honest about provider caveats, Spotify
   precedent: restricted-scope unverified-app warning, and Testing-status refresh
   tokens expiring after 7 days unless the project is published to Production.
3. **Every destructive action is a per-batch confirmed write, and trash-only is
   STRUCTURAL.** Permanent delete (`messages.delete`/`batchDelete`) requires the
   `https://mail.google.com/` scope, which is deliberately not pinned — the token
   cannot permanently delete, regardless of app code. On top of that: each
   suggestion card and mass-cleanup run shows exactly what it touches (count +
   senders) and takes one host-side confirm per batch; a negative test asserts
   authored code never calls the delete endpoints anyway. Bulk trash rides
   `messages.batchModify` (`addLabelIds:["TRASH"]`, ≤1000 ids). "Move to spam" is
   labeled honestly (SPAM label move, not classifier-training "Report spam").
4. **Unsubscribe is channel-split by what the sandbox can honestly do:** `mailto:`
   List-Unsubscribe → a `gmail.send` message (confirmed write); `http(s)` links →
   the open-url bridge to the system browser (ADR-0038 D5) behind an https-only /
   no-userinfo URL gate (ledger's `safeCancelUrl` precedent); RFC 8058 one-click
   POST is structurally excluded — it would POST to arbitrary hosts outside the
   frozen `gmail.googleapis.com` ceiling.
5. **13th shelf app, 8th connection declarer, desktop-only at v1** (a Desktop-app
   OAuth client registers only loopback redirects; the web playground origin is not
   registrable — trade-copilot/hue/whatsapp tile precedent). Full ADR-0031/0035
   provenance and an ADR-0011 runtime contract as the carry-forward base prompt.
   Charts are hand-rolled inline SVG — chosen on merits (zero dependency, ~0 bytes
   toward the 5MB cap, full theme control), not for lack of precedent: Telepath
   already ships KB-known-good Chart.js 4.

## Alternatives considered

- **Read-only v1** (charts + flags, dry-run actions): safest, but cleanup *is* the
  USP; rejected by owner in the task interview.
- **Full `https://mail.google.com/` scope**: one consent line instead of three, but
  grants permanent delete the app must never use — a granted-but-promised-unused
  scope is exactly the silent-privilege smell ADR-0028 exists to kill, and it would
  demote D3 from structural to behavioral.
- **Chart.js 4 from the CDN allowlist** (the real precedent, not Recharts): richer
  axes/tooltips for less code; rejected for dependency weight and because the
  shelf's charts are small, bespoke, and theme-critical.
- **RFC 8058 one-click unsubscribe**: best UX, impossible under declared-hosts
  without per-sender ceiling widening; open-url bridge chosen instead.
- **Web-playground support at v1**: would need a Web-application OAuth client and a
  posture-branched walkthrough; deferred — desktop-only tile instead.

## Consequences

- The pin is registry DATA; ADR-0028's emitter/borrow-REPLACE/wizard-render/
  re-consent machinery handles it with no auth code-path changes. The auth touch
  still makes the task High tier: negative tests + pre-implementation plan review
  (run 2026-08-19) + self-sign-off.
- Any pre-existing approved gmail row (none known pre-launch) re-consents via
  ADR-0028 rule 3 — pins never promote silently.
- The consent screen states send capability; the walkthrough states the tradeoff
  (any Snug app connected to Gmail can then use these scopes) and the 7-day
  Testing-status expiry with the publish-to-Production path.
- Users who stay in Testing status re-consent weekly — accepted as a BYOK reality,
  documented rather than hidden.
