# TASK-20260814-hue-pairing-e2e: Hue wizard — verify before claiming connected; kill the LAN reopen ghost flow

- **Status**: in-progress — plan approved by owner 2026-08-14; fresh-context AI plan review running (High-tier extra), then Gate 3 tests first
- **Owner**: Jeetu
- **Risk tier**: **High** — touches `packages/auth` (registry + `WellKnownPairingExchange`); auto-escalate per PROCESS.md. High-tier extras owed: negative tests, fresh-context AI plan review before implementation, self-sign-off in journal.
- **Branch**: `fix/TASK-20260814-hue-pairing-e2e`
- **Packages touched**: `packages/auth`, `apps/playground`, `examples/hue-lights-party`; test-run fan-out to `apps/desktop` (consumes playground source per architecture.md graph)
- **Spec impact**: none — `WellKnownPairingExchange` lives in `packages/auth/src/well-known-providers.ts`, not `packages/protocol` (verified this session)
- **Related**: ADR-0023 (LAN-class providers — this task amends its "pairing IS the verification" stance), ADR-0022, draft **ADR-0025** (this task), TASK-20260812-desktop-auth-awareness (built the lane; owner hardware verification was held open — this report is that verification failing), PR #43 AC9/AC10

## Spec (what & why)

Owner's first hardware test of the Hue lane (2026-08-14, fresh post-PR-43 desktop build,
current-firmware bridge): pressed the bridge link button, clicked **"I pressed the button
— connect"** on the real pair screen, and the wizard reported connected **instantly**.
Reopening the wizard then re-walked the press-the-button instructions and showed an empty
"Bridge application key" box — so the owner concluded no API key was ever pulled.

Code review findings (pre-interview, this session):

1. **`runLanPairing` itself is sound** — every path that reaches `done` minted a real key
   and wrote key + TOFU pin together (connectionWizard.ts `runLanPairing`); the Rust
   `lan_fetch` pair mode and the `lanPair` seam are sound. An instant success on a LAN
   round-trip is physically plausible (~tens of ms). The key very likely WAS minted and
   stored on the owner's machine.
2. **The reopen ghost flow is real and is what the owner saw second**: `nextStep` knows
   nothing about LAN rows, so review advances toward `register` → `credentials`. The
   `lanNeedsPairing` interceptor hides those screens only while the minted key is
   ABSENT (`lanKeyPresent` probe). On a PAIRED row, reopening walks
   review → RegisterScreen ("press the link button" again) → CredentialsScreen (an empty,
   un-fillable secret box — C1 means a stored secret never renders) → done ("connected"),
   all local, zero network. To a user this is indistinguishable from "it never got a key."
3. **Nothing ever proves the claim**: the wizard says "connected" on the pairing response
   alone; no credentialed request is ever made until an app tries. And the starter app
   can never try — `apply to my lights` is permanently `disabled` (the app-addressing
   runtime gap, documented in app.html) with copy that lies on desktop ("waits for the
   desktop app"). So a successful pairing LOOKS identical to a failed one.

**Interview decisions (owner, 2026-08-14):** scope is **truthful wizard + verified
pairing + honest starter copy**. The protocol-level app-addressing seat (lights actually
turning on from the app) is split to a follow-up task with its own ADR; it is NOT in
scope here.

**Acceptance criteria** (each becomes at least one test):

1. **AC1 — LAN rows never see the api-key screens.** For a LAN requirement,
   `nextStep('review', requirement)` skips `register`/`credentials` (they are
   pairing-owned; the host screen already renders the registry instructions), and
   state-level guards make `advanceFromRegister`/`saveCredentials` refuse a LAN row with
   an honest message. Unit + component + guard tests.
2. **AC2 — Reopen tells the truth (the owner's regression).** Reopening the wizard on a
   paired-and-verified LAN row: review → approve → connected summary. Never
   RegisterScreen, never the credential box. Component test reproducing the owner's
   REAL journey (review issue G corrected the narrative: the ghost flow re-walks the
   press-the-button instructions and then STRANDS at the un-fillable required key box —
   `CredentialsScreen.save` refuses the empty field; it does not reach done). The
   fixture reproduces the pre-fix state shape honestly (`connected`, pin present, no
   verified marker → re-pair offered; a verified row → summary). Must FAIL on main.
3. **AC3 — "Connected" is claimed only after verification.** `runLanPairing` order
   becomes: pair exchange → **one write**: key to secrets + connection state
   `{ status: 'pending', lanPin }` (status is a required enum; `pending` is the honest
   pre-verify value) → `invalidateNetGrants` → **verify read** — a registry-pinned
   credentialed GET (`verify` seat on `WellKnownPairingExchange`; hue: CLIP v2
   `GET /clip/v2/resource/bridge` with the entry's own `hue-application-key` header
   carrying the just-minted value, rendered via the auth package's exported
   `renderAuthRequestTemplates` — never a hand-rolled replace) through
   `platform.lanFetch` with the just-captured pin, **status-only** (the probe body is
   never read) — and only a 2xx upgrades state to
   `{ status: 'connected', lanPin, lanVerifiedAt }` + step `done`. Verify failure: key +
   pin + `pending` stay (the device did mint them; re-pairing overwrites), **no
   `lastError` write** (that KV syncs/exports), honest fixed-sentence error
   distinguishing unreachable vs refused, wizard stays on the pair screen. A platform
   without `lanFetch` gets the fixed unreachable-for-verification sentence.
4. **AC4 — Pairing-owed is derived from the verified fact, via one reader.**
   `lanVerifiedAt` (epoch ms, written ONLY by the verify step) is added to
   `AuthConnectionState`. A LAN row is verified iff
   `status === 'connected' && lanVerifiedAt` present; a state-layer export
   (`lanPairingOwed`-shape) is the ONLY reader of the connection state — the sheet holds
   a boolean set inside its single effect before `loaded` flips (never parses the state,
   never enumerates secret keys). Consequences pinned by tests:
   - a key-present-but-unverified row lands on the pair screen;
   - a **legacy pre-fix row** (`connected` with no `lanVerifiedAt` — the owner's
     machine) is pairing-owed on reopen: honest re-pair, no migration;
   - **accepted divergence (review issue 1)**: the executor's LAN gate (connected-fetch
     gate 9a) keys on pin presence and is deliberately unchanged — a limbo row's app
     requests fail at the device and route back through the NET_AUTH_FAILED repair CTA
     into this wizard. Documented in ADR-0025; extending gate 9a was considered and
     rejected (second truth source in the executor; self-limiting failure).
5. **AC5 — C1 negatives extended.** The verify request/response never surfaces the key:
   error copy comes from a fixed sentence set; the probe body is never read, stored,
   rendered, or logged; verify failures write nothing into the synced `_connection` KV
   beyond the `pending` already there. Scan-style negatives in the lanWizardFlow
   pattern.
6. **AC6 — The done screen states what was proven.** LAN done copy names the verified
   fact ("paired and verified with the device at `<host>`"), not a generic "connected"
   — and is sourced from the verified fact, so it can never render for an unverified
   row.
7. **AC7 — Starter app copy tells the truth everywhere.** `examples/hue-lights-party`
   drops the two stale claims (preconnect notice implying desktop-connect is elsewhere;
   apply-control copy "waits for the desktop app") for platform-agnostic honest copy:
   pairing lives in this desktop app's connect flow; scene-sending from inside apps is a
   runtime capability that does not exist yet (follow-up task). Apply stays greyed.
8. **AC8 — Suites green across the fan-out**: `auth`, `playground`, `desktop`,
   `examples` (auth is upstream of playground/desktop per architecture.md).
9. **AC9 — No transient lie during row staleness (review issue 3).** The sheet refuses
   to render a screen for a revision whose row it has not re-read: the effect records
   the revision it loaded and the chain shows the loading hint while
   `loadedRevision !== revision`. Additionally the final fallback branch requires the
   verified fact for LAN rows (defense in depth: a LAN row that is not verified renders
   the pair screen, never DoneScreen). Regression test: approve a LAN row and assert
   DoneScreen/AC6 copy never appears before pairing ran.
10. **AC10 — Re-approval invalidates what it changes (review issue 4).** A LAN
    re-approval whose promoted requirement changes the frozen hosts or the field set
    downgrades connection state to `{ status: 'pending' }` (dropping pin + verified
    marker) and deletes the pairing-owned secret, so the wizard routes to re-pair and
    the "verified with the device at <host>" claim can never migrate to a device it was
    not proven against. Same-kind, same-host, same-fields re-approvals keep the
    verified state (unchanged behavior).

**Out of scope**: the app-addressing seat (apps naming/reaching the bridge host — needs
its own ADR + protocol/spec-sync work); Hue Entertainment `clientkey` storage; discovery
broker changes; any OAuth-lane behavior; the Settings connections pill (derives
"connected" from `row.status` for ALL kinds — pre-existing, noted by the plan review,
its own cleanup); extending connected-fetch gate 9a to consult verified status
(considered and rejected, see AC4).

## Plan

Order is tests-first per TDD.md; every step lands on the task branch.

1. **ADR-0025 draft** (done alongside this plan): "LAN pairing verifies before it
   claims" — amends ADR-0023's "no testRequest; pairing IS the verification" for the
   post-pair credentialed probe; records the routing decision (LAN rows never route
   through register/credentials) and the pairing-owed source-of-truth swap (AC4).
   Marked Proposed; accepted at plan approval.
2. **`packages/auth` — the `verify` seat** (`well-known-providers.ts`):
   - Extend `WellKnownPairingExchange` with required
     `verify: { method: 'GET'; pathAndQuery: string }`. Required, not optional: a
     pairing provider that cannot be verified is the defect this task exists to fix,
     and v1 has exactly one pairing entry (hue).
   - Hue entry: `verify: { method: 'GET', pathAndQuery: '/clip/v2/resource/bridge' }`.
     Header for the probe is built from the entry's own `request.headerTemplate` with
     ONLY the just-minted `secretField` value substituted (no new template machinery).
   - Tests first: registry shape test pinning the seat + a walk of the hue entry.
3. **`apps/playground` state** (`state/connectionWizard.ts`):
   - Tests first in `__tests__/lanWizardFlow.test.tsx` (+ a nextStep unit block):
     AC1 routing, AC2 reopen regression (must fail on main), AC3 verify-probe outcomes
     (2xx → connected; non-2xx / transport throw → stored-but-unconnected + fixed
     sentence; probe unreachable ≠ device refusal — two sentences), AC4 gate source,
     AC5 scans.
   - `nextStep`: LAN requirement → `'review' → 'done'` (interceptor + done screen own
     everything after review).
   - `advanceFromRegister` / `saveCredentials`: refuse LAN rows.
   - `runLanPairing`: append verify step after the key+pin write; only verified success
     sets `status:'connected'` + `'done'`. New fixed error sentences (P1 lesson: distinct
     causes get distinct sentences — verify-unreachable vs verify-refused).
   - Export a `lanPairingOwed`-style derivation reading connection state (for AC4).
4. **`apps/playground` sheet** (`connections/ConnectionWizardSheet.tsx`):
   - Swap `lanKeyPresent` probe → connection-state read (AC4).
   - DoneScreen LAN branch copy (AC6). Component tests first alongside AC2.
5. **`examples/hue-lights-party/app.html`** — copy truth (AC7); adjust the examples
   validate/manifest test if it pins the old copy.
6. **Verification**: `pnpm --filter @snugprotocol/auth test && pnpm --filter playground
   test && pnpm --filter desktop test && pnpm --filter examples test` (or root
   `pnpm test`); e2e `lanWizardFlow`/`starters-connect` specs updated if they pin the
   old routing.
7. **High-tier extra**: fresh-context AI review of this plan BEFORE implementation
   (after owner approval), self-sign-off in journal at close. **DONE 2026-08-14 —
   verdict approve-with-changes; all five confirmed issues folded into AC3/AC4/AC9/AC10
   and ADR-0025 (see journal).**
8. **Owner hardware retest script** (after merge): rebuild desktop app → open Hue
   starter → connect. Because the pre-fix row on the owner's machine carries
   `connected` with no verified marker, the wizard will offer RE-PAIR on open (AC4) —
   press the link button, pair, and expect "paired and verified with the device at
   <ip>". Reopen wizard → connected summary, no re-walk; starter shows honest copy.

**Implementation notes (from the plan review):**
- `reapproveFromDiff` restructures off sync `withSession` (follow
  `saveConnectionCredentials`'s hand-rolled async shape) so the AC10 state downgrade
  can await the credential store.
- Verify header rendering: `renderAuthRequestTemplates` from `@snugprotocol/auth`
  (already exported — index.ts), wrapped in a catch emitting a fixed sentence.
- Ordering preserved: secret+state write → `invalidateNetGrants` → verify → status
  upgrade (+ a second grant invalidation after upgrade is harmless and kept for
  symmetry).
- `lan-class-registry.test.ts`'s "NO testRequest" rationale comment now cites
  ADR-0025's amendment (no pre-pair probe stands; verification moved inside pairing).
- The verify probe is a dedicated status-only read on the pinned transport — NOT the
  executor path; its containment (frozen-ceiling host, registry path, template
  renderer, no body read) is recorded in ADR-0025 so it is not mistaken for drift.

**Cross-package impact**: `auth` → `playground` → `desktop` (source-consuming). No
`protocol`, no `runner`, no CI/release config. C1 honored throughout (minted value and
probe response never leave `runLanPairing`'s scope; done/error copy is fixed-sentence).

**Spec-sync**: not triggered (no `packages/protocol` change). Re-check at Gate 6.

## Decisions & surprises

- The owner's "no key pulled" was almost certainly a UX lie, not a storage failure: the
  pairing wrote the key, then the reopen ghost flow re-asked for the button press and
  showed an empty (never-rendered-by-design) secret box. The fix makes the wizard unable
  to lie in either direction: it cannot claim connected without a verified probe, and it
  cannot re-walk setup for a verified row.
- `verify` is REQUIRED on the pairing seat — a deliberate constraint on future pairing
  providers, recorded in ADR-0025.

## Session journal (append-only, newest last)

### 2026-08-14 — Claude (Fable) — session
- Done: Gate 1 recon (wizard state + sheet, hue registry entry, Rust lan_fetch, lanPair
  seam, starter app, PR #43 diff surface); owner interview (screen seen = real pair
  screen; evidence = instant + reopen re-walk; scope = truthful wizard + verified
  pairing; fresh build + current bridge); task file + plan written; ADR-0025 drafted;
  branch created.
- State: **Gate 2 stop — awaiting owner plan approval.** No implementation code written.
- Next step: on approval → fresh-context AI plan review (High tier), then Gate 3 tests
  first in the order above.
- Open questions: none blocking; verify-seat header substitution reuses the entry's own
  headerTemplate — confirm during implementation that the existing substitution helper in
  `packages/auth` is reachable from the wizard without new exports.

### 2026-08-14 — Claude (Fable) — session (continued, post-approval)
- Done: owner approved the plan. High-tier fresh-context adversarial review ran and
  returned **approve-with-changes** with 5 confirmed issues, all folded into the plan +
  ADR-0025 before any code: (1) "same fact the executor honors" was FALSE — gate 9a
  keys on pin presence; divergence now accepted + documented, gate 9a untouched;
  (2) pre-verify write must pick a status — `pending` chosen, no `lastError` ever
  written to the synced KV; (3) the reroute would have flashed a transient DoneScreen
  on every fresh approve (stale-row render race) — AC9 added: revision-matched
  rendering + verified-fact fallback; (4) re-approvals changing hosts/fields kept a
  stale "verified" claim — AC10 added: downgrade state + delete pairing-owned secret;
  (5) pre-fix rows (incl. the owner's machine) carry unverified `connected` —
  `lanVerifiedAt` marker written only by verify; legacy rows are pairing-owed, no
  migration. Advisories adopted: `renderAuthRequestTemplates` reuse (open question
  resolved — already exported), state read stays in the state layer via one derivation,
  Settings pill noted out-of-scope, verify-fail keeps net-grant invalidation, ghost-flow
  narrative corrected (strands at the required-field refusal, doesn't reach done).
- State: plan + ADR amended and committed; Gate 3 starting.
- Next step: failing tests in plan order (registry seat → routing/reopen regression →
  verify outcomes → race → re-approval downgrade → C1 scans → starter copy).

### 2026-08-14 — Claude (Fable) — session (continued, Gates 3-5)
- Done — Gate 3: red tests committed (2 auth registry + 12 wizard + 1 examples; 11 of
  the wizard tests failed on main as designed, the AC9 race test guards the new route).
  Gate 4: implemented auth verify seat + `lanVerifiedAt`, LAN step routing + guards,
  verify probe, connected-state gate, revision-matched rendering, done copy, starter
  copy. All suites green (auth 717, playground 1028, desktop 105, examples 182).
- Done — Gate 5: /code-review at high effort (multi-angle finders + adversarial
  verification). 10 verified findings, 1 candidate REFUTED (order-sensitive host
  compare cannot misfire today — `deriveConnectionAllowedHosts` sorts, load-bearing for
  import reconciliation; kept as a reuse fix anyway). Fixes applied, each with its
  regression pinned where testable:
  - **Verify-first, ONE durable write per outcome** in `runLanPairing` (was: write
    pending+pin, then verify, then upgrade). Closes the widened executor window (pin
    was in the store before the verdict; gate 9a keys on pin presence), the double
    whole-DB persist flush, the post-verify re-read/clobber race, and restores
    "key+pin+status land together". Mid-verify wizard close now KEEPS a successful
    proof (the button press is not wasted) and only the step write is session-scoped.
  - **Uncredentialed-probe refusal**: a header render that does not carry the minted
    value refuses (`LAN_VERIFY_UNPREPARABLE`) instead of degrading into a liveness
    probe a captive portal could satisfy.
  - **Rebind hole closed**: the §5 downgrade keys on `before || after` LAN class (+
    regression test staging a LAN→api_key rebind).
  - **Session recheck after `reapproveFromDiff`'s new await** before the step write
    (the withSession invariant, restated for the second suspension point).
  - **Failure paths bump the revision** and the pairing error moved to
    `lanPairingErrorStore` (fixed sentences only) so the remount cannot eat it.
  - **Consolidated LAN gate**: one catch-all pairing branch ABOVE the step-keyed
    branches (no status conjunct, tail fallback removed) — no step value can walk an
    unproven LAN row into register/credentials/done (+ forced-step regression test).
  - **Shared `requirementFieldKeysDigest`/`connectionHostsEqual`** helpers (reapproval
    + drift migration read one definition; comparison order-insensitive), Set-deduped
    secret deletion, single grant invalidation, `loaded` folded into `loadedRevision`,
    DoneScreen host guard, pre-collection LAN approve refusal in `advanceFromReview`.
  - **Doc drift fixed in-branch**: code-map LAN row (verify seat + marker), ADR-0025
    §1/§2/§5 rewritten to the verify-first single-write shape, next-steps queued the
    four follow-ups (async withSession, shared row hook, Settings pill
    verified-awareness, probe→auth relocation).
  - Deliberately NOT changed, with reasons on record: executor gate 9a stays
    pin-keyed (ADR-0025 §3 accepted divergence, now confined to the failure outcome);
    `nextStep` returns 'done' for LAN from any step (total by design — every caller
    enumerated safe by the review's own verifier); Settings pill (queued);
    corrupt-`_connection` reads as unverified → re-pair (self-healing and honest —
    the executor could not use a corrupt pin either); HubView badge + starter README
    copy (true in their web-only contexts).
- Verification: root `pnpm test` 21/21 green after fixes.
- **High-tier self-sign-off**: plan reviewed fresh-context before implementation and
  its five findings folded pre-code; tests first (red commit precedes implementation);
  C1 negatives present (probe body never read, fixed sentences, store scans); no
  protocol schema touched (spec-sync not triggered); no test deleted or weakened; the
  one deliberate residual (gate 9a divergence) is an ADR-recorded decision, not an
  oversight. Signed: Claude (Fable), 2026-08-14.
- State: branch complete pending owner review + merge; owner hardware retest owed
  after merge (procedure in plan step 8 — note the pre-fix row on the owner's machine
  will offer RE-PAIR on open; that is AC4 working, not a regression).
- Next step: owner review → PR → merge → move task file to done/ → hardware retest.
