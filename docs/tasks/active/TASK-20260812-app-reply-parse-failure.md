# TASK-20260812-app-reply-parse-failure: in-app agent replies with visible JSON/SQL still fail the bridge parser

- **Status**: **draft — QUEUED for a fresh session (`/pickup TASK-20260812-app-reply-parse-failure`); diagnosis recorded, reproduction is step 1**
- **Owner**: Jeetu (reported live 2026-08-12 on the app "kept"); diagnosis session by Claude
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
