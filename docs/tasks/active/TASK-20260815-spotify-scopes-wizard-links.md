# TASK-20260815-spotify-scopes-wizard-links: Spotify starter 403 repair (registry scopes), provider-error detail on the auth banner, registry-pinned console links

- **Status**: in-review
- **Owner**: jeetu (AI: Claude Fable 5)
- **Risk tier**: **high** — touches `packages/auth` (registry, admission, connected-fetch executor); auto-escalates per PROCESS.md. Plan requires a fresh-context AI review before implementation.
- **Branch**: `fix/TASK-20260815-spotify-scopes-wizard-links`
- **Packages touched**: `packages/auth`, `apps/playground`, `apps/desktop` (dependent; possibly a small opener touch), `examples/spotify-party-dj` (docs only, if at all)
- **Spec impact**: none — `scopes` already exists in `connectionRequirementSchema` (`packages/protocol/src/connection-requirement.ts:460`); no protocol schema bytes change. If implementation discovers otherwise, STOP and re-plan via SPEC_SYNC.
- **Related**: ADR-0017 (wizard, copy-only console URLs), ADR-0020 (multi-option, matched-option handle), ADR-0021 (loopback OAuth, port 41420), ADR-0022 (registry seats, drift migration, auth-shaped-failure observer), next-steps 2026-08-08 "real-provider verification gap" (Spotify PKCE round trip), next-steps 2026-08-13 item (7) (other wizard-incomplete entries — out of scope here). New ADRs drafted with this task: **ADR-0028** (registry-pinned scopes), **ADR-0029** (registry-pinned URL clickability).

## Spec (what & why)

The Spotify starter (`examples/spotify-party-dj`) completes OAuth but every playlist call
returns 403, surfaced as "The key may be wrong, expired, or revoked (403)". Root cause
(code + Spotify docs, researched 2026-08-15): the registry's standing "no default scopes"
posture means the Spotify authorize URL carries **no `scope` parameter**, so the minted
token cannot read the user's private playlists — and the banner's guess-copy misdiagnoses
it. (Owner confirmed the dashboard account = listening account and holds Premium, so the
dev-mode allowlist is not the blocker — but its rules changed Feb 2026 and our wizard
walkthrough copy is stale: allowlist is now max **5** users, owner needs **Premium**, one
Client ID per developer.)

Separately, the wizard renders the provider console URL as copy-only for the starter,
because clickability is keyed on `provenance === 'registry'` — but a starter/inference row
whose provider matched the registry had its URLs **substituted from the registry**
(`applyRegistryValues`), so the anti-phishing rationale ("never link a model-proposed
URL") does not apply to them. Clickability should key on "is this URL registry-pinned",
not on which channel created the row.

Redirect-URI/https finding (owner asked): Spotify requires https **except** loopback IP
literals — `http://127.0.0.1:PORT` is sanctioned, `localhost` is banned. Desktop already
does exactly this (`http://127.0.0.1:41420/callback`, ADR-0021). **No https work is
needed for Spotify**; the https-bridge posture remains reserved for Slack-class providers
and stays out of scope.

**Owner decisions (interview 2026-08-15):**
1. Diagnosis facts: same Spotify account for dashboard + sign-in, has Premium.
2. Scope set: **read + playback control** (exact set in ADR-0028): `playlist-read-private`,
   `playlist-read-collaborative`, `user-read-private`, `user-library-read`,
   `user-top-read`, `user-read-playback-state`, `user-modify-playback-state`.
   (`user-read-email` deliberately excluded.)
3. Auth banner learns the provider's own error reason (scrubbed, bounded).
4. Link rule: clickable iff the console URL byte-matches the pinned registry value for the
   row's matched provider, any provenance; redirect-URI box stays copy-only everywhere.

**Acceptance criteria** (each becomes at least one test):
1. **AC1 — scopes reach the authorize URL.** The Spotify registry entry pins the approved
   scope set; `requirementFromRegistryEntry` emits `scopes` as an **ENTRY-level seat**
   (like display name/hosts — privilege breadth is brand identity, never a flow choice;
   `WellKnownAuthOption` gains no scopes seat, preserving the
   `registry-self-containment` options sweep). The AC1 test composes the REAL chain at
   the production altitude: entry → emitter/admission → `requirementToSpec`
   (`connected-fetch.ts:471`, scopes at `:495`) → `generateAuthUrl` → URL carries
   `scope=` with exactly the pinned set (space-joined, order preserved). (Plan-review
   correction: the auth-code token/refresh legs do NOT send `scope` — only the
   client-credentials mint does — and that is RFC-correct; no oauth-service change.)
2. **AC2 — substitution owns scopes.** `applyRegistryValues` REPLACES declared scopes
   with the entry's pinned ones on every borrow hit (a borrowed brand can never widen or
   narrow a scope-pinned entry); entries without pinned scopes preserve today's behavior
   byte-for-byte. Starter manifests stay bare (no manifest change needed).
3. **AC3 — scope drift forces a fresh sign-in, and the old token cannot outlive the
   approval.** Wizard-open drift migration on an approved, scope-less Spotify row STAGES
   a diff showing the added scopes; approving it routes through the credential half into
   a fresh authorization round trip (re-consent), and the silent `repersisted` promotion
   is structurally unreachable for a scope change even when the host ceiling is
   identical. ONE `scopesChanged` comparison (order-sensitive structural compare — the
   wizard spells its own; `structurallyEqual` is not exported from admission) drives all
   THREE seats: drift *detection* (`connectionWizard.ts:1272-1276` — today a scope gain
   is neither `fieldSetChanged` nor `gainsSeats` and never even stages), the
   silent-promotion guard (`:1284-1288`), and `reapproveFromDiff` routing
   (`:488-536`). **Token invalidation (plan-review blocker 1):** a scopes-changed
   promotion deletes the stored access/refresh tokens (or sets a non-serving state) in
   the SAME act as `reapproveConnection` — the LAN branch at `:504-528` is the shape
   precedent. **Abandonment test:** approve the scope diff → close the wizard before
   sign-in completes → connected-fetch must NOT silently serve the old scope-less token
   (banner/CTA re-fires; the row is honestly non-serving, and reopening the wizard
   offers the sign-in, not `'none'`). Negative: request/testRequest-only seat drift
   still promotes silently as today.
3b. **AC3b — re-consent is VISIBLE (plan-review blocker 2).** `ReviewScreen` gains a
   scopes block (the queryTemplate-box P6 pattern at `ConnectionWizardSheet.tsx:552-574`)
   and `ReapprovalDiffScreen` renders the scope DELTA — today neither renders scopes at
   all, and the protocol comment at `connection-requirement.ts:653` describes rendering
   that does not exist (comment corrected in the same change). Tests pin both surfaces.
   Without this, a scopes-only staged diff renders as a diff with no visible delta —
   lessons 2026-08-13's "seat that skips consent" verbatim.
4. **AC4 — banner shows the provider's reason.** The connected-fetch `deliver` seat
   extracts a short detail from **`result.body`** — NEVER the raw `Response`
   (`scrubCandidates` is function-local to `performFetch` and out of scope at `deliver`;
   `result.body` is already read, 1 MiB-capped, and scrubbed with the full candidate set
   at `connected-fetch.ts:1156`, so the "existing scrub" requirement holds by
   construction only on that path). JSON `error.message` shape first, text head
   fallback; hard cap 160 chars. Extends `onAuthShapedFailure(slot, status, detail?)`;
   `AuthRepairBanner` renders "{provider} says: {detail}" when present, current copy
   when absent. The THREE pinned "no response bytes" doctrine comments are rewritten in
   the same commit (`connected-fetch.ts:181-185`, `net.ts:79-80`,
   `AuthRepairBanner.tsx:17-19`) — the channel's new contract is "status + a
   scrubbed, bounded, plain-text extract of the already-delivered body; never
   credentials, never unscrubbed bytes". Negative (C1): a query-credential provider's
   failing URL/value never appears in the detail (asserted through the real scrub
   path). Negative (render): detail is plain text — never a link, never HTML — pinned
   like the P3-AC5 hostile-instructions test.
5. **AC5 — registry-pinned console links.** `RegisterScreen` renders a clickable console
   link iff the row's `registration.consoleUrl` byte-matches the resolved registry
   entry's (or its options') pinned `consoleUrl` — regardless of provenance. Resolution
   MUST be `resolveRegistryEntryByName` (the hue brand-adjacent lesson the drift
   migration documents at `connectionWizard.ts:1250-1258`), never
   `lookupWellKnownProvider`. A one-char-off URL under a registry brand stays copy-only
   (anti-phishing negative test). Unmatched/user-authored providers keep the
   copy-address flow — with the hint copy REWORDED
   (`ConnectionWizardSheet.tsx:710`: post-ADR-0029 that branch also serves user/starter
   URLs no model proposed; say "we haven't pinned it", not "a model proposed it"). On
   desktop the link opens via the system browser (https-only opener), never webview
   navigation. Plan-review verified: `applyRegistryValues` DOES substitute
   `registration` on borrow hits (`requirement-admission.ts:540-542`) so the byte-match
   premise holds for starter rows — and `:541` is a SHALLOW copy (`instructions` stays a
   live registry-singleton reference, unlike every deep-copied sibling seat): deep-copy
   it in this task while AC6 edits that array.
6. **AC6 — walkthrough copy is current.** Spotify `registration.instructions` state the
   Feb-2026 dev-mode facts: max 5 allowlisted users, owner Premium requirement, sign in
   with the dashboard account or one added under User Management. Redirect-URI exactness
   copy unchanged.
7. **AC7 — suites.** `pnpm --filter auth test`, `--filter playground test`,
   `--filter desktop test` green, then root `turbo run test --force` (21/21, Cached: 0).

**Out of scope**: https-bridge page + device-flow transports (queued 2026-08-12);
google/gmail/googledrive/slack wizard completion (queued 2026-08-13 item 7); per-app
requirement-declared scope overrides (follow-up — registry pin only for now);
Feb-2026 `/playlists/{id}/items` migration beyond what the starter calls (it only calls
`GET /v1/me/playlists`, unaffected); starter feature changes (it works once scopes exist);
Apple-Music invented-endpoints cleanup.

**Owner manual test (after merge, desktop):** open the Spotify starter → wizard offers
the staged scope diff → approve → fresh sign-in (consent screen lists the 7 scopes) →
playlists load. This also closes the standing "Spotify desktop sign-in" verification and
the "Spotify real PKCE round trip" next-steps item.

## Plan

Order is tests-first per TDD.md; High tier ⇒ negative tests + fresh-context AI plan
review BEFORE implementation + self-sign-off in the journal.

**P0 — ADR drafts (this branch, status: proposed)**
- `docs/decisions/0028-registry-pinned-scopes.md`: amends the "no default scopes"
  registry posture — a per-entry pinned scope list is reviewed registry data, rendered on
  the wizard review screen (never silent), substituted like every pinned seat, and a
  scope CHANGE on an approved row always re-consents (AC3 rule). Records the Spotify set
  + rationale (read + playback control, owner decision). Notes: `scopes` stays OUT of
  `CREDENTIAL_PROMPT_SEATS` (borrower-authored scopes on non-scope-pinned entries keep
  today's behavior; flagged beside the known borrowed-endpoints-survive-substitution
  item, next-steps 2026-08-12).
- `docs/decisions/0029-registry-pinned-url-clickability.md`: clickability keys on
  byte-match with pinned registry data, not row provenance; redirect-URI box stays
  copy-only; desktop routes through the system-browser opener.

**P1 — `packages/auth` (tests first, then code)**
Files: `well-known-providers.ts` (+test), `requirement-admission.ts` (+tests),
`oauth-service.ts` (no change expected — covered by composition test),
`connected-fetch.ts` + `scrub.ts` (+tests).
1. Tests: Spotify entry pins the exact 7-scope set · emitter emits `scopes` as an
   ENTRY-level seat (options never carry it — the existing self-containment sweep at
   `registry-self-containment.test.ts:292-298` stands) · the AC1 composition test runs
   entry → emitter/admission → `requirementToSpec` → `generateAuthUrl` and asserts the
   exact `scope=` param · `applyRegistryValues` replaces authored scopes on borrow hit /
   leaves non-scope-pinned entries byte-identical (structural sweep across the registry)
   · deliver-seat detail extraction from `result.body`: Spotify JSON error shape, text
   fallback, 160-char cap, absent on empty/unparseable, **scrub negative with a
   query-credential fixture**, observer arity both ways (detail present and absent).
2. Implement: entry `scopes` + updated `instructions` (AC6) + stale-comment updates
   (type comment at `well-known-providers.ts:201`, header posture note, line ~561
   comment) · emitter seat · substitution seat · `deliver` extraction + widened
   observer signature.
3. Mutation-check per lessons.md: revert the emitter seat and watch AC1's test red;
   revert substitution and watch AC2 red.

**P2 — `apps/playground` wizard (tests first)**
Files: `state/connectionWizard.ts` (+`connectionWizard.test.tsx`),
`state/net.ts` (+`authShapedFailureSurface.test`), `run/AuthRepairBanner.tsx`,
`connections/ConnectionWizardSheet.tsx` (+`desktopWizardSheet.test.tsx`).
1. Drift tests (AC3/AC3b): scope-gain on approved row → `staged`, never `repersisted`
   AND never `'none'` (detection is the first seat — today a scope gain fails the
   detection gate entirely); approving the staged diff routes through the credential
   half into a fresh authorize round trip (assert via the step machine + a flow-start
   spy); the promotion act invalidates the stored tokens; the ABANDONMENT case (approve
   → close wizard → old token must not serve; reopening offers sign-in); seat-only
   drift still promotes silently (negative); `ReviewScreen` renders the scopes block;
   `ReapprovalDiffScreen` renders the scope delta.
2. Drift implementation: ONE order-sensitive `scopesChanged` comparison driving all
   three seats — detection (`connectionWizard.ts:1276`), the silent-promotion guard
   (`:1284`), and `reapproveFromDiff` routing (`:488-536`, reusing the existing
   `fieldSetChanged`-style routing into the credential half — the connect step alone
   cannot mint: `startConnectionOAuthFlow({}, …)` has no `client_id` and
   `generateAuthUrl` never falls back to stored credentials
   (`oauth-service.ts:357,653-658`), so the user re-pastes the non-secret client ID
   once; no oauth-service change, custody posture untouched). Token invalidation on
   scopes-changed promotion follows the LAN-branch shape (`:504-528`). One rule, all
   halves driven from the same comparison (lesson 2026-08-12).
2b. Consent surfaces (AC3b): scopes block in `ReviewScreen` (queryTemplate-box
   pattern), scope delta in `ReapprovalDiffScreen`, comment fix at
   `connection-requirement.ts:653`.
3. Banner (AC4): `net.ts` store carries `detail?`; `AuthRepairBanner` renders the
   provider-says line when present; tests for both shapes.
4. Link rule (AC5): replace `consoleUrlIsClickable(row)` with a resolver that
   `resolveRegistryEntryByName(row.requirement.provider.name)` → byte-match
   `registration.consoleUrl` against entry AND `authOptions`; rewrite the P3-AC4
   describe block — the POSITIVE case must move onto a REAL pinned provider (the
   current fixture brand "Tunecast" resolves to no entry and flips to copy-only under
   the new rule; the starter case at `connectionWizard.test.tsx:487-491` flips to
   clickable as intended); near-miss URL → copy-only; unmatched provider → copy-only;
   hostile-instructions test untouched; hint copy reworded (`:710`). Desktop: anchor
   becomes an `openExternal`-backed control when `getPlatform().oauth !== undefined`
   (https-only guard already lives in the opener); test in `desktopWizardSheet.test.tsx`
   (its Spotify rows declare `'registry'` provenance and survive). ADR-0029 records the
   fail-closed residue: a future registry consoleUrl edit never re-stages persisted
   rows, so they fall to copy-only until any other drift stages them.
5. e2e: extend `e2e/connection-wizard.spec.ts` journey 4's register screen assertion to
   cover the clickable-console-link variant (stub provider registered in the test
   registry — follow the existing journey fixtures).

**P2c — breaking-test inventory (from the fresh-context plan review; each classified
MIGRATED at implementation per lesson 2026-08-10):**
- `packages/auth/src/__tests__/well-known-providers.test.ts:42-46` — whole-registry
  "no entry defaults scopes" sweep → MIGRATED to "only ADR-0028 entries pin scopes"
  (exact-set assert for Spotify).
- `packages/auth/src/__tests__/registry-self-containment.test.ts:149-151` — per-entry
  emitter `scopes` undefined sweep → MIGRATED (Spotify carve-out asserts the pinned
  set); the OPTIONS sweep at `:292-298` STANDS (entry-level-only decision).
- `packages/auth/src/__tests__/connected-fetch-query-observer.test.ts:303,309,315,405`
  — exact-arity observer matchers → MIGRATED to the widened signature.
- `apps/playground/src/__tests__/authShapedFailureSurface.test.tsx:110,120` —
  exact-shape store asserts → MIGRATED (detail key).
- `apps/playground/src/__tests__/connectionWizard.test.tsx:465-470` — P3-AC4 positive
  case on unpinned "Tunecast" → MIGRATED onto a pinned provider.
- e2e `connection-wizard.spec.ts:174` ("Meridian", unpinned) survives;
  `desktopWizardSheet.test.tsx:147` survives; `static-kind-registry.test.ts:148-155`,
  `registry-substitution.test.ts:151-173`, `demoRequirementStarters`, `examples`
  manifest suites survive (manifest stays bare).

**P3 — dependents + verification (AC7)**
- `pnpm --filter auth test` → `--filter playground test` → `--filter desktop test` →
  root `turbo run test --force` from repo root (Cached: 0 — lessons 2026-08-13).
- `examples` suite only if any starter file is touched (expected: none, or README-only).

**P4 — docs (same branch, Gate 6 previews)**
- next-steps: prune/rewrite the Spotify manual-test line (points at this task), note the
  25→5 allowlist correction anywhere it appears; code-map rows for the wizard +
  registry lines; spec-changelog: NOT touched (no protocol change).
- Threat-model note: AC4's detail extract is host-rendered provider text — add one line
  to the desktop-auth threat delta's observer section (no new surface: same scrub, same
  C1 posture, bounded length, never linkified).

**Cross-package impact**: `auth` → `auth + playground + desktop` (dependency graph,
architecture.md). Protocol, runner, db, knowledge, adapters, server untouched.

**Step 0 after plan approval (High tier): fresh-context AI review of this plan** —
findings folded back before any test is written.

## Decisions & surprises

- 2026-08-15: Owner interview answers recorded in Spec. Scope set = read + playback
  control (widest of the three offered; consent screen will show device-control power —
  ADR-0028 records the tradeoff).
- 2026-08-15: Research (primary Spotify docs): redirect rules (https except loopback IP
  literal; `localhost` banned; enforcement Apr-2025/Nov-2025), dev-mode changes
  (Feb-2026: 5-user allowlist, owner Premium, 1 Client ID; existing-app endpoint changes
  postponed), `GET /v1/me/playlists` unaffected by the Feb-2026 endpoint removals.
  Sources pinned in ADR-0028.
- 2026-08-15: `scopes` kept OUT of `CREDENTIAL_PROMPT_SEATS` — see ADR-0028 note. The
  plan review constructed the strongest rule-5 attack (borrowed non-scope-pinned brand
  with authored maximal scopes) and confirmed it exists TODAY independent of this task;
  parked beside borrowed-endpoints for the next threat-model pass, acceptable at this
  tier because AC3b makes the widened ask visible in-wizard.
- 2026-08-15: **Scopes are ENTRY-level only** (plan review, finding 6): a flow choice
  never changes privilege breadth (ADR-0020's identity-seat rule extended); the options
  self-containment sweep stands unchanged.
- 2026-08-15: **Re-consent routes through the credential half** (finding 4): the connect
  step alone cannot mint (no stored-client_id fallback in `generateAuthUrl`); the user
  re-pastes the non-secret client ID once rather than bending the write-only custody
  posture or touching oauth-service.
- 2026-08-15: Fresh-context plan review (High tier) returned 2 blockers + 5 must-fix —
  ALL folded into AC1/AC3/AC3b/AC4/AC5 and P1/P2 above; verdict was "approve after
  amendments, no re-plan".

## Session journal (append-only, newest last)

### 2026-08-15 — claude (fable-5) — session
- Done: Gate 1–2. Four-agent recon (starter/registry, wizard UX, loopback transport,
  Spotify docs), owner interview (4 decisions), this plan. Branch created.
- State: awaiting owner plan approval; then the High-tier fresh-context plan review,
  then tests-first implementation.
- Next step: owner approves/amends plan → P0 ADR drafts → fresh-context plan review →
  P1 tests.
- Open questions: none blocking. (Implementation may discover the exact
  `reapproveFromDiff` routing needs a variant — plan already scopes it to "fresh
  authorize round trip", tests pin the outcome, not the routing.)

### 2026-08-15 (later) — claude (fable-5) — session (implementation)
- Done: owner approved the plan; ADR-0028/0029 drafted; High-tier fresh-context plan
  review returned 2 BLOCKERS + 5 must-fix (all folded — the two big ones: re-consent
  must invalidate the old tokens in the same act as promotion, and the review/diff
  screens rendered scopes NOWHERE, so "visible consent" was built, not assumed). Then
  red-first TDD end to end:
  - P1 auth: Spotify entry pins the 7-scope set + Feb-2026 walkthrough facts (5-user
    allowlist, owner Premium); emitter emits `scopes` ENTRY-level; `applyRegistryValues`
    replaces it on borrow hits (+ deep-copies `registration.instructions`, the review
    drive-by); `deliver` extracts a ≤160-char scrubbed provider reason and widens
    `onAuthShapedFailure(slot, status, detail?)`. Auth 747 (tsc-gated), substitution
    seat mutation-checked (4 red with the seat reverted, emitter tests green).
  - P2 wizard: ONE `requirementScopesDigest` drives drift detection, the
    silent-promotion guard, and `reapproveFromDiff` routing; scopes-changed promotion
    deletes access/refresh tokens + sets connection state `pending` (client_id kept);
    abandonment pinned (approve → close → nothing serves, reopen offers the walk).
    ReviewScreen `review-scopes` box + ReapprovalDiffScreen `reapproval-scope-diff`
    delta; stale protocol comment corrected. Banner renders "{provider} says: …"
    (plain-text pinned by hostile-copy test). Console links: byte-match via
    `resolveRegistryEntryByName`, any provenance; near-miss negative rides the
    legacy-mint harness (the imported-file channel where near-misses can exist —
    gated accessors can't mint one since substitution replaces registration); desktop
    anchor preempts to `openExternal` (system browser); copy-only hint reworded.
  - Verification: auth 747 · playground 1042 · desktop 105 · root
    `turbo run test --force` **21/21, Cached: 0**.
- Deviations from plan, journaled: (1) e2e journey 4 left unchanged — its "Meridian"
  brand is unpinned so its copy-only path still holds; the clickable variant is pinned
  at component AND desktop altitude (an e2e pinned-provider journey would aim a real
  authorize endpoint for no added DOM evidence). (2) The AC4 "2-arg when no detail"
  choice keeps empty-body observer behavior byte-identical (exact-arity matchers pin
  both shapes). (3) `oauth-service.ts` untouched, as re-planned (the token-leg claim
  was corrected at plan review).
- **High-tier self-sign-off (PROCESS.md):** C1 traced — the new detail channel reads
  only the gate-10-scrubbed delivered body, query-credential echo negative green in
  both raw and percent-encoded forms; no new fetch caller, no strictness knob, sandbox
  and CSP untouched; the three "no response bytes" doctrine comments rewritten in the
  same commit as the code they describe. Every migrated test classified in P2c;
  red-first evidenced for every new assertion.
- State: implementation complete on `fix/TASK-20260815-spotify-scopes-wizard-links`;
  docs (next-steps, code-map, threat-delta S7, ADR index) updated in-branch.
- Next step: Gate-5 AI diff review → owner review + PR → after merge, the owner manual
  test (wizard offers scope diff → approve → sign-in shows 7 scopes → playlists load).
- Open questions: none.
