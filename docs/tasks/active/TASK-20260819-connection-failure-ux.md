# TASK-20260819-connection-failure-ux: honest Spotify scopes, wizard-owned failure disclosure, readable Ledger playbook

- **Status**: planned
- **Owner**: Jeetu
- **Risk tier**: **high** (touches `packages/auth` credential broker + registry scopes; ADR-0028 re-consent path)
- **Branch**: `fix/TASK-20260819-connection-failure-ux`
- **Packages touched**: `packages/auth`, `apps/playground`, `examples/spotify`, `examples/ledger`
- **Spec impact**: none — no `packages/protocol` schema change (see Plan §0). ADR-0028 amended (not superseded).
- **Related**: [ADR-0028](../../decisions/0028-registry-pinned-scopes.md) (registry-pinned scopes), [ADR-0022](../../decisions/0022-registry-request-seats.md) §4 (auth-shaped failure observer), ADR-0025/0038 (wizard screen precedents)

## Spec (what & why)

Three owner-reported defects, all on the same seam — what the user is told when a
connection is (or merely looks) unhealthy.

**1 — Rewind cries wolf on every launch.** After a *successful* Spotify connect, every
launch raises the red auth-repair banner: "Spotify isn't accepting this app's key …
*Insufficient client scope*". Dismissing it leaves a fully working app. Root cause is
not a bug in the banner: Rewind makes exactly one `GET /v1/me/player/recently-played`
per session ([app.html:1372](../../../examples/spotify/app.html)), the registry's pinned
scope set deliberately omits `user-read-recently-played`
([well-known-providers.ts:508](../../../packages/auth/src/well-known-providers.ts)), so
Spotify answers 403 — and the host-side observer at
[connected-fetch.ts:1318](../../../packages/auth/src/connected-fetch.ts) fires for every
delivered credentialed 401/403 without knowing this one was expected. The app already
degrades honestly; the *host* is the thing that misreports.

Owner decision: **pin the missing scope** rather than teach the host to expect refusals.
This is the honest fix here because Rewind already carries a complete, built-and-unused
"scope granted" lane (`recentMetrics`, the `recent-chips` row, the discovery caption's
two branches) — the scope makes shipped functionality reachable instead of merely
silencing an alarm. Consequence, accepted: per ADR-0028 §3 a scope change on an approved
row invalidates the stored tokens and routes the user through re-consent. Existing
Spotify connections will show the re-approval diff once and re-sign-in.

**2 — The failure surface itself is not Apple-grade.** The maroon full-bleed
`connection-note.is-error` block sits inside the running app
([AuthRepairBanner.tsx](../../../apps/playground/src/run/AuthRepairBanner.tsx)),
shoving the app's own UI down and offering two bare buttons. Move the diagnosis and its
actions **into the connection wizard as Step 0** ("attention"), and leave on the app
surface only a quiet, non-displacing status chip in the run header next to the existing
`⚯` connections door — tapping it opens the wizard at Step 0.

**3 — Ledger's "help me cancel" output is unreadable.** The generated playbook is
genuinely good content rendered into a broken box: `.planbox` is emitted as a *third
flex child* of `.leak` ([app.html:1192](../../../examples/ledger/app.html)) alongside
`.emoji` and `.body`, so on a narrow app frame the merchant column collapses to ~40px
and the step text overprints it (see owner screenshot). Restructure the row so the
playbook is a full-width disclosure panel *beneath* the row, and make it a showcase
moment — this is a headline value-add of the app.

**Acceptance criteria** (each becomes at least one test):

1. `spotify` registry entry pins `user-read-recently-played`, positioned in
   consent-screen order, and the pinned-scope test asserts the full expected 8-set.
2. A Spotify row seeded with the **hardcoded OLD 7-element set** stages a re-approval
   whose `pendingRequirement.scopes` contains `user-read-recently-played`. Deliberately
   NOT registry-derived and NOT scope-less: the existing scope-less coverage in
   `registryDriftMigration.test.tsx:731` would pass unchanged if this task's scope were
   never added, so only an old-set fixture pins THIS change (plan-review BLOCKER-2).
3. Rewind's recently-played lane still degrades to the labeled `unavailable` caption on
   a 403 — the app must never assume the scope was granted (old rows, declined consent,
   non-registry provenance).
4. **`attention` is a DERIVED GATE, not a step**: `ConnectionWizardStep` is UNCHANGED,
   and a source-level test pins that the union gained no member (the sheet's own
   "WHY NOT NEW STEPS" doctrine, `ConnectionWizardSheet.tsx:1842`).
5. **The diff outranks the attention screen** (owner decision A): when
   `needsReapproval(row)` is true, the re-approval diff renders and attention is
   SUPPRESSED — the diff is the cure, and showing the diagnosis first would hand the
   user an unexplained consent delta one tap later.
6. Step 0 renders the provider name, the status code, and the scrubbed provider `detail`
   verbatim as TEXT (never markup, never a link — the hostile-copy rule carries over),
   plus a primary continue and a dismiss.
7. **The failure is HANDED OFF, never cleared into nothing** (owner decision B): opening
   from the chip COPIES the failure into the wizard session, then clears the store. Step 0
   reads the session copy, so it can never render blank.
8. `AuthRepairBanner`'s maroon block no longer renders in `RunView`; a quiet chip renders
   in the run header when a failure is live for that app, and clicking it opens the wizard
   for the exact failing `(appId, slot)` — never a re-derivation.
9. The v3 dismissal lesson holds at the new call site: the chip hands off ONLY when
   `openConnectionWizard` returns a real `true`, never on a refusal (a refused open must
   leave the chip standing, or the user loses their route back).
10. No double-render: the chip hides itself while the wizard is open on that app.
11. Dismissing from Step 0 closes the wizard and leaves no failure stranded.
12. **The collision case** — a live failure AND a staged diff simultaneously, which this
    task creates for every existing Spotify user — has its own test asserting AC5's
    precedence. Highest-value test in the suite (plan-review MAJOR-6).
13. Ledger: `.planbox` is NOT a flex sibling of `.body`; it renders as a full-width block
    beneath the leak row.
14. Ledger playbook presents numbered steps with per-step separation, the email draft in
    a distinct block, and the panel's own CTA in an action bar inside the panel.

**Out of scope**: any `packages/protocol` schema change; an app-declared "expected
refusal" seat on the net request (considered and rejected for this task — revisit if a
second provider needs it); persisting the standing-approval grant; changing the
`onAuthShapedFailure` observer's firing rule in `packages/auth`; the cross-app Settings
connections list; touching `.error-note` or the LAN/linked-device wall screens.

## Plan

### §0 — Why this is High tier but NOT a spec change

`packages/auth` is a High-tier area (credential broker) and the registry scope list is
part of what a user consents to, so the tier auto-escalates and this plan needs a
fresh-context AI review before implementation (PROCESS.md risk table). No
`packages/protocol` schema moves: `scopes` is an existing seat on
`connection-requirement.ts`, and `ConnectionWizardStep` is a playground-local union.
No [SPEC_SYNC](../../engineering/SPEC_SYNC.md) step, no spec-changelog entry.

### §1 — Tests first (Gate 3, [TDD.md](../../engineering/TDD.md))

Written and failing before any implementation, in this order:

| # | AC | File |
|---|----|------|
| 1 | 1 | `packages/auth/src/__tests__/registry-pinned-scopes.test.ts` — extend `SPOTIFY_SCOPES` to the 8-set |
| 2 | 2 | `apps/playground/src/__tests__/registryDriftMigration.test.tsx` — NEW old-7-set fixture (beside the existing scope-less one, not replacing it) |
| 3 | 4,5,12 | `apps/playground/src/__tests__/connectionWizard.test.tsx` — derived gate, diff-outranks-attention, and the collision case |
| 4 | 6,7,11 | `apps/playground/src/__tests__/authShapedFailureSurface.test.tsx` — Step 0 copy from the SESSION copy + hostile-copy negative test |
| 5 | 8,9,10 | `apps/playground/src/__tests__/authShapedFailureSurface.test.tsx` — chip renders, hands off, survives a refused open, hides while open |
| 6 | 3 | `examples/spotify` — source-level: the 403 degrade branch survives (see §1a) |
| 7 | 13,14 | `examples/ledger-playbook.test.mjs` — source-structure assertions (see §1a) |
| 8 | 4 | `apps/playground/src/__tests__/connectionSurfaces.test.tsx` — REWRITTEN, see §1b |

### §1a — Harness reality check (plan-review MAJOR-6)

`ledger-analysis.test.mjs` evaluates an EXTRACTED pure-core region; it cannot assert JSX
nesting, and there is no jsdom+babel harness for starter HTML. AC13/AC14 and AC3 are
therefore **source-structure assertions over `app.html`** — the same technique
`connectionSurfaces.test.tsx` already uses on component source. This is honest about what
it proves: it pins the STRUCTURE (planbox is not inside the flex row; the degrade branch
still exists), not the rendered pixels. Rendered behaviour is covered by §4 owner
verification. AC3's wording was narrowed accordingly — "renders its chips" is not
provable by this harness and was dropped from the AC.

### §1b — A recorded decision reversal (plan-review MAJOR-6)

`connectionSurfaces.test.tsx:129` asserts *"a REJECTED credential still reads as a
failure"* — TASK-20260813 AC10 deliberately gave this surface the danger accent. Three
assertions there (`:132`, `:138-145`, `:153`) read `AuthRepairBanner.tsx` as a SOURCE
STRING and will break. They are not stale tests to be silenced: they encode a prior
decision that owner decision D2 now REVERSES (the alarm moves into the wizard; the run
surface keeps only a quiet chip). The rewrite must re-point them at the chip + Step 0 and
carry a comment naming this task as the reversal, so the next reader sees a decision
changing rather than a guard eroding.

### §2 — Implementation order (each step green before the next)

1. **`packages/auth/src/well-known-providers.ts`** — add `'user-read-recently-played'` in
   consent order; extend the block comment with why + the re-consent consequence.
2. **`docs/decisions/0028-registry-pinned-scopes.md`** — APPEND an amendment block dated
   2026-08-19 recording the 8th scope and its rationale. ADR-0028 is accepted and §4
   enumerates the 7-set; amending is a decision act, never a silent list edit.
3. **`examples/spotify/README.md:19-26`** — rewrite the enumerated set AND the
   "deliberately omits `user-read-recently-played`" paragraph, which will otherwise
   contradict shipped behaviour.
4. **`apps/playground/src/state/connectionWizard.ts`** — carry an OPTIONAL failure copy on
   `ConnectionWizardSession`; `openConnectionWizard` copies the live failure in and clears
   the store on a successful open (decision B). `ConnectionWizardStep` and `nextStep` are
   UNTOUCHED (decision A / BLOCKER-1).
5. **`apps/playground/src/connections/ConnectionWizardSheet.tsx`** — derive
   `showAttention = session.failure !== undefined && !needsReapproval(row)` and branch it
   **immediately above `showDiff`**. Continue clears the session copy and falls through to
   review naturally. No `nextStep` case, no LAN early-return hazard, no inversion of the
   `step !== 'review'` catch-alls.
6. **`apps/playground/src/run/AuthRepairBanner.tsx` → chip**, mounted in
   `RunHeaderActions.tsx` beside the `⚯` door; removed from `RunView.tsx:648`. Keep the
   file's C1 commentary about what may and may not reach it.
7. **`apps/playground/src/theme/app.css`** — chip styles. `.connection-note` and its
   `.is-error` variant STAY (Step 0 uses them).
8. **`examples/spotify/app.html`** — update the three stale scope claims: the
   scope-honesty comment (~461-465), the `loadCore` comment (~1370), and the discovery
   caption's `unavailable` branch (~951, 480 lines away — easy to miss). `recentMetrics`
   at ~583 needs NO edit; its docstring is already correct post-change.
9. **`examples/ledger/app.html`** — wrap children 1/2/4 in a `.leak-row`; leave `.planbox`
   as the second child of `.leak`; `.leak` becomes `flex-direction: column`. Then restyle
   the panel (numbered step chips, separated rows, distinct email block). The existing
   `.leak .emoji|.body|.head|…` rules are DESCENDANT selectors and survive the wrapper.
   Note `.leak`'s `padding: 10px 12px` means "full-width" is full-CONTENT-width.

**AC14 tension, resolved:** the actions `<span>` stays in row 1 always. Moving it into the
panel would duplicate two conditional guards (`app.html:1221`, `:1227`) for no user-visible
gain; only the panel's OWN CTA ("open the cancellation page") joins the panel action bar.

### §3 — Cross-package impact

`packages/auth` is depended on by `apps/playground`, `apps/desktop`, `apps/server`. The
scope change is DATA, not signature. Confirmed no dependent breakage: `ConnectionWizardStep`
is unchanged (decision A), so the ~16 `connectionWizardStepStore.set(...)` call sites across
`desktopWizardSheet`/`lanWizardFlow`/`connectErrorSurfacing` tests are untouched. Gate 5
still runs `packages/auth` + `apps/playground` + `examples` + root `pnpm test` given the tier.

### §3a — The second failure-store writer (plan-review MAJOR-3)

`authShapedFailureStore` has TWO writers, not one: `net.ts:395` (iframe/net lane) and
**`providerTools.ts:175` (the provider chat lane)**, whose comment names the banner as its
consumer. Removing the banner without accounting for this strands chat-lane failures — set,
with nothing rendering them. The chip mounts in the run header, which the chat lane shares,
so the fix is to VERIFY that path renders and to update the stale comment. Added to the
touched-file list.

### §4 — Owner verification on hardware (not done without it)

1. Existing Spotify connection → expect the re-approval diff naming the added scope (and
   NOT the attention screen — AC5), one re-sign-in, then a clean launch with the
   recently-played chips populated.
2. **The residual (see MAJOR-4 below):** dismiss the diff WITHOUT re-approving, relaunch →
   the chip still appears. Confirm this is acceptable.
3. Force a failure (revoke in the Spotify dashboard) → quiet chip, not the maroon block;
   tap → Step 0 with the provider's own sentence; dismiss → chip clears.
4. Ledger → "help me cancel" at narrow AND wide app frame → readable full-width panel.

### §5 — Rollback

Reverting the scope line after users re-approve stages a REMOVAL diff and
`reapproveFromDiff` deletes their tokens again (`connectionWizard.ts:536-545` fires on any
`scopesChanged`, add or remove). A revert therefore costs every Spotify user a SECOND
re-sign-in. Deliberate act, never a quiet fix-forward.

## Decisions & surprises

- **D1 (owner, 2026-08-19)** — fix Rewind's false alarm by pinning the missing scope, not
  by teaching the host to tolerate expected refusals. An app-declared "expected refusal"
  seat was considered and rejected: a protocol-visible knob whose only consumer is one
  starter, against ADR-0028's rule that privilege breadth is reviewed registry data.
  Revisit if a second provider needs a legitimately-refused read.
- **D2 (owner, 2026-08-19)** — the run surface keeps a quiet chip rather than going silent:
  a failure discoverable only behind an icon is one most users never learn about. **This
  REVERSES TASK-20260813 AC10** ("a REJECTED credential still reads as a failure" —
  `connectionSurfaces.test.tsx:129`). Recorded as a reversal, not a test cleanup (§1b).
- **D3 (owner, 2026-08-19, plan-review decision A)** — the re-approval diff OUTRANKS the
  attention screen. The diff is the cure; leading with the diagnosis would hand the user an
  unexplained consent delta one tap later.
- **D4 (owner, 2026-08-19, plan-review decision B)** — the failure is COPIED into the wizard
  session at open, then the store is cleared. Clearing without copying would leave Step 0
  with nothing to read (the AC6/AC9 contradiction the plan review caught).
- **D5 (implicit, from the fresh-context review)** — `attention` is a DERIVED GATE, not a
  step. The first plan proposed a new `ConnectionWizardStep` member, which this codebase
  explicitly avoids ("WHY NOT NEW STEPS", `ConnectionWizardSheet.tsx:1842`) and which would
  have broken three ways: `showDiff` is step-keyed and would go false; `nextStep`
  early-returns `'done'` for LAN rows ABOVE its switch, so a LAN row with a live 403 would
  skip review entirely; and three catch-alls keyed on `step !== 'review'` would fire during
  attention, inverting the ADR-0025 doctrine that they sit above every step-keyed branch.
- **ACCEPTED RESIDUAL (plan-review MAJOR-4, owner-visible)** — **pinning the scope does not
  fully close issue 1.** Token invalidation happens in `reapproveFromDiff`, i.e. on
  APPROVAL. A user who dismisses the re-approval diff keeps the old 7-scope token, and the
  403 fires on every launch exactly as today. Same for static-kind Spotify rows and
  non-registry provenance, which gain no scopes at all. Rewind cannot self-gate: it cannot
  see granted scopes (C1 — no token, scopes are host-side). Documented rather than papered
  over; §4.2 makes the owner look at it on hardware.
- **ACCEPTED CONSEQUENCE** — existing Spotify connections re-consent once (ADR-0028 §3
  working as designed). AC2 pins it with an old-set fixture.
- **Closed** — the "Step 0 from Settings" question is moot under D3/D5: the gate is derived
  from a live failure regardless of source, and the diff outranks it either way.

## Session journal (append-only, newest last)

### 2026-08-19 — Jeetu — session
- Done: Gate 1 spec + Gate 2 plan. Root causes confirmed in code for all three defects.
  Owner interviewed (D1, D2). Fresh-context High-tier plan review run BEFORE any
  implementation — it returned 2 BLOCKERs and 4 MAJORs, all independently verified
  against the code rather than taken on trust. Plan REVISED to close every finding:
  `attention` became a derived gate (D5) instead of a new step; diff-outranks-attention
  (D3); failure hand-off instead of clear (D4); the scope set's 5 duplication sites
  inventoried (the first plan named 2); AC2 rewritten to be non-vacuous; the
  `connectionSurfaces.test.tsx` decision reversal recorded (§1b); the second
  failure-store writer in `providerTools.ts` added (§3a); the harness limits for
  AC3/AC13/AC14 stated honestly (§1a); and the incomplete-re-consent residual documented
  rather than claimed fixed (MAJOR-4).
- State: plan approved by owner on decisions A and B; revised plan closes all six review
  findings. Ready for Gate 3.
- Next step: write the eight test groups in §1 order, red first.
- Open questions: none blocking. The accepted residual is owner-visible and scheduled for
  hardware verification at §4.2.
