# 0028 — Registry-pinned OAuth scopes: reviewed registry data, never silent defaults

- **Status:** accepted (2026-08-15, at merge; owner approved the plan, verified the live Spotify round trip on hardware — playlists load with the pinned scopes — and commissioned the merge explicitly) · **AMENDED 2026-08-19** (TASK-20260819, PR #78): rule 4's Spotify set gains `user-read-recently-played` — see the amendment block at the foot of this file. Rules 1–3 and 5 stand unchanged. · **AMENDED 2026-08-19** (TASK-20260819-gmail-starter, ADR-0039): `gmail` becomes the SECOND scope-pinned entry — see the second amendment block at the foot of this file. Rules 1–5 stand unchanged; the pin is an application of rule 1, not a change to it.
- **Date:** 2026-08-15
- **Task:** TASK-20260815-spotify-scopes-wizard-links

## Context

The registry's standing posture (carried from the source system, stated at the top of
`packages/auth/src/well-known-providers.ts` and on the type's `scopes?` field) was **"no
default scopes — silent privilege widening"**: every entry left `scopes` undefined and
callers were expected to declare their own. In practice no channel ever did — the
requirement schema's `scopes` seat (`connection-requirement.ts:460`) exists and the OAuth
service sends it on both the authorize and token legs, but nothing upstream ever filled
it. The result for Spotify: the authorize URL carries no `scope` parameter, Spotify mints
a public-data-only token, and the starter's `GET /v1/me/playlists` answers 403 — surfaced
to the owner as "the key may be wrong, expired, or revoked", which misdiagnoses a
provider whose OAuth round trip actually succeeded.

The original posture guarded against the right harm with the wrong rule. The harm is a
scope grant the user never sees. A registry-pinned scope list is as reviewed as pinned
hosts or fields, and the provider's own consent screen lists it again. (The fresh-context
plan review caught that the wizard did NOT render `scopes` anywhere — the protocol
comment at `connection-requirement.ts:653` described rendering that never existed — so
this task BUILDS the review-screen block and the diff-screen delta rather than assuming
them; without that, this ADR's justification would be fiction.) What "no scopes ever"
actually bought was providers whose APIs are useless without scopes shipping broken by
construction.

## Decision

1. **A registry entry may pin `scopes` — ENTRY-level only, never per auth option.**
   Privilege breadth is brand identity, exactly like display name and hosts (ADR-0020's
   identity-seat rule extended): a flow choice must never change what the credential can
   do. A human-reviewed list, exactly like `endpoints`/`fields`/`request`. What stays
   forbidden is the original harm, restated precisely: **a scope the user never sees**.
   Pinned scopes ride the requirement, render on the wizard review screen (built by this
   task), and appear on the provider's consent screen. An entry whose API works
   scope-less keeps `scopes` undefined.
2. **The seat rides every surface pinned seats ride** (lesson 2026-08-13): emitted by
   `requirementFromRegistryEntry` from the ENTRY (options never carry it — the
   self-containment sweep stands), REPLACED (never merged) by `applyRegistryValues` on
   every borrow hit, rendered by the review AND diff screens, and reconciled by the
   wizard-open drift migration.
3. **A scope change on an approved row always re-consents, and the old token cannot
   outlive the approval.** One `scopesChanged` comparison drives drift detection, the
   silent-promotion guard, and the re-approval routing — the silent `repersisted`
   promotion is structurally unreachable when scopes changed, even with an identical
   host ceiling. The comparison is **SET-based** (Gate-5 review): RFC 6749's `scope`
   parameter is unordered, so a pure reorder is not a consent change — it neither
   stages (the set-based diff renderer would show an approval with no visible delta)
   nor invalidates tokens; adds and removes do both. The scopes-changed promotion
   **invalidates the stored access/refresh tokens for BOTH token-minting OAuth kinds**
   (`oauth2_auth_code` and `oauth2_client_creds` — the client-credentials mint sends
   `scope` too), and the invalidation runs **before** the promotion so a mid-write
   failure leaves the recoverable state (old requirement + staged diff), never a
   promoted row with live old-scope tokens and no healing diff. The token was minted
   under the old consent and providers do not widen on refresh, so an abandoned
   re-consent must leave an honestly non-serving row (banner + wizard re-offer), never
   a silently under-scoped one. Substitution and emission write the seat only onto
   declarations whose KIND consumes scopes — a static-kind row under a scope-pinned
   brand gains nothing and stages nothing.
4. **Spotify pins** (owner decision 2026-08-15, read + playback control):
   `playlist-read-private`, `playlist-read-collaborative`, `user-read-private`,
   `user-library-read`, `user-top-read`, `user-read-playback-state`,
   `user-modify-playback-state`. `user-read-email` deliberately excluded (no Snug
   surface needs the address). The tradeoff is recorded: every Spotify-connected Snug
   app's token can control playback; the consent screen says so.
5. **`scopes` stays OUT of `CREDENTIAL_PROMPT_SEATS`.** A borrower authoring scopes
   under a scope-pinned brand is substituted away by rule 2; under a non-scope-pinned
   brand it keeps today's behavior. This sits beside the known
   borrowed-`endpoints`-survive-substitution item (next-steps 2026-08-12) for the next
   threat-model pass — one decision for both seats, not two drifting ones.

## Consequences

- The Spotify starter works: the token can read private/collaborative playlists.
  Existing scope-less rows heal at wizard open via the staged diff + fresh sign-in.
- Provider research facts backing this change (primary Spotify docs, read 2026-08-15):
  redirect URIs must be https EXCEPT loopback IP literals (`http://127.0.0.1:PORT`
  sanctioned, `localhost` banned; enforced Apr-2025/new, Nov-2025/existing) — ADR-0021's
  desktop transport is already exactly compliant, so no https work rides this task.
  Dev-mode (Feb-2026): max **5** allowlisted users, owner must hold Premium, one Client
  ID per developer — the entry's registration walkthrough now states these.
- Registry comments claiming "scopes are ALWAYS undefined by policy" are rewritten to
  point here.
- Widening a pinned set later is a normal registry edit: drift stages it, the user
  re-consents. Narrowing likewise (tokens keep serving until re-consent).

---

## Amendment — 2026-08-19 (TASK-20260819-connection-failure-ux)

**Rule 4's Spotify set gains an eighth scope: `user-read-recently-played`.** The list in
rule 4 above is left as written — it records what was decided on 2026-08-15 — and this
block records what changed and why. Appended rather than edited, per the repo's
append-only decision convention; the machine-readable truth is
`packages/auth/src/well-known-providers.ts`, pinned by `registry-pinned-scopes.test.ts`.

**Why.** The original seven deliberately omitted this scope, and Rewind was written to
match: it attempts the recently-played read once per session, expects the 403, and
derives discovery from top-list drift instead. That was honest inside the app — and
invisible to the host. The auth-shaped failure observer (ADR-0022 §4) fires on any
delivered credentialed 401/403 and cannot know a refusal was expected, so the owner saw
the repair alarm — *"Spotify isn't accepting this app's key … Insufficient client
scope"* — on **every launch of a working connection**, dismissed it, and used the app
normally. A surface that cries wolf on every launch is one users learn to ignore, which
costs exactly the failures it exists to report.

**Why widen rather than teach the host to expect refusals.** An app-declared
"expected refusal" seat on the net request was considered and rejected: a
protocol-visible knob whose only consumer is one starter, cutting against this ADR's own
rule that privilege breadth is reviewed registry data. The deciding fact is that Rewind
already ships a complete recently-played lane (`recentMetrics`, the recent-chips row, the
second branch of the discovery caption) that the omission left unreachable — so the pin
switches on built functionality rather than merely silencing an alarm.

**Consent tradeoff, stated:** every Spotify-connected Snug app's token can now read
listening history. The consent screen lists it, and the review screen renders it before
any approval. `user-read-email` stays excluded.

**Consequence, accepted:** rule 3 applies unchanged — every existing Spotify row stages a
diff and re-consents once, tokens invalidated before promotion.

**Residual, NOT closed by this amendment.** Invalidation happens on *approval*
(`reapproveFromDiff`). A user who dismisses the diff without re-approving keeps the old
seven-scope token, and the 403 — and therefore the alarm — returns on every launch.
Static-kind Spotify rows and non-registry provenance gain no scopes at all (rule 2's
kind guard), so they are in the same position permanently. Rewind cannot self-gate: C1
means it never sees the token, and granted scopes are host-side. The task file records
this as an accepted residual rather than a closed defect.

---

## Amendment — 2026-08-19 (TASK-20260819-gmail-starter, ADR-0039): the second pinned entry

The `gmail` entry pins three scopes: `gmail.modify`, `gmail.settings.basic`,
`gmail.send`. Recorded here because rule 1 requires it — a pin is only legitimate as
reviewed registry data with an ADR behind it, and this file is the roster. The full
argument (why these three, why not `https://mail.google.com/`, the probed
`client_secret`, the walkthrough's provider caveats) lives in
[ADR-0039](0039-gmail-starter-scopes-and-governed-cleanup.md).

**What this amendment adds to the ADR-0028 doctrine, beyond a second row:**

**A pin can be load-bearing for what an app CANNOT do.** The Spotify pin was
subtractive-by-omission — `user-read-email` excluded because nothing needed it. The
Gmail pin uses omission as a *mechanism*: withholding the full-access
`https://mail.google.com/` scope is what makes "Inbox Copilot never permanently
deletes mail" a property of the minted token rather than a promise kept by app code.
Rule 1's "a scope the user never sees" harm has a mirror image worth naming — **a
scope the user grants that the app promises not to use**. Both are silent-privilege
smells. A scope set should be the smallest that makes the shipped functionality
reachable (the 2026-08-19 Spotify amendment) *and* the smallest that leaves the
app's stated limits enforceable rather than merely intended.

**The wizard-completeness lesson.** Gmail had been resolvable since the well-known
sweep — right endpoints, right hosts, PKCE, loopback — and was still unconnectable:
no scopes meant a token that reads nothing, and no `fields` meant a credential screen
with zero inputs (the wizard renders `fields ?? []` and `generateAuthUrl` has no
stored-`client_id` fallback). `docs/next-steps.md` item (7) had recorded the dead-end;
nothing failed, because nothing tested that a registry entry is *sufficient* rather
than merely *present*. An entry is connectable only when scopes, fields, and
walkthrough are all pinned together.

**Consent tradeoff, stated:** every Gmail-connected Snug app's token can read, modify,
trash, and mark-spam mail, create filters, and send mail as the user. The consent
screen lists all three scopes and the review screen renders them before any approval.
Permanent deletion is not grantable through this entry.

**Consequence:** rule 3 applies unchanged — any existing `gmail` row (none known
pre-launch) stages a diff and re-consents once, tokens invalidated before promotion.
