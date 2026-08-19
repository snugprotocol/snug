# TASK-20260818-ledger-starter: Ledger — the personal-finance starter + SimpleFIN token-claim connections

- **Status**: in-progress (plan approved by owner 2026-08-18 with one amendment — sample
  data showcases the Phase C concierge; fresh-context plan review owed before code)
- **Owner**: Jeetu
- **Risk tier**: **High** (auto-escalated: touches `packages/protocol` connection-requirement schema + `packages/auth` registry/wizard runtime — credential-minting path, C1-bearing)
- **Branch**: `feat/TASK-20260818-ledger-starter`
- **Packages touched**: `auth` (pairing union + registry entry + claim runtime + `claimVerifiedAt` state seat) · `playground` (wizard flow + shelf + open-url confirm) · `examples` (the `ledger/` starter) · `protocol` + `runner` (**Phase C only**: open-url frame internal draft + host-ready `openUrl` capability flag) · dependents per graph
- **Spec impact**: **Phase A: none** (fresh-context review Blocker 1 — the pairing union is REGISTRY data in `packages/auth`, deliberately never persisted on the row (ADR-0023 D2), so token-claim touches zero protocol bytes). **Phase C: real** — the open-url frame is internal-draft (out of `schemas/`, net-frames precedent) BUT capability discovery rides `hostReadySchema`, which IS in the published `SOURCES` set: optional `openUrl` flag ⇒ `pnpm gen:schemas` + a real spec-changelog entry for `host-ready.json` (the `net` flag's own precedent)
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

*Phase A — SimpleFIN provider (High-tier surface; amended per fresh-context review 2026-08-18)*
1. `WellKnownPairing` union (`packages/auth/src/well-known-providers.ts` — NOT
   `connection-requirement.ts`; Blocker 1) gains `WellKnownTokenClaimPairing`
   (`kind: 'token-claim'`, seats `tokenLabel`, `preconditionInstruction`, `secretFields`,
   REQUIRED `verify`); "no host/URL representable" and "basic_auth-only" are enforced by
   the type's construction + structural-registry tests (the `linked_device` precedent),
   never by requirement-schema superRefines. The seat stays registry data, never
   persisted on the row (ADR-0023 D2).
2. Registry gains `simplefin` — **ONE host: `apiHosts: ['bridge.simplefin.org']`**
   (Blocker 2: symbolic addressing requires a one-host ceiling —
   `connected-fetch.ts:943` refuses `allowedHosts.length !== 1` — and the declared
   probe fires at `allowedHosts[0]`); kind `basic_auth`, `browserCallable: true` with
   dated probe comment, `testRequest` GET `/simplefin/accounts?balances-only=1`,
   Hue-grade layman `registration.instructions`. Beta-bridge for the owner's demo-token
   manual check rides a dev-only fixture, never the shipped entry. All registry
   structural suites pass with the new row.
3. Wizard runs the claim: paste setup token → base64-decode → refuse unless decoded URL
   is https AND host on the frozen (singleton) ceiling AND default port (empty
   `url.port`) AND empty userinfo → POST with `redirect: 'error'`, no auth header,
   empty body → returned access URL refused unless https + on-ceiling host + default
   port + **path exactly `/simplefin`** (Blocker 3: the base path becomes a checked
   invariant, refused with a named error, live-probed and date-commented) → parse
   `username`/`password` → **verify** (`GET /simplefin/accounts?balances-only=1` — SAME
   spelling as `testRequest`, one definition — with minted Basic creds, `redirect:
   'error'`, 2xx only) → credentials + connected state (`claimVerifiedAt`, its OWN
   `AuthConnectionState` seat per the lanVerifiedAt/linkVerifiedAt doctrine) written
   TOGETHER by the proving function. Binding order collect → approve → freeze → claim →
   verify pinned by test.
4. Negative tests (C1): setup token never persisted anywhere; minted username/password
   never returned from the claim function, never in any store/render/log (byte-probe);
   claim POST carries no credential header; decoded host off-ceiling refused
   (punycode-normalized comparison); off-default port refused; userinfo-bearing URL
   refused; redirect refused; wrong access-URL path refused; a used token's 403
   surfaces as a named, plain-language error with a "get a fresh token" retry path —
   never a silent failure.
5. Wizard routing: `isTokenClaimRequirement(row)` (single registry resolution, the
   `lanPairingExchangeFor` rule) routes to the paste screen; `saveConnectionCredentials`
   gains a third family refusal ("this access key is created when you claim your setup
   token — there is nothing to type") WITH its positive twin (claim path still writes);
   a custom user-authored `basic_auth` provider still gets the typed screen (pinned).
   Re-opening the wizard on a row with `claimVerifiedAt` never re-claims; revoke wipes
   the `auth:<appId>:simplefin:*` slice (per-slot wipe accessor verified in A4 tests,
   not assumed).

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
    frame from a starter (uninstalled) refused; an app without the capability gets a
    named HOST_ERROR-style refusal, never the router's silent unknown-frame drop.
    **The user signs in on the merchant's site themselves — merchant credentials never
    touch Snug (C1).** Dialog hardening (review SF8): provenance copy ("The app asked
    to open this address — Snug hasn't checked it…"), host rendered in punycode/toASCII
    form (homograph defense), `window.open(url, '_blank', 'noopener,noreferrer')`
    called SYNCHRONOUSLY in the click handler (no awaits between gesture and open —
    popup-blocker escape proven by a real-browser Playwright assertion, not a stub),
    one pending open-url dialog per app instance.
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
  `/simplefin/...` literally; the claim step REFUSES an access URL whose path is not
  `/simplefin`, so the assumption is checked, not hoped — residual noted in ADR-0038).
- Third-party SimpleFIN servers on other hosts (the ceiling is the pinned bridge host;
  named limitation, ADR-0038).
- **Phase C is explicitly severable** (review N10): if it stalls, Phase B ships with the
  deterministic subscription radar (AC9) as the demo surface the sample data points at;
  the ranked money-leaks view + open-url land when C does. A post-B edit to `app.html`
  re-baselines the starter-HTML vouch for already-installed users — acceptable
  pre-launch, noted.

## Plan

**Order: A before B** (the starter's wizard journey needs the provider). Tests FIRST per
TDD.md at every step. High tier ⇒ this plan gets a **fresh-context AI review before any
implementation code**, and negative tests land with each C1-adjacent step.

### Phase A — SimpleFIN provider + token-claim (protocol → auth → playground)

A1. `packages/auth/src/well-known-providers.ts`: add `WellKnownTokenClaimPairing` to the
    `WellKnownPairing` union (registry data, never persisted on the row — Blocker 1) —
    seats: `tokenLabel`, `preconditionInstruction`, `secretFields` (must equal the
    entry's two `basic_auth` field keys), `verify` (required, ADR-0025). No host/URL
    seat is representable by construction. Tests first in the structural registry
    suites (accept + coherence refusals: token-claim beside non-basic_auth kind,
    secretFields/fields mismatch, missing verify).
A2. Same file: `simplefin` entry per AC2 (ONE host `bridge.simplefin.org`; no `request`
    seat — `basic_auth` kind default produces the header; fields `username`/`password`
    marked "filled in for you when you connect"). Extend `static-kind-registry`,
    `registry-self-containment`, `registry-template-parity`. Live-probe the `/simplefin`
    base path on the pinned host; date the comment (CORS probes already dated
    2026-08-18).
A3. `packages/auth/src/token-claim.ts` (new, pure, DI over `fetchImpl`): decode/validate
    setup token, claim POST (`redirect:'error'`, no headers, empty body), access-URL
    parse (URL API, never regex; refuse non-https / off-ceiling host / non-default port
    / userinfo in the DECODED claim URL, and additionally wrong base path on the
    RETURNED access URL), verify GET (`redirect:'error'`) — ceiling checks via existing
    `isHostAllowed`/`normalizeAuthHost`. Unit tests incl. every refusal (AC4) + the
    never-returns-secret probe. `AuthConnectionState` gains `claimVerifiedAt` (its own
    seat, credential-store.ts doctrine). The CredentialStore write happens in the
    wizard step (A4) via the same write-together contract as `completeDeviceLink`.
A4. `apps/playground/src/state/connectionWizard.ts` + `ConnectionWizardSheet.tsx`:
    `isTokenClaimRequirement(row)` predicate (single registry resolution) routes the
    sheet to the paste screen (one paste box, verb button "Claim my access key");
    `saveConnectionCredentials` gains the third family refusal + positive twin; custom
    basic_auth providers still get the typed screen (pinned). Claim runs over the
    platform `fetchImpl` seam (wizard-probe path — desktop native fetch for free),
    verify-before-claim, no-re-claim gate keyed on `claimVerifiedAt`, named error copy
    for 403/expired, honest retry. Per-slot revoke wipe accessor verified by test, not
    assumed. Tests: `simplefinWizardFlow` (step machine + refusals + write-together
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
    gate; deterministic sample-data generator (fixed seed, authored to showcase the
    money-leaks concierge per the owner amendment); sync engine; dashboards (canvas/SVG,
    no new CDN deps beyond allowlist); LLM lanes with responseSchema. `connection.json`
    bare manifest with the EXACT shape pinned (review N9: `slot`, `provider.name:
    'SimpleFIN'`, `kind: 'basic_auth'`, `declaredApiHosts: ['bridge.simplefin.org']`,
    NO `fields`, NO `pairing` key — the strict schema refuses unknown keys and
    `parseManifest` fails SOFT to "declares nothing"); `runtime-contract.json`; README
    ("Data it keeps" section naming every table); authoring bundle — `01-build.md`
    carries the owner's verbatim prompt (preserved below),
    `02-subscription-concierge.md` the follow-up, header blocks per Telepath precedent.
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
    no userinfo, own modest size class) — OUT of `schemas/` like the net frames — PLUS
    the published-surface half (review SF6): `hostReadySchema` capabilities gain an
    optional `openUrl` flag (additive, R2-safe), `pnpm gen:schemas` regeneration, and a
    REAL spec-changelog entry for `host-ready.json` (the `net` flag precedent). Tests
    first (accept + the AC14 refusals).
C2. `packages/runner`: `openUrl` capability seam beside NetHandler (host-assigned app
    binding, value-blind — the runner never opens anything itself; capability flag off
    by default, off for starters). An app without the capability gets a named refusal,
    never the router's silent unknown-frame drop. Tests mirror `host-net.test.ts`.
C3. `apps/playground`: confirm dialog per AC14 hardening (provenance copy, toASCII
    host, `'noopener,noreferrer'`, SYNCHRONOUS open in the click handler, one pending
    dialog per instance); web = host-page `window.open` on the confirm gesture, desktop
    = existing https-only system-browser opener via the platform seam. Unit tests + one
    REAL-BROWSER Playwright spec (confirm → tab actually opens — popup-blocker escape
    is only provable there; decline → nothing).
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

### 2026-08-18 — Claude (Fable 5) — review (fresh-context plan review, High-tier)
- Done: adversarial fresh-context review returned 3 BLOCKERs, 5 SHOULD-FIXes, 2 NOTEs —
  all plan-text defects, none architectural. Folded into the ACs/plan/ADR: (1) token-claim
  lives in the registry `WellKnownPairing` union, NOT connection-requirement.ts — Phase A
  touches zero protocol bytes; (2) ONE pinned host (`bridge.simplefin.org`) — a two-host
  ceiling breaks symbolic addressing (`allowedHosts.length !== 1` refusal) AND aims the
  declared probe at the wrong bridge; (3) `/simplefin` base path rides every spelling and
  the claim REFUSES a divergent access-URL path; (4) `isTokenClaimRequirement` routing +
  third `saveConnectionCredentials` refusal; (5) `claimVerifiedAt` as its own state seat;
  (6) Phase C's host-ready `openUrl` flag IS a published-schema change (gen:schemas +
  real spec-changelog entry); (7) claim/verify pin `redirect:'error'`, default port,
  empty userinfo; (8) open-url dialog hardening (provenance copy, toASCII host,
  noopener+noreferrer, synchronous open, real-browser proof); (9) exact bare-manifest
  shape pinned; (10) Phase C severability stated.
- State: plan amended and re-committed; review verdict "implementable as amended".
- Next step: Gate 3 — A1/A2 structural tests first.

### 2026-08-18 — Claude (Fable 5) — session (Phases A + B implemented, green)
- Done — **Phase A** (commits c3ad38d, 58af1de): `WellKnownTokenClaimPairing` union member
  + `simplefin` registry entry (structural suites extended: kind table, browserCallable
  documented-set, network-seat allowlist deliberately widened to THREE named modules);
  `performTokenClaim` pure mint (26 tests: full refusal battery, write-together-after-
  verify call order, never-echoes-secrets probes); `claimVerifiedAt` state seat; wizard
  family routing (`tokenClaimPairingFor`/`isTokenClaimRequirement`), paste-and-claim
  screen, third `saveConnectionCredentials` refusal + positive twin, no-re-claim gate
  loaded from the row on reopen; threat-model delta doc. Auth 878 green; playground
  1236 green.
- Done — **Phase B** (commits 688c665 + prior): `examples/ledger/` — 85 KB single-file
  app (sample household with PLANTED leaks per the owner amendment; deterministic
  radar/time-machine/cash-flow/heatmap/net-worth reconstruction; four agent lanes over
  one discriminated schema; SimpleFIN sync with watermark+overlap upsert and wholesale
  sample eviction), bare `connection.json`, runtime contract (1838 B), README,
  full authoring bundle (both owner prompts verbatim); suite wiring (APPS,
  CONNECTED_APPS, MANIFEST_APPS, P4/SURVEYED, STARTER_LOOKS, shelf membership pin);
  `ledger-analysis.test.mjs` (15 extracted-core tests — examples 235 green); ledger
  e2e row PASSES in a real browser (DDL on real sql.js under real CSP, banner + time
  machine rendered).
- Surprise (pre-existing, repaired half / residual half): the env-gated
  `starters-connect` DEGRADED rows had never run since the TASK-20260817 tile rename —
  tile clicks keyed on the FOLDER while labels became display names. Repaired the
  helper to click by `data-starter-name` identity (the 2026-08-17 lesson's exact
  surface). STILL RED, pre-existing, NOT this task's: github/spotify/weather content
  pins + the read-only row — their apps key pre-connect state on a probe a read-only
  route never answers; needs per-app investigation → next-steps.
- State: Phases A+B complete and green; Phase C (open-url + concierge) not started.
- Next step: Phase C tests first (protocol frame + host-ready openUrl flag + runner
  seam + confirm dialog + app money-leaks integration), then root `turbo run test
  --force` + owner real-token walk.

### 2026-08-18 — Claude (Fable 5) — session (Phase C implemented; ALL PHASES GREEN)
- Done — **Phase C** (commits after 6e013f6): protocol `snug:open-url-request`/
  `snug:open-url-result` (internal draft, strict, https-only + userinfo-free at the
  schema, no target/features seats; `parseFrame` taught; protocol 342 green) +
  host-ready `openUrl` capability flag (PUBLISHED surface — `gen:schemas` regenerated
  `host-ready.json`, real spec-changelog entry, `net`-flag precedent); runner
  `OpenUrlHandler` seam (named refusal on absence — never the silent unknown-frame
  drop; single-pending per instance; stale-drop; capability truth on host-ready;
  runner 119 green; three capability-set pins in host-lifecycle MIGRATED to include
  the new seat); playground `OpenUrlConfirmDialog` + `state/openUrl.ts` (provenance
  copy, NORMALIZED-href rendering so a homograph displays as xn--, synchronous
  open-inside-gesture with 'noopener,noreferrer', desktop routes the same gesture via
  `oauth.openExternal`; 6 unit tests incl. the Cyrillic-а homograph and the
  opened-during-click pin), RunView binds the handler for installed apps only
  (starters: capability false); **real-browser popup-escape proof** — new scoped
  Playwright project `open-url` (net-project precedent: the https stub is the popup
  target) driving PRODUCTION runner bytes: real click → real tab → `window.opener`
  null → app hears `opened`; negative: no handler → app hears named `refused`.
  Ledger gained the `cancel_playbook` lane (schema+contract re-trimmed under seat
  caps), the hand-rolled open-url bridge (Telepath doorbell precedent — no snug-hooks
  byte-bump), the app-side https/userinfo gate on LLM-proposed cancelUrls, and the
  honest copy-the-link fallback on `refused`; examples 235 green; ledger e2e boot row
  re-verified.
- Verification: **root `turbo run test --force` 23/23 tasks green, 0 cached, run
  TWICE** (the trusting-a-green-run lesson).
- Deviations from plan text (recorded): token-claim's `secretFields` became two named
  seats (`usernameField`/`passwordField` — order-proof for the basic_auth injection
  contract) + an `accessPath` seat (Blocker 3's checked invariant); the network-seat
  allowlist (`test-request-single-path`) deliberately widened to THREE named modules
  with in-test justification; the open-url e2e proof rides a fixture harness on
  production runner bytes (the playground dialog's synchronous-order is pinned by its
  unit test) because the playground-level popup path needs an LLM turn no e2e brain
  can produce.
- State: Phases A, B, C all implemented and green. NOT yet done: owner real-token
  walk (SimpleFIN Bridge account + fresh setup token — next-steps entry), PR + AI/
  human review (Gate 5), ADR-0038 status flip to accepted at merge, Gate 6 close-out.
- Next step: owner walks Ledger end-to-end with a real SimpleFIN setup token; then PR.
