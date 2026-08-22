# TASK-20260822-gmail-dual-mode: Gmail starter dual-mode — runtime-detected desktop/web connection wizard

- **Status**: planned (awaiting plan approval)
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

**Design — the general seat.** Model the web path as a `WellKnownAuthOption` on the gmail
entry, not an entry-level `webRedirectPosture`:
- Redirect capability is per-**client-type** (flow-shaped); options already carry
  per-flow `desktopRedirectPosture`, `fields`, `registration`, `endpoints` — the seat
  rides an existing vehicle. `browserCallable` stays entry-level (per-provider fact;
  `desktop-posture.test.ts:121` asserts options never carry it — unchanged).
- New option-level seat: `webRedirectPosture?: 'origin-callback'` (sole member today).
  Semantics: "this option's walkthrough registers the connecting web origin's
  `/oauth/callback` as an exact Authorized redirect URI; the wizard auto-selects it when
  the runtime lacks desktop OAuth capability." Absence keeps today's meaning (entry-level
  data serves web) — no regression for spotify/github/etc.
- Wizard resolution (`connectionWizard.ts` ~:2042-2181, :2260-2270): on web, if the
  entry has a `webRedirectPosture` option → bind its fields/registration/endpoints
  (auto-select, not a choice card); on desktop, filter web-posture options out of choice
  cards / `alternativeFlows`. Honors ADR-0021 §1 (registry data, resolved at
  render/connect time, nothing persisted into `ConnectionRequirement`).
- Lesson 2026-08-13 (a new seat rides EVERY surface the old one rides) — walked
  explicitly in implementation: schema/type (`WellKnownAuthOption`), registry lint tests,
  wizard admission/resolution, register-screen copy (`ConnectionWizardSheet.tsx:999-1003`
  redirect display; :1114 instructions), review screen, drift migration (option identity
  — verify staged-diff behavior when an entry gains an option), scrub (no new secret
  params — `client_secret` already in `SECRET_FORM_PARAMS`). Any surface skipped gets a
  written why-not here.

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
1. `docs/decisions/0049-web-surface-auth-options.md` — draft ADR (this gate).
2. `packages/auth/src/__tests__/` — new web-option tests (AC 1–5, 7, 8): registry shape,
   scope-pin invariance + mail.google.com negative, resolution table
   (gmail-web → option / gmail-desktop → entry / spotify-web → entry), exchange +
   encoded-spelling scrub. Update deliberately: `registry-pinned-scopes.test.ts:296`
   (walkthrough-contains-'desktop' becomes per-surface assertions);
   `desktop-posture.test.ts:165-167` stays green unchanged (entry posture untouched).
   Every new regression test checked against the pre-fix commit rule (lesson 2026-08-19):
   gmail-web cases must fail on `main` today.
3. `packages/auth/src/well-known-providers.ts` — `webRedirectPosture` seat on the option
   type; gmail: `browserCallable: true` (probed-host comment), `authOptions` web entry
   (fields + "Web application" walkthrough; caveats carried over).
4. `apps/playground/src/connections/connectionWizard.ts` — web binding via the existing
   `getPlatform().oauth === undefined` discriminator; desktop filtering. (First: re-read
   the module's own rationale comments — lesson 2026-08-19 propose-into-doctrine;
   `ConnectionWizardSheet.tsx:1842` "WHY NOT NEW STEPS" — no new wizard steps, bind data
   into existing screens.)
5. `apps/playground/src/views/HubView.tsx:56-62` — drop `desktopOnly` from gmail row,
   rewrite comment; update `hubDesktopStarter.test.tsx`, `starterTileName.test.tsx`.
6. `apps/playground/e2e/starters-connect.spec.ts:220,291` — gmail rows: connect CTA opens
   wizard on web.
7. Docs in-branch: `architecture.md:126-127` (web seat sentence), `code-map.md:52`
   (registry-seats row), `examples/gmail/authoring/docs/plan.md:32-33` (desktopOnly
   staleness), ADR-0021/0039 status lines. next-steps.md:9 pruned at Gate 6.

**Cross-package impact / verification:** auth → playground/desktop/server dependents;
rebuild producer before dependent runs (lesson 2026-08-15) — verify via root `pnpm test`
(turbo graph), not bare vitest in the app. CI is billing-blocked → merge on local
evidence, journal the runs.

**High-tier extras before implementation:** fresh-context AI review of this plan (as run
2026-08-19 for the gmail starter), then owner approval → Gate 3.

## Decisions & surprises

## Session journal (append-only, newest last)

### 2026-08-22 — Claude (with Jeetu) — session
- Done: task file created from next-steps 2026-08-21 entry; Gate 1 interview (owner: path (a) BYO Web client + secret; general option seat, gmail first; two registrations per surface); Gate 2 code sweep (web OAuth lane already exists — registry-data task), lessons/ADR read; plan written; ADR-0049 drafted; branch `feat/TASK-20260822-gmail-dual-mode` created.
- State: Gates 1–2 complete; STOPPED for plan approval.
- Next step: fresh-context AI plan review (High tier) + owner approval → Gate 3 tests-first.
- Open questions: none blocking; seat name (`webRedirectPosture: 'origin-callback'`) open to review challenge.
