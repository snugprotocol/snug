# TASK-20260822-gmail-dual-mode: Gmail starter dual-mode — runtime-detected desktop/web connection wizard

- **Status**: in-review (plan approved by owner 2026-08-22 — "plan approved, go thru all phases"; implementation complete; Gate 5 AI review in progress)
- **Owner**: Jeetu
- **Risk tier**: high (touches `packages/auth` registry — auto-escalate per PROCESS.md; High extras: negative tests + fresh-context AI plan review before implementation + journal self-sign-off)
- **Branch**: `feat/TASK-20260822-gmail-dual-mode`
- **Packages touched**: `packages/auth` (High), `apps/playground` (Medium); docs. `packages/protocol` and `packages/runner` deliberately untouched.
- **Spec impact**: none (ADR-0021 §1: redirect posture is reviewed registry data, never a requirement seat — a design that needs a protocol change is the wrong design)
- **Related**: next-steps 2026-08-21 Gmail dual-mode entry (research verdict recorded there); ADR-0039 (web deferred at v1 — this task is that pickup); ADR-0021 (posture doctrine, §7 secret custody); ADR-0028 (pin machinery); next-steps item (7) wizard-incomplete google/googledrive/slack; TASK-20260819-gmail-starter; new ADR-0049 (drafted this task)

## Spec (what & why)

The Gmail (Inbox Copilot) starter shipped desktop-only at v1 (ADR-0039 §5) because a
Desktop-app OAuth client registers only loopback redirects. Research (2026-08-21, live
probes) established the Gmail REST API is fully CORS-open from any web origin; the only
blocker is the OAuth code exchange, where Google requires `client_secret` even with PKCE
for "Web application" clients. This task adds web-playground support: the runtime detects
whether it is running in the desktop app or a web browser and the connection wizard
activates the matching flow and registration instructions automatically.

**Interview outcomes (2026-08-22, owner):** web path = **(a)** BYO Google "Web
application" client, client_id + client_secret into host credential custody (refresh
tokens work; C1-consistent). Posture mechanism = **general seat, gmail first** (designed
so googledrive/slack can adopt it when item (7) is picked up). Dual-surface users
register **two OAuth clients** (one per client type) — no shared-registration attempt.

**Acceptance criteria** (each becomes at least one test):
1. Runtime detection is automatic: on web (`getPlatform().oauth === undefined` — the wizard's existing discriminator) the wizard binds the gmail entry's web auth option (fields, registration walkthrough, redirect URI); on desktop it binds the entry-level Desktop-app data exactly as today. No manual toggle.
2. The gmail registry entry declares a web auth option: `client_id` + `client_secret` (password field, web-specific copy), a "Web application" console walkthrough that instructs pasting the wizard-displayed exact redirect URI (`{origin}/oauth/callback`), and carries the same provider caveats (unverified-app warning, 7-day Testing-status refresh expiry with publish-to-Production path).
3. The web option mints exactly the ADR-0039 pinned scope set (`gmail.modify`, `gmail.settings.basic`, `gmail.send`); negative test: `https://mail.google.com/` is never pinned via any option.
4. `browserCallable: true` lands on the gmail entry with a VERIFIED comment naming the exact probed host (`gmail.googleapis.com`, 2026-08-21 probes — lesson 2026-08-18: pin the host you probed).
5. Desktop flow is regression-pinned: entry `desktopRedirectPosture` stays `'loopback'`; on a desktop platform fixture the wizard still renders the Desktop-app walkthrough; web-surface options never appear as desktop choice cards.
6. `desktopOnly` is dropped from the gmail row in `STARTER_LOOKS` (`HubView.tsx:56-62`) and the rationale comment rewritten; tile renders unlocked on web (`hubDesktopStarter.test.tsx`, `starterTileName.test.tsx`, `starters-connect.spec.ts` gmail rows updated deliberately, not weakened).
7. C1 negative tests on the web path: the exchange sends `client_secret` only in the form body to the ceiling-gated token endpoint; error-body echo scrub is exercised with a secret whose spelling changes under `encodeURIComponent` (chars like `+/=` — lesson 2026-08-21: the fixture must be able to express the leak).
8. Providers with no web option are unaffected: spotify (et al.) on web still binds entry-level data (regression pin).

**Out of scope**: Trade Copilot / hue / whatsapp stay desktop-only (transport reasons
unchanged); completing google / googledrive / slack entries (next-steps item (7) — the
seat is general but only gmail is populated); any `packages/protocol` schema change; any
change to the desktop loopback transport; token-model path (b) (rejected in interview).

## Plan

**Core finding (code sweep 2026-08-22):** the web OAuth lane already exists end-to-end —
playground route `/oauth/callback` (`App.tsx:204` → `OAuthCallbackPage.tsx`,
BroadcastChannel + initiator-side `expectedFlowId` binding), web redirect URI derivation
(`connectionWizard.ts:2260-2270` → `${origin}/oauth/callback`), and a secret-bearing code
exchange (`oauth-service.ts` `handleCallback` :443-470 conditionally appends
`client_secret` :455; `postForm` ceiling-gates the endpoint; `SECRET_FORM_PARAMS` scrubs
logs). Gmail-on-web is blocked only by registry DATA: the entry vouches solely for the
Desktop-app client type whose walkthrough registers a client that cannot accept the web
origin, and `desktopOnly` in `STARTER_LOOKS` is the honest UI consequence. So this is a
registry-seat + wizard-binding + copy task — **no new transport, no oauth-service change
expected** (that "no change needed" is a claim to trace, lesson 2026-08-12: verify the
web option's `redirectUri` re-derivation at :448 resolves byte-identically on both legs).

**Design v2 (post fresh-context review — v1's option vehicle rejected on four blockers,
see Decisions & surprises).** Entry-level, render-time surface data:
- Two new ENTRY-level seats on `WellKnownOauthProvider`:
  `webRedirectPosture?: 'origin-callback'` — "the provider's client registration can
  accept the connecting web origin's `/oauth/callback` as an exact Authorized redirect
  URI" — and `webRegistration?: { consoleUrl?, instructions? }` — the web-surface
  walkthrough. Structural rule (registry test): `webRegistration` requires
  `webRedirectPosture`, and both require an oauth kind. NO `authOptions` entry, NO
  `optionLabel` — gmail stays single-option, so the choice card, `matchedRegistryOption`,
  `alternativeFlows`, drift restage, and `registry-self-containment`'s exact-set pin are
  all untouched by construction.
- The seats are read ONLY at wizard render time when `getPlatform().oauth === undefined`
  (the wizard's existing web discriminator, same predicate as the redirect display —
  binding and displayed URI cannot disagree). They are NEVER emitted into
  `ConnectionRequirement` (negative test on `requirementFromRegistryEntry`) — the same
  render-time registry-data class posture already occupies under ADR-0021 §1, so no
  protocol change and no drift: admission re-substitution stays byte-identical, the
  drift gate answers 'none' for every approved gmail row.
- New helper in `connectionWizard.ts` (state module): `webSurfaceRegistrationFor(
  requirement)` → the entry's `webRegistration` iff platform lacks oauth AND the entry
  declares `webRedirectPosture` AND `requirement.kind === entry.kind` (default flow
  only — an option-bound requirement of a different kind never gets the override) AND
  kind is `oauth2_auth_code`; else `undefined` (the row's own persisted registration
  renders, exactly today's behavior — spotify et al. unchanged). The sheet's register
  screen consults it where it renders `registration` (read the "what is rendered is the
  row" doctrine comment ~:1940 first and document why a registry-sourced walkthrough
  override preserves the anti-phishing property: registry and user entry remain the only
  sources, per AL-04 D5).
- `browserCallable: true` on gmail (entry-level, probed-host comment naming
  `gmail.googleapis.com`, 2026-08-21).
- Entry `fields` DELIBERATELY untouched: the identical `client_id`/`client_secret` pair
  serves both surfaces, and `fieldsMatchPinnedList` compares descriptions — a copy edit
  stages a full re-credential walk for approved rows (review finding 7 tripwire).
- Credential clobbering across surfaces is accepted + disclosed (finding 6; Decisions
  above): one storage cell per app+slot; web walkthrough carries a one-line disclosure;
  abandoned-start state pinned by test in `packages/auth`.
- Lesson 2026-08-13 seat walk for the two new seats: registry type + structural tests
  (ride), emitter (explicit non-ride, negative test), wizard register screen (ride),
  review screen (non-ride — review renders the approved row; why-not: the walkthrough is
  registration guidance, not approved credential semantics, and review must show what
  was approved), drift/admission (non-ride by construction, pinned by the
  byte-identical-substitution test), scrub (no new secret params), chat choice card
  (non-ride — no options added).

**ADR-0049 (drafted before implementation):** "Web-surface auth options and genuine web
client secrets". Two decisions: (1) the option-level `webRedirectPosture` seat +
runtime-driven binding; (2) custody of a **genuine** secret — ADR-0021 §7 says desktop
holds no client secrets for the user, and gmail's existing desktop secret rode Google's
"installed-app secret is not a secret" position; a Web-application client secret IS
secret, so the custody argument is re-made (user's own portable DB, C1 boundary, scrub +
ceiling gates, BYOK — the user holds their own secret), not inherited. Amends ADR-0021 §7
and picks up ADR-0039's deferred alternative — both old ADRs get status-line updates in
the same change (ADR-0027).

**Files to touch, in order (tests FIRST per TDD.md):**
1. `docs/decisions/0049-web-surface-auth-options.md` — rewritten to design v2 (this
   gate); option vehicle recorded as rejected alternative with the four blockers.
2. `packages/auth/src/__tests__/` — NEW: registry web-seat shape (gmail declares
   `webRedirectPosture: 'origin-callback'` + `webRegistration` naming "Web application",
   the redirect-URI paste step, unverified-app warning, 7-day Testing expiry,
   clobbering disclosure; structural rule webRegistration ⇒ webRedirectPosture ⇒ oauth
   kind); emitter negative (web seats never in the requirement);
   abandoned-start clobbering pin; web exchange C1 scrub (URLSearchParams-serialized
   secret, asserted on the surfaced `lastError`/NET_AUTH_FAILED prose). UPDATE:
   `desktop-posture.test.ts` `BROWSER_CALLABLE` table + :246-252 absent-pin gains gmail.
   UNTOUCHED (pinned green): `registry-pinned-scopes.test.ts` (entry walkthrough +
   mail.google.com negative), `registry-self-containment.test.ts:248-253`,
   `desktop-posture.test.ts:165-167`. Pre-fix-commit rule: every new behavioral test
   red on `main` today.
3. `packages/auth/src/well-known-providers.ts` — two entry-level seats on the type
   (doc comments carry the ADR-0021 §1 render-time rule); gmail:
   `browserCallable: true` + `webRedirectPosture` + `webRegistration` (VERIFIED
   comments name probed hosts/dates).
4. `apps/playground/src/state/connectionWizard.ts` — `webSurfaceRegistrationFor`
   helper + tests (table: gmail-web → webRegistration; gmail-desktop → undefined;
   spotify-web → undefined; option-kind requirement → undefined).
5. `apps/playground/src/connections/ConnectionWizardSheet.tsx` — register screen
   consults the helper for walkthrough copy (read ~:1940 doctrine comment first);
   render test: web shows "Web application" + `${origin}/oauth/callback`, desktop
   fixture shows Desktop-app copy.
6. `apps/playground/src/views/HubView.tsx:57-62` — drop `desktopOnly` from gmail row,
   rewrite comment; NEW tile-unlocked-on-web test (hubDesktopStarter suite).
7. `apps/playground/e2e/starters-connect.spec.ts` — NEW gmail row: connect CTA opens
   the wizard on web (respecting the suite's env gates).
8. Docs in-branch: `architecture.md:126-127` (web seats sentence), `code-map.md:52`
   (registry-seats row), `examples/gmail/authoring/docs/plan.md:30-34` (desktopOnly
   staleness), ADR-0021/0039 status lines. next-steps.md:9 pruned at Gate 6.

**Cross-package impact / verification:** auth → playground/desktop/server dependents;
rebuild producer before dependent runs (lesson 2026-08-15) — verify via root `pnpm test`
(turbo graph), not bare vitest in the app. CI is billing-blocked → merge on local
evidence, journal the runs.

**High-tier extras before implementation:** fresh-context AI review of this plan (as run
2026-08-19 for the gmail starter), then owner approval → Gate 3.

## Decisions & surprises

- **2026-08-22 — Plan v1 (option-vehicle) rejected by the fresh-context review; design v2
  adopted (entry-level render-time surface data).** Four blockers, all downstream of one
  fact the machinery's own comments state: options are discriminated **by kind**
  (`connectionWizard.ts:2097-2103`), and a gmail web option would be the first
  *same-kind* option — (1) invisible to `matchedRegistryOption`, so a web-bound row on
  desktop resolves as the loopback flow and fails MID-FLOW with `redirect_uri_mismatch`
  (the exact failure ADR-0021 §1 exists to prevent); (2) `resolveDesktopPosture`'s
  `?? entry` fallback makes the web option inherit `'loopback'` — "no desktop transport"
  is unrepresentable on an option whose entry has a posture, and
  `desktop-posture.test.ts:62-82` would bless it green; (3) fields/registration are
  PERSISTED requirement seats — auto-select-without-persisting contradicts the sheet's
  render-the-row doctrine, and a byte-identical-fields web option can never survive
  `matchAuthOption` (entry matches first); (4) any `authOptions` seeds the chat
  AuthChoiceCard on every surface with no surface filter, persisting wrong-surface
  choices durably on the `user` channel. **v2:** entry-level
  `webRedirectPosture: 'origin-callback'` + `webRegistration` walkthrough, read ONLY at
  wizard render time when `getPlatform().oauth === undefined` (the same render-time
  registry-data class posture already occupies under ADR-0021 §1); fields untouched —
  identical `client_id`/`client_secret` pair serves both surfaces, and an entry-field
  copy edit would make every approved row's field list match no pinned option and stage
  a full re-credential walk (`fieldsMatchPinnedList` compares descriptions;
  `requirement-admission.ts:328-342`) — left alone deliberately, journaled here.
  Interview decisions all preserved (path (a); the seat is still general — any entry
  adopts it by declaring the two web seats; two registrations per surface).
- **2026-08-22 — Dual-surface credential clobbering is the accepted model (review
  finding 6):** `generateAuthUrl` persists pasted creds under one `(appId, slot)` cell
  at flow start; connecting on surface B overwrites surface A's client creds, and an
  ABANDONED start on B leaves A's refresh_token paired with B's client creds (refresh
  then fails while the row looks connected). Accepted for a roaming `.snug` file — two
  registrations, one active client pair; disclosed in the web walkthrough; the
  abandoned-start state pinned by test. ADR-0049 §4 records it.
- **2026-08-22 — Review corrections to the v1 test list:** `hubDesktopStarter.test.tsx:69`
  pins the HUE tile, `starterTileName.test.tsx` has no gmail row, and
  `starters-connect.spec.ts` has NO gmail rows (v1's :220/:291 were hue/trade-copilot) —
  AC6 needs NEW tests, with the pre-fix-commit rule applied to them.
  `registry-self-containment.test.ts:248-253` pins "exactly coinbase and github carry
  authOptions" — stays green under v2 (no gmail option).
  `desktop-posture.test.ts:246-252` ("every other entry leaves browserCallable ABSENT")
  and the `BROWSER_CALLABLE` table (:212-236) must gain the gmail row.
  `registry-pinned-scopes.test.ts:292-299` (entry walkthrough mentions 'desktop') stays
  green untouched — entry copy unchanged under v2. Scrub-test fixture must use the
  scrub's own serializer (URLSearchParams, not `encodeURIComponent` — they disagree on
  space) and assert on the SURFACED string (`lastError` / NET_AUTH_FAILED prose).
  Wizard module path is `apps/playground/src/state/connectionWizard.ts` (v1 said
  `src/connections/`).

## Session journal (append-only, newest last)

### 2026-08-22 — Claude (with Jeetu) — session
- Done: task file created from next-steps 2026-08-21 entry; Gate 1 interview (owner: path (a) BYO Web client + secret; general option seat, gmail first; two registrations per surface); Gate 2 code sweep (web OAuth lane already exists — registry-data task), lessons/ADR read; plan written; ADR-0049 drafted; branch `feat/TASK-20260822-gmail-dual-mode` created.
- State: Gates 1–2 complete; STOPPED for plan approval.
- Next step: fresh-context AI plan review (High tier) + owner approval → Gate 3 tests-first.
- Open questions: none blocking; seat name (`webRedirectPosture: 'origin-callback'`) open to review challenge.

### 2026-08-22 (later) — Claude — session (plan approved; Gates 2–5)
- Done: **Plan review** (fresh-context, High tier): v1 option-vehicle REJECTED on four
  blockers → design v2 (entry-level render-time seats), ADR-0049 rewritten, findings in
  Decisions above. **Gate 3**: auth `web-surface-seats.test.ts` (registry shape,
  structural rules, emitter negative, dual-surface custody pin, web-exchange C1 scrub
  with URLSearchParams-spelling fixture) + `BROWSER_CALLABLE` gmail row — 6 red on
  `main`; playground `webSurfaceWizard.test.tsx` (helper table + register-screen
  branching) + gmail dual-mode tile tests — 7 red on `main`, desktop pins green
  pre-change (honest pins). Pin-green negatives (defense pre-existing, journaled):
  exchange scrub, custody overwrite. **Gate 4**: gmail entry gains `browserCallable:
  true` (probed host named), `webRedirectPosture: 'origin-callback'`,
  `webRegistration` (8-step "Web application" walkthrough incl. both provider traps +
  the §4 custody disclosure); `webSurfaceRegistrationFor` helper in
  `connectionWizard.ts`; `RegisterScreen` override (consoleUrl clickable BY
  CONSTRUCTION — registry-sourced, ADR-0029 rationale in-code); `STARTER_LOOKS` gmail
  row unlocked; e2e gmail journey added to `starters-connect.spec.ts`. **Gate 5
  verification:** root `pnpm test` **25/25 tasks green** (turbo graph — auth 939,
  playground 1480/150 files, desktop 175, all dependents rebuilt). Two load-shaped
  flakes observed on the way (desktop `app-shell` 5s timeout; playground `sidecarLive`
  backoff timing) — both green in isolation AND in their full package suites; same
  signature as the known file-parallelism flake (open-threads memory).
- e2e leg: `SNUG_E2E_HAS_APP=1` run BLOCKED locally — port 8787 held by the owner's own
  dev server (`node --env-file=.env.local dist/server.js`, left running; not killed).
  The spec is committed and collects under `chromium`; owner to run
  `SNUG_E2E_HAS_APP=1 npx playwright test e2e/starters-connect.spec.ts` when the port
  is free. The same branch behavior is covered by the component suites
  (`webSurfaceWizard`, `hubDesktopStarter`).
- State: implementation complete; Gate 5 AI review running (/code-review high).
- Next step: review findings → fixes if real → self-sign-off → push branch → PR →
  owner closes/merges (explicit ask this session).

### 2026-08-22 (Gate 5 review) — Claude — review + fixes
- Seven review lanes ran (/code-review high). Every confirmed finding fixed in-branch;
  root `pnpm test` 25/25 green after (auth 939, playground 1482 incl. tsc, examples,
  website-sync gate).
- **Security-grade (fixed):** the web walkthrough override originally keyed on
  provider NAME alone — an imported R-4 row named "Gmail" with attacker endpoints
  would have been dressed in Snug's pinned Google walkthrough around a flow sending
  the pasted client_secret to the row's endpoints. Fix: the override now BINDS TO THE
  ROW'S ENDPOINTS (byte-match against the entry's pinned authorize+token URLs);
  mismatches keep the old copy-only honesty rules. Pinned by the attacker-endpoints
  negative in `webSurfaceWizard.test.tsx`.
- **Correctness (fixed):** (1) ReviewScreen's "how you get them" still rendered the
  desktop walkthrough on web — adjacent screens instructed two client types; both
  screens now take the override (guidance ≠ approved semantics; fields/scopes/hosts
  stay the row's). (2) Exact-key `lookupWellKnownProvider` missed brand-adjacent rows
  (the hue lesson) → `resolveRegistryEntryByName`, pinned by a "Gmail Premium" case.
  (3) `hasRegistrationWalkthrough`/`nextStep` now consult the effective registration,
  so a future web-only adopter cannot have the register screen skipped. (4) The e2e
  journey clicked a `run-connect` testid nothing renders, on a route that persists no
  row — rewritten as the REAL journey (tile → `starter-install` → installed copy →
  `manage-connections` → review+register both asserting web copy). (5) Tile-unlock ↔
  registry-seat tripwire test added (the two were keyed on different data).
- **Mechanism discipline (fixed):** clickable verdict routed through the ONE ADR-0029
  byte-match (`consoleUrlIsClickable` taught the displayed URL) instead of a
  clickable-by-construction bypass; single [row]-keyed memo (no dead registry walk).
- **Dedup/quality (fixed):** shared Google project/trap steps hoisted
  (`GMAIL_PROJECT_STEPS`/`GMAIL_TRAP_STEPS` — walkthroughs compose, byte-identical);
  shared wizard-sheet test harness extracted (`wizardSheetHarness.tsx`, tuned-settle
  rationale carried; older copies migrate opportunistically); `starterTile(name)`
  helper; test casts dropped (typed `ConnectionRequirement`, tsc-checked).
- **Docs (fixed):** examples/gmail starter.json v3 changelog entry + v1 line
  clarified, README connect section rewritten for dual-mode, authoring next-tasks
  web item pruned; ADR-0049 context now carries the probe record itself (the
  next-steps citation dangled once the entry was pruned); ADR-0049 consequences
  corrected (review screen rides; endpoint binding; web-refusal semantics deferral
  recorded, next-steps item (7) augmented).
- Deferred deliberately: web refusal semantics for entries whose client type cannot
  register a web origin (google/googledrive) — pre-existing dead-ends, rides
  next-steps item (7); rationale in ADR-0049 consequences.
- Task status → in-review; branch ready for PR.
- **High-tier self-sign-off (C1/C2 walk):** the web `client_secret` lives ONLY in the
  user's own credential store; it rides only the token-endpoint form body behind the
  frozen-ceiling gate (`postForm`), is scrubbed from thrown messages AND persisted
  `lastError` in both raw and wire spellings (pinned with a spelling-changing fixture),
  never appears in the authorize URL (pinned), never enters a `ConnectionRequirement`,
  the iframe, or the LLM. No sandbox/CSP surface touched; `packages/protocol` and
  `packages/runner` untouched (spec impact: none). Negative tests: emitter non-emission
  (non-vacuous), option-level web seats structurally banned, mail.google.com never
  pinned (pre-existing suite, still green).
