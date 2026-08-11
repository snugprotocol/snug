# TASK-20260810-p5-security-close: Dynamic Auth v2 — P5, security close-out

- **Status**: **ACTIVE — Gate 5 (close-out).** Final child of the Dynamic Auth v2 rewrite (P0→P5). All code work landed; this file is the record.
- **Owner**: Claude (orchestrator; owner directed an autonomous P0→P5 run on 2026-08-10)
- **Risk tier**: **High** — touches `packages/auth` (credential broker: `template-engine.ts`, `connected-fetch.ts`, `requirement-admission.ts`, `well-known-providers.ts`).
- **Branch**: `feat/TASK-20260810-p5-security-close` (cut from P4 — the whole P0–P4 rewrite is in its ancestry).
- **Parent plan**: `docs/TASK-20260810-plan` branch — read with `git show docs/TASK-20260810-plan:docs/tasks/active/TASK-20260810-dynamic-auth-rewrite.md`.
- **Umbrella**: [`TASK-20260805-alpha-umbrella.md`](TASK-20260805-alpha-umbrella.md) — this task re-checks the umbrella ACs the rewrite owns.

## What P5 delivered

The carried findings P0–P4 deliberately deferred here, plus one BLOCKER found during the fold:

1. **`required: false` was broken end-to-end (BLOCKER, found and fixed in P5).** A blank optional
   field — the intended user path for Coinbase's `passphrase` — threw `AuthTemplateLintError` at
   the render seat. Fixed at **three** seats: `AuthTemplateContext.declaredFieldKeys` (render-seat
   lint now uses the declaration, the same list `connected-fetch.ts` already checked),
   `resolveExpression`, and `resolveArgToken`. The third was **not** in the prescribed fix and is
   load-bearing: it does not throw, it falls through to a literal, so a blank optional field used as
   a helper argument would have signed over the literal string `"passphrase"` — a silently wrong
   signature instead of a loud `NET_AUTH_FAILED`.
2. **Brand-adjacent registry-borrow evasion (carried finding (a)) — CLOSED.** `findBrandAdjacentRegistryKeys`
   now catches added-word evasions that `normalizeProviderKey`'s `toLowerCase().replace(/[^a-z0-9]/g,'')`
   collapsed past.
3. **The flaky Playwright journey (carried finding (c)) — CLOSED** by genuine product CSS fixes.
4. **ADR-0017 residual #2 aligned** to the executed per-case scrub table (it overstated one case and
   understated the other).

## Umbrella AC disposition — the ACs this rewrite owns

### AC5(a) — two-layer callback unwraps `userLayer`: **MET, and checkable now**

Re-pointed at the `userLayer` seat in `connectionRequirementSchema` per fold **T-M7**, as P0 §A.3
promised. Two independent halves, both verified by execution against `dist/` (not source):

- **The unwrap itself** (the original OProject audit bug 1): `packages/auth/src/oauth-service.ts`
  resolves the effective layer via `requireAuthCodeLayer` at **both** `:335` (start) and `:379`
  (callback). The source system unwrapped on start only, so its two-layer loop could never complete.
  The `:379` comment names it: `// bug 1: the callback unwraps too`.
- **The channel guard** (`requirement-admission.ts:380–388`): `userLayer` is registry-synthesized
  ONLY, judged on **channel alone**, never on what it says.

**Why it is checkable now and was not before.** P0's own audit recorded that
`admitConnectionRequirement` had **no production caller**, so "AC5's userLayer channel guard is
unreachable and its tests pass while the property does not hold at the only path that persists a
requirement." That is now closed — four production call sites plus a db-layer floor:

| Seat | Line |
|---|---|
| `apps/playground/src/agent/connectionPipeline.ts` | `:153` (build/edit pipeline) |
| `apps/playground/src/starter/starterDeclaration.ts` | `:150` (`channel: 'starter'`) |
| `packages/auth/src/connection-requirement-inferrer.ts` | `:225` (inference rungs) |
| `apps/playground/src/state/userdb.ts` | `:31` (the default that holds the floor) |

Executed across all five channels (probe deleted):

```
registry   ok=true
inference  ok=false  userLayer is registry-synthesized only — the 'inference' channel may not declare one
user_docs  ok=false  (same)
starter    ok=false  (same)
user       ok=false  (same)
```

### AC5(b) — session binding: **MET by citation, and THE CITATION STILL HOLDS after the P3 rebuild**

This is the claim the close-out was told to distrust, because P1 closed it by citing
`apps/playground/src/state/wizard.ts` — **a file P3 deleted**. It was re-derived from scratch against
the replacement, `apps/playground/src/state/connectionWizard.ts`. **All four load-bearing facts
survive; only the line numbers moved.** No `expectedSessionId` exists and none is needed.

| P1's cited fact | Old cite (deleted file) | New cite — verified |
|---|---|---|
| `activeFlow` is module-scoped memory, the ONLY source of `expectedFlowId` | `wizard.ts:186` | `connectionWizard.ts:669` — `let activeFlow: ActiveFlow \| null = null` |
| Callback passes the caller's OWN held copy, never parsed from the delivery | `wizard.ts:565` | `connectionWizard.ts:899` — `expectedFlowId: start.flowId, // the HELD copy, never parsed out of the delivery` |
| Delivery drops unless a live session AND a live flow | `wizard.ts:544–547` | `connectionWizard.ts:884` — `if (activeFlow === null \|\| connectionWizardStore.get() !== session) return;` |
| Teardown nulls `activeFlow`, so ending the session destroys the binding | `wizard.ts:216–226, 346–352` | `connectionWizard.ts:702–712` (`teardownFlow`) + `:250–256` (`forceCloseWizard`) |
| 128-bit CSPRNG flowId, checked against the signed state | `oauth-service.ts:338/387` | **unchanged** — `randomBase64Url(16)` at `:338`, `payload.flowId !== expectedFlowId` at `:387`, flow burned at `:390` |

**The falsifiers P1 named were re-checked, not assumed.** `activeFlow` is still module memory
(`grep` for `localStorage|sessionStorage|OPFS|persist` in `connectionWizard.ts` returns no
persistence of flow state); `flowStateStore` is `InMemoryFlowStateStore`; `flowId` is still CSPRNG,
not derived from `appId` or a counter. The staleness guard survived the rebuild in strengthened form
— `stale()` at `:798` is an identity check re-run after **every** await (`:808`, `:810`, `:817`).

**P3's new confirm-before-discard was audited specifically for this AC, because it is exactly the
kind of change that could open a gap** — a session that ends while `activeFlow` survives would break
the subsumption. It does not: `closeConnectionWizard` (`:234`) returns `'needs_confirm'` **without
touching anything** when a flow is in flight (the session survives, the popup stays open, the channel
stays subscribed), and the only path that ends a session is `forceCloseWizard` (`:250`), whose first
statement is `teardownFlow()`. Session-end and flow-teardown remain inseparable.

**Scope limit, restated:** this covers the *playground* caller, still the only `handleCallback`
caller in the repo. An embedder holding `expectedFlowId` in cross-session storage would need its own
analysis; the obligation transfers with the caller, not the service.

### AC5(c) — strict host injection always-on, not a flag: **MET, structurally**

No injection-mode knob exists anywhere in `packages/auth` production source. The property is guarded
by a *structural* test, not just absence: `packages/auth/src/__tests__/browser-safe.test.ts:128`
greps the shipped surface for `strictHost*|skipValidation|skipHostCheck|allowInsecure|insecureMode|disableHostCheck|bypassHost*|unsafeAllow*|noVerify`,
and `:155` additionally bans `STRICT_AUTH_HOST_INJECTION|injectionMode|hostCheckMode|enforceHosts|process.env`.
So a future flag cannot be added silently. (The only `allowInsecureRequests` hits are
`apps/server/src/auth/oidc.ts:60`, the local fake OIDC issuer over http — a different subsystem, not
the credential-injection path.)

### Umbrella AC7 — suites green after the change

Met. Real uncached counts below.

## R1–R8 against what shipped

| # | Rule | Verdict |
|---|---|---|
| **R1** | Infer at build, bake before run | **MET** — requirement declaration at the **post-turn seam**; `declared` rows persist when the app version is saved, before first run. |
| **R2** | Never infer at run | **MET** — run-time inference **removed**, not gated. No `runWizardInference` / "infer from docs" exists in production source; guarded by a negative test (`connectionWizard.test.tsx:592` asserts the source carries no inference seam) **and** a Playwright journey (`connection-wizard.spec.ts:328`). |
| **R3** | Re-infer only on auth-touching edits | **MET** — deterministic backstop, not vibes: `canonicalRequirementHash` decides "changed" (`userdb.ts:1268` returns the SAME version on an identical hash); approved rows route to `stagePendingRequirement`, and the executor binds the **approved** grant, never the pending one. |
| **R4** | Starters dev-time inferred, install copies | **MET** — six manifests; install copies requirement into `snug_connections` (never credentials); registry `fields` substituted for omitting borrowers. Playwright journey 5 covers the registry-pinned field. |
| **R5** | Any credential shape | **MET** — five kinds + `none`; multi-field static (Coinbase key/secret/passphrase), signed headers (`hmac_sha256`, `hmac_sha256_b64`), PAT, basic, both OAuth flavors, two-layer. **The `required: false` blocker fixed in P5 was the last gap here** — before it, the optional-field shape was expressible but not *usable*. |
| **R6** | One connection today, N tomorrow | **MET** — slot-keyed storage/runtime/UI; `AUTH_MAX_SLOTS_PER_APP = 8`; `NET_AMBIGUOUS_CONNECTION` refuses rather than guesses between credentials; KB still teaches one-connection doctrine. |
| **R7** | Grandma UX | **MET** — step machine `review → register → credentials → connect → done`, one decision per screen, verb buttons, numbered walkthroughs, masked fields, live progress. Plus an owner-decision confirm before discarding an in-flight sign-in. |
| **R8** | Security bar unchanged | **PARTIALLY MET — and this is the one to read.** C1–C5 hold, fail-closed runtime holds, no trust decision was weakened, and the rewrite **raised** the bar in places (kind-agnostic borrow ban, brand-adjacent containment, structural no-flag guard). **But three residual risks are accepted-not-mitigated** (ADR-0017 §Residual risk) and one is *new in frequency*: admitting LLM-authored header templates means risk (1) — an approved-but-hostile template routing a secret into an odd header of an already-allowed host — now has many more authors than v3's registry-pinned templates. ADR-0017 states this honestly: "What the rewrite changes is who may author the template, which raises the frequency, not the ceiling." Calling R8 fully met would paper over that. |

## Test evidence — real, uncached

`pnpm test -- --force`, exit 0, **`Cached: 0 cached, 19 total`** (per the turbo-cache hazard):

```
@snugprotocol/protocol:test:  Tests  221 passed (221)
@snugprotocol/knowledge:test: Tests  120 passed (120)
@snugprotocol/runner:test:    Tests  108 passed (108)
@snugprotocol/db:test:        Tests  236 passed (236)
server:test:                  Tests  110 passed (110)
@snugprotocol/adapters:test:  Tests   92 passed (92)
@snugprotocol/sdk:test:       Tests   41 passed (41)
@snugprotocol/auth:test:      Tests  357 passed (357)
playground:test:              Tests  596 passed (596)
 Tasks:    19 successful, 19 total
Cached:    0 cached, 19 total
```

Playwright: **66 passed, 1 skipped (1.2m)**, exit 0. The skip is the by-default-skipped real-WebLLM
test. Journeys 1–5 (api_key multi-field, bearer_token, basic_auth, oauth2_auth_code, starter
registry-pinned field) all pass, as does the P3-AC6 no-inference-affordance journey.

Deltas from the P0–P4 baseline: `auth` 346 → **357** (+11: the 5 optional-field executor-altitude
tests + brand-adjacent containment). `playground` 594 → **596**. Playwright 62 → **66** (+4,
including the starter journey that closed carried finding (d)).

### Carried findings re-verified by execution

| # | Finding | State |
|---|---|---|
| (a) | Brand-adjacent registry-borrow evasion | **CLOSED.** `Spotify Inc` / `Spotify Connect` / `Spotify-Premium` / `CoinbaseInc` / `GitHub Enterprise` / `CoinGecko API` → all `ok=false`. **No false positives:** `Slackline Weather`, `Slacker Radio`, `Googol Analytics`, `Gmailer Tools`, `Githubbub` → all `ok=true`. |
| (b) | ASCII lookalikes | **OPEN by design.** `5potify` / `Spotlfy` → `ok=true`, confirmed by execution. Accepted with disclosure (ADR-0017 residual 3). |
| (c) | Flaky Playwright journey | **CLOSED.** 72/72 across three `--repeat-each=4 --workers=3` stress runs at the settings that reproduced it. Fixed by real CSS product fixes (a real user scrolling the card under the sticky header also could not click it), not a retry loop. |
| (d) | `?demoreq=starter-*` unexercised by Playwright | **CLOSED** — journey 5. |

## Everything still open

Nothing here is swept under. Grouped by who must act.

### Owner decisions required

1. **`docs/security/threat-model-delta-dynamic-auth-v2.md` is UNTRACKED** (24.8 KB). It holds the
   **only** written record of R-3b (the ASCII-lookalike acceptance) and the idempotence lesson. If it
   is not committed, that record is lost. The orchestrator/owner must decide — this task did not
   commit it (house rule: the orchestrator commits).
2. **AL-10, AL-11, AL-12, AL-15 remain HELD** for the owner's manual tests, per the 2026-08-06 scope
   amendment. This rewrite did not touch that hold. Note AL-11 (threat model v1) is the natural home
   for the delta doc in item 1.
3. **AL-09 remains PARKED** at `7b45f90`, with its rebase collision already written into its own task
   file.

### Accepted residual risks (ADR-0017 §Residual risk — carried, not fixed)

4. **Approved-but-hostile header template** can route a secret into an odd header of an
   already-allowed host. The lint bounds *what* a template references, never that `X-Debug: {{api_secret}}`
   is wrong. Bounded only by the frozen host ceiling and the human who reads the template verbatim.
   **Frequency raised by this rewrite** (see R8).
5. **Helper encoding defeats the value-match scrubber by design.** Precise boundary, executed:
   `[1] b64 injected + b64 echoed → redacted`; `[2] b64 injected + RAW echoed → NOT redacted` (the
   genuinely uncaught case); `[3] raw injected + raw echoed → redacted`. URL-escaped, hex,
   double-base64 and split-across-JSON echoes uncaught for the same reason. The host ceiling was
   always the wall; the scrubber never was.
6. **ASCII lookalike provider names accepted** — carried finding (b). Carried by the host-intersection
   ban and the review's provenance copy, not by the charset rule.

### Known gaps carried from earlier children

7. **The URL-borne credential channel is unpatched.** Nothing inspects query strings, and any filter
   must distinguish host-injected from app-authored params (OpenWeather's `?appid=` is a legitimate
   provider transport). Routed to AL-10/AL-11 as a design decision with the tension stated — still
   open.
8. **MAJOR-1 UX residue** (connection-reachability, PR #30): a user who edits their installed
   declaring app loses the guided setup. Shipped as-is; the honest fix needs the revoke tombstone
   queued to AL-10.

### Hygiene

9. **14 stale probe artifacts survive under `packages/*/dist/`** (12 in `auth`, 2 in `db`), left by
   earlier agents. Verified **inert**: `dist/` is gitignored (`.gitignore:2`), vitest's default
   exclude skips it, and the 357/236 counts confirm they are not collected. They vanish on the next
   clean rebuild. Deleting another agent's artifacts was not this task's to do. **Source tree is
   clean** — confirmed with grep AND python (per the NUL-byte hazard): `PROBE FILES IN SOURCE TREE: NONE`.
10. **The parent plan file is not in the working tree** — it lives only at
    `git show docs/TASK-20260810-plan:docs/tasks/active/TASK-20260810-dynamic-auth-rewrite.md`.
    Anyone re-reading R1–R8 needs that ref, not a path.

## Session journal

### 2026-08-10 — Claude — P5 close-out

- Re-checked the umbrella ACs this rewrite owns. **AC5(a)** re-pointed at the `userLayer` seat
  (fold T-M7) and confirmed **checkable** — the "no production caller" gap P0 recorded is closed by
  four call sites plus the db floor; verified by executing all five channels against `dist/`.
- **AC5(b) re-derived from scratch rather than trusted.** P1 closed it by citing `wizard.ts`, which
  P3 **deleted**. All four load-bearing facts survive in `connectionWizard.ts` at new line numbers,
  the named falsifiers were re-checked, and P3's new confirm-before-discard was audited specifically
  for a session-ends-while-flow-lives gap. **The citation holds.** Recorded loudly here because a
  future reader will hit the same dead file cite.
- **All three OProject audit bugs re-confirmed fixed post-rewrite**, each at source: (a) callback
  unwraps at `oauth-service.ts:379`, (b) session binding per above, (c) no injection flag, guarded
  structurally by `browser-safe.test.ts:128/155`.
- R1–R8 re-checked: **seven met, R8 partially met** — the accepted residual risks are real and the
  template-authoring frequency genuinely rose. Recorded rather than rounded up.
- Gates: root `pnpm test -- --force` **19/19, `Cached: 0 cached`**; Playwright **66 passed + 1
  skipped**.
- Probes deleted (grep + python confirmed). No `git commit` run — the orchestrator commits. C1/C2/C5
  untouched; nothing pushed to `snugprotocol/spec` (C3). No test weakened or deleted.

---

## Orchestrator verification (2026-08-10) — the BLOCKER reproduced and its fix confirmed

- **BLOCKER — `required: false` credential fields were broken end-to-end, ON THE REWRITE'S OWN
  FOUNDING EXAMPLE. Reproduced by the orchestrator, not accepted from the report:**
  - outer lint (what `connected-fetch` checks, using DECLARED keys) → **`true`**
  - inner lint (what the engine re-checks at render, using only LOADED keys) → **`false`**,
    `'passphrase' is not a declared field key or a pinned request token`
  - render → **threw `AuthTemplateLintError`**

  The shipped Coinbase registry entry marks `passphrase` `required: false`, the wizard
  explicitly permits leaving it blank, and the KB-taught template signs with
  `{{passphrase}}`. So a user who left the optional field blank got a wizard reporting
  **CONNECTED**, then every request failed closed with `NET_AUTH_FAILED` and **zero
  fetches**. This is the single worst-shaped defect found in the whole run: green suite,
  happy UI, dead product.
  **Why eleven prior lenses missed it:** it is a PHASE-BOUNDARY bug. P0 wrote the lint, P1
  wrote the executor, P4 wrote the registry entry — each correct alone. Only a
  whole-surface pass that traces a credential from authoring to wire could see the two
  lints disagreeing about what "declared" means. It is the argument for the final review
  existing at all.
  **Why the suite stayed green:** the ONLY optional-field test used a requirement with no
  header template and never executed a request — it asserted the wizard reaches `done` and
  stopped one step short of the failure.
  **FIX CONFIRMED by orchestrator execution:** `declaredFieldKeys` is now threaded into
  `AuthTemplateContext` so both lints consult ONE key source, and a declared-but-unstored
  optional field resolves to empty. With the blank passphrase: `CB-ACCESS-KEY = "K"`,
  `CB-ACCESS-PASSPHRASE = ""`, `CB-ACCESS-SIGN = computed`. **And the typo guard still
  fires** — `{{nosuchfield}}` still throws `AuthTemplateLintError`, so the fix did not
  buy tolerance by removing the protection the lint exists for.
- **AC5(b) — THE CITATION WAS RE-DERIVED, NOT ASSUMED, and it HOLDS.** P1 closed it citing
  `wizard.ts`, which P3 then DELETED; the close-out was explicitly told to distrust it.
  All four load-bearing facts were re-verified against the replacement
  `connectionWizard.ts`, and the orchestrator independently confirmed the load-bearing
  half: `activeFlow` is module-scoped memory (`:669`), the delivery guard drops anything
  without a live session AND flow (`:884`), `expectedFlowId` uses the caller's held copy
  (`:899`), and the module's ONLY persistence call is the credential write — **`activeFlow`
  is never persisted**. So flow binding still subsumes session binding.
- **Carried finding (a), the brand-adjacent borrow evasion — FIXED, and fixed in the right
  place.** The fix SEPARATES two questions that were conflated: exact-key lookup stays for
  RESOLUTION (which pinned endpoints a spec should use), while a new brand-adjacency check
  drives the BAN. Making lookup fuzzy instead would have handed "Spotify Inc" Spotify's
  real OAuth endpoints — a worse bug than the one being fixed.
  **Orchestrator-verified by execution:** `"Spotify Inc"`, `"Spotify Connect"`,
  `"Spotify-Premium"` are now all REFUSED (previously admitted with attacker hosts and
  field labels); `"Notify"` — which contains "spotify" as a substring — is correctly NOT
  caught, so it is word-aware rather than naive substring matching. `"Sp0tify"` still
  passes, which is the ASCII-lookalike limit ADR-0017 already scopes honestly.
- **MAJOR — a probe file left in the tree BROKE THE BUILD**, so an earlier "all green" claim
  was false. Two `zz-probe-*` files were re-created mid-run by a concurrent agent; the
  reviewer deliberately did NOT delete another agent's in-flight work, which was the right
  call. **Orchestrator confirmed before committing: `git status --porcelain | grep zz-probe`
  → 0, and `pnpm test -- --force` → 19/19, `Cached: 0 cached`.**
- **MINOR, accepted as documentation precision:** ADR-0017's residual-risk #2 states the
  scrub boundary slightly wrong in BOTH directions — the literal base64 echo IS redacted
  (the executor scrubs RENDERED headers), while the genuinely uncaught case is sharper and
  was unstated: the underlying RAW secret is never in the scrubber's candidate set when
  only an encoded form was injected. The threat-model delta states it as a per-case table
  with executed evidence.

**Final counts, re-run live by the orchestrator: root 19/19 UNCACHED (`Cached: 0 cached`) ·
protocol 221 · auth 357 · db 236 · knowledge 120 · playground 596 · examples 170/170.**

---

## Session journal

### 2026-08-10 — Claude (orchestrator) — Gate 6 close: the full P0–P5 rewrite is built, reviewed and green; NOTHING IS MERGED

**DONE this session.** The owner directed an autonomous P0→P5 run at `/pickup`. All six
phases shipped, each on its own branch cut from its predecessor (a linear chain), each
test-first, each with a fresh-context adversarial review folded before the next opened.

**EXACT STATE — six unmerged branches, in mandatory merge order:**

| Branch | Head | What it carries |
|---|---|---|
| `docs/TASK-20260810-plan` | `f28b109` | docs-only, off fresh `main` (fold F-M2's cherry-pick path) |
| `feat/TASK-20260810-p0-contracts` | `b731c70` | v4 contracts, template lint, slot-keyed storage, ADR-0017, staged v0.3 draft |
| `feat/TASK-20260810-p1-runtime` | `8ed1ffd` | slot routing, amended gate order, AC5(b) closed |
| `feat/TASK-20260810-p2-pipeline` | `171134a` | build-time declaration at the post-turn seam, KB doctrine, inferrer |
| `feat/TASK-20260810-p3-wizard` | `1f65044` | the grandma wizard, v3 table deleted (schema v5), coverage restored, **+ the owner's in-flight-sign-in confirm** |
| `feat/TASK-20260810-p4-starters` | `1cc026a` | registry entries, six manifests, install copy-to-rows, `llmProposalSchema` deleted |
| `feat/TASK-20260810-p5-security-close` | `5b118f7` | threat-model delta, whole-surface review, this close-out |

**MERGE ORDER IS LOAD-BEARING, not a preference.** P0 is deliberately ADDITIVE — v4 lands
*alongside* v3 — because `starterDeclaration.ts` imported `llmProposalSchema` at runtime and
33 files touched the `snug_auth_specs` surface. The two deletions are the named exit items
of P3 and P4 respectively. PR'ing out of order breaks the cutover rule and makes "every
phase ends green" unsatisfiable.

**FINAL COUNTS, re-run live and UNCACHED (`Cached: 0 cached, 19 total`):** root **19/19** ·
protocol 221 · auth 357 · db 236 · knowledge 120 · playground 596 · examples 170/170.

**THE SINGLE NEXT STEP:** the owner reviews the six branches and opens PRs **in P0→P5
order**. Nothing else should start on this surface first.

**OPEN QUESTIONS / ITEMS FOR THE OWNER (nothing swept under):**
1. **AL-12 stays HELD.** P0 created only the LOCAL staged v0.3 draft under the owner's
   2026-08-10 carve-out. SPEC_SYNC steps 1–3 + 6 taken; **steps 4–5 NOT taken; nothing was
   pushed to `snugprotocol/spec`.** Publication remains an explicit-ask gate.
2. **A flaky Playwright journey** — 1 failure in 5 full-suite runs, a DOM-detach race in
   `openWizardFromCard` (`connection-wizard.spec.ts:82`); passes 5/5 in isolation. Not
   diagnosed. Worth fixing before it teaches anyone to re-run a red.
3. **The `?demoreq=starter-*` variants** have vitest coverage but no Playwright journey.
4. **ASCII-lookalike registry-borrow** (`Sp0tify`) is accepted-with-disclosure per ADR-0017 —
   carried by the review's provenance copy, not the guard. Revisit if an untrusted
   declaration channel ever opens.
5. **ADR-0017 residual-risk #2** is slightly imprecise versus shipped scrub behavior in both
   directions; the threat-model delta states it correctly. Align when convenient.
6. **The AL-09 branch stays parked** at `86a564c`, never merged (Q8). Its harvested HTML was
   reviewed as it came across; the branch itself is now spent as a source.

**PROCESS NOTE, recorded because the owner should weigh it against the next autonomous run.**
The bar found real defects on **twelve consecutive reviews** — including a live
credential-exfiltration hole (P0), a pipeline unreachable from production (P2), 14 shipped
behaviors silently losing their guard (P3), registry field lists that were dead code so
starters showed ZERO credential boxes (P4), and `required: false` fields broken end-to-end on
the rewrite's own founding example (P5). Folding the review INTO each phase preserved the
bar's substance, which is what the autonomous run was betting on. What it could not replace
is the owner's eyes at a phase boundary: four of those were BLOCKERs that would have been
cheaper to catch there than after the next phase had built on top. **Recommendation: keep the
per-phase adversarial review, and keep the owner gate for High-tier children.**
