# TASK-20260812-registry-authoritative-auth: registry-authoritative auth shapes + connect-error surfacing

- **Status**: **IMPLEMENTED P0–P3 (2026-08-12, tests-first throughout) — awaiting review/PR; branch unpushed**
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

**Therefore F1 and F2 are NOT the same bug** — and, per §5, the owner's symptom turned out
to be **neither**. The owner never reached the wizard at all: the app has no connection row,
so the run view's `NET_NOT_APPROVED` banner CTA no-ops silently (**F4**). F1 remains a real
but independent defensive fix on a path the owner has not walked.

*(The paragraph above analyses a row shape that assumed a row EXISTS. For the owner's app
none does — F2 still explains why persistence refused it, which §5 traces.)*

**F2 — registry entries are not self-contained, and the inferrer ignores what they do
carry.** `connection-requirement-inferrer.ts:130` hardcodes `kind: 'oauth2_auth_code'` for
EVERY registry hit and never reads the entry's `fields`. **Reproduced by execution against
the real inferrer:**

| provider | emitted kind | fields emitted | registry actually holds |
|---|---|---|---|
| Coinbase | `oauth2_auth_code` | 0 | `api_key` + 3 named fields (key/secret/passphrase) |
| OpenWeather | `oauth2_auth_code` | 0 | `api_key` + 1 field |
| Spotify | `oauth2_auth_code` | 0 | correct kind, but `client_id` field dropped |

So an authored Coinbase app gets an OAuth requirement carrying NO fields — a shape whose
three real credential fields the registry already holds and the emitter threw away.
**F2 is the probable ROOT CAUSE of the owner's F4 symptom** (§5): the post-turn recovery
would have received exactly this shape, and `persistConnectionRequirement` refusing it is
the most likely reason no row exists. Fixing F2 makes the Coinbase requirement an `api_key`
with three named fields — a shape that persists, routes `credentials → done`, and never
renders a Connect button at all (verified by probe). **The chain is not yet proven end to
end; P0 proves it.**

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
11. **AC11 (the net-error CTA never silently no-ops) — NEW (F4, the owner's ACTUAL bug):**
   clicking `connect this app` on a `NET_NOT_APPROVED` banner for an app with **zero**
   connection rows must produce a visible outcome — an explanation of why there is nothing
   to connect, and a route forward — never today's silent `return false`. Test asserts at
   the CTA handler (the decision altitude), with a zero-row fixture.
12. **AC12 (connected-but-unconnectable is never silent) — NEW:** when the post-turn
   recovery cannot persist a requirement for an app whose HTML calls `connectedFetch`, the
   user is left with EITHER a reviewable row OR a visible explanation. Negative test: a
   recovery that returns nothing does not yield an app that merely fails at runtime with no
   route to fix it.
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

## 5. Q-A ANSWERED (owner, 2026-08-12) — it was (c): a THIRD defect, upstream of both models

The owner's real symptom: opening the Coinbase app shows *"this app tried to use the
network but its connection is not ready (NET_NOT_APPROVED)"* and **the banner's CTA does
nothing.** Neither my model nor the reviewer's had this — both of us were reasoning about
the wizard's internal screens, and **the owner never reached them.**

**F4 (NEW) — the net-error CTA silently no-ops when the app has no connection row.**
Traced to source:
1. `connectedFetch` finds no APPROVED row → `connected-fetch.ts:611` returns
   `NET_NOT_APPROVED`. Correct behavior, not a bug.
2. `RunView.tsx:551` renders the banner with a `connect this app` CTA.
3. The CTA calls `openConnectionWizardForNetError` → `openConnectionWizardForApp`, which
   returns at **`connectionWizard.ts:166`: `if (rows.length === 0) return false;`**
4. `false` means "not opened", so `RunView.tsx:562` correctly does NOT dismiss the banner
   (that guard is well-commented and right). **Net effect: a CTA whose only failure mode is
   silence** — no wizard, no error, no state change.

**So the app has NO connection row at all** — the declaration never persisted one. The
recovery path exists for exactly this case (`connectionPipeline.ts:420-455`, which already
calls the state "connected-but-unconnectable"), and its chain resolves correctly for
Coinbase — probed: `usesConnectedFetch → true`, host `api.coinbase.com`, slot `coinbase`.
So the most likely cause is that recovery RAN, called the inferrer, received F2's broken
shape (`oauth2_auth_code` + zero fields), and `persistConnectionRequirement` refused it —
leaving no row. **That would make F2 the root cause of F4 too**, but the chain is NOT yet
proven end to end; **P0 proves it rather than assuming it.**

**Consequences:**
- **F4 gets its own AC11** — a CTA whose only failure mode is silence is F1's bug class, one
  layer up, and it is what the owner actually hit.
- **AC12** — the connected-but-unconnectable recovery must leave the user with EITHER a
  reviewable row OR a visible explanation, never a silent no-op.
- **P2 re-scoped**: the banner CTA is the priority; line 873 stays a defensive fix.
- **Both earlier diagnoses were wrong in the same way** — the reviewer and I each traced
  inward from a screen the owner never saw. Recorded in lessons: when a user reports "the
  button does nothing", trace from THEIR entry point, not from the component that looks
  most related.

### Superseded hypotheses (kept for the record)
- **(a)** owner saw the empty-fields message and read it as nothing → **no**, wrong screen.
- **(b)** the stored row differs from the model → **partly**: there is no row at all.
- **(c)** a third defect → **yes, F4.**

**Still worth reading the real row in P0** (`(await getUserDb()).listConnections('<appId>')`)
to confirm it is genuinely empty rather than present-but-unapproved — the two produce the
same banner but different fixes, and F4's `rows.length === 0` branch is only reached by the
first.

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

### 2026-08-12 — Claude (planning session, Q-A answered → F4 found) — session

- Done: owner supplied the REAL symptom — `NET_NOT_APPROVED` banner on opening the Coinbase
  app, and a CTA that does nothing. **Traced to a third defect (F4)** neither my diagnosis
  nor the reviewer's had found: `openConnectionWizardForApp` returns `false` at
  `connectionWizard.ts:166` when the app has NO connection rows, and the CTA's (correct)
  "only dismiss on a real open" guard then leaves the banner up with nothing having
  happened. Added AC11 + AC12; re-scoped P2 around the banner CTA.
- **Both earlier diagnoses were wrong the same way.** The reviewer and I each traced inward
  from a wizard screen the owner never reached. The lesson (queued for `docs/lessons.md` at
  close): when a user says "the button does nothing", trace from THEIR entry point — the
  first thing they see — not from the component that looks most related to the feature.
  Neither of us asked what the screen actually said until the owner volunteered it.
- **Probable root cause chain, NOT yet proven:** F2's broken emitter → recovery gets an
  `oauth2_auth_code` requirement with zero fields → `persistConnectionRequirement` refuses
  it → no row → F4's silent CTA. The Coinbase recovery chain itself resolves correctly
  (probed: `usesConnectedFetch → true`, `api.coinbase.com` → slot `coinbase`), so the break
  is at persistence. **P0 proves this end to end before any fix is written** — it is the
  difference between fixing the cause and fixing three symptoms.
- State: **replanned, still NO implementation code** (High-tier gate honored).
- Next step: **owner approval → P0 tests-first**, starting with the end-to-end reproduction
  of the chain above against a real userdb.
- Open questions: none. Q-A is answered.

### 2026-08-12 — Claude — HANDOFF (pick up with `/pickup TASK-20260812-registry-authoritative-auth`)

**Where this stands:** Gates 1–2 complete, replanned TWICE, **no implementation code by
design** (High tier stops for approval before code). Branch is clean and unpushed.

**THE ONE THING BLOCKING PROGRESS: owner approval of the plan.** Everything else is ready.

**What a fresh session must NOT re-derive** (all of it is already in this file, verified):
- The four findings F1–F4 and which one is the owner's ACTUAL symptom (**F4** — the
  `NET_NOT_APPROVED` banner CTA that silently no-ops at `connectionWizard.ts:166` when the
  app has zero connection rows). F1 and F2 are real but the owner never walked those paths.
- §6's fresh-context review record: 3 BLOCKERs + 4 MAJORs + 2 minors, ALL folded. Do not
  re-run that review; do re-read §6 before touching D3 (aliases) or D6 (the kind
  split-brain), because both encode a trust boundary that the obvious design violates.
- 12 acceptance criteria, several deliberately RESTATED so they can actually fail
  (AC4/AC7/AC9). Do not "simplify" them back — the original versions passed before any fix.

**Probes already run (do not repeat, results are recorded above):**
- Real inferrer emits `oauth2_auth_code` + 0 fields for ALL 10 registry providers.
- Owner-shaped Coinbase row → `fields: undefined` → the empty-fields guard fires.
- Coinbase recovery chain resolves: `usesConnectedFetch → true`, `api.coinbase.com` → slot
  `coinbase`. So the break is at PERSISTENCE, not at host/slot derivation.
- All 4 starters + all 4 demo requirements already agree with AC1's kind table (Risk 1 is
  empirically zero). No host ceiling changes under the proposed kinds.

**First actions on pickup, in order:**
1. Confirm the plan is still approved/unchanged by the owner (it was awaiting approval at
   handoff — check for a reply before writing code).
2. **P0 step 1 is a REPRODUCTION, not a fix:** prove the chain F2 → recovery →
   `persistConnectionRequirement` refuses → no row → F4, end to end against a real userdb.
   If the chain does NOT hold, there is a fifth defect and the plan needs revisiting before
   any code. This is the difference between fixing the cause and fixing three symptoms.
3. Also read the owner's REAL row (`(await getUserDb()).listConnections('<appId>')`) to
   confirm it is genuinely empty vs present-but-unapproved — same banner, different fix.
4. Then P0 proper, tests-first per §2.

**Known trap for the implementation session:** `packages/auth`'s `test` script is
`vitest run` with NO `tsc`, so a package-level green is not a type-clean claim (this bit the
previous task three times). P0 adds the prefix; until then use `pnpm build` at the root as
the type check. My earlier "only four packages lack it" claim was INCOMPLETE — P3 audits
every package.

**Nothing about this task's state exists only in the chat.** Branch:
`feat/TASK-20260812-registry-authoritative-auth`, 5 commits, unpushed, tree clean.

### 2026-08-12 — Claude (implementation session) — session

- Done: picked up via `/pickup`. Baselines re-verified green (auth 357, playground 740).
  Diff vs main is doc-only, exactly as journaled. **Owner APPROVED the full plan (P0–P3)**
  at pickup — Gate 2 cleared. Starting P0 with the end-to-end reproduction of the
  F2 → persist-refusal → no-row → F4 chain before any fix.
- State: implementation beginning, tests-first.
- **P0 step 1 (the reproduction) REFUTES the assumed chain's middle link.** Executed end
  to end against a real userdb with the production admission gate (probe file, since
  deleted; output recorded here): the inferrer's rung 1 does emit F2's broken shape
  (`oauth2_auth_code`, zero fields, poison adapter untouched) — but
  `persistConnectionRequirement` does NOT refuse it. The borrow ban fires on the
  `registry` channel, `applyRegistryValues` substitutes the pinned 3 Coinbase fields, and
  a row IS created (`declared`, provenance `registry`, fields present, **kind still
  `oauth2_auth_code`**). `openConnectionWizardForApp` then returns `true`.
- **Consequences, examined before continuing (the "fifth defect" gate):**
  - The live defect for a FRESH build is the WRONG-KIND row: an api_key provider routed
    to the OAuth connect step, which cannot succeed (D6's split-brain is live in
    persisted rows, not latent). AC1 remains exactly the right root fix; AC2/AC3 stand
    (the inferrer must emit fields itself, not lean on admission's substitution
    side-channel); AC11 stands (the zero-row CTA silence is real code, reachable for any
    app whose row never persisted).
  - The owner's row-less app is NOT explained by current-main behavior. Most plausible:
    it was built before the P3 lazy-adapter fold, when a keyless configuration returned
    `completion_failed` BEFORE rung 1 — recovery ran and persisted nothing. Forward-only
    (owner decision Q4) covers it; after AC11 the CTA explains and routes forward.
  - **No plan change beyond narrative**: every AC, design decision, and phase survives;
    "F2 is the probable root cause of F4" is downgraded to "F2's kind half breaks fresh
    builds; the owner's no-row state is historical". P3's whole-surface check gains one
    pin: a recovered registry provider's PERSISTED row carries the registry's kind.
- Still owed from handoff item 3: reading the owner's REAL rows needs the owner's
  browser (OPFS) — queued as an owner-assist item at close; forward-only makes it
  non-blocking.

### 2026-08-12 — Claude (implementation session, P0–P3 complete) — session

- **P0 (auth):** `registry-self-containment.test.ts` RED-first (45 red / 7 structural
  passes), then: required `kind` on the type + all 10 entries (AC1 table; **decision:
  Apple Music pins `oauth2_auth_code`** — the one entry the plan's table did not name;
  it is what the old hardcode emitted, its entry says "authors override", and no
  truthful MusicKit kind exists in `CONNECTION_KINDS` — queued follow-up), optional
  `aliases` seat (`Coinbase Pro` owner-named; `OpenWeatherMap` as the one obvious
  synonym), derived `INFERRER_ALIASES` + `resolveInferrerAlias` (D3 — collision tests:
  alias→existing key, no key shadowing, pre-normalized), `requirementFromRegistryEntry`
  (D2, deep-copies, no cast needed — tsc-clean). `tsconfig.test.json` + tsc prefix added
  to `packages/auth` (D1 correction).
- **P1 (auth):** `connection-requirement-inferrer.test.ts` RED-first (10 red for the
  right reasons), then rung 1 = exact key ?? alias, emitting via the ONE emitter. AC4
  restated as call-recording + bypass mutation; AC5/AC6 pinned. AC10 (D6 split-brain)
  pinned in the self-containment suite. auth 357 → 409, tsc-gated.
- **P2 (playground):** RED-first both files. **AC11/F4**: the zero-row branch of
  `openConnectionWizardForApp` now WRITES the explanation (why + route forward) and
  `ConnectionWizardNote` is the note store's first-ever renderer (app-level mount beside
  the sheet) — the store had NO subscriber, so even the pre-existing "wizard already
  open" refusal was silent; one renderer fixes the class. **AC7/AC8/F1**: the
  ConnectScreen retry's `void` became a catch into `connectionFlowStatusStore`, so the
  three pre-status throws render their literal copy beside the existing retry button.
  **Found in the red phase: the retry ALWAYS threw for client_id flows** — it passes
  `{}` as client creds, so `generateAuthUrl` threw `Missing required client credential:
  client_id` on every click and the void discarded it; that literal is now an AC7 test.
  D4 note: the catch routes to the flow-status store rather than component-local state —
  same altitude (the sheet's handler), and it reuses the exact error region + retry
  ConnectScreen already renders. playground 740 → 750.
- **P3:** whole-surface `coinbaseJourney.test.ts` — undeclared Coinbase build → recovery
  (poison adapter) → persisted `api_key` row w/ 3 named fields, provenance `registry` →
  the banner CTA's own call opens the wizard → `nextStep('credentials') === 'done'`,
  never a Connect step. **Test-script audit (M4 closed): `runner` and `sdk` ALSO lacked
  the tsc gate** — both gained `tsconfig.test.json` + the prefix; runner's gate
  immediately caught a pre-existing type error in its test harness
  (`snug-app-frame.test.tsx` spreading `Partial<>` over a discriminated-union props
  type — fixed harness-side with a single post-composition assertion). Docs: lessons
  entry (trace from the user's entry point; execute assumed chains; grep for the
  subscriber), next-steps updated, code-map rows updated. **Threat-model decision: no
  delta needed** — D3's alias map is an authoring-only short-circuit consulted by rung 1;
  resolution and ban semantics are untouched, so the trust story is unchanged.
- Evidence: root `pnpm test -- --force` run at close (result recorded in the commit
  below). No test deleted or weakened; every RED observed before its GREEN.
