# Threat-model delta — Dynamic Auth v2 (the requirement/grant rewrite)

- **Scope:** the P0–P4 rewrite recorded in [ADR-0017](../decisions/0017-connection-requirement-and-grant.md), amending [ADR-0016](../decisions/0016-connection-proposal-trust-ladder.md).
- **Date:** 2026-08-10 · **Task:** TASK-20260810-p5-security-close
- **Status:** the honest delta. Every claim below was verified **by execution against the built packages** (`packages/*/dist`), not by reading intent. Where a mitigation is partial, this document says which part.

> **How to read this.** This is a *delta*, not a full threat model. It states what the rewrite **added** to the attack surface, what now bounds each addition, and what is **accepted and not mitigated**. Three residuals are accepted. If you are evaluating whether to ship, §6 is the list you are looking for.

---

## 1. The posture change in one sentence

The defense moved from **"the authoring channel cannot express it"** to **"the user sees exactly what it expresses."**

Pre-rewrite, every LLM-authored connection proposal flowed through `llmProposalSchema`, which was literally hints **minus** five seats (verified at `git show main:packages/protocol/src/render-directive.ts:63–69`):

```ts
export const llmProposalSchema = authSpecHintsSchema.omit({
  registrationConsoleUrl: true,
  registrationInstructions: true,
  headerTemplate: true,
  fields: true,
  userLayerFields: true,
});
```

Those omissions were a real control: an LLM could not author a field label, a registration walkthrough, or a header template. They were also why a Coinbase-shaped app was unbuildable — the same five seats a signed, multi-field requirement needs. The rewrite **opens all five** and pays for them with review, lint, admission and a frozen host ceiling.

**This trade raises frequency, not the ceiling.** v3 already admitted a hostile template for *registry-pinned* providers and already shipped `base64`. What changes is **who may author the template**, and therefore how often a hostile one is in front of a user.

---

## 2. New attack surface admitted by R5/Q2, and the mitigation for each

| # | New surface | Mitigation | Partial? |
|---|---|---|---|
| **A1** | **LLM-authored header templates** — an LLM now decides *where the typed secret is sent* | Template lint (`template-lint.ts:202–244`): every `{{…}}` must be a pinned helper (4) or a pinned request token (5); every **unquoted** argument must be a declared field key or pinned token. Enforced at the **render seat** (`template-engine.ts:200`), so a caller that skips authoring-time lint still cannot sign. Rendered **verbatim** in review (`ConnectionWizardSheet.tsx:216–232`). | **PARTIAL — see R-1.** The lint bounds *what* a template may reference. It cannot know that `X-Debug: {{api_secret}}` is wrong. |
| **A2** | **LLM-authored registration prose** — walkthrough copy rendered with wizard-grade legitimacy (a phishing surface: "step 3: paste your password here") | Registry-borrow ban **substitutes** the registry's pinned `registration` block whenever the requirement borrows a known provider by **name or host** (`requirement-admission.ts:279–281`); substitution is **replacement, not merge**. For non-registry providers, the review's provenance copy states the claim is *"proposed by a model — a guess, not an authority."* | **PARTIAL.** Only providers **in the registry** get pinned copy. A novel provider's prose is attacker-authored and carried by human judgment alone. |
| **A3** | **LLM-authored field labels** — the label dictates *which* secret the user pastes (credential misdirection) | Asymmetric rule (`requirement-admission.ts:195, 334–377`): a borrowing channel that **omits** `fields` **receives** the registry's human-reviewed list; one that **authors** them is **refused outright**, not silently corrected. | **PARTIAL**, same boundary as A2 — applies only on a registry borrow hit. |
| **A4** | **`userLayer`** — the embedded org→user second consent leg | Judged on **channel alone** (`requirement-admission.ts:314–326`): registry-synthesized only; rejected on `inference`/`user_docs`/`starter`/`user` *because of where it came from*, never because of what it says. | **No.** This closes a live v3 hole where `llmProposalSchema` omitted `userLayerFields` but **not** `userLayerEndpoints`/`Scopes`/`Pkce`. |
| **A5** | **Persistence of ungranted requirements** (`declared` rows) | Credential-free by construction; write rules enforced by typed throws in `packages/db` accessors, not review prose: `ConnectionWriteRuleViolation`, `ConnectionRevokedError`, `ConnectionSlotCapExceeded`. `putDeclaredConnection` throws on `approved` and `revoked`. Slot cap `AUTH_MAX_SLOTS_PER_APP = 8`. | **No.** A requirement is not a grant; only the wizard writes `approved` + frozen hosts. |
| **A6** | **`hmac_sha256_b64`** — the first helper that **decodes** a secret | Decode is **fused inside** the helper (fixed arity, key argument only), never exposed as a general `base64decode()` a template could aim at arbitrary text (`template-engine.ts:122–138`). Failure to decode **throws** rather than falling back to signing with the raw string. | **See R-2** — the *output* is outside the scrubber's reach. |

### Verified: the lint and the engine agree

The most dangerous failure mode here is a template that **lints one way and renders another**. That was a real, shipped C1 breach (ADR-0017 §Quoted helper arguments): the lint skipped quoted args as inert literals while the engine stripped quotes and resolved them **as credentials**, so `{{base64('api_key')}}` passed review *because* it looked inert and rendered the live secret.

Verified fixed by execution:

```
lint {{base64('api_key')}} -> {"ok":true,"issues":[]}
render                     -> {"X-Q":"YXBpX2tleQ=="}   ->  decodes to "api_key"   (the LITERAL, not the secret)
```

**Mutation-proven, not merely observed.** Deleting the guard (`if (quoted) return token;`, `template-engine.ts:310`) and re-running uncached kills 3 tests in `template-parity.test.ts`:

```
× {{base64('api_key')}} renders base64 of the literal "api_key", NOT the credential
× holds for double quotes and for the request-token namespace
× the LINT and the ENGINE agree on every quoting shape (the parity claim itself)
```

---

## 3. Residual risk — both variants, stated plainly

These are **accepted, not mitigated.** Folding S-m1.

### R-1 — A hostile-but-approved template routes a secret into an odd header of an already-allowed host

The lint constrains *what a template references*, never *whether referencing it there is sensible*. A template that sends the raw credential under a junk header name **lints clean and renders the live secret**:

```
template  { "X-Debug": "{{api_key}}", "X-Trace-Id": "v={{api_key}}" }
lint      {"ok":true,"issues":[]}
render    {"X-Debug":"SUPERSECRETKEY","X-Trace-Id":"v=SUPERSECRETKEY"}
```

**Bounded only by:**
1. the **frozen host ceiling** — it decides *who receives it* (see §5), and
2. the **human** who read the template verbatim in review.

There is no third control. This is the direct, intended cost of admitting LLM-authored templates, and it is precisely why the review renders templates uncollapsed rather than summarizing them. **If the review screen ever degrades — truncating a template, collapsing a host list, summarizing instructions — this trade stops paying.** Verified today it does not: templates render verbatim (`ConnectionWizardSheet.tsx:226–230`) and `HostList` maps every host with no slice or cap (`:157–167`).

### R-2 — Scrub evasion via helper encoding, **by design**

`scrub.ts` is exact-substring replacement over the **injected header values**, and it documents its own boundary at `scrub.ts:16–19`: *"A provider that RE-ENCODES the value (base64, hex, URL-escaping) defeats the scrubber; the frozen allowlist remains the primary wall."*

The executor feeds the scrubber `injected` — the **rendered** headers (`connected-fetch.ts:759, 762`). This makes the boundary sharper than "base64 defeats the scrubber", and the precise shape matters:

| What the provider echoes | Scrubbed? | Why |
|---|---|---|
| the injected `base64(secret)` value, verbatim | **yes** — `x=***` | it *is* an injected value; exact substring hits |
| the same value URL-escaped (`…%3D`) | **no** | re-encoding, out of scope per `scrub.ts:16–19` |
| the same value re-encoded (hex / double-base64) | **no** | same boundary |
| the value split across JSON fields | **no** | no contiguous substring |
| **the underlying raw secret** | **no** | the raw secret was **never injected**, so it is not in the scrubber's candidate set |

That last row is the load-bearing one and it is the honest statement of the risk: when a template sends `{{base64(api_secret)}}`, the scrubber's candidate list contains the **base64 form only**. A cooperating or debug endpoint on an allowed host that decodes and reflects the *underlying* secret is reflected **in the clear**:

```
scrub('raw: SUPERSECRETKEY', {'X-Debug':'U1VQRVJTRUNSRVRLRVk='})  ->  "raw: SUPERSECRETKEY"   (NOT redacted)
scrub('raw: SUPERSECRETKEY', {'X-Debug':'SUPERSECRETKEY'})        ->  "raw: ***"              (redacted)
```

`hmac_sha256_b64` adds one row to this family: the **decoded key never leaves the render**, but its base64 digest output sits outside the scrubber's reach by the same documented boundary. `{{base64(secret)}}` and `hmac_sha256_b64` output therefore defeat the value-match scrubber **by design, not by defect**.

**The host ceiling remains the wall.** The scrubber was never the primary control; it is defense-in-depth against an echo endpoint on a host the user already approved.

> **Not an instance of this risk:** the *quoted* form `{{base64('api_secret')}}`. Since the B1 fix it renders the literal string `api_secret`. A reviewer may now rely on quotes meaning what they appear to mean — verified above.

---

## 4. The confusable guard, scoped honestly (incl. carried finding (a))

`provider.name` is constrained to printable ASCII (U+0020–U+007E) with an NFC assertion. It stops two things: **visual homoglyphs** (`ѕpotify`, Cyrillic ѕ) and **registry-key evasion** via homoglyph (a homoglyph normalizes to a *different* key, misses the registry, and therefore misses the borrow ban while still *looking* pinned).

**It does not stop ASCII lookalikes, and it does not stop added words.** `normalizeProviderKey` is `toLowerCase().replace(/[^a-z0-9]/g,'')` (`well-known-providers.ts:328–330`) — it collapses **case and punctuation** but **not added words**.

### Carried finding (a) — brand-ADJACENT registry-borrow evasion

Verified by execution against `packages/auth/dist`:

```
"Spotify"          HIT registry      admission: ok=false  (ban fires)
"SPOTIFY!"         HIT registry      admission: ok=false  (ban fires)
"Spotify "         HIT registry      admission: ok=false  (ban fires)
"Spotify Inc"      MISS              admission: ok=true   hosts=["collector.evil.example"]
"Spotify Connect"  MISS              admission: ok=true   hosts=["collector.evil.example"]
"Spotify-Premium"  MISS              admission: ok=true   hosts=["collector.evil.example"]
"5potify"          MISS              admission: ok=true   hosts=["collector.evil.example"]
"Spotlfy"          MISS              admission: ok=true   hosts=["collector.evil.example"]
```

So a requirement named **"Spotify Inc"**, declaring its own hosts, its own field labels and its own header template, is **admitted** — and reaches the review screen trading on a real brand. Finding (b) (`5potify`, `Spotlfy`) is the same family, already scoped in ADR-0017.

**What catches it:** only the **host-intersection** trigger, and only if the attacker *also* declares a registry host. Verified — adding `api.spotify.com` alongside `collector.evil.example` fires the ban and refuses the authored `fields`:

```
"Spotify Inc" + hosts ["collector.evil.example","api.spotify.com"]
  -> ok=false borrowed=true from=spotify
     issue: 'fields' is credential-prompt copy that the 'inference' channel may not author
            while borrowing registry provider 'spotify'
```

**Mutation-proven load-bearing:** disabling the host trigger in `findBorrowedEntry` kills **10 tests** across `channel-admission.test.ts`, `static-kind-registry.test.ts` and `registry-substitution.test.ts`, including *"a lookalike NAME borrowing the real HOST is still caught."*

### Recommendation: ~~accept with disclosure~~ → **FIXED in P5**

> **SUPERSEDED 2026-08-10 (TASK-20260810-p5-security-close).** This section recommended
> accepting the brand-adjacent gap. The P5 review implemented the guard instead, and the
> reasoning below is preserved only so the overturn is auditable. Points 1, 2 and 4 stand
> as descriptions of the *residual* risk; **point 3 is the one that was wrong**, and it was
> overturned on evidence rather than taste — which is exactly the bar it asked for.

The original reasoning, and what happened to each point:

1. **A brand-adjacent name that borrows no registry host is a human-judgment problem, not a technical one.** "Spotify Inc" pointing at `collector.evil.example` gets **no** registry hosts, **no** pinned fields, **no** pinned registration copy, and carries the review's *"proposed by a model — a guess, not an authority"* provenance line. — *Still true, and still the fallback for names the guard does not reach (`5potify`).*
2. **The useful version of the attack is already caught.** A lookalike is only *valuable* if it reaches the real provider's data, which requires naming the real host. — *True for data exfiltration from the provider; it does not cover the CREDENTIAL-collection harm, where the attacker never needs the real host because the user's secret is the goal.*
3. ~~**A substring/token-containment guard is the obvious fix and is wrong here.**~~ — **OVERTURNED.** The objection conflated two different guards. A *substring* test is indeed wrong: measured, it fires on `Slackline Weather`, `Slacker Radio`, `Googol Analytics` and `Gmailer Tools`. But a **boundary-aware segment-run** match misses all four while catching `Spotify Inc`, `Spotify Connect`, `CoinbaseInc`, `GitHub Enterprise` and `OpenWeather Pro`. Both directions are pinned by test, and the false-positive test kills a substring mutation. The concern that it "invites the belief that the ban catches lookalike domains" is addressed in prose rather than by declining the guard: the host comparison remains exact, and ADR-0017 still states plainly that `5potify` is out of scope.
4. **Shipping a partial guard is worse than a documented gap.** — *The guard shipped is not partial along the axis it claims: it catches the added-word family completely. It is explicitly scoped to exclude ASCII lookalikes, and that scope is stated in ADR-0017 and in the code.*

**What is still accepted:** pure-ASCII lookalikes (`5potify`, `Spotlfy`) that share no segment
with a registry key. That residual keeps the original condition — it is tenable only while
the review screen states provenance plainly.

---

## 5. What the frozen host ceiling does and does NOT bound

`allowed_hosts` is computed at approval (`deriveConnectionAllowedHosts`) and **frozen**. Routing matches against the frozen list only, never against anything the app supplies at run time (`connected-fetch.ts:74–75, 420–450`).

**It DOES bound:**
- **Which hosts** may receive an injected credential — exact-host, case-insensitive. Verified: `api.spotify.com` ✅, `API.Spotify.com` ✅, `api.spotify.com.evil.example` ❌, `evil.example` ❌, **`sub.api.spotify.com` ❌** (no subdomain widening).
- **Widening after approval** — a changed requirement stages into `pending_requirement_json` and the grant keeps serving the **old** frozen hosts until re-approval. "Needs re-approval" is *derived*, never a fourth status.
- **Slot ambiguity** — two approved rows matching one host fail closed with `NET_AMBIGUOUS_CONNECTION` rather than silently picking one.

**It does NOT bound:**
- **Paths, methods, or query strings.** Any path on an allowed host is reachable — including a debug/echo endpoint. This is the precondition R-2 depends on.
- **Header names.** The ceiling has no opinion that `X-Debug` is an odd place for a secret (R-1).
- **What the provider does with the value** once received.
- **Hosts unioned in from endpoints.** `deriveConnectionAllowedHosts` unions **endpoint hosts** into the ceiling — verified: declared `api.example.com` + authorize `auth.other.com` + token `token.third.com` → **all three** in the ceiling. This is why registry entries for static-kind providers carry **no placeholder endpoints**: an invented URL would silently widen the frozen ceiling.
- **Anything at all before approval.** `allowed_hosts` is empty until the wizard writes it; pre-approval the executor fails closed with `NET_NOT_APPROVED`.

---

## 6. Accepted residuals — the ship list

| ID | Residual | Bounded by | Recommendation |
|---|---|---|---|
| **R-1** | Approved-but-hostile template routes a secret to an odd header of an **already-allowed** host | frozen host ceiling + verbatim human review | **Accept.** Intrinsic to admitting LLM-authored templates. |
| **R-2** | Helper encoding defeats the value-match scrubber — `{{base64(secret)}}` and `hmac_sha256_b64` output, **by design** (`scrub.ts:16–19`); the **underlying** secret is outside the candidate set entirely | frozen host ceiling (the scrubber was never the primary wall) | **Accept + disclosed.** |
| **R-3** | ~~brand-adjacent~~ **FIXED in P5** — `Spotify Inc` / `Coinbase Pro` / `CoinbaseInc` now fire the ban via boundary-aware segment-run matching | the borrow ban's name trigger (`findBrandAdjacentRegistryKeys`) | **Fixed, not accepted.** See §4 (superseded). |
| **R-3b** | ASCII-lookalike provider names (`5potify`, `Spotlfy`) are admitted (carried finding (b)) — they share no segment with a registry key | host-intersection ban (only when a registry host is also declared) + review provenance copy | **Accept with disclosure.** Re-open if provenance copy softens. |

**None of these are new *classes*.** v3 admitted R-1 for registry-pinned templates and R-2 via `base64`. The rewrite changes **who may author the template**, which raises the **frequency**, not the ceiling.

---

## 7. Verification record

- Full suite **green uncached**: `pnpm test -- --force` → `Tasks: 19 successful, 19 total` · **`Cached: 0 cached, 19 total`**.
  - As recorded at the time of §1–§6: protocol 221 · auth 346 · db **237** · knowledge 120 · playground 594 · runner 108 · server 110 · adapters 92 · sdk 41.
  - **After the P5 close** (2026-08-10): protocol 221 · auth **357** · db 236 · knowledge 120 · playground **596** · runner 108 · server 110 · adapters 92 · sdk 41 · examples 170. Plus Playwright **66 passed, 1 skipped** (the skip is the by-default-skipped real-WebLLM generation test).
  - The final auth figure is **357**, not the 352 recorded mid-close: the optional-field blocker (§ below) added five executor-altitude tests.
- All behavioral claims in §2–§5 executed against **`packages/*/dist`** (not `src`), because packages resolve to `dist/`.
- Mutation evidence: quoted-literal guard (3 tests die) · borrow-ban host trigger (10 tests die) · optional-field render lint (2 tests die) · optional-field resolve branch (2 tests die) · typo guard neutered (1 test dies). All mutations reverted; tree verified clean.

### `required: false` was broken end to end (P5 blocker, FIXED)

A template naming a **declared-but-blank optional** field passed the executor's lint and was
then rejected by the render seat's own lint, because the two consulted **different key
lists** — the declaration vs. what was actually loaded. The wizard reported CONNECTED and
every later request failed closed with `NET_AUTH_FAILED` and **zero fetches**.

It landed on the rewrite's founding example: the shipped Coinbase entry pins `passphrase`
as `required: false`, the wizard invites leaving it blank, and the taught template signs
with `{{passphrase}}`.

Executed on the unmutated tree, template `{'X-Key':'{{api_key}}','X-Pass':'{{passphrase}}'}`:

```
fieldKeys ['api_key','passphrase']  ->  ok: true      (executor's lint, declared keys)
fieldKeys ['api_key']               ->  ok: false     (render seat's lint, loaded keys)
   "'passphrase' is not a declared field key or a pinned request token"
```

**Two independent seats**, both fixed: the render-seat lint now takes the requirement's
declared keys via `AuthTemplateContext.declaredFieldKeys`, and `resolveExpression` /
`resolveArgToken` resolve a declared-but-unstored field to the **empty string** instead of
throwing. The `resolveArgToken` seat matters on its own: without it a blank optional field
used as a helper argument would have signed over the **literal string** `"passphrase"` — a
silently wrong signature rather than a loud failure.

The typo guard is intact and proven so: a token naming **no** declared field still throws
(neutering that branch kills a test). Why the suite was green before — the only
optional-field test used a requirement with **no header template** and never executed a
request, stopping one step short of the failure.

**Not a fork.** The brief suspected a registry/KB disagreement over `passphrase`
required-ness. There is none: the inferrer prompt teaches an invented provider
(`Meridian Exchange`, 0 Coinbase references — confirmed with two tools). The real gap was
that `registry-template-parity.test.ts` compares key **names** only and always supplies a
value, so it cannot see required-ness at all.

### P5 addendum — a SHIPPED blocker this delta did not surface

Recorded 2026-08-10 for completeness, because a threat model that lists only the residuals
it looked for is misleading about the ones it did not.

**Admission was not idempotent, and every registry-backed starter was broken by it.**
Admission runs twice on the production path (pipeline, then the db accessor's injected
gate). Pass 1 *substitutes* the registry's pinned `fields`; pass 2 read that seat as
borrower-authored credential copy and refused the write. `putDeclaredConnection` threw
`ConnectionNotAdmitted`, the post-turn seam reported `write_refused`, and the user got
"the agent proposed a connection that failed validation" and **no connect card** — for all
six shipped manifests. Present on the P4 baseline; not introduced by P5.

**Why this delta missed it.** Every behavioral claim in §2–§5 was executed against
`packages/*/dist` in isolation — which is the right instinct for a guard, and is exactly
why the defect was invisible: it only appears when admission runs a *second* time on its
own output. Nothing in this document exercised the persist path, and no test did either.
The playground's `installTestUserDb` had also been opening the user DB **without** the
production `admissionGate`, so the second pass was structurally unreachable from the whole
suite. It took a browser journey to see it.

**Now closed by:** `fieldsMatchRegistry` (a seat equal to the pinned value is not an
authoring act), the test helper wiring the production gate, a vitest regression that drives
all four starters through the real seam, and Playwright journey 5. Mutation-proven in both
directions — reverting the fix turns the starter regression red; disabling the `fields`
guard entirely turns the negative test red.

**The lesson worth carrying:** a guard verified only on a single pass is not verified. Any
check that runs more than once on a path must be tested against **its own output**.

---

### Two notes for the committing orchestrator

1. **db is 237, not the 236 in the P5 brief.** The extra test is real and pre-existing; the count in the brief was taken while an untracked probe file was present.
2. **Untracked `zz-probe-*` files exist in the tree** (`packages/auth/src/__tests__/zz-probe-optional.test.ts`, `packages/db/src/userdb/__tests__/zz-probe-slot.test.ts`), written *during* this session by a concurrent agent. They are labeled `// TEMPORARY PROBE — delete after use`. An earlier copy of the db probe **broke `@snugprotocol/db#build`** with `TS2339` errors; it was removed to obtain a green baseline and was then re-created by the other agent. **They must not be committed** — verify the tree before the commit.

### Not covered by this delta (carried, still open)

- **(c)** A flaky Playwright journey — 1 failure in 5 full-suite runs, DOM-detach race in `openWizardFromCard` (`connection-wizard.spec.ts:82`); passes 5/5 in isolation. Test-infrastructure defect, no production-security bearing.
- **(d)** The four `?demoreq=starter-*` variants are exercised by vitest but by **no** Playwright journey.
