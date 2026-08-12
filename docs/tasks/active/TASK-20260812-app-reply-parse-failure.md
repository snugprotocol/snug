# TASK-20260812-app-reply-parse-failure: in-app agent replies with visible JSON/SQL still fail the bridge parser

- **Status**: **in progress — AC1 + AC3 BUILT and green on the branch (unpushed); AC2/AC4 BLOCKED on the owner's raw reply bytes (see 2026-08-12 pickup journal — hypothesis 1 REFUTED by parser mechanics, truncation/scanner-edge promoted)**
- **Owner**: Jeetu (reported live 2026-08-12 on the app "kept"); diagnosis session by Claude; pickup session (AC1/AC3 build) by Claude 2026-08-12
- **Risk tier**: **provisional Medium — auto-escalates to High** if the fix touches `packages/protocol` (`reply.ts` lives there; it is an internal parser, not a published schema, so spec impact is expected NONE — but the tier rule keys on the package)
- **Branch**: none yet — cut `fix/TASK-20260812-app-reply-parse-failure` off `main` at pickup (this bug is INDEPENDENT of the two 2026-08-12 auth branches; nothing here depends on them)
- **Packages likely touched**: `adapters` (stopReason threading), `runner` (bridge error copy/strike rule), `protocol` (only if `parseAgentReply` itself changes), `playground` (transport cap rule), `db`/none for storage
- **Related**: ADR-0018/0019 (lean runtime + contracts — the `maxOutputTokens` seat), TASK-20260811-lean-runtime-data-chat (where the cap seat shipped), owner bug report 2026-08-12

## Spec (what & why)

**The symptom (owner, 2026-08-12).** A data question typed INSIDE the existing app
"kept" (BYOK mode). The app's agent request came back to the app as its own error copy
*"the agent didn't answer (agent reply was not a parseable JSON object). try again."* —
while the LLM inspector showed the model replying with the SQL, **and (owner
observation) the reply contains JSON data**. Retrying does not help.

**Where the failure actually is (traced 2026-08-12, read-only).** The copy is
app-authored (the KB-taught pattern; verbatim in `examples/habit-tracker/app.html:494`).
The real refusal is the host bridge: `packages/runner/src/host.ts:323` runs
`parseAgentReply(result.text)` on the reply to an APP request and returned
`PARSE_FAILED`. So this is the app→host bridge path — NOT the rail chat's data lane
(nothing in the playground calls `parseAgentReply`; only the runner and the auth
inferrer do).

**Hypotheses, ranked AFTER the owner's "it has JSON data" observation:**

1. **The reply's JSON is not a plain OBJECT.** `parseAgentReply` (`packages/protocol/
   src/reply.ts`) accepts ONLY non-null plain objects — by design. A model replying
   with a bare ARRAY (e.g. rows: `[{...}, {...}]`), or with the only balanced `{…}`
   regions being items INSIDE an array, fails the parse even though the text is
   full of valid JSON. This now best fits the evidence: JSON visibly present, parse
   still failing, retry failing identically.
2. **A `balancedObjects` scanner edge**: the string-state tracker meeting content the
   SQL/answer text produces (stray double-quote at depth > 0, escapes). Would need the
   real bytes to confirm.
3. **Truncation mid-JSON** (stop reason `max_tokens`) — the owner doubts this and the
   default caps are large (anthropic 128k, local 8192); only a contract-authored
   `maxOutputTokens` could do it. Kept as a hypothesis until the raw reply rules it
   out, because the host currently CANNOT distinguish it (see finding below).

**A confirmed defect regardless of which hypothesis wins (found during diagnosis):**
the adapter knows the reply's `stopReason` (`packages/adapters/src/anthropic.ts:108`)
but the turn layer DROPS it (`packages/adapters/src/agent-turn.ts:139` returns only
`text`), so the bridge reports a truncated reply as "not parseable JSON" with no hint,
charges a parse-failure strike for it, and the app's retry can only truncate again —
an unwinnable retry loop presented as the model's fault. The F4 class, one layer down.

**Owner decision (2026-08-12), recorded verbatim as policy for this task:**
> **"Never let a contract's `maxOutputTokens` bind a request that carries a
> `responseSchema` — structured replies must be allowed to finish."**
Implement this rule at the transport seam (`apps/playground/src/agent/transport.ts:129`
is where the contract cap is applied) regardless of what the reproduction shows — it is
correct on its own. The reproduction then decides whether MORE is needed (array
acceptance / scanner fix / copy fix).

**Acceptance criteria (draft — refine at Gate 2 with the repro in hand):**
1. **AC1 (owner rule):** a request carrying a `responseSchema` is NEVER sent with the
   contract's `maxOutputTokens`; a schema-less chat request still honors it. Pinned at
   the transport seam for every mode that applies the contract.
2. **AC2 (repro first):** the owner's REAL failing reply (pasted from the LLM
   inspector into this file at pickup) run through the REAL `parseAgentReply` — the
   test that reproduces the bug before any parser change, and goes green after.
3. **AC3 (stopReason surfaced):** the turn layer carries the adapter's stop reason;
   the bridge distinguishes "reply was cut off (output limit)" from "reply was not
   JSON" in the error message the app receives, and a truncation does NOT charge a
   parse-failure strike (`LIMITS.MAX_PARSE_FAILURES` budget is for model non-compliance,
   not for host-imposed caps).
4. **AC4 (decided by repro):** IF hypothesis 1 holds — decide deliberately whether
   `parseAgentReply` accepts top-level arrays (wrapped as `{data: [...]}`? refused with
   honest copy telling the app author?), or whether the KB/response-format layer must
   teach object-envelopes harder. This is a contract decision, not a patch — the
   parser's object-only rule is load-bearing for every existing app's `responseSchema`.
5. **AC5 (no regression):** runner bridge suites + the habit-tracker/e2e app request
   paths stay green; PARSE_FAILED strikes still fire for genuinely non-JSON replies.

**Out of scope:** the CORS/BYOK outbound relay (separate next-steps row) · anything on
the two 2026-08-12 auth branches.

## First actions at pickup (fresh session)

1. Get from the owner (or the saved inspector log): the failing round trip's RAW reply
   text and stop reason, the provider/model, and the app "kept"'s runtime contract
   (does it set `maxOutputTokens`?). Paste the reply (redacted if needed) into this
   file — it is the repro fixture.
2. Feed it to `parseAgentReply` in a RED test (AC2). Rank the hypotheses with evidence.
3. Gate 2 plan (interview if AC4's contract question is live), then tests-first.

## Session journal (append-only, newest last)

### 2026-08-12 — Claude (diagnosis session, read-only) — session

- Done: traced the symptom from the app's own error copy to `host.ts:323`; ruled the
  rail data lane OUT (no `parseAgentReply` caller in playground); found the dropped
  `stopReason` defect; recorded the owner's cap rule decision and their observation
  that the failing reply DOES contain JSON (which re-ranks the array-shape hypothesis
  to #1). No code changed; no branch cut.
- State: draft task, queued. Independent of the auth branches.
- Next step: pickup in a fresh session; repro from the real reply bytes FIRST.
- Open questions: the raw reply + stop reason + "kept"'s contract (owner-assist, step 1).

### 2026-08-12 — Claude (pickup session, autonomous) — session

- **Step-1 blocker worked around, not solved**: the LLM inspector persists browser-side
  (OPFS/IndexedDB) — the raw failing reply is NOT reachable from this machine. AC2's
  real-bytes repro fixture stays **owner-assist**: paste the failing round trip (raw
  reply text + stop reason + whether "kept"'s contract sets `maxOutputTokens`) into this
  file. Everything below is the owner-approved-regardless half of the task.
- **Branch**: `fix/TASK-20260812-app-reply-parse-failure` cut off `main` (`4d97695`).
- **DIAGNOSTIC FINDING — hypothesis 1 REFUTED by the parser's own mechanics** (pinned in
  `packages/protocol/src/__tests__/reply.test.ts` characterization block; protocol
  SOURCE untouched, tier stays Medium): a bare array of ROW OBJECTS does not
  PARSE_FAIL — `balancedObjects` yields the first `{…}` INSIDE the array, so
  `parseAgentReply` silently succeeds with ONE row and drops the rest (a distinct
  latent hazard, now documented; feeds AC4). The shape that DOES produce the owner's
  exact symptom (PARSE_FAILED + valid JSON visibly on screen + retry failing
  identically) is an envelope whose outer `{` never closes — exactly what a
  `max_tokens` cut produces. **Re-ranked: (1) truncation, (2) scanner edge (needs real
  bytes), (3) array-of-SCALARS reply.** The owner's doubt about truncation predates
  knowing the host could not SEE truncation (stopReason was dropped); with AC3 built,
  the next occurrence will name itself in the inspector and the app error copy.
- **AC1 BUILT (owner cap rule), test-first at both cap seams**: the wire self-describes
  via `parseAppRequest`, so each seam checks `envelope.responseSchema !== undefined`
  and drops the contract's `maxOutputTokens` — direct path
  `apps/playground/src/agent/transport.ts` (+3 tests in
  `runtimeContractTransport.test.ts`), subscription path
  `apps/server/src/routes/invoke.ts` app-path plan (+2 tests in
  `invoke-runtime-contract.test.ts`). Schema-less requests still honor the cap (D4
  tests unchanged); the rest of the contract still rides the turn (asserted).
- **AC3 BUILT (stopReason surfaced end-to-end), test-first bottom-up** — the drop was
  one layer DEEPER than diagnosed: the adapters never read the wire's stop reason at
  all (`AdapterResult.stopReason` was synthesized from tool calls; the type could not
  even express `max_tokens`). Chain now: `anthropic.ts` reads `message_delta`'s
  `stop_reason`, `openai.ts` maps `finish_reason:"length"`, `mock.ts` scripts it
  (`MockTurn.stopReason`) → `AdapterResult`/`AgentTurnResult` unions widened →
  playground direct transport + server SSE `done` event (`{text, stopReason}`) +
  `createHttpTransport` all carry it (optional on `TransportResult`, so older servers
  degrade to today's behavior) → **bridge** (`packages/runner/src/host.ts`): a parse
  failure with `stopReason === 'max_tokens'` charges NO strike and answers
  `HOST_ERROR` "agent reply was cut off by the output token limit before it finished"
  (retryable) instead of PARSE_FAILED "not a parseable JSON object". A truncated reply
  whose JSON still parses succeeds normally (tested). New suite
  `packages/adapters/src/__tests__/stop-reason.test.ts` (9 tests) + 2 bridge tests in
  `host-messaging.test.ts` + SSE/done tests server & http-transport.
- **Bonus surface**: the round-trip snapshot now carries `maxOutputTokens`
  (`AgentRoundTrip.request`) so the LLM inspector shows the cap as sent (also the AC1
  test seam); the inspector's stop-reason chip renders `max_tokens` verbatim.
- **Tests**: protocol 253 · adapters 117 · runner 110 · server 126 · playground 769 —
  all green (tsc-gated); ~10 pre-existing exact-shape assertions updated to include
  the new `stopReason`/`stopReason:'end'` fields (strengthened, none weakened).
- **NOT done / open**: AC2 (real-bytes RED repro — owner-assist as above); AC4 (the
  first-row-wins array hazard is a CONTRACT decision — wrap as `{data:[...]}`, refuse
  honestly, or teach the KB harder; needs owner); e2e/habit-tracker path rerun at
  Gate 5; OAuth-popup-era subscription servers emit `stopReason` only after deploy —
  until then subscription truncations still strike (transport omits the field,
  bridge keeps old behavior by design).
- Next step: owner pastes the failing round trip here → AC2 RED test → AC4 decision
  interview → Gate 5 full pass + PR.
