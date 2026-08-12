# TASK-20260812-registry-authoritative-auth: registry-authoritative auth shapes + connect-error surfacing

- **Status**: **REPLANNED after a fresh-context review found 3 BLOCKERs — awaiting owner input on one open question, then approval (Gate 2 stop)**
- **Owner**: Jeetu (commissioned 2026-08-12); planning session by Claude
- **Risk tier**: **High** (auto-escalated: `packages/auth` is the credential broker; the change decides which credential FIELDS a user is asked for and which hosts a credential may be injected against — C1-adjacent by construction)
- **Branch**: `feat/TASK-20260812-registry-authoritative-auth` (off `main` at `bac5562`)
- **Packages touched**: `auth` (registry + inferrer), `playground` (wizard sheet error surface); dependents per graph: `auth` → `playground`, so both suites plus a root run
- **Spec impact**: **none expected.** `packages/protocol`'s `connectionRequirementSchema` and `CONNECTION_KINDS` are UNCHANGED — this task makes the registry emit shapes the schema already expresses. If that proves false during implementation the task stops for a spec-sync decision rather than widening a published schema quietly.
- **Related**: ADR-0017 (dynamic auth v2 / registry-borrow ban, ASCII-lookalike disclosure) · TASK-20260810-p3-wizard (the wizard's connect step) · TASK-20260810-p4-starters (registry `fields` seat, fold T-M1) · owner bug report 2026-08-12 (Coinbase Connect silently drops)

## Spec (what & why)

Three owner-commissioned changes, one root cause behind two of them.

**F1 — an unhandled-rejection swallow site exists, but it is NOT what the owner hit.**
`ConnectionWizardSheet.tsx:873` calls `void startConnectionOAuthFlow({}, preOpened)` with
no `.catch()`, so a throw there is discarded unhandled. That site is real and worth closing.

**But the review refuted my causal chain, and I re-verified the refutation by execution.**
The owner's stored Coinbase row has `fields: undefined` (probe output below), so
`saveConnectionCredentials` (`connectionWizard.ts:423-428`) refuses it at the CREDENTIALS
screen — `kind !== 'none' && fields.length === 0` → "this connection declares no credential
fields". The machine never advances, the `connect` step never renders, and line 873 never
runs. The credentials path moreover ALREADY catches and calls `setError`
(`ConnectionWizardSheet.tsx:448-452`).

```
Coinbase via the real inferrer:  kind >>> oauth2_auth_code | fields >>> undefined
guard fires (kind!==none && fields empty) >>> true
```

**Therefore F1 and F2 are NOT the same bug, and the owner's symptom is entirely F2.**
That leaves a genuine open question (§5 Q-A): the code path the owner walked should have
RENDERED an error, but the owner reported none. Either the stored row differs from this
model, or there is a third defect not yet found. **Not guessing — the first implementation
step is to read the owner's actual row.**

**F2 — registry entries are not self-contained, and the inferrer ignores what they do
carry.** `connection-requirement-inferrer.ts:130` hardcodes `kind: 'oauth2_auth_code'` for
EVERY registry hit and never reads the entry's `fields`. **Reproduced by execution against
the real inferrer:**

| provider | emitted kind | fields emitted | registry actually holds |
|---|---|---|---|
| Coinbase | `oauth2_auth_code` | 0 | `api_key` + 3 named fields (key/secret/passphrase) |
| OpenWeather | `oauth2_auth_code` | 0 | `api_key` + 1 field |
| Spotify | `oauth2_auth_code` | 0 | correct kind, but `client_id` field dropped |

So an authored Coinbase app gets an OAuth requirement carrying NO fields — and the
empty-fields guard then refuses it at the credentials screen (see F1). The user is asked to
"connect" a provider whose three real credential fields the registry already holds and the
emitter threw away. **This is the owner's actual bug, on its own.** Fixing F2 makes the
Coinbase row an `api_key` requirement with three named fields, which routes
`credentials → done` and never renders a Connect button at all (verified by probe).

**F3 — registered providers must never reach the model.** Rung 1 already short-circuits on
a registry hit, so the ladder is right. The remaining gap is narrower than first described:
a near-miss name ("coinbase pro") misses the normalized key and falls through to inference.
Note these names are **already handled correctly on the BAN path** — they resolve as
brand-ADJACENT and their authored fields are refused — so this adds an authoring
short-circuit only, via a separate inferrer-scoped alias map (D3), and deliberately does
NOT grant them registry authority anywhere else.

**Acceptance criteria** (each becomes at least one test):

1. **AC1 (registry is authoritative for KIND):** each registry entry declares its own
   `kind`; the inferrer emits THAT kind, never a hardcoded one. Coinbase → `api_key`,
   OpenWeather/CoinGecko → `api_key`, GitHub → `bearer_token`, the five OAuth entries →
   `oauth2_auth_code`. Asserted per entry through the REAL inferrer, not a stub.
2. **AC2 (registry is authoritative for FIELDS):** a registry hit emits the entry's pinned
   `fields` verbatim. Coinbase's three fields arrive named and typed; a registry entry with
   no `fields` emits none (no invented input).
3. **AC3 (entries are self-contained):** a structural test proves every entry composes into
   a requirement that PARSES against the real `connectionRequirementSchema`, and that the
   emitted requirement carries everything the entry holds — kind, fields, hosts, endpoints,
   registration, authorizeParams, pkce. A new entry missing a required piece fails in
   `packages/auth`, not in front of a user.
4. **AC4 (inference never fires for a registered provider) — RESTATED (MAJOR 7).** My first
   version was a tautology for registry keys: rung 1 `return`s before `deps.complete` is
   referenced, so a throwing adapter tests a `return` statement. Restated to assert the
   *observable order of effects*: a **call-recording** adapter must have `calls.length === 0`
   for every registry key and every alias, AND the emitted `provenance` is `'registry'`,
   AND — the part that can actually fail — a mutation test where rung 1 is bypassed makes
   the suite go red. The alias half is meaningful only if alias lookup sits inside rung 1
   (D3), so the test names that call site explicitly.
5. **AC5 (unregistered providers still infer):** an unknown provider name still reaches the
   LLM rungs and returns `provenance: 'inference'` / `'user_docs'`. The registry is a
   short-circuit, never a whitelist — an app may still declare a novel provider.
6. **AC6 (aliases are human-authored only):** aliases resolve to their entry; an
   unrecognized near-miss (`Cooinbase`, `Sp0tify`) does NOT match and falls through to
   inference. Pins ADR-0017's accepted ASCII-lookalike posture rather than reopening it.
7. **AC7 (connect errors surface) — RESTATED (MAJOR 6).** The sheet ALREADY renders an
   `error-note` with a retry for the popup-blocked/closed/exchange-failure paths
   (`ConnectionWizardSheet.tsx:528-557`), so "an error region appears" passes today, before
   any fix — unfalsifiable. Restated to assert the **specific thrown message text** reaches
   the DOM for each of the three paths that `throw` before any status is written
   (`connectionWizard.ts:759-761`, `:766-768`, `:813-816`) — e.g. the literal
   `this connection does not sign you in`. Each of the three must fail before the fix.
8. **AC8 (no silent unhandled rejection at line 873):** the ConnectScreen retry path is the
   genuinely uncaught site (reachable only for an OAuth requirement that HAS fields).
   Regression test pins that its rejection is handled, so a future refactor back to
   `void f()` fails.
9. **AC9 (C1 holds) — RESTATED (MINOR 9).** "No credential-shaped value" has no testable
   definition — any regex broad enough for a real secret needs an entropy threshold nobody
   has chosen, and the entries legitimately contain prose like "The passphrase you chose".
   Restated in SHAPE terms: every `fields[]` entry has exactly the keys of
   `connectionFieldSchema` and no others (the structural rule
   `static-kind-registry.test.ts:102-127` already uses), plus the existing credential-scan
   and borrow-ban suites stay green.
10. **AC10 (the kind split-brain is pinned, not latent) — NEW (D6/BLOCKER 3):** a test
   documents that `applyRegistryValues` substitutes fields but NOT `kind`, so a borrowing
   declaration keeps its own kind while receiving registry fields. Named behavior with a
   queued follow-up, rather than a surprise found later in production.

**Out of scope:** repairing ALREADY-STORED requirement rows (owner decision: forward-only —
the owner's existing Coinbase row stays wrong until the app re-declares its connection or
the slot is dropped; the wizard will now state the real reason instead of failing silently)
· rebuilding the OAuth popup flow itself (unrelated, still works for true OAuth providers) ·
adding NEW providers to the registry · host-based or fuzzy provider matching (ADR-0017
disclosure stands) · any change to `packages/protocol` schemas.

## Interview → answers (owner, 2026-08-12)

- **Q1 registry kinds** → **per-provider correct kind** (the table in AC1). GitHub is
  `bearer_token`: its own registry comment already argues a PAT *is* a bearer token, and the
  OAuth `endpoints` stay for requirements that do run the app flow.
- **Q2 matching** → **exact + human-authored alias list.** No fuzzy, no host-based matching.
- **Q3 error surfacing** → **inline on the wizard sheet**, matching the done-screen probe
  precedent ("reported honestly rather than swallowed").
- **Q4 existing rows** → **forward-only**, re-declare on the next authoring turn.

## Plan

> Gate 2, written 2026-08-12 against `main` at `bac5562`. Every claim below was verified
> against the source or by executing the real code (the F2 table is probe output).
> High tier ⇒ this plan gets a fresh-context AI review BEFORE any implementation code.

### 0. Ground truth

- `WellKnownOauthProvider` (`well-known-providers.ts:21+`) ALREADY carries `fields`,
  `apiHosts`, `registration`, `authorizeParams`, `pkce`, optional `endpoints`. **Zero
  entries carry a `kind`** (`grep -c '^    kind:'` → 0). The type comment already
  anticipates static kinds: endpoints were made optional in the v2 rewrite precisely so "an
  exchange with an HMAC-signed API key and no OAuth flow at all" is representable.
- `requirement-admission.ts` ALREADY exempts registry-substituted `fields` from the
  borrow ban (Guard 2b, fold T-M1) — the plumbing this task needs exists and is unused by
  the inferrer.
- `nextStep`/`needsOAuthConnectStep` route on `kind === 'oauth2_auth_code'` only — verified
  by probe: an `api_key` requirement goes `credentials → done` and never renders a Connect
  button. So AC1 alone removes the owner's Coinbase symptom; AC7 makes the remaining
  failure modes legible.
- `ConnectionWizardSheet.tsx:870-874` is the swallow site.

### 1. Design decisions

- **D1 — `kind` becomes a REQUIRED field on `WellKnownOauthProvider`.** Required, not
  optional-with-default: an optional kind reintroduces exactly today's bug for the next
  entry someone adds (a default is a hardcode with better manners).
  **CORRECTION (MAJOR 4):** I justified this with "caught by `tsc` now that
  `packages/auth`'s test script type-checks." **That is false** —
  `packages/auth/package.json` is `"test": "vitest run"`, no `tsc`. My earlier follow-up
  added the prefix to `db`/`protocol`/`knowledge`/`playground` and I asserted those were
  the only gaps; **`auth` and the other remaining packages were never checked**. So the
  enforcement rests on **AC3's structural test**, not on the compiler. P0 additionally adds
  the `tsc` prefix to `packages/auth` so the compile-error safety net actually exists — and
  P3 audits every remaining package's test script, since my "four packages" claim is now
  known to be incomplete.
- **D2 — one emitter, driven entirely by the entry.** Replace the hardcoded object literal
  with a `requirementFromRegistryEntry(entry, providerName, slot)` function that copies
  every seat the entry holds. AC3 tests THAT function, so "self-contained" is enforced at
  one altitude rather than asserted per call site.
- **D3 (REWRITTEN after BLOCKER 1) — aliases get their OWN lookup, and
  `lookupWellKnownProvider` is left alone.** My first design added alias keys to the
  registry lookup, which `well-known-providers.ts:334-341` explicitly prohibits: that
  function is the **RESOLUTION** path ("resolving 'Spotify Inc' to Spotify here would hand
  a brand-adjacent declaration Spotify's real OAuth endpoints as if it had asked for
  them"), and the BAN path is a separate question answered by
  `findBrandAdjacentRegistryKeys`. Two other callers depend on that semantics
  (`params-to-auth-spec.ts:62,248`), so aliasing there would have granted any spec named
  "Coinbase Pro" the real Coinbase's pinned hosts AND its `registration` walkthrough
  rendered with wizard-grade legitimacy. Verified: "coinbase pro" and "Google Calendar"
  already resolve as brand-ADJACENT today and are correctly caught by the ban.
  **New design:** a separate `INFERRER_ALIASES` map consulted ONLY by rung 1 of the
  inferrer, never by `lookupWellKnownProvider`. Resolution semantics and the ADR-0017
  boundary are untouched. **Owner-visible consequence: "coinbase pro" resolving to
  Coinbase is a NARROWER win than I first described** — it short-circuits inference for
  authoring, and does not grant registry authority anywhere else.
- **D6 (NEW, from BLOCKER 3) — `kind` does NOT join admission's substitution set; AC3's
  "self-contained" is scoped to the INFERRER.** `applyRegistryValues`
  (`requirement-admission.ts:293-359`) substitutes name/hosts/fields/endpoints/registration/
  authorizeParams/pkce but deliberately never `kind` — the module doc calls the ban
  "kind-AGNOSTIC" by design. Making the registry authoritative for kind in the inferrer
  while admission stays kind-agnostic is a split-brain the plan must NAME rather than
  discover later: a borrowing declaration can keep its own `oauth2_auth_code` kind while
  receiving Coinbase's `api_key` field set, and `generateAuthUrl` then demands a
  `client_id` that no longer exists. **Decision: leave the ban kind-agnostic** (changing a
  security guard's contract belongs in its own task with its own ADR), and add **AC10** —
  a test pinning the split so it is documented behavior rather than a latent surprise.
  Recorded as a queued follow-up, not silently accepted.
- **D4 — the connect handler catches and surfaces.** `startConnectionOAuthFlow` keeps
  THROWING (its contract is unchanged and its own tests depend on it); the SHEET catches,
  stores the message in local state, and renders it beside the button with a retry. Error
  text comes from the thrown `Error.message`, which is already user-facing prose in all
  three paths.
- **D5 — GitHub keeps its OAuth endpoints while declaring `bearer_token`.** Its comment
  documents both uses. Recorded explicitly because it is the one entry where kind and
  endpoints disagree by design, and a future reviewer will otherwise "fix" it.

### 2. Phases (tests FIRST in each)

**P0 — registry self-containment (`packages/auth`)**
1. RED: AC3's structural suite — every entry composes + parses; every entry declares a
   kind; kind/fields/hosts round-trip through the emitter.
2. Add required `kind` + optional `aliases` to the type; declare the kind on all 10 entries
   per AC1's table. Add aliases for the obvious near-misses the owner named.
3. `requirementFromRegistryEntry` (D2) + AC9's negative test (no credential-shaped values
   in any entry).

**P1 — inferrer honors the registry (`packages/auth`)**
1. RED: AC1/AC2/AC4 through the REAL inferrer with a throwing adapter (reaching the model
   is a hard failure). AC5's unknown-provider case stays green.
2. Swap the hardcoded literal for the emitter. Verify provenance stays `'registry'`.
3. AC6: alias hits resolve; lookalikes fall through.

**P2 — connect-error surfacing (`apps/playground`)**
1. RED: AC7 (each throw path renders its message) + AC8 (rejection handler attached).
2. Catch + inline error state + retry in `ConnectionWizardSheet`.

**P3 — close**: whole-surface check that an authored Coinbase app now reaches the
credentials screen with three named fields (the owner's actual journey), docs (code-map row
for the registry's new authority, architecture note if warranted), threat-model note if the
alias list changes the trust story, ADR only if a decision proves load-bearing beyond D1–D5.

### 3. Test plan (AC → suite)

| AC | Where |
|---|---|
| AC1/AC2 | `packages/auth` inferrer suite, real inferrer + throwing adapter, per entry |
| AC3 | new `packages/auth` registry structural suite (compose → real schema parse) |
| AC4 | same suite: every key AND alias ⇒ `provenance: 'registry'`, adapter never called |
| AC5 | unknown provider ⇒ inference rung, existing suite extended |
| AC6 | alias hits + `Cooinbase`/`Sp0tify` fall-through |
| AC7/AC8 | playground `connectionWizard` suite: three throw paths render; handler attached |
| AC9 | existing borrow-ban + credential-scan suites (must stay green) + new negative |

Run `packages/auth` and `playground` plus a root `pnpm test -- --force` (auth is depended
on by playground; the root run is the evidence standard per lessons 2026-08-10).

### 4. Cross-package impact & risks

- `packages/protocol` UNCHANGED (no spec-sync owed) — but the emitter's output is parsed by
  `connectionRequirementSchema`, so a shape the schema rejects surfaces as a P0 test
  failure. That is the designed early-warning.
- **~~Risk 1 — starter/registry kind disagreement~~ — RESOLVED AT PLAN TIME, empirically
  ZERO (MAJOR 5).** I deferred this to P0; the reviewer ran it instead. All four shipped
  starters, through the REAL `admitConnectionRequirement` on the `starter` channel, already
  declare exactly the kinds AC1 proposes: `my-repos` → `bearer_token`/github,
  `crypto-portfolio` → `api_key`/coingecko, `weather-planner` → `api_key`/openweather,
  `spotify-party-dj` → `oauth2_auth_code`/spotify. All four `DEMO_STARTER_REQUIREMENTS`
  agree too. **Lesson taken: a risk that a ten-minute probe can settle should be settled at
  plan time** — carrying it as an unquantified scare displaced attention from the real
  risk (the kind split-brain, D6), which the first plan did not name at all.
- **Risk 1' (the REAL one) — the inferrer/admission kind split-brain.** See D6 and AC10.
- **Risk 2 — already-stored rows keep the old shape** (owner-accepted, forward-only). The
  wizard will now say why instead of dropping silently.
- **Risk 3 — alias collisions** (two entries claiming one alias). Prevented by a P0 test
  asserting the alias map has no duplicate keys.

## 5. Open question for the owner (blocks nothing; changes what P2 fixes)

**Q-A — what exactly did you see on the Coinbase Connect click?** The plan's model of your
row (registry hit → `oauth2_auth_code` + no fields) predicts the CREDENTIALS screen refuses
it with a visible message — *"this connection declares no credential fields — there is
nothing to collect, so it cannot be connected"* — because that path already catches and
calls `setError`. You reported nothing at all.

Three possibilities, and they lead to different fixes:
- **(a)** You saw that message but read it as "nothing happened" → F2 alone fixes it, P2
  shrinks to closing the line-873 swallow site defensively.
- **(b)** Your row differs from the model (e.g. authored before the registry hit, or with
  fields) → the diagnosis needs redoing against the real row.
- **(c)** There is a third defect — something silent BEFORE the credentials screen.

**Resolution costs one minute and no guessing:** with the app open, run
`(await getUserDb()).listDeclaredConnections('<appId>')` in the console, or tell me what the
screen showed. **P2's first step is reading your actual row** — I will not implement an
error surface for a path I have not confirmed you were on.

## Decisions & surprises

- 2026-08-12: **The registry-first ladder already existed and was already correct** — my
  earlier reading that inference "fires for registered providers" was wrong in mechanism.
  Rung 1 short-circuits; the defect is that the short-circuit emits a hardcoded OAuth shape
  and discards the entry's own `fields`. Recorded because it changes the fix from "add a
  ladder" to "make rung 1 honest".
- 2026-08-12: I earlier told the owner the wizard's OAuth connect step was "still a
  placeholder". **That was stale** — it is fully wired (popup, BroadcastChannel, PKCE). The
  note I was quoting predates the P3 wizard work.

### Fresh-context plan review record (2026-08-12, adversarial, REVISE → all folded)

One read-only reviewer attacked this plan against source, refute-first. **Three BLOCKERs,
two of which refuted premises the plan was built on.** I independently re-verified the three
most consequential claims by reading source and executing the real inferrer before folding.

| # | Finding | Disposition |
|---|---|---|
| B1 (sec) | Alias design put alias keys on `lookupWellKnownProvider` — the RESOLUTION path, whose own comment (`well-known-providers.ts:334-341`) prohibits exactly that; two other callers would have granted "Coinbase Pro" the real Coinbase's hosts + walkthrough. "coinbase pro"/"Google Calendar" already resolve as brand-ADJACENT and are correctly banned today | **Folded**: D3 rewritten — separate `INFERRER_ALIASES` consulted only by rung 1; resolution path untouched |
| B2 (correctness) | F1's causal chain is blocked by `saveConnectionCredentials`'s empty-fields guard, so the swallow site is NOT on the owner's journey; the credentials path already catches. "F1 and F2 are the same bug" was false | **Folded**: F1 rewritten, **re-verified by probe** (owner's row has `fields: undefined`, guard fires). Opens Q-A — the owner saw NO error where this path renders one |
| B3 (arch) | "Guard 2b plumbing already exists" is half-true: admission substitutes `fields` but never `kind`, so the registry becomes kind-authoritative in the inferrer and kind-agnostic in admission | **Folded**: D6 names the split explicitly, decides to leave the ban kind-agnostic, adds AC10 to pin it + a queued follow-up |
| M4 | D1's `tsc` justification false — `packages/auth` runs `vitest run` only | **Folded**: correction recorded in D1; P0 adds the prefix; **P3 audits ALL remaining packages**, since my earlier "four packages" claim is now known incomplete |
| M5 | Risk 1 (starter/registry kind disagreement) is empirically ZERO; deferring it displaced attention from B3 | **Folded**: resolved in §4 with the evidence; lesson recorded |
| M6 | AC7 unfalsifiable — the error region already renders today | **Folded**: AC7 restated to assert the specific thrown message text per throw path |
| M7 | AC4 tautological for registry keys (rung 1 returns before touching the adapter) | **Folded**: AC4 restated as call-recording + order-of-effects + a mutation that must go red |
| m8 | GitHub's OAuth endpoints are CEILING-LOAD-BEARING (`deriveConnectionAllowedHosts` unions them regardless of kind); removing them later would narrow a frozen ceiling and mass-demote approvals | **Folded**: D5 gains the consequence, not just the decision |
| m9 | AC9's "credential-shaped value" untestable | **Folded**: AC9 restated in shape terms |

Reviewer-VERIFIED claims worth keeping: the F2 probe table is accurate; all four starters
already agree with AC1's kinds; **no host ceiling changes** for any entry under the proposed
kinds (verified through the real `deriveConnectionAllowedHosts`).

## Session journal (append-only, newest last)

### 2026-08-12 — Claude (planning session) — session

- Done: Gate 1 spec + Gate 2 plan written from source. Root cause of the owner's Coinbase
  bug found and **reproduced by executing the real inferrer** (registry hits emit
  `oauth2_auth_code` + 0 fields for all 10 providers, including two API-key providers whose
  correct fields the registry already holds). Confirmed the wizard routes only
  `oauth2_auth_code` to the connect step, and located the unhandled-rejection swallow site.
  Owner interviewed: 4 decisions recorded above. Branch cut off `main`.
- State: **planned, no implementation code** (High-tier gate honored). Working tree holds
  this task file only.
- Next step: **fresh-context plan review (High tier), then owner approval → P0 tests-first.**
- Open questions: none blocking. Risk 1 (starter/registry kind disagreement) is assigned to
  P0's first step rather than guessed at now.

### 2026-08-12 — Claude (planning session, review fold) — session

- Done: fresh-context adversarial plan review run (High-tier gate). **3 BLOCKERs + 4 MAJORs
  + 2 minors, ALL FOLDED** (§6 record; the plan text above is post-fold). I independently
  re-verified the three most consequential findings before accepting them — read the
  registry's prohibiting comment and `packages/auth/package.json` directly, and **executed
  the real inferrer** to confirm the owner's row has `fields: undefined` and that the
  empty-fields guard fires.
- **Two of my own premises were wrong**, both now corrected in place: (1) "F1 and F2 are the
  same bug" — false; the swallow site is unreachable on the owner's journey, so the owner's
  symptom is entirely F2 and F1 is an independent defensive fix. (2) The alias design would
  have inverted a documented trust boundary, granting brand-adjacent names the real
  provider's pinned hosts and walkthrough — the exact thing the registry's own comment
  forbids. Also corrected: my "only four packages lack a type-checking test script" claim
  from the previous task was incomplete — `packages/auth` lacks it too, so P3 now audits
  ALL packages rather than trusting that list.
- State: **replanned, still NO implementation code** (High-tier gate honored). Branch holds
  the task file only.
- Next step: **owner answers Q-A (§5) → approval → P0 tests-first.** Q-A does not block
  approval of P0/P1 (the registry work is independent); it only decides what P2 fixes.
- Open questions: Q-A above.
