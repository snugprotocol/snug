# TASK-20260810-p4-starters: Dynamic Auth v2 — P4, the starter shelf across the auth spectrum

- **Status**: **ACTIVE** — starters + registry data landed; fresh-context review folded (see §Review fold).
- **Owner**: Claude (orchestrator; owner directed an autonomous P0→P5 run on 2026-08-10)
- **Risk tier**: **HIGH** (fold T-M1). Registry entries live in `packages/auth`, and PROCESS.md auto-escalates ANY touch of a High area. Negative tests required; mutation evidence required for security claims.
- **Branch**: `feat/TASK-20260810-p4-starters` (cut from P3).
- **Parent plan**: `docs/TASK-20260810-plan` branch — read with `git show docs/TASK-20260810-plan:docs/tasks/active/TASK-20260810-dynamic-auth-rewrite.md`.

> **Why this file exists late, stated plainly.** P0–P3 each shipped a task file; P4 did not, and the fresh-context review caught it (PROCESS.md gate 1: no work outside a task file). The ACs below were real — they are cited by identifier across `apps/`, `packages/` and `examples/` — but they existed only as prose inside the tests claiming to satisfy them, which gives a reviewer no independent spec to map against. That is precisely the condition under which an AC can be silently dropped, and one effectively was: **no AC covered "a registry-backed starter reaches a usable credential prompt"**, which is exactly the defect the review found shipped. AC11 now covers it.

## Acceptance criteria

| AC | Statement | Test home |
| --- | --- | --- |
| **P4-AC1** | The three static-kind providers (`coinbase`, `openweather`, `coingecko`) exist in the registry with pinned `apiHosts`, an EXACT credential `fields` list, and a registration walkthrough; no OAuth endpoints, no default scopes. | `packages/auth/src/__tests__/static-kind-registry.test.ts` |
| **P4-AC2** | Exactly FIVE example folders ship a `connection.json`; `hue-lights-party` ships none (LAN posture). Every manifest parses as a v4 requirement and carries no credential value. | `examples/connection-manifests.test.mjs` |
| **P4-AC3** | The five starter apps ship with `app.html` + `README.md` and appear on the shelf. | `apps/playground/src/__tests__/starterShelf.test.tsx` |
| **P4-AC4** | The install act copies the declared requirement VERBATIM onto the installed app. | `apps/playground/src/__tests__/starterInstallAct.test.ts` |
| **P4-AC5** | Pre-install disclosure renders the declared connection from the manifest. | `apps/playground/src/__tests__/starterInstallDisclosureV4.test.tsx` |
| **P4-AC6** | The harvested AL-09 static lints hold: no credential in authored app code (AC3), hook-not-fetch (AC4). | `examples/connection-manifests.test.mjs` |
| **P4-AC9** | The v3 `llmProposalSchema` is DELETED and the starter channel is rewired to `connectionRequirementSchema`. | `packages/protocol/src/__tests__/render-directive.test.ts` |
| **P4-AC10** | The `?demoreq=starter-*` variants MIRROR the shipped manifests, read **off disk**, and survive the full production path (schema → admission → template lint). | `apps/playground/src/__tests__/demoRequirementStarters.test.ts` |
| **P4-AC11** | **(added by the review fold)** Each shipped registry-backed starter resolves, through the REAL install path, to a requirement carrying the registry's credential `fields` and — for OAuth — its `endpoints` and `pkce`. A borrower that OMITS fields RECEIVES the pinned list; one that AUTHORS them is still REFUSED. | `packages/auth/src/__tests__/registry-substitution.test.ts` |
| **P4-AC12** | **(added by the review fold)** Registry field keys and the KB-taught header template cannot fork: every token the taught Coinbase template signs with resolves against the registry's field list, and the composition renders no empty header. | `packages/auth/src/__tests__/registry-template-parity.test.ts` |
| **P4-AC13** | **(added by the review fold)** The three exports that survived the v3 deletion (`liveInferenceAdapter`, `inferenceWireCopy`, `completeWithAdapter`) keep their guards — above all the AL-05 gate that a real inference never runs on the mock demo brain. | `apps/playground/src/__tests__/inferenceAdapterLadder.test.ts` |

**Exit (a)** — the shelf ships five starters spanning the credential spectrum (api_key ×2, bearer_token, oauth2_auth_code, plus hue's declared-nothing LAN posture).
**Exit (b)** — install → connect end-to-end on a zero-LLM profile (Playwright), per fold T-M6. Evidence: `apps/playground/e2e/connection-declaration.spec.ts` **3/3 passing** after the un-park below.

## Harvest inventory (AL-09, `feat/TASK-20260807-starters-auth-spectrum` @ 86a564c, never merged — Q8)

Read-only harvest from the parked branch. Reusable near-verbatim; every MANIFEST and every auth-flow TEST was rebuilt on the v4 schema.

- **AL-09 AC3** — the credential-in-authored-code lint → `examples/connection-manifests.test.mjs`.
- **AL-09 AC4** — the hook-not-fetch lint → same file.
- **AL-09 AC8** — the five starters' HTML and shelf looks → `examples/{crypto-portfolio,weather-planner,my-repos,spotify-party-dj,hue-lights-party}/`.
- **AL-09 AC9** — bearer_token spectrum coverage → the `my-repos` starter (a PAT modelled honestly as a bearer token).
- **AL-09 AC10** — the Spotify registration walkthrough → `packages/auth/src/well-known-providers.ts` (registry DATA, never wizard component copy, per AL-04 D5).
- **The Hue posture** — declares nothing, because a LAN bridge is unreachable from the web and a manifest would mint a connect affordance that cannot work.

## Review fold — what the fresh-context review found, and what changed

Four BLOCKERs, five MAJORs, four MINORs. Re-verified at source before acting; all confirmed. The two independent BLOCKER reports (security lens + fidelity lens) describe the SAME root cause.

### BLOCKER 1+4 (same defect) — registry `fields` were never substituted

`applyRegistryValues` copied provider, hosts, registration, authorizeParams — and never `fields`. So all four registry-backed starters reached the credential step with **ZERO input boxes**, and the wizard then reported SUCCESS having stored no credential. The founding defect ("Coinbase needs key + secret + passphrase" as one nameless box) was not closed; it was made worse — from one box to none.

**Fixed** by adding a `fields` branch (deep-copied, so the shared registry singleton cannot be mutated by a downstream caller). **Mutation-proven**: removing the branch turns 11 tests red across the four real shipped manifests; before the fix, zero tests noticed.

**Defence in depth** added at `saveConnectionCredentials`: a credential-bearing kind resolving to zero fields now REFUSES rather than returning `{ok:true}` and advancing to `done`. `kind:'none'` is exempt — it legitimately collects nothing, and refusing it would break a working posture.

### BLOCKER 2 — Spotify's OAuth endpoints and PKCE were dropped

The endpoint seats were written only when the DECLARATION already carried them; a bare registry-backed manifest carries neither, so the flow was aimed at `?? ''`. The original rationale (`oauth2AuthCodeSchema` needs authorize+token together) argues against writing when the REGISTRY lacks endpoints — not against writing when the registry has a complete pair. **Fixed** to condition on the registry. The `entry.endpoints !== undefined` half stays: a static kind must not sprout URLs that would union a nonexistent host into the frozen ceiling.

### BLOCKER 3 — the `api_passphrase` fork

The registry keyed Coinbase's third secret `api_passphrase`; the KB-taught template signs `{{passphrase}}`, as do seven other declaration sites. The template engine resolves tokens against the FIELD KEY, so once fields actually arrived this would send `CB-ACCESS-PASSPHRASE` present-but-EMPTY — a generic 401 with nothing in the product explaining it. **The rename and the substitution fix had to land together**: fixing substitution alone converts a dead-data bug into a strictly harder-to-diagnose wrong-signature bug. Pinned by AC12 so the two literals cannot fork again (the repo's own 2026-08-03 shared-literal lesson).

### BLOCKER 5 — P4's exit (b) was not proven

The two journeys P3 parked FOR P4 to un-park were still `test.skip(true, ...)`. The premise ("the install-act channel still reads `llmProposalSchema`") was false — P4 completed the rewire. **Un-parked.** Four stale references had accumulated while parked, each fixed to what SHIPS, none weakening a journey: `connection-declared-row` → `connection-slot-row`; the review copy → the starter-provenance line; `getByLabel('provider name')` → the rendered heading (the v4 review presents for judgement, it does not offer editing); `wizard-hosts` → `review-hosts`. The journey also now walks the REGISTER step, which `nextStep` routes to whenever a manifest declares a walkthrough. **3/3 passing.**

### MAJOR — the AL-05 demo-brain gate lost its only guard

P4 deleted `inferrerAdapter.test.ts` (19 tests) along with `runAuthSpecInference`. The function's deletion is correct and stays. But three exports SURVIVE and were left untested, including the gate that a real inference never runs on the mock demo brain. **Restored on the shipped path** (AC13) rather than resurrecting the v3 entry point.

> **A false guard, caught by re-running the mutation.** The first draft of the restored suite passed *with the gate deleted* — it never set `webllmFlagStore`/`webgpuStore`, so `currentBrain()` returned `{kind:'settings'}` and the demo branch was never entered. The mutation-killing case had to be arranged so the gate is the ONLY possible cause of refusal: byok mode, a real provider, AND a stored key. This is the argument for mutation evidence over test count in one example.

### MAJOR — three vacuous assertions, each mutation-proven

- **Coinbase's field list** was guarded only by `length > 0`, which cannot distinguish three secrets from one. Deleting the passphrase field passed all 307 auth tests and all 19 root tasks. Now pinned as an EXACT ordered key set.
- **`demoRequirementStarters`' "MIRROR the shipped manifests"** never read a manifest — it compared the demo table against a literal typed inside the test. Drifting `my-repos`' kind left the repo green. Now reads `examples/*/connection.json` off disk.
- **"exactly six example folders ship a connection.json"** built a six-member list and immediately `.filter()`ed one out, so the assertion compared the same five-element array to itself. The POSTURE was right (five declaring + hue abstaining); the name and the arithmetic were wrong. Renamed and made literal.

### MINOR — flaky journey 1

1 failure in 5 full-suite runs on a DOM-detach race in `openWizardFromCard`. Fixed by awaiting a stable button before clicking. Harness-only; no assertion weakened.

## Owner decisions needed — data accuracy, NOT code

The review could not verify these against live vendor docs (no network access), and states them as unverified rather than asserting them:

1. **Coinbase**: which API surface does the entry target — Exchange/Pro or Advanced Trade? The three-field key+secret+passphrase shape is the Exchange/Pro model; ADR-0017 records only MEDIUM confidence and notes the Advanced Trade variant has **no passphrase**. Both `consoleUrl: https://www.coinbase.com/settings/api` and the passphrase field's `required: false` depend on that answer.
2. **CoinGecko**: is the Demo key still issued from `/en/developers/dashboard`, and is the transport header `x-cg-demo-api-key`?
3. **OpenWeather**: is `/api_keys` still the issuing page, and is the "up to two hours to activate" window current?

## Session journal

### 2026-08-10 — Claude — P4 built, reviewed, review folded

- Registry DATA entries landed for the three static kinds (P0 had already widened the TYPE). Five starters harvested from the parked AL-09 branch and rebuilt on the v4 schema.
- Fresh-context review found the phase's headline fix was **dead code**: the `fields` data shipped but was never substituted. Two reviewers found it independently through different lenses. Folded per above, each fix mutation-proven.
- **Six mutations executed and killed** during the fold: fields-substitution removal (11 red), endpoints/pkce revert (2 red), passphrase re-fork (5 red), passphrase field deletion (6 red), manifest kind drift (1 red), AL-05 gate removal (2 red). Every green claim re-run with `pnpm test -- --force` — the turbo cache reports GREEN over a mutated tree otherwise, and packages resolve to `dist/`, so a bare `npx vitest run` on a dependency's `src/` proves nothing.
- Probe hygiene: the review found four uncleaned `zz-probe*.test.ts` files that BROKE the build. Already removed from the tree before this fold began; re-verified absent.

---

## Orchestrator verification (2026-08-10) — both BLOCKERs re-verified CLOSED by execution

Two lenses returned BLOCK and one REVISE, converging on the same root defect. Re-verified
by the orchestrator rather than accepted from the fold report.

- **BLOCKER (found independently by 2 lenses) — the registry `fields` were DEAD CODE.**
  `applyRegistryValues` substituted provider/hosts/endpoints/registration but never
  `fields`, so every registry-backed starter reached the credential step with **ZERO input
  boxes** and the wizard reported success having stored nothing. That is the founding
  defect in a *worse* form — not "one generic box" but no box at all.
  **CLOSED, verified by execution against the built package:** a bare registry-backed
  manifest (`{slot, provider, kind, declaredApiHosts}`, no authored fields — which is what
  Guard 2b requires of a borrowing channel) now admits with **FIELD COUNT: 3** and keys
  `api_key, api_secret, passphrase`.
- **BLOCKER — the Coinbase registry key was `api_passphrase` while every other site uses
  bare `passphrase`.** Once the fields defect was fixed this would have substituted a key
  the KB-taught `CB-ACCESS-PASSPHRASE: {{passphrase}}` template cannot resolve — silently
  sending an empty passphrase header and producing an unexplainable auth failure.
  **CLOSED and verified end-to-end:** the key is now `passphrase` (the two remaining
  `api_passphrase` strings are the comment warning against exactly this mistake), and the
  KB-taught template **lints `ok: true` against the registry's own field keys**.
  **The founding defect is now closed along the whole chain: registry → admission →
  wizard → signed request.**
- **MAJOR — the "exactly six manifests" test asserted FIVE**, via an array built with six
  members then `.filter()`ing one out so both sides of the comparison were the same five.
  Fixed honestly: five declarers named explicitly, with Hue surveyed separately as a
  non-declaring starter rather than silently dropped.
- **MAJOR — deleting `inferrerAdapter.test.ts` orphaned three SHIPPED exports**, including
  `liveInferenceAdapter` and its AL-05 gate ("a real inference must never run on the mock
  demo brain"). This is the **same class of defect P3 was caught on**, caught again one
  phase later — evidence the coverage-migration check should be standing practice, not a
  one-off. **CLOSED:** `inferenceAdapterLadder.test.ts` restores 22 tests.
  **Orchestrator mutation-proof:** removing the demo-brain gate from `decideWire()` fails
  **2 tests**; restored, `grep MUTANT` = 0, suite green.
- **NAMED EXIT ITEM CONFIRMED — `llmProposalSchema` is DELETED.** Every remaining textual
  reference in the tree is a historical comment; the export is gone from
  `packages/protocol/src/index.ts`. The schema whose `.omit()` list caused the original
  Coinbase defect no longer exists.
- **Two vacuous-green defects the red-stage agent found in ITS OWN tests** before handing
  off, which is the behaviour this process is trying to produce: 9 auth assertions passed
  against a *missing* registry entry (`undefined?.endpoints` is falsy, so "declares no
  endpoints" went green over exactly the state P4 exists to change), and 4 demo-variant
  assertions passed for unknown variants. Both tightened before implementation.
- **A factually wrong comment on the parked AL-09 branch was recorded, not silently fixed**
  (AC6 says port as-is): the AC3 lint's comment claims `tokenLabel` cannot false-positive,
  but `'tokenLabel'.split(/(?=[A-Z])|_/)` → `['token','label']`, so it does. The rule is
  defensible; the comment was not. Rule kept byte-identical, finding written down.

**Suites, re-run live by the orchestrator: root 19/19 UNCACHED · protocol 221 · auth 346 ·
db 236 · knowledge 120 · playground 594 · examples 170/170.**

**Carried to P5:** the brand-adjacent registry-borrow evasion (`"Spotify Inc"` misses the
name-keyed registry) · a flaky Playwright journey (1 failure in 5 full-suite runs, a
DOM-detach race in `openWizardFromCard`; passes 5/5 in isolation) · the four new
`?demoreq=starter-*` variants are exercised by vitest but by no Playwright journey.
