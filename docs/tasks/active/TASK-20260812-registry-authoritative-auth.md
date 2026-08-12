# TASK-20260812-registry-authoritative-auth: registry-authoritative auth shapes + connect-error surfacing

- **Status**: **planned — awaiting owner approval (Gate 2 stop)**
- **Owner**: Jeetu (commissioned 2026-08-12); planning session by Claude
- **Risk tier**: **High** (auto-escalated: `packages/auth` is the credential broker; the change decides which credential FIELDS a user is asked for and which hosts a credential may be injected against — C1-adjacent by construction)
- **Branch**: `feat/TASK-20260812-registry-authoritative-auth` (off `main` at `bac5562`)
- **Packages touched**: `auth` (registry + inferrer), `playground` (wizard sheet error surface); dependents per graph: `auth` → `playground`, so both suites plus a root run
- **Spec impact**: **none expected.** `packages/protocol`'s `connectionRequirementSchema` and `CONNECTION_KINDS` are UNCHANGED — this task makes the registry emit shapes the schema already expresses. If that proves false during implementation the task stops for a spec-sync decision rather than widening a published schema quietly.
- **Related**: ADR-0017 (dynamic auth v2 / registry-borrow ban, ASCII-lookalike disclosure) · TASK-20260810-p3-wizard (the wizard's connect step) · TASK-20260810-p4-starters (registry `fields` seat, fold T-M1) · owner bug report 2026-08-12 (Coinbase Connect silently drops)

## Spec (what & why)

Three owner-commissioned changes, one root cause behind two of them.

**F1 — the Connect button fails silently.** `ConnectionWizardSheet` calls
`void startConnectionOAuthFlow({}, preOpened)` with no `.catch()`. That function throws on
every failure path (unapproved row, non-OAuth spec, mint failure), so the rejection is
discarded unhandled: the user clicks Connect and nothing happens — no error, no log, no
state change. Verified by reading the call site; the owner hit it on a Coinbase app.

**F2 — registry entries are not self-contained, and the inferrer ignores what they do
carry.** `connection-requirement-inferrer.ts:130` hardcodes `kind: 'oauth2_auth_code'` for
EVERY registry hit and never reads the entry's `fields`. **Reproduced by execution against
the real inferrer:**

| provider | emitted kind | fields emitted | registry actually holds |
|---|---|---|---|
| Coinbase | `oauth2_auth_code` | 0 | `api_key` + 3 named fields (key/secret/passphrase) |
| OpenWeather | `oauth2_auth_code` | 0 | `api_key` + 1 field |
| Spotify | `oauth2_auth_code` | 0 | correct kind, but `client_id` field dropped |

So an authored Coinbase app gets an OAuth requirement, the wizard routes it to a `connect`
step (`needsOAuthConnectStep` is `kind === 'oauth2_auth_code'` — verified), and the connect
handler throws `this connection does not sign you in` — which F1 then swallows. **F1 and F2
are the same bug seen from two ends**, which is why they ship together.

**F3 — registered providers must never reach the model.** Rung 1 already short-circuits on
a registry hit, so the ladder is right; the gap is that a near-miss name ("coinbase pro",
"Google Calendar") misses the normalized key and falls through to inference even though a
reviewed entry exists. Adds a human-authored alias list per entry.

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
4. **AC4 (inference never fires for a registered provider):** for every registry key AND
   every alias, `infer()` returns `provenance: 'registry'` with an adapter whose `complete`
   THROWS if called — so reaching the model is a test failure, not a soft assertion.
5. **AC5 (unregistered providers still infer):** an unknown provider name still reaches the
   LLM rungs and returns `provenance: 'inference'` / `'user_docs'`. The registry is a
   short-circuit, never a whitelist — an app may still declare a novel provider.
6. **AC6 (aliases are human-authored only):** aliases resolve to their entry; an
   unrecognized near-miss (`Cooinbase`, `Sp0tify`) does NOT match and falls through to
   inference. Pins ADR-0017's accepted ASCII-lookalike posture rather than reopening it.
7. **AC7 (connect errors surface):** a failing `startConnectionOAuthFlow` renders its
   message inline on the wizard sheet with a retry affordance; the placeholder never sits
   silent. Covers all three throw paths (unapproved row, non-OAuth spec, mint failure).
8. **AC8 (no silent unhandled rejection):** a regression test asserts the handler attaches a
   rejection handler — the specific defect, pinned so a future refactor to `void f()`
   fails.
9. **AC9 (C1 holds):** registry substitution still carries field DEFINITIONS only, never
   values; the existing credential-scan and registry-borrow-ban suites stay green. Negative
   test: no registry entry contains a credential-shaped value (High-tier requirement).

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
  entry someone adds (a default is a hardcode with better manners). The type change makes
  every existing entry a compile error until it declares its kind — which is the point, and
  is caught by `tsc` now that `packages/auth`'s test script type-checks.
- **D2 — one emitter, driven entirely by the entry.** Replace the hardcoded object literal
  with a `requirementFromRegistryEntry(entry, providerName, slot)` function that copies
  every seat the entry holds. AC3 tests THAT function, so "self-contained" is enforced at
  one altitude rather than asserted per call site.
- **D3 — aliases live on the entry, resolved by the existing normalizer.** `aliases?:
  string[]`, each normalized through the same `normalizeProviderKey`, built into a lookup
  map at module load. Human-authored, reviewed in a PR — the one channel the borrow ban
  exempts. No fuzzy matching (ADR-0017).
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
- **Risk 1 — a registry kind that disagrees with a shipped STARTER's declared shape.** The
  starters declare their own requirements; if `my-repos` declares GitHub differently from
  the registry, admission could now substitute a conflicting kind. **Checked in P0 before
  changing any entry** — this is the one thing that could turn a 10-line data change into a
  starter migration.
- **Risk 2 — already-stored rows keep the old shape** (owner-accepted, forward-only). The
  wizard will now say why instead of dropping silently.
- **Risk 3 — alias collisions** (two entries claiming one alias). Prevented by a P0 test
  asserting the alias map has no duplicate keys.

## Decisions & surprises

- 2026-08-12: **The registry-first ladder already existed and was already correct** — my
  earlier reading that inference "fires for registered providers" was wrong in mechanism.
  Rung 1 short-circuits; the defect is that the short-circuit emits a hardcoded OAuth shape
  and discards the entry's own `fields`. Recorded because it changes the fix from "add a
  ladder" to "make rung 1 honest".
- 2026-08-12: I earlier told the owner the wizard's OAuth connect step was "still a
  placeholder". **That was stale** — it is fully wired (popup, BroadcastChannel, PKCE). The
  note I was quoting predates the P3 wizard work.

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
