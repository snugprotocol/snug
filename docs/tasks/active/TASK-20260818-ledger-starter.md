# TASK-20260818-ledger-starter: Ledger — the personal-finance starter + SimpleFIN token-claim connections

- **Status**: in-progress (plan approved by owner 2026-08-18 with one amendment — sample
  data showcases the Phase C concierge; fresh-context plan review owed before code)
- **Owner**: Jeetu
- **Risk tier**: **High** (auto-escalated: touches `packages/protocol` connection-requirement schema + `packages/auth` registry/wizard runtime — credential-minting path, C1-bearing)
- **Branch**: `feat/TASK-20260818-ledger-starter`
- **Packages touched**: `protocol` (internal-draft pairing discriminant) · `auth` (registry entry + claim runtime) · `playground` (wizard flow + shelf) · `examples` (the `ledger/` starter) · dependents per graph (protocol → everything)
- **Spec impact**: **internal draft only** — `connection-requirement.ts` is deliberately NOT in `schemas/` exports (AL-02 posture); follows the ADR-0026 precedent: internal-draft spec-changelog entry, zero `schemas/` bytes changed
- **Related**: ADR-0038 (drafted this task) · precedents ADR-0025 (verify-before-claim), ADR-0023 (collect→approve→freeze→pair binding order), ADR-0026 (connection-relative addressing), ADR-0031 (connected shelf + provenance), ADR-0035 (authoring-docs ingestion), ADR-0011 (LLM-optional), ADR-0018 (runtime contract) · `docs/next-steps.md` BYOK CORS advisory (2026-08-12)

## Spec (what & why)

Ledger is the flagship connected starter: a user-owned personal-finance app that is
complementary to (and deliberately unlike) Mint — the user's transaction data lives in
THEIR portable file, consolidated from every bank/credit-card account they connect via
**SimpleFIN**, and the intelligence layer is the user's own governed LLM, not an ad-funded
recommender. It answers budget/expense/income questions, strategizes and plans against
stated goals, and renders trajectory visuals: where you are, and where you could be in N
months if you follow specific recommendations.

SimpleFIN becomes a first-class registered provider (registry entry + wizard walkthrough a
layman can follow), so Ledger AND any future user-authored app get the same consistent
auth flow. SimpleFIN's shape: the user creates a SimpleFIN Bridge account
(bridge.simplefin.org, ~$1.50/yr), connects banks there, and copies a one-time **setup
token** (a base64-encoded claim URL). The app POSTs the claim URL ONCE and receives a
permanent **access URL** with embedded HTTP Basic credentials; thereafter `GET /accounts`
returns every connected account with balances + transactions. This is plain
request/response HTTPS — **no sidecar** (ADR-0038 D1): live probes 2026-08-18 confirmed
full CORS on both the claim POST and `GET /accounts` (arbitrary origin echoed,
`authorization` allowed, credentials allowed), so it works browser-direct on web AND
desktop.

Owner interview answers (2026-08-18): platform **web + desktop** · name **Ledger**
(folder `examples/ledger/`, tile label "Ledger") · **bundled deterministic sample data**
demo mode (usable instantly, banner + connect CTA) · **full in-app LLM turns** (runtime
contract; Q&A, planning, projections) on top of deterministic dashboards.

**Acceptance criteria** (each becomes ≥1 test):

*Phase A — SimpleFIN provider (High-tier surface)*
1. `connection-requirement.ts` pairing union gains a `token-claim` discriminant (beside
   `exchange`/`device-link`); schema refuses a token-claim seat carrying its own host/URL,
   and refuses it on kinds other than `basic_auth`.
2. Registry gains `simplefin` (kind `basic_auth`, `apiHosts: ['bridge.simplefin.org',
   'beta-bridge.simplefin.org']`, `browserCallable: true` with dated probe comment,
   `testRequest` GET `/simplefin/accounts?balances-only=1`, Hue-grade layman
   `registration.instructions`); all registry structural suites
   (self-containment/template-parity/static-kind) pass with the new row.
3. Wizard runs the claim: paste setup token → base64-decode → refuse unless decoded URL
   is https AND its host is on the row's **frozen ceiling** → POST (no auth header, empty
   body) → response access URL refused unless https AND host on ceiling → parse
   `username`/`password` → **verify** (`GET /accounts?balances-only=1` with minted Basic
   creds, 2xx only) → credentials + connected state written TOGETHER by the proving
   function (completeDeviceLink lesson). Binding order collect → approve → freeze →
   claim → verify pinned by test.
4. Negative tests (C1): setup token never persisted anywhere; minted username/password
   never returned from the claim function, never in any store/render/log (byte-probe);
   claim POST carries no credential header; decoded host off-ceiling refused
   (punycode-normalized comparison); a used token's 403 surfaces as a named,
   plain-language error with a "get a fresh token" retry path — never a silent failure.
5. Re-opening the wizard on a connected row never re-claims; revoke wipes the
   `auth:<appId>:simplefin:*` slice (existing accessors — pinned for this slot).

*Phase B — the Ledger starter*
6. `examples/ledger/` passes the full examples validate suite: single-file `app.html`
   (hooks byte-identical, no forms, no browser storage, literal SQL, ≤5 MB, agent-driven
   posture: `sendMessage` + `responseSchema`), `runtime-contract.json` (≤2560 bytes,
   schema-valid), bare `connection.json` (slot `simplefin`, registry substitutes),
   `README.md`, `authoring/prompts/01-build.md` (owner's verbatim prompt, this session) +
   `authoring/docs/{vision,requirements,plan,lessons,next-tasks}.md` (AC9 shape).
7. Demo mode: with no approved connection, the app seeds a deterministic bundled sample
   dataset (fixed seed → identical bytes every install), shows a persistent "sample data"
   banner with the connect CTA; connecting replaces sample rows with real data (sample
   rows carry a provenance flag so the swap is total and testable). **Owner amendment
   (2026-08-18, plan approval): the sample dataset is authored to showcase Phase C — it
   contains recurring subscriptions with clear redundancies (two overlapping streaming
   services, a free trial that converted and is unused, one price-creep case), so the
   money-leaks view is the demo's hero moment and motivates installing + connecting.
   Test: the deterministic recurrence detector finds ≥3 flaggable subscriptions in the
   bundled sample feed.**
8. Sync engine: fetch with `start-date` watermark from the last successful run; upsert by
   SimpleFIN transaction id (re-fetch overlap window for pending→posted transitions);
   consolidated into native tables (`accounts`, `transactions`, `balance_snapshots`,
   `orgs`, `sync_runs`, `categories`, `category_rules`, `budgets`, `goals`, `scenarios`,
   `insights`) — DDL executed against real sql.js in the real-browser pass (reserved-word
   screen done at authoring).
9. Deterministic dashboards render from SQL alone (ADR-0011: fully usable with no LLM):
   net-worth trajectory, cash-flow by month, category breakdown, recurring-subscription
   radar (deterministic recurrence detection), calendar heatmap, burn-rate/runway.
10. LLM layer (runtime contract): auto-categorization proposes `category_rules` the user
    approves (deterministic engine applies them); insight cards cite the transaction ids
    they derive from; goal planner produces a scenario (monthly deltas) rendered as a
    projected branch beside the actual trajectory ("time machine" view). Each lane has a
    response-schema test + a designed no-LLM empty state.
11. Shelf: `STARTER_LOOKS` entry (name "Ledger", emoji, color, blurb); install act
    resolves the manifest (starterInstallAct suite extended); one Playwright
    starters-connect spec walks install → wizard-open → declared row.
12. Playwright real-browser pass: app boots under real CSP, DDL executes, dashboards
    render with sample data, export carries zero starter trace (existing gate).

*Phase C — subscription concierge (owner addition, 2026-08-18 mid-Gate-1)*
13. Redundancy view: deterministic recurrence detection (AC9) feeds an LLM lane that
    groups subscriptions, flags redundant/overlapping ones (two streaming services, dead
    trials, price creep vs history), each claim citing its transaction ids; presented as
    a ranked "money leaks" list with monthly/annual cost.
14. Cancel flow: per subscription, the LLM produces a tailored cancellation playbook
    (steps, direct cancel/account URL, retention-script warning, cancel-by-email draft
    where that is the provider's mechanism); the app requests the host open the URL —
    a NEW confirm-gated `open-url` capability (internal-draft frame, same class as
    net-request): app→host request, host shows the full https URL in a confirm dialog,
    on user approval web opens a new tab from the HOST page and desktop uses the
    existing https-only system-browser opener. The app can never navigate anywhere
    itself (C2 unchanged: sandbox flags untouched, no `allow-popups`). Negative tests:
    non-https refused, credential-bearing URL userinfo refused, no confirm → no open,
    frame from a starter (uninstalled) refused. **The user signs in on the merchant's
    site themselves — merchant credentials never touch Snug (C1).**
15. Verified-cancelled tracking: user marks "I cancelled"; the app watches the next
    expected charge window and flips to "verified — no charge since <date>" (or flags
    "still charging"), with a running savings tally. Deterministic, testable from
    fixture feeds.

**Out of scope** (each recorded, not silently dropped):
- **Automated cancellation on merchant sites** (agentic browsing/form-filling): the app
  guides, opens the site, drafts emails — the user performs the merchant-side act and
  signs in themselves. Merchant credentials are never collected, stored, or proxied.
- **Shared cross-app connection custody** — today custody is strictly per-app
  (`(app_id, slot)` PK, `auth:<appId>:<slot>:*` keys, fail-closed by design); a second
  app needs its own setup token. Registry-level consistency (this task) is what "any
  custom app can leverage SimpleFIN" means at 1.0; shared custody is its own ADR/task →
  next-steps entry.
- Scheduled/background sync (no background-jobs runtime exists) — sync on open + manual
  refresh only.
- Investment holdings detail, multi-currency conversion (per-currency display only),
  generalizing connection-relative addressing to carry a base path (Ledger addresses
  `/simplefin/...` literally; prefix is stable for the pinned hosts — residual noted in
  ADR-0038).

## Plan

**Order: A before B** (the starter's wizard journey needs the provider). Tests FIRST per
TDD.md at every step. High tier ⇒ this plan gets a **fresh-context AI review before any
implementation code**, and negative tests land with each C1-adjacent step.

### Phase A — SimpleFIN provider + token-claim (protocol → auth → playground)

A1. `packages/protocol/src/connection-requirement.ts`: add `token-claim` pairing
    discriminant — seats: `tokenLabel`, `preconditionInstruction`, `secretFields`
    (must equal the requirement's two `basic_auth` field keys), `verify` (required,
    ADR-0025). SuperRefine: no host/URL seat representable; `basic_auth`-only coherence.
    Tests first in `connection-requirement.test.ts` (accept + both refusals).
    Spec-sync: internal-draft changelog entry (ADR-0026 precedent).
A2. `packages/auth/src/well-known-providers.ts`: `simplefin` entry per AC2. Extend
    structural suites (`static-kind-registry`, `registry-self-containment`,
    `registry-template-parity`) — no `request` seat: `basic_auth` kind default produces
    the `Authorization: Basic` header; fields `username`/`password` marked
    "filled in for you when you connect".
A3. `packages/auth/src/token-claim.ts` (new, pure, DI over `fetchImpl`): decode/validate
    setup token, claim POST, access-URL parse (URL API, never regex), ceiling checks via
    existing `isHostAllowed`/`normalizeAuthHost`. Unit tests incl. every refusal + the
    never-returns-secret probe. The CredentialStore write happens in the wizard step
    (A4) via the same write-together contract as `completeDeviceLink`.
A4. `apps/playground/src/state/connectionWizard.ts` + `ConnectionWizardSheet.tsx`:
    token-claim credentials screen (one paste box, verb button "Claim my access key"),
    claim runs over the platform `fetchImpl` seam (wizard-probe path — desktop native
    fetch included for free), verify-before-claim, named error copy for 403/expired,
    honest retry. Tests: `simplefinWizardFlow` (step machine + refusals + write-together
    call-order spy), mirroring `linkedDeviceWizard` structure.
A5. Threat-model delta: `docs/security/threat-model-delta-simplefin-token-claim.md`
    (user-supplied claim target bounded by ceiling; single-use token; what is accepted
    and not mitigated — e.g. a malicious setup token pointing at the real bridge's other
    user is claim-refused by SimpleFIN itself, not by us).

### Phase B — the Ledger starter (examples → playground shelf)

B1. Read `/Users/jeetu/.claude/projects/-Users-jeetu-SnugProtocol/memory/prompt-engineering-reference.md`
    before authoring the runtime contract + in-app prompts (standing owner rule).
B2. `examples/ledger/` per AC6–AC10: app.html from the KB template (hooks verbatim; all
    authored code below the RESPONSE_SCHEMA banner); DDL literal array + `schemaReady`
    gate; deterministic sample-data generator (fixed seed); sync engine; dashboards
    (canvas/SVG, no new CDN deps beyond allowlist); LLM lanes with responseSchema.
    `connection.json` bare manifest; `runtime-contract.json`; README ("Data it keeps"
    section naming every table); authoring bundle — `01-build.md` carries the owner's
    verbatim prompt (preserved below), header block per Telepath precedent.
B3. Suite wiring: `APPS` + `CONNECTED_APPS` (validate.test.mjs), `MANIFEST_APPS` +
    `P4_STARTER_FOLDERS` + `SURVEYED_FOLDERS` (connection-manifests.test.mjs),
    `STARTER_LOOKS` (HubView). Extracted-core tests for the pure logic (recurrence
    detector, watermark/upsert merge, projection math) in an `examples/ledger-analysis`
    style node --test file, following `whatsapp-analysis.test.mjs`.
B4. Playwright: starters-connect spec for ledger (install → declared row → wizard opens
    prefilled); real-browser boot + sample-data render; export zero-trace already covered
    by the existing gate.

### Phase C — subscription concierge (runner/protocol `open-url` capability + app surface)

C1. `packages/protocol`: internal-draft `open-url` request frame (app→host; https-only,
    no userinfo, own modest size class) — OUT of `schemas/` like the net frames; tests
    first (accept + the AC14 refusals). Spec-sync: internal-draft changelog entry.
C2. `packages/runner`: `openUrl` capability seam beside NetHandler (host-assigned app
    binding, value-blind — the runner never opens anything itself; capability flag off
    by default, off for starters). Tests mirror `host-net.test.ts`.
C3. `apps/playground`: confirm dialog (full URL shown, verb button "Open <host>"), web
    = host-page `window.open(url, '_blank', 'noopener')` on the confirm gesture, desktop
    = existing https-only system-browser opener via the platform seam. Tests + one
    Playwright spec (confirm → tab opened stub; decline → nothing).
C4. Ledger app: money-leaks view, cancel playbook LLM lane (responseSchema'd), open-url
    integration with copy-link fallback when the capability is absent, verified-cancelled
    watcher + savings tally (pure logic in the extracted-core test file).

### Verification & close-out

- Root `turbo run test --force` (protocol touched ⇒ full graph), repeated per the
  trusting-a-green-run lessons; desktop suite + macOS gate (auth touched).
- Real-flow walk (lesson 2026-08-17: a feature is done when someone walks it): fresh
  profile → install Ledger → sample-data WOW pass → wizard with a REAL SimpleFIN setup
  token (owner supplies; beta-bridge demo token for CI-adjacent manual check) → sync →
  dashboards on real data → LLM lanes.
- Gate 6: ADR-0038 accepted, spec-changelog internal-draft entry, lessons, next-steps
  (shared-custody residual + owner manual test addition), journal, done-index line.

## Decisions & surprises

- 2026-08-18 — **No sidecar** (ADR-0038 D1): SimpleFIN meets all five plain-connected-fetch
  criteria; CORS empirically confirmed (OPTIONS + GET + claim POST probes, origin echoed,
  `authorization` allowed). The sidecar ladder stays for providers that need it.
- 2026-08-18 — Claim host is **user-supplied data** (inside the pasted token), which the
  pairing seat deliberately cannot express; resolved by keeping the ADR-0023 binding
  order — the ceiling freezes from registry-pinned bridge hosts FIRST, and the decoded
  claim/access URLs must land on it. A third-party bridge host is therefore refused at
  1.0 (named limitation, ADR-0038).
- 2026-08-18 — Owner interview: web+desktop · "Ledger" · bundled sample data · full
  in-app LLM turns.

## Owner build prompt (verbatim, for `authoring/prompts/01-build.md` — do not edit)

> I would like to build another starter app - which is an unique never seen before Mint
> like app.  This starter app should be more complementary to apps like mint where it is
> user owned and can help user to query any budget/expenses/income/finance related
> queries from all the connected bank accounts/credit cards, help them strategize, plan
> based on their needs and expected outcome, give them ultra cool visuals on where they
> are and where they can be in a given time if they follow certain recommendations by
> the LLM.  more than a clone of mint this app should be 10 steps ahead of Mint with an
> ultracool super intuitive UI/UX .  I want you to be super creative, think out of the
> box and also add any features you think will be value add given the context,
> possibilities and create the ultimate WOW factor .
>
> Like any starter app (whatsapp/telepath and others) this app should also persist the
> build prompt, lessons, plan, vision, requirements, etc
>
> I'm considering to integrate SimpleFIN for this app.  SimpleFIN should be registered
> in the auth connetion (and wizard guiding the user which a layman can easily follow,
> click on links, register dev account with SuperFIN if not yet and authenticate thru
> it), so this starter app and any custom authored user app can leverage it and have a
> consistent auth flow via the wizard.  For the starter app I want you to determine if
> we should take the sidecar approach similar to whatsapp or directly connect from the
> app itself ? Please remember than SimpleFIN auth will be the first step for the user
> installing this app or similar apps.  Subsequently the user would need to connect with
> any bank accounts they wish via SimpleFin but all within the app.  The app should then
> be able to fetch data from any and every bank/credit card accounts connected and then
> consolidate at its end , save it in the snug db and then user can run analysis on it
> and get some interesting insights and intelligence

## Owner follow-up prompt (verbatim, same session — for `authoring/prompts/02-subscription-concierge.md`)

> i would also like to include features like where the shows user's all redundant
> expenses especially subscriptions categorized and presented clearly to user and user
> can within the app choose to unsubscribe from the selected ones and the app should
> with the help of the LLM and user go ahead, take necessary action , automate the
> unsubscribe as much as possible, guide weherever necessary and when needed for tasks
> like credentials app should ask user to sign in on the relevant web site opened by
> the app

## Session journal (append-only, newest last)

### 2026-08-18 — Claude (Fable 5) — session (Gates 1–2)
- Done: research (starter anatomy incl. ADR-0031/0035 provenance pipeline; auth registry/
  wizard/pairing precedents; SimpleFIN protocol + live CORS probes), owner interview,
  this spec + plan, ADR-0038 draft, branch cut.
- State: awaiting owner plan approval; High tier ⇒ fresh-context AI plan review still
  owed before implementation.
- Next step: owner approves/amends plan → fresh-context plan review → Phase A tests first.
- Open questions: none blocking (residuals recorded in Out of scope).

### 2026-08-18 — Claude (Fable 5) — session (plan approved, implementation begins)
- Done: owner approved the plan with one amendment (sample data must showcase the Phase C
  money-leaks concierge — folded into AC7 with a testable floor of ≥3 flaggable
  subscriptions in the bundled feed). Fresh-context plan review launched next.
- State: entering Gate 3 (tests first) on Phase A after review findings are addressed.
- Next step: fresh-context plan review → address findings → A1 protocol tests.
