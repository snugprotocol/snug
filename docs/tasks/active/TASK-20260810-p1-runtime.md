# TASK-20260810-p1-runtime — Dynamic Auth v2, P1 (the RUNTIME)

**Status:** implemented, green. **Branch:** `feat/TASK-20260810-p1-runtime` (cut from P0).
**Parent plan:** `docs/TASK-20260810-plan` branch (not on main — see Gate 5 note below).

P0 landed the CONTRACTS (`connectionRequirementSchema`, schema v4 `snug_connections`, the
slot-keyed secret builders, the admission lint). P1 lands the RUNTIME that consumes them:
the connected-fetch executor now routes by slot.

---

## What shipped

1. **Slot routing** (`packages/auth/src/connected-fetch.ts`). The executor resolves the
   grant by TARGET HOST against each row's FROZEN `allowed_hosts`. Zero matches →
   `NET_NOT_APPROVED` with a CTA naming the provider of a *declared* row that would match;
   two matches → `NET_AMBIGUOUS_CONNECTION`, refused before any credential read.
2. **Amended gate order** — parse-then-resolve (fold F-m2). See the ADR note below.
3. **Approved-grant binding** (folds B2/S-m2). `pendingRequirement` is in the row type and
   read by nothing.
4. **Slot-keyed credentials**, via `SlotScopedCredentialStore`, with **no v3 fallback**.
5. **`'none'` kind** (Q6) — injects `{}`; approval and the host ceiling still gate it.
6. **`executeConnectionTestRequest`** (Q7) — a thin wrapper that delegates to the same
   `execute`, proven by a source walk that no third `fetchImpl(` seat exists.
7. **`NET_AMBIGUOUS_CONNECTION`** added to `NET_ERROR_CODES`; it joins the CTA map's *null*
   set (not auth-fixable — see the M12 note in `wizardStore.test.ts`).

**Cutover (fold B1) honoured:** `llmProposalSchema` and the `snug_auth_specs` surface are
untouched; `NetSpecReader` still ships and `connected-fetch.test.ts` (33 tests) is green
unmodified. Their deletion remains a named exit item of P4/P3.

---

## AC5(b) — session binding: the falsifiable exit

**Disposition: (i) — CITATION. `expectedFlowId` binding is per-session, so it subsumes
session binding. No `expectedSessionId` is needed and none was added.**

The umbrella claimed OProject audit bug 2 (session binding) fixed, while
`expectedSessionId` does not exist anywhere in `packages/auth`. The question is whether the
shipped `expectedFlowId` binding is genuinely per-session or merely per-flow. It is
per-session, by four linked facts:

1. **`apps/playground/src/state/wizard.ts:186`** — `let activeFlow: ActiveFlow | null` is
   module-scoped state in the browsing context that started the flow. It is the ONLY source
   of `expectedFlowId`.
2. **`apps/playground/src/state/wizard.ts:565`** — the callback passes
   `expectedFlowId: flow.start.flowId`, read from that held `activeFlow`. The comment at
   :564 states it: "the caller's OWN held copy — never parsed out of the delivery." The
   value therefore cannot be supplied, replayed, or influenced by the delivered payload.
3. **`apps/playground/src/state/wizard.ts:544–547`** — `handleDelivery` returns early
   unless BOTH `activeFlow !== null` AND `wizardStore.get() !== null`. A delivery arriving
   with no live wizard session is dropped before any exchange. `forceCloseWizard`
   (:346–352) calls `teardownFlow()`, which nulls `activeFlow` (:216–226) — so ending the
   session destroys the binding rather than leaving it exchangeable.
4. **`packages/auth/src/oauth-service.ts:338`** — `flowId = randomBase64Url(16)`, 128 bits
   of CSPRNG per flow, checked at `oauth-service.ts:387` against the HMAC-signed state's
   `payload.flowId` (and `payload.appId`), with the flow row burned on mismatch (:390).

**Why this is session binding and not merely flow binding:** a session cannot outlive its
flow binding, and a flow binding cannot outlive its session. `startOAuthFlow` tears down any
prior flow before installing a new one (:466, :538), and the staleness guard at :473
(`wizardStore.get() !== session`, an identity check) bails after every await if the session
was closed, replaced, or re-opened. So the set of accepted callbacks is exactly {the one
flow started by the currently-live session}. A callback from a previous session, a closed
session, or another tab's session finds either `activeFlow === null` or a different
128-bit `flowId`, and is refused with `flow_mismatch`.

**What would falsify this** (stated so the claim is checkable, not merely asserted): if
`activeFlow` were persisted across sessions (localStorage/OPFS rather than module memory),
or if `handleDelivery` dropped its `session === null` check, or if `flowId` were derived
from anything predictable such as `appId` or a counter, the subsumption breaks and an
explicit `expectedSessionId` becomes necessary. None of those hold at the cited lines
today.

**Scope limit, stated honestly:** this citation covers the *playground* caller, which is
the only caller of `handleCallback` in this repo. A future embedder that holds
`expectedFlowId` in storage shared across sessions would need its own analysis; the
obligation transfers with the caller, not with the service.

---

## Gate 3↔4 swap — amended in the open (fold F-m2)

The shipped v3 order resolved the row (a PK lookup on `app_id`) before parsing the URL. v4
chooses the grant BY HOST, and the host is only knowable from a parsed URL, so resolution
structurally cannot precede the parse. Only these two gates exchange places; every other
gate keeps its order and semantics.

**Observable difference:** an app with no approved connection sending a malformed or
non-https URL now gets `NET_INVALID_REQUEST` / `NET_SCHEME_BLOCKED` instead of
`NET_NOT_APPROVED`. That is more honest (the request was malformed regardless of approval)
and leaks nothing new — URL validity is a property of the app's own input. The parse gates
only ADD refusals ahead of the approval check; none behind it were removed. Rationale is
also inline at the swap site in `connected-fetch.ts`.

---

## Test evidence

- `@snugprotocol/auth` — **296 passed (23 files)**, incl. the 56 new P1 tests and the 33
  untouched v3 `connected-fetch.test.ts` tests.
- `@snugprotocol/db` — 243 passed (17 files).
- `playground` — 482 passed (55 files).
- `@snugprotocol/protocol` — 221 passed (14 files).

**Mutation evidence** (each break was applied, the named test observed red, then restored):

| # | Mutation | Test that went red |
|---|---|---|
| M1 | ambiguity returns `matched: matches[0]` instead of refusing | AC1 two-match refusal + "before any credential is read" |
| M2 | slot read falls back to the v3 non-slot key | AC7 "a v3 NON-SLOT key is NOT a fallback" |
| M3 | grant binds to `pendingRequirement ?? requirement` | AC4 "a pending requirement changing the TEMPLATE" |
| M3b | routing also matches pending `declaredApiHosts` | AC4 host widening + "routing ignores pending hosts" |
| M4 | `scoped(field)` returns `field` (slot scoping removed) | 4× AC3 cross-slot theft, 2× AC1 routing, 2× AC7 |
| M5 | `'none'` injects a fabricated header instead of `{}` | AC5 "injects NOTHING" |
| M6 | revoked rows participate in routing | AC1 "a REVOKED row does not participate" |

---

## Deviations / notes for Gate 5

- **`SnugAuthError.code` is now appended** to the `NET_AUTH_FAILED` message
  (`missing credential field 'token' — connect this app first (missing_credential)`). The
  wire code is unchanged; only the human-readable message gained the typed cause, so host
  surfaces can distinguish causes without the message-substring matching N1 outlawed. No
  shipped test pinned that message shape; C5 holds (the code names the FIELD, never a value).
- **`CredentialStore.getConnectionState/setConnectionState/clearConnectionState` gained an
  optional trailing `slot`.** Optional, not required, so every v3 caller keeps compiling
  (cutover rule). `clearApp` is deliberately NOT slot-narrowed — its contract is the whole
  app slice, and narrowing it would strand other slots' credentials after a disconnect.
- **`ConnectedFetchDeps` is now a union** (`specReader` XOR `connectionReader`) rather than
  two optional fields, so a deps object with neither fails at the wiring site.
- **A module-load drift guard** asserts `authCredentialSecretKey(app, 'slot:field') ===
  authConnectionCredentialSecretKey(app, 'slot', 'field')`, so the composite re-key and P0's
  canonical builder can never diverge silently.
- **This task file did not exist before P1** — the parent plan lives on branch
  `docs/TASK-20260810-plan`, which is on neither `main` nor this branch. Worth resolving
  before Gate 5 so the plan and the task file are reachable together.

---

## Orchestrator verification (2026-08-10) — claims re-checked, not accepted

Every load-bearing P1 claim was re-verified by the orchestrator at source or by execution.
Agent reports are evidence, not authority.

- **AC5(b) — CLOSED by citation (disposition (i)), and the citation HOLDS.** Open since
  2026-08-09. Re-verified line-for-line: `activeFlow` is module-scoped in-memory state
  (`apps/playground/src/state/wizard.ts:186`); `expectedFlowId` reads the caller's OWN held
  copy (`:565`, comment at `:564` confirming it is never parsed from the delivery);
  `handleDelivery` drops any delivery with no live session (`:547`); the staleness identity
  check bails on close/replace/re-open (`:473`). **The load-bearing half — that `activeFlow`
  is memory-only — was verified INDEPENDENTLY**: it appears in no other module and there is
  zero `localStorage`/`sessionStorage`/`indexedDB`/OPFS/secret-store persistence of it
  (grep clean). So the flow binding cannot outlive its session, which is exactly what makes
  `expectedFlowId` subsume `expectedSessionId` here. AC5(b) is met UNDER ANOTHER NAME, with
  a stated falsifier: persist `activeFlow` across sessions, or drop the `session === null`
  check, and this disposition dies.
- **The MAJOR (frozen ceiling vs re-editable declared hosts indistinguishable) was REAL and
  is now FIXED — confirmed by re-running the reviewer's own mutation.** Applied M5 (change
  the routing predicate at `connected-fetch.ts:442` from `row.allowedHosts` to
  `deriveRowHosts(row)`): **1 failed | 298 passed** — the mutation is now CAUGHT, where it
  previously survived all 296. Restored from backup; suite back to **299 passed**, file diff
  unchanged. The gating predicate reads the FROZEN ceiling; `deriveRowHosts` is confined to
  CTA copy on an already-refused path.
- **The AC6 source-proof MINOR was real** — a reviewer demonstrated BY EXECUTION that the
  old `toContain('execute(')` assertion passed while the probe bypassed all ten gates. The
  fold replaced it with a NEGATIVE assertion (the probe body must contain no `deps.fetchImpl(`
  seat of its own), which is the half that actually catches a bypass. The test comment
  records the defeat honestly rather than quietly upgrading.
- **A fold agent CORRECTED its own review finding rather than complying** — the prescribed
  fix claimed one empty-ceiling test would kill mutation M6; execution showed M6 survived,
  because `deriveRowHosts` is only reachable from already-refused CTA paths. It added a
  third test (a revoked row whose declared list was re-edited to add a phishing host) that
  genuinely closes M6. Reviewers are not taken at face value in either direction.
- **Suites re-run live by the orchestrator: root `pnpm test` 19/19 · protocol 221 ·
  auth 299 · db 243 · playground 482.** Cutover verified: `connected-fetch.test.ts` (33 v3
  tests) green and unmodified.
- **Carried to P5** (not patched mid-phase): the pre-existing brand-ADJACENT registry-borrow
  evasion found during P0 — `"Spotify Inc"`, `"Spotify Connect"`, `"Spotify-Premium"` all
  miss the registry and are admitted with attacker-authored fields, because
  `normalizeProviderKey` collapses case/punctuation but not added words.
