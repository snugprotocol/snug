# TASK-20260814-hue-pairing-e2e: Hue wizard — verify before claiming connected; kill the LAN reopen ghost flow

- **Status**: planned — awaiting owner plan approval (Gate 2 stop)
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
   paired LAN row: review → approve → connected summary. Never RegisterScreen, never an
   empty credential box, never a re-pair walk. Component test reproducing the owner's
   journey — must FAIL on main before the fix.
3. **AC3 — "Connected" is claimed only after verification.** `runLanPairing` order
   becomes: pair exchange → write key+pin together (unchanged) → **verify read** — a
   registry-pinned credentialed GET (`verify` seat on `WellKnownPairingExchange`; hue:
   CLIP v2 `GET /clip/v2/resource/bridge` with the entry's own `hue-application-key`
   header carrying the just-minted value) through `platform.lanFetch` with the
   just-captured pin — and only a 2xx sets connection state `connected` + step `done`.
   Verify failure: key+pin stay stored (the device did mint them; re-pairing overwrites),
   state stays unconnected, honest fixed-sentence error, wizard stays on the pair screen.
4. **AC4 — Pairing-owed is derived from the verified fact.** The sheet's gate swaps the
   `listSecretKeys` presence probe for connection-state `status === 'connected'` — the
   same fact the executor honors. A key-present-but-unverified row therefore lands back
   on the pair screen, not on a done screen (closes the limbo AC3 creates and removes a
   secret-key enumeration from the component layer).
5. **AC5 — C1 negatives extended.** The verify request/response never surfaces the key:
   error copy comes from a fixed sentence set; the probe body is never stored, rendered,
   or logged. Scan-style negatives in the lanWizardFlow suite pattern.
6. **AC6 — The done screen states what was proven.** LAN done copy names the verified
   fact ("paired and verified with the device at `<host>`"), not a generic "connected".
7. **AC7 — Starter app copy tells the truth everywhere.** `examples/hue-lights-party`
   drops the two stale claims (preconnect notice implying desktop-connect is elsewhere;
   apply-control copy "waits for the desktop app") for platform-agnostic honest copy:
   pairing lives in this desktop app's connect flow; scene-sending from inside apps is a
   runtime capability that does not exist yet (follow-up task). Apply stays greyed.
8. **AC8 — Suites green across the fan-out**: `auth`, `playground`, `desktop`,
   `examples` (auth is upstream of playground/desktop per architecture.md).

**Out of scope**: the app-addressing seat (apps naming/reaching the bridge host — needs
its own ADR + protocol/spec-sync work); Hue Entertainment `clientkey` storage; discovery
broker changes; any OAuth-lane behavior.

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
   (after owner approval), self-sign-off in journal at close.
8. **Owner hardware retest script** (after merge): rebuild desktop app → open Hue
   starter → connect → pair (press button) → expect "verified with the device at
   <ip>" done screen; reopen wizard → connected summary, no re-walk; starter shows
   honest copy; optionally delete the bridge key row in the Hue app first to force a
   fresh mint.

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
