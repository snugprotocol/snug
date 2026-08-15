# TASK-20260815-spotify-scopes-wizard-links: Spotify starter 403 repair (registry scopes), provider-error detail on the auth banner, registry-pinned console links

- **Status**: planned
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
   scope set; `requirementFromRegistryEntry` emits `scopes` (option-over-entry flow rule);
   a Spotify wizard flow's authorize URL carries `scope=` with exactly that set
   (space-joined, order preserved). Token/refresh legs already send `spec.scopes` —
   pinned by an integration-shaped test composing the real registry entry through the
   real `generateAuthUrl`.
2. **AC2 — substitution owns scopes.** `applyRegistryValues` REPLACES declared scopes
   with the entry's pinned ones on every borrow hit (a borrowed brand can never widen or
   narrow a scope-pinned entry); entries without pinned scopes preserve today's behavior
   byte-for-byte. Starter manifests stay bare (no manifest change needed).
3. **AC3 — scope drift forces a fresh sign-in.** Wizard-open drift migration on an
   approved, scope-less Spotify row STAGES a diff showing the added scopes; approving it
   routes through a fresh authorization round trip (re-consent), and the silent
   `repersisted` promotion is structurally unreachable for a scope change even when the
   host ceiling is identical. (The stored access/refresh token was minted scope-less;
   providers do not widen on refresh.) Negative: request/testRequest-only seat drift
   still promotes silently as today.
4. **AC4 — banner shows the provider's reason.** The connected-fetch `deliver` seat
   extracts a short detail from the failing response body (JSON `error.message` shape
   first, text head fallback; hard cap ~160 chars; passed through the slot's existing
   scrub), extends `onAuthShapedFailure(slot, status, detail?)` backward-compatibly, and
   `AuthRepairBanner` renders "{provider} says: {detail}" when present, current copy
   when absent. Negative (C1): a query-credential provider's failing URL/value never
   appears in the detail (scrub asserted through the real scrub path).
5. **AC5 — registry-pinned console links.** `RegisterScreen` renders a clickable console
   link iff the row's `registration.consoleUrl` byte-matches the resolved registry
   entry's (or matched option's) pinned `consoleUrl` — regardless of provenance. A
   one-char-off URL under a registry brand stays copy-only (anti-phishing negative
   test). Unmatched/user-authored providers keep the copy-address flow with its existing
   copy. On desktop the link opens via the system browser (https-only opener), never
   webview navigation.
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
1. Tests: Spotify entry pins the exact 7-scope set · emitter emits `scopes` under the
   option-over-entry rule (an option WITHOUT scopes emits none — same rationale as
   request seats) · composed real-entry → `generateAuthUrl` URL carries the exact
   `scope=` param · `applyRegistryValues` replaces authored scopes on borrow hit /
   leaves non-scope-pinned entries byte-identical (structural sweep across the registry)
   · deliver-seat detail extraction: Spotify JSON error shape, text fallback, 160-char
   cap, absent on empty/unparseable, **scrub negative with a query-credential fixture**,
   3-arg observer backward compatibility.
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
1. Drift tests (AC3): scope-gain on approved row → `staged`, never `repersisted`;
   approving the staged diff routes into a fresh authorize round trip (assert via the
   step machine + a flow-start spy); seat-only drift still promotes silently (negative);
   diff screen renders the scope delta (review renders `scopes` already — pin it).
2. Drift implementation: extend `migrateConnectionRegistryDrift`'s promotion guard with
   `scopesChanged` (structural compare of `row.requirement.scopes` vs substituted) and
   extend `reapproveFromDiff` routing so a scopes-changed approval lands in the connect
   step (fresh sign-in) rather than silent re-approve. One rule, both halves driven from
   the same comparison (lesson 2026-08-12: refuse/rewrite from one resolution).
3. Banner (AC4): `net.ts` store carries `detail?`; `AuthRepairBanner` renders the
   provider-says line when present; tests for both shapes.
4. Link rule (AC5): replace `consoleUrlIsClickable(row)` with a resolver that
   `resolveRegistryEntryByName(row.requirement.provider.name)` → byte-match
   `registration.consoleUrl` against entry AND `authOptions` (matched-option handle
   where applicable); rewrite the P3-AC4 describe block: starter provenance +
   byte-match → anchor; near-miss URL → copy-only; unmatched provider → copy-only;
   hostile-instructions test untouched. Desktop: anchor becomes an
   `openExternal`-backed control when `getPlatform().oauth !== undefined`
   (https-only guard already lives in the opener); test in `desktopWizardSheet.test.tsx`.
5. e2e: extend `e2e/connection-wizard.spec.ts` journey 4's register screen assertion to
   cover the clickable-console-link variant (stub provider registered in the test
   registry — follow the existing journey fixtures).

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
- 2026-08-15: `scopes` kept OUT of `CREDENTIAL_PROMPT_SEATS` — see ADR-0028 note.

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
