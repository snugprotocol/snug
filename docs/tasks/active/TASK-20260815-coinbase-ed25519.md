# TASK-20260815-coinbase-ed25519: cdp_jwt goes Ed25519 — fix Coinbase connect/portfolio

- **Status**: in-progress (plan approved by owner 2026-08-15; High-tier fresh-context plan review PASSED — "approve with amendments", all 8 applied to plan + ADR-0030 before implementation)
- **Owner**: Jeetu
- **Risk tier**: **high** (touches `packages/auth` — credential broker; auto-escalate per PROCESS.md)
- **Branch**: `fix/TASK-20260815-coinbase-ed25519` (to be created after plan approval)
- **Packages touched**: `packages/auth` (registry entry, key import, template engine), `apps/playground` (wizard guidance/tests), likely docs only elsewhere. **Not** `examples/` — the Coinbase Trade Copilot app is a frozen benchmark and must not change.
- **Spec impact**: none expected (`cdp_jwt` grammar name unchanged; helper semantics change → spec-drafts note if auth surface draft mentions ES256; AL-12 spec push remains HELD)
- **Related**: ADR-0022 (§2 "ES256 only at v1" — superseded by this task's ADR), ADR-0020 (multi-option auth), ADR-0028 (credential invalidation precedent), open thread "Coinbase CDP re-credential + portfolio" (open since PR #42, 2026-08-13), BYOK CORS advisory (browser leg unaffected by this task)

## Spec (what & why)

The Coinbase connection never verifies: market data (public endpoints) renders, but the
authenticated portfolio path does not connect. The current `cdp_jwt` implementation is
**ES256-only by design** (ADR-0022 §2): `es256-key.ts` imports only EC P-256 keys and
**explicitly rejects Ed25519 PEMs** with a "generate an EC key" error, and the registry
entry's fields/instructions steer the user to create a legacy EC key. Coinbase's current
docs say the opposite of our 2026-08-12 recon note: **Ed25519 is the default and
recommended CDP key type; ECDSA/ES256 is legacy** (portal defaults to Ed25519). Verified
against Coinbase's own `coinbase-advanced-py` `jwt_generator`: the claim shape we mint is
already correct (`iss:'cdp'`, `sub:<key name>`, `uri:'<METHOD> <host><path>'`, `nbf:now`,
`exp:now+120`, header `kid`+random `nonce`; no `aud` on the Advanced Trade surface); only
the algorithm and key-import posture must change: Ed25519 secrets arrive as PKCS#8 PEM or
base64 (64-byte seed‖pubkey, first 32 bytes = signing seed) and sign `EdDSA`; WebCrypto
Ed25519 raw signature output is already JWS EdDSA format (no conversion — same happy
property as ES256).

Move the Coinbase auth surface to Ed25519-first: the `cdp_jwt` helper signs EdDSA from an
Ed25519 secret, the registry entry's fields/labels/registration walkthrough guide the
user to create an Ed25519 key, and the wizard errors honestly on legacy shapes. The
Coinbase Trade Copilot app and the wizard *machinery* are explicitly out of scope — this
is a registry + auth-helper fix, exactly the layer ADR-0022 built for this purpose.

**Interview decisions (2026-08-15, owner):** (1) Ed25519 ONLY — ES256 dropped, not
auto-detected; (2) accept base64 (64-byte seed‖pubkey and bare 32-byte seed) AND PKCS#8
PEM, auto-detected; (3) the saved EC-era credential is invalidated — wizard re-prompts;
(4) field failure mode was "not sure / no error shown" → the plan carries a diagnostic
finding (recon located two genuine silent paths, see Plan §0) and hardening ACs.

**Acceptance criteria** (each becomes at least one test):
1. `cdp_jwt` mints a verifiable `EdDSA` JWT from an Ed25519 secret in all three portal
   shapes (PKCS#8 PEM, base64 64-byte seed‖pubkey, base64 32-byte seed). Claim shape
   byte-compatible with the ES256 era: header EXACTLY `{alg:'EdDSA', kid, typ:'JWT',
   nonce:<16-byte hex, fresh per render>}`, payload EXACTLY `{iss:'cdp', sub, uri:
   '<METHOD> <host><path>' (no scheme/query), nbf, exp:nbf+120}`. Signature verifies via
   WebCrypto against the fixture public key; tampered payload fails (non-vacuous).
2. Honest typed errors, never silence — detection is ARMOR FIRST (an EC SEC1 paste
   must hit the EC error, never the base64 decoder): a legacy EC key (SEC1
   `BEGIN EC PRIVATE KEY` or PKCS#8 with id-ecPublicKey OID) names the fix ("create an
   Ed25519 API key…"); the base64 branch whitespace-normalizes before decoding (a
   trailing newline must not fail a valid key); base64url-alphabet pastes and wrong
   lengths earn typed fix-naming errors (a 48-byte PKCS#8-prefixed armorless paste has
   its seed extracted instead); and because every accepted shape canonicalizes to a
   seed WE re-wrap, ANY post-validation import/sign failure surfaces the honest
   runtime error — the TOTAL rule (the desktop subtle-fallback throws plain `Error`,
   not `NotSupportedError`; an error-name allowlist would tell that user to re-create
   a valid key). Negative (C1/C5): no error string ever carries key bytes or pasted
   content.
3. Registry re-pin: Coinbase `api_key` option's secret field becomes
   `ed25519_private_key` (label/description name Ed25519 + both paste shapes), template
   `Bearer {{cdp_jwt(api_key, ed25519_private_key)}}`, registration instructions walk
   the Ed25519 portal path and warn off legacy ECDSA; `testRequest` unchanged
   (`GET /api/v3/brokerage/accounts`); stale "Ed25519 not accepted" comment corrected.
4. Invalidate + re-prompt: an approved EC-era row (old `private_key` field key) is
   refused on re-admission by the drift migration → the registry's current shape is
   staged → the wizard walks the credential half again. The orphaned `private_key`
   secret is deleted at re-approval — no dead secrets in `snug_secrets` (C5).
5. Probe hardening (silent-path regression): an unexpected non-typed throw inside the
   test-connection chain renders an honest failure line in the wizard result area —
   never a blank area / unhandled rejection (recon: `runTest` has no `.catch`,
   `testConnection` no try/catch, `execute()` no top-level catch).
6. Honest done screen: gate = the existing `probeable` predicate (`Sheet:1157` —
   `testRequest` present ∧ kind not OAuth) **plus an explicit `isLanRequirement`
   exclusion** (vacuous today — no LAN entry carries a probe — but a future one must
   not downgrade a pairing-PROVEN claim to "saved until you probe"). Gated rows claim
   "connected" only after a passing probe; until then the done screen says the
   credentials are SAVED and offers the test (today "X is connected" renders regardless
   of any probe outcome — the second silent path the owner hit). Blast radius verified
   by review: only coinbase + openweather carry `testRequest`; e2e `/connected/i`
   assertions all hit non-probeable screens; LAN "paired and verified" untouched.
7. KB truth: `packages/knowledge` authoring KB teaches `cdp_jwt` as Ed25519/EdDSA;
   generated content in sync (content-drift test); taught templates still pass the lint.
8. Owner manual (hardware) close-out: create an Ed25519 key in the CDP portal → wizard
   re-prompts (AC4) → paste → probe passes → Trade Copilot portfolio renders live.
   Closes the PR-#42 Coinbase verification thread in `snug-open-threads`/next-steps.

**Out of scope**: the Coinbase Trade Copilot app (frozen benchmark — zero edits); the
Coinbase OAuth authOption (stays as-is, https-bridge refusal posture unchanged); the
institutional Exchange HMAC surface (stays dropped per ADR-0022); browser-BYOK CORS
relay (separate advisory); other providers' entries; the Meridian-Exchange demo triple
(`demoRequirement.ts`, `coinbaseBuildFixture`, desktop `journey.tsx`, e2e journey 1 —
fictional provider, pins nothing of the real registry entry); RunView's app-runtime
copy that misdescribes a template-render fault as a missing connection (queued to
next-steps, not fixed here); the drift-heal `.catch(() => undefined)` swallow at wizard
open (queued to next-steps).

## Plan

### §0 — Diagnosis (why "no error was shown")

Recon (2026-08-15, fresh-context agent over the wizard/probe/drift code) found the
failure is over-determined — three stacked causes, all addressed or queued:

- **Wrong key type guided**: registry instructions say "Choose the EC (ECDSA/ES256) key
  type… Ed25519 keys will not work here" (`well-known-providers.ts:695-701`) while the
  portal defaults to Ed25519; `es256-key.ts:119-123` rejects Ed25519 PEMs by design.
  → ACs 1-3.
- **Done screen claims connected unconditionally**: `ConnectionWizardSheet.tsx:1169`
  renders "X is connected" regardless of probe outcome; the probe is a button the user
  must click (`:1137-1234`). Market data (public) renders in-app, so everything LOOKS
  fine until portfolio 401s. → AC6.
- **Blank-result seat**: `runTest` chains `.then(setOutcome)` with no `.catch`
  (`Sheet:1162-1164`), `testConnection` (`connectionWizard.ts:1419-1461`) and
  `execute()` have no top-level catch — any non-typed throw = unhandled rejection =
  spinner clears, nothing renders. → AC5.
- (For the record: a *typed* `AuthTemplateError` from `cdp_jwt` IS surfaced today in the
  probe result line via `NET_AUTH_FAILED` (`connected-fetch.ts:1031-1051` →
  `connectionWizard.ts:1435` → `Sheet:1204-1221`); at app runtime it degrades to the
  generic connect-CTA banner (`RunView.tsx:598-631`) — copy gap queued, out of scope.)

### §1 — Files to touch, in order

**Phase A — tests first (Gate 3), `packages/auth`:**
1. Fixtures: REUSE the existing `ed25519-test-key.pkcs8.pem` fixture already embedded
   in `cdp-jwt.test.ts:34` (today's rejection fixture becomes the acceptance key —
   review finding 9) and derive its base64 shapes (64-byte seed‖pub, 32-byte seed,
   armorless 48-byte body) + raw public key for WebCrypto verify. The existing
   `SEC1_PEM` EC fixture becomes the rejection fixture. No second Ed25519 key minted.
2. Rewrite `src/__tests__/cdp-jwt.test.ts` against ACs 1-2: EdDSA header pin, all three
   import shapes, claim-shape pins carried over verbatim, WebCrypto verify +
   tamper-fails, EC-rejection error string, no-key-echo negatives, no-WebCrypto-Ed25519
   loud failure, fresh-nonce pin, blank-field guards (carry over).
3. Update registry pins: `registry-request-seats.test.ts` (renamed arg in template +
   `['api_key','ed25519_private_key']` substitution), `registry-template-parity.test.ts`
   (render entry template with the Ed25519 fixture), `static-kind-registry.test.ts`
   (field-key pin), **plus the three suites the review found pinning the old key by
   name** (finding 8): `connection-requirement-inferrer.test.ts:84,291`,
   `matched-option-admission.test.ts:99`, `registry-self-containment.test.ts:378`.
   `template-lint.test.ts`: enum unchanged; arg-rule fixtures updated only if they
   name the old field key.

**Phase B — implement, `packages/auth`:**
4. NEW `src/ed25519-key.ts` (delete `src/es256-key.ts`): auto-detect PEM vs base64;
   PKCS#8 Ed25519-OID check; EC-shape detection (SEC1 header or id-ecPublicKey OID) →
   fix-naming `CdpKeyImportError` (class name kept — it is still the CDP key importer);
   seed → fixed PKCS#8 prefix `302e020100300506032b657004220420` → non-extractable
   `importKey('pkcs8', …, {name:'Ed25519'})`; honest runtime-absence error. Same
   C5 contract: no error names pasted content.
5. `src/template-engine.ts` `cdp_jwt` helper: import from `ed25519-key.js`, header
   `alg:'EdDSA'`, `crypto.subtle.sign({name:'Ed25519'}, …)` (raw 64-byte output IS JWS
   EdDSA — no conversion), claims untouched; comment block updated (ADR-0030).
6. `src/well-known-providers.ts` Coinbase entry per AC3 (field key, labels,
   instructions, template arg, corrected recon comments; `testRequest`,
   `browserCallable`, OAuth option, apiHosts all byte-unchanged).

**Phase C — playground (tests first within each step):**
7. `src/__tests__/registryDriftMigration.test.tsx`: NEW case — approved EC-era row
   (old field keys `['api_key','private_key']` + old template) vs new registry shape →
   admission refusal path stages current shape (`connectionWizard.ts:1369-1380`) →
   credential-half re-walk (`reapproveFromDiff:589-591` routing) → AND the orphaned
   `private_key` secret is deleted at re-approval. Implementation per review findings
   3/4: deletion runs **BEFORE `db.reapproveConnection`**, in the same pre-promotion
   block as the ADR-0028 token invalidation (`:530-540` — its own comment `:522-529`
   is the ordering argument: a throw after a landed promotion strands the orphan
   forever), computed as `before.requirement.fields` keys minus staged-shape keys.
   **This is a decided POSTURE INVERSION, not a shape update**: the pinned "old
   secrets stay in storage" assertion (`registryDriftMigration.test.tsx:310,334-336`)
   inverts (the old triple's `api_secret`/`passphrase` now also delete at
   re-approval), and the `connectionWizard.ts:1287-1298` "WHAT IT NEVER TOUCHES"
   docstring updates — recorded in ADR-0030 §5, not silently weakened. Existing drift
   suites (old-triple staging, seat persistence) updated for the new shape.
8. AC5: test in `src/__tests__/connectionWizard*.test.tsx` — probe path whose executor
   dep throws a non-typed Error renders an honest failure line; implement via try/catch
   in `testConnection` plus a `.catch` on the `runTest` chain in
   `ConnectionWizardSheet.tsx`. Review finding 6 (C5): the rendered message is a FIXED
   sentence plus `err.name` ONLY — never `err.message` (a non-typed throw from below
   the scrub seat carries arbitrary library text and no scrub candidates exist at this
   altitude): "the test failed unexpectedly (TypeError)".
9. AC6: test — probeable static-kind done screen shows "saved" + test affordance, flips
   to "connected" only on probe `ok`; non-probeable kinds keep today's copy; gate
   predicate per AC6 (probeable ∧ ¬LAN). Implement in `DoneScreen` (`Sheet:1137-1234`).
   Update `coinbaseJourney.test.ts`, `registrySeatPersistence.test.ts` (CDP literals),
   `wholeSurfaceP6.test.tsx` (labels), and the done-probe describe at
   `registryDriftMigration.test.tsx:408-499` (review finding 7b — hit by BOTH the
   rename and the AC6 copy change).
10. e2e `connection-wizard.spec.ts`: only if journey 1 asserts done-screen copy
    (Meridian triple is out of scope otherwise).

**Phase D — knowledge + docs:**
11. `packages/knowledge/prompts/knowledge-base/app-authoring/90-auth-and-connected-apis.md`:
    "ES256" → Ed25519/EdDSA wording; regenerate `src/generated/content.ts`; auth-kb +
    taughtTemplatesLint tests stay green.
12. Docs in-branch: ADR-0030 finalize; ADR-0022 status line gains the superseded-§2
    pointer; `architecture.md` desktop-aware-auth section ES256 mentions;
    `docs/spec-drafts/spec-v0.3-auth.md` wording (internal draft — AL-12 push HELD);
    `docs/next-steps.md`: update the Coinbase re-credential thread (now waits on AC8
    with an Ed25519 key), add queue items (RunView render-fault copy; drift-heal
    swallow surfacing); `code-map.md` UNCONDITIONALLY (review finding 8 — `:42` names
    both `es256-key.ts` and the old field pair).

### §2 — Cross-package impact & verification

`packages/auth` → dependents `apps/playground`, `apps/desktop`, `apps/server`;
`packages/knowledge` → playground. `packages/protocol` untouched → **no spec-sync**.
Gate 5: suites of auth, playground, desktop, knowledge + root `turbo run test --force`
(turbo cache vouches falsely — repo rule). Known flake: playground vitest ~1-in-5
(next-steps 2026-08-14) — a red run gets the failing test NAMED before being attributed
to the flake.

### §3 — Risks / open items

- **WebCrypto Ed25519 availability** — spike BOTH test runtimes (review finding 9):
  packages/auth (`node` env — PASSED 2026-08-15, Node v22.13.1, see Decisions) AND the
  playground vitest environment (its drift tests genuinely sign through the template).
  If a runner lacks it, tests pin the honest-error path there and the signing tests
  gate on runtime support.
- **`kid` format**: portal file may carry the full `organizations/…/apiKeys/…` name or
  a bare key id (newer CDP export). Field guidance says paste the name/id as shown in
  the key file; live confirmation is AC8 (owner hardware test). If the bare id 401s,
  the fix is guidance-only, not code.
- **High tier**: plan requires a fresh-context AI review BEFORE implementation
  (PROCESS.md) — run after owner approval, before Phase A.

## Decisions & surprises

## Decisions & surprises

- 2026-08-15: Coinbase docs + official SDK (`coinbase-advanced-py` `jwt_generator.py`)
  confirm Ed25519/EdDSA is the recommended path and the ADR-0022 recon note ("Ed25519
  keys are NOT accepted on the Coinbase App surface", registry comment
  `well-known-providers.ts`) is stale — the portal now defaults to Ed25519. Claim shape
  needs **no** change; `aud` is NOT sent on the Advanced Trade REST surface (the
  `aud:['cdp_service']` claim in the JWT docs page belongs to the CDP platform API, a
  different surface).
- 2026-08-15: WebCrypto Ed25519 (`importKey('pkcs8', …, {name:'Ed25519'})`,
  `sign({name:'Ed25519'})`) is supported in current Node, Safari/WKWebView 17+, Chrome
  137+, Firefox 130+ — the honest-runtime-error pattern from ES256 carries over for
  older runtimes. Raw 64-byte signature = JWS EdDSA, no DER conversion.

- 2026-08-15 (post-approval): Plan §3 spike PASSED — Node v22.13.1 (CI pins node 22;
  auth vitest env is `node`) imports the PKCS#8-wrapped 32-byte seed via
  `importKey('pkcs8', …, {name:'Ed25519'})` and signs a raw 64-byte signature; the
  fixed prefix `302e020100300506032b657004220420` verified against a real
  openssl-generated key. Deterministic Ed25519 test fixture generated (PEM + 32/64-byte
  base64 + raw pubkey) for Phase A.

## Session journal (append-only, newest last)

### 2026-08-15 — Claude (Fable) — session
- Done: repo recon (es256-key.ts, template-engine.ts cdp_jwt helper, coinbase registry
  entry, ADR-0022), Coinbase docs + official SDK research; task file created. Interview
  held (4 decisions recorded in Spec). Fresh-context recon agent mapped wizard probe /
  error surfacing / drift migration / all pinning tests — findings in Plan §0/§1.
  ADR-0030 drafted. Branch `fix/TASK-20260815-coinbase-ed25519` created off `main`
  @ `861d8a6`.
- State: Gate 2 complete — plan written, **awaiting owner approval**. No implementation
  code touched.
- Next step: owner approves plan → High-tier fresh-context AI plan review → Phase A
  (tests first, incl. the WebCrypto Ed25519 runtime spike).
- Open questions: `kid` format nuance (Plan §3) — resolved at AC8 hardware test.

### 2026-08-15 — Claude (Fable) — session (cont.)
- Done: owner approved plan verbatim. High-tier fresh-context review (adversarial
  reviewer agent) returned **approve with amendments** — 1 blocker (draft ADR-0030 §4
  described a relabel-only variant whose invalidation never fires / silently promotes
  the stale secret; task file's rename was correct), 6 should-fix, 2 notes. All 8
  amendments applied to ADR-0030 (§2 armor-first detection + canonicalize-to-seed,
  §3 total runtime-error rule, §4 rename rationale, §5 orphan deletion ordering +
  posture inversion) and to Plan steps 1/3/7/8/9/12 + AC2/AC6 + §3. Reviewer
  independently verified the crypto bytes (RFC 8410 prefix, RFC 8037 JWS EdDSA) and
  the AC4 path on both admission branches. Ed25519 runtime spikes PASSED in both test
  runtimes: packages/auth `node` env (Node v22.13.1) and playground `jsdom` env.
- State: Gate 2 fully closed. Entering Gate 3 (Phase A tests-first).
- Next step: rewrite `cdp-jwt.test.ts` against ACs 1-2, then registry-pin suites.
