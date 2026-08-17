# Threat-model delta — the WhatsApp linked-device sidecar (TASK-20260816-whatsapp-twin, ADR-0032/0033)

What this change ADDED to the attack surface, what guards it, and what is **accepted and not
mitigated**. Baseline: ADR-0023's LAN delta and the AL-03/AL-04 connected-fetch deltas. The
executor's ten gates are unchanged by this task except for one additive field pair on the
confirm seat (below); `isForbiddenNetHost`, `isPrivateRfc1918Ipv4Literal` and
`transportPolicy` are untouched, deliberately and by construction.

## New surface

1. **A long-lived helper process** (`apps/whatsapp-sidecar`, Node + Baileys) holding a live
   WhatsApp linked-device session: Signal/noise key material on disk, a persistent WebSocket,
   and the ability to send messages as the user. It is outside the iframe (C2) and outside the
   request/response executor by construction — a linked-device session cannot live in either.
2. **A new IPC pair in the desktop shell**: `sidecar_ctl` (spawn/supervise) and
   `sidecar_fetch` (the only route from the webview to the helper).
3. **A new class of data reaching a third-party LLM**: other people's private messages, and
   psychological profiles built from them.
4. **A standing, pre-recorded write approval** as a concept (ADR-0033), even though the
   arming surface itself is deferred.

## Guards carried, per link

- **Credential custody split (C1).** WhatsApp session keys live ONLY in the helper's own disk
  store and are serialized on no route — asserted by a negative test that drives EVERY route
  against a POPULATED, real-shaped auth store (an empty store would pass for the wrong
  reason). What reaches `snug_secrets` is a helper access token, ≥256 bits of CSPRNG entropy,
  minted exactly once. The store's re-mint guard is tested by driving the store directly,
  because the router's own check otherwise masks it.
- **The helper is not a host, so no ceiling entry exists.** Reachability is
  `sidecar_fetch`, enforcing METHOD + PATH against the enumerated contract in Rust before a
  socket opens, traversal checked on the DECODED form (`%2e%2e` defeats a literal scan), and
  a 1 MiB cap enforced *while reading* — a client that buffered first would defeat the bound
  before the check saw a byte. The Rust route table is a deliberate restatement across an IPC
  boundary and earns an equivalence test that PARSES the Rust source, verified to catch drift
  in both directions plus a non-vacuity assertion.
- **Unix-domain socket, not TCP** (owner decision). Port squatting is unrepresentable — no
  port to race for; `0600` filesystem permissions, not bind order, decide who connects.
  Nothing on the machine's network stack can reach the helper. The spawn nonce remains as
  defense in depth.
- **`/pair/*` and `/session/*` are wizard-only**, refused on the app path in Rust AND absent
  from the derived `APP_REACHABLE_SIDECAR_ROUTES`. This closes the cross-app token-capture
  attack at its source: `GET /pair/status` releases the token, so an app able to poll it
  could mint itself a credential without breaking the credential store at all.
- **EVERY route requires a credential, `/pair/*` included.** The original draft ("every
  non-pair route 401s") would have left the token-releasing route open; the pairing routes
  require the spawn nonce, which only the process that started the helper knows.
- **C2:** both IPC commands join the gate scope with per-command checks
  (`ipc-sidecar-fetch-refused`), and two isolation tests pin that neither command's refusal
  can grant the other's verdict.
- **New-reader scrub (ADR-0032 §B4).** Every LLM-bound payload derived from thread content is
  pseudonymised at the turn's altitude: participants become stable per-thread labels, and
  phone numbers and JIDs are redacted from message BODIES as well as author fields. Phone
  numbers are matched on the primitive (a dialable digit run, however spaced or punctuated),
  not on one spelling. `scrubAuthValues` does not cover this — it protects a different reader
  (credentials entering the iframe) at a different altitude.
- **Honest sync state.** History is pushed in chunks and completion is sometimes only
  INFERRED; `explicit: false` rides with every page and the app renders it as partial. An app
  that showed an inferred completion as the whole record would be misdescribing the evidence
  its entire analysis rests on.
- **Standing approvals (ADR-0033), for when arming lands.** The gate is keyed
  (appId, slot, threadJid, trigger), returns no opinion outside its frozen scope so the
  ordinary confirm still runs, enforces cap + quiet hours + kill switch, and REFUSES when a
  send's body JID disagrees with its path JID rather than picking one. The confirm seat's new
  `slot`/`body` fields are optional, so every existing caller is byte-identical; the ABSENCE
  of `slot` on the absolute-URL path is what keeps a grant off the wizard's shared probe.

## Accepted and NOT mitigated

- **ToS and account-ban risk.** Unofficial WhatsApp automation violates WhatsApp's terms and
  accounts have been banned for it. Human-like pacing and the rate cap are harm reduction,
  never detection evasion, and are not a guarantee. Disclosed in the wizard consent copy and
  the starter README, before the user connects.
- **Third-party consent (distinct from impersonation — different people, different harm).**
  The other participants in an analysed thread never consented, are not Snug users, and
  cannot opt out. Under BYOK their messages reach the user's configured model provider under
  the user's own key. Mitigated in degree by pseudonymisation and the cascading
  "forget this thread" control; not eliminated. This is the residual a reviewer should weigh
  most heavily.
- **Impersonation.** Drafted replies are speech in the user's name. In this version every
  send is read and confirmed by the user first, which bounds it; when arming lands, the
  activity journal and the tagged-only group default become the honesty controls.
- **Local-process trust.** Any process running as the same user can read `~/Snug/` and
  therefore the socket and the helper's key store. This is the standard desktop trust
  boundary — the same one that protects every other credential Snug holds — and is not
  something an app-layer guard can improve.
- **The pairing window.** Between spawn and link there is an interval in which a process
  holding the spawn nonce could complete pairing. The nonce is 256-bit CSPRNG and never
  leaves the shell and the wizard; `start` is idempotent so a second call cannot spawn a
  rival.
- **Windows is deliberately red** (ADR-0021 D8). The named-pipe twin is authored behind the
  same seam but not shipped green.
- **Packaging.** The helper is spawned via system `node` against `~/Snug/helpers/`; bundling
  is out of scope for this task and documented as a requirement.
- **In-memory standing grants.** An armed thread would not survive a page reload. Harmless
  while arming is deferred; it must be closed when the arming surface lands.
