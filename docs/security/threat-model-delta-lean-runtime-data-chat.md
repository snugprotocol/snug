# Threat-model delta — lean runtime turns + intent-routed app data chat

**Task:** TASK-20260811-lean-runtime-data-chat · **ADRs:** 0018, 0019 · **Date:** 2026-08-11

A delta, not a replacement: it states what this task ADDS to the attack surface, what
defends each addition, and — in its own section — what is deliberately NOT defended and
why. Read alongside `threat-model-delta-dynamic-auth-v2.md` (the connection surface) and
the hard constraints C1–C5 in `CLAUDE.md`.

## 1. What is new

| Surface | What it is | Trust posture |
|---|---|---|
| Runtime contract | Per-app text rendered into the SYSTEM slot of every runtime turn | Host-assigned, never app-claimed; bounded at parse on every channel |
| `/invoke` `contract` field | Client-supplied contract for subscription mode | **Client-controlled system content** — the strictest new surface |
| LLM-authored SQL | `data_query` / `data_propose_write` over the app's data | Runs only on a throwaway copy; writes need a human gate |
| Intent classifier | Routes each app-chat message to a lane | Steerable by the message it classifies |
| `artifact_edit` | Targeted edits to the app file | Trust-equivalent to `artifact_write` |

## 2. The runtime contract as system content

**The claim.** A contract reaches the model's system slot, which is the most trusted
position in a request. Every channel that can write one is therefore bounded and
validated by the SAME schema (`runtimeContractSchema`, strict, per-seat caps plus a 2.5 KB
whole-artifact cap):

| Channel | Gate |
|---|---|
| `runtime_contract_write` tool | `safeParse` in the handler; sink-pinned target so the model cannot choose the app |
| Post-turn synthesis | Same `safeParse`; tool-free turn; failure leaves the app contract-less |
| Starter manifest | Same `safeParse` at install; never overwrites an existing contract |
| `/invoke` body | Same schema at the route; over-bound/extra-field/wrong-type ⇒ 400 before any adapter call; covered by the C1 credential scan |
| Whole-DB import from an untrusted donor (a file the user picked) | Dropped unless canonically byte-identical to a contract the hub already holds |
| Restore from the user's OWN sync origin (recovery restore, sync pull) | Kept — the caller declares `trustedOrigin`; see below |

**Import is the sharpest case.** A user database is a file that can arrive from anywhere —
a backup, a sync remote, someone else's export. Accepting its contracts would let a foreign
file dictate the model's instructions for apps the user already trusts. So an imported
contract survives only when its canonical bytes match one the importing hub already knows;
everything else is dropped and reported in `UserDbImportReport.droppedRuntimeContracts`.
The affected app runs contract-less — degraded, never compromised.

*Corrected 2026-08-11 (review finding R-M2).* As first written, "known" was read off the
CURRENTLY OPEN database, so an EMPTY hub meant "nothing is known" and every imported
contract was nulled — and an empty hub is exactly what a legitimate restore looks like.
Corruption recovery imports the user's own origin image into `openFresh()`, and a new
device's first pull does the same, so the one case this guard exists to protect (a backup
round trip must not silently degrade every app) was the case it broke, permanently:
`needsSynthesizedContract` only fires on first build, so an existing app never regained one.

The exemption is keyed on the **caller**, not on local state. "The hub is empty" cannot
carry the distinction — a hostile donor arrives at exactly the same empty hub a restore
does — so trusting emptiness would trade this guarantee away to fix a usability bug. What
actually differs is provenance the bytes cannot forge: the recovery restore and the sync
pull fetch from the user's own configured origin and pass `trustedOrigin: true`. The flag is
absent-means-untrusted, so a future call site that forgets it gets the safe behavior rather
than the convenient one, and a user-picked file into an empty hub remains fully guarded
(its own negative test).

*Verified during implementation:* all three sync entry points (`pullMerge` in
`sync/loop.ts`, the recovery restore in `sync/recovery.ts`, and the playground's manual
import) funnel through `importUserDb`, so the reconciliation covers sync pulls and not only
file imports. Pinned by a behavioral test, so a future bespoke sync-import would fail loudly
rather than silently reopening the hole.

**A contract cannot forge a system-block boundary.** `renderRuntimeContract` neutralizes
any horizontal-rule LINE in its output, so contract text cannot present itself as a new
top-level system block.

*This was a real defect, found by the P4 whole-surface review and fixed.* The first
implementation stripped only the EXACT separator (`split(SEP).join(…)`), which a contract
containing `\n\n\n---\n\n\n` passed straight through — its own surrounding newlines then
supplied the blank lines the separator needs, and the text after the rule became a PEER of
`10-host-identity`, reading as a fresh host directive. Verified against the real assembler:
5 system blocks where 4 were expected, the fifth attacker-authored. It reproduced from
every free-text seat AND from a settings VALUE (only settings KEYS are charset-bound).
Neutralizing the rule LINE removes the primitive rather than one spelling of it, and it is
regression-tested from all five seats.

**An app cannot claim a contract.** The envelope has no such seat and the frame schemas
strip unknown keys. The negative test asserts on what reaches the SYSTEM slot rather than
on the raw wire string, because the raw envelope legitimately carries unknown fields into
the USER slot — asserting their absence there would pass for the wrong reason.

## 3. LLM-authored SQL

**Isolation is physical, not a name guard.** `db.scratchRun` exports the app's materialized
runtime database and opens it in an independent sql.js instance. Other apps' tables and
every hub table (`snug_secrets`, `snug_connections`, …) were never in those bytes, so a
query naming them fails as a missing table. There is no allowlist to bypass and no
`readonly` flag to set wrongly.

Stated exemption: the app's OWN `snug_kv` is present (ADR-0010's single reserved-prefix
exemption). It is omitted from the schema description shown to the SQL author rather than
execution-guarded, because it is the app's own data.

**Writes end at a human gate.** `data_propose_write` produces a preview and stages a
proposal; only the user's approve action calls `executeApprovedWrite`, which is host code
the model cannot invoke. At execution the dry run is re-run and execution HALTS if the
affected-row counts have drifted from what was approved (TOCTOU).

**The write lane is DML-only** (added 2026-08-11 by review finding R-B1, which was
reproduced end to end before the fix). `nonDataStatementReason` restricts an approved data
change to INSERT/UPDATE/DELETE; it is applied when the proposal is staged and re-applied at
the execute gate, and it lives in `packages/db` beside the other statement guards so the
scratch preview and the real executor cannot disagree about what a write may contain.

The reason the class is closed rather than merely described better: the approval card's ONLY
impact signal is the affected-row count, and `sqlite3_changes()` is **0 for all DDL**. So
`DROP TABLE expenses` previewed as "would affect 0 row(s)" — the most destructive statement
available rendering as the most harmless on the one control the user is asked to judge — and
the TOCTOU guard could not help, because it compared 0 to 0 and agreed. Unlike the feature
lane, the data lane has no versioning and no revert, so the table was simply gone. A
statement kind whose blast radius a row count cannot express does not belong behind a gate
whose only signal is a row count; schema change keeps its own reviewed path through
`schema_apply` (ADR-0010's verbatim-DDL registry), which versions and reloads. This is the
same FAMILY as the earlier whole-surface-review blocker but a different instance: that one
fixed the count being *dropped*, this one closes the count being legitimately *0 while the
statement is destructive*.

**Approved writes are atomic** (R-M4). The execute loop runs inside `BEGIN IMMEDIATE` /
`COMMIT` and rolls back on any failure. Previously a mid-batch failure left the data
half-changed while the UI stated "nothing was changed" — the copy is now made true rather
than merely asserted.

**Statement guards** are shared with the real executor rather than copied:
single-statement, no `ATTACH`, no `load_extension`, no `PRAGMA writable_schema`. The
`writable_schema` match was **hardened in this task**: it previously anchored on
`PRAGMA\s+writable_schema` and so missed quoted (`PRAGMA "writable_schema"`) and
schema-qualified (`PRAGMA main.writable_schema`) spellings, both of which SQLite honors.
Pre-existing, verified bypassable, now closed.

**Results are bounded** (200 rows / 32 KiB) before re-entering the model's context, and
truncation is stated in-band so a partial count cannot be reported as a total.

## 4. The classifier as a steerable router — the honest asymmetry

The classifier reads the user's message, and that message is untrusted text. It is
delimited in the user slot, the system slot is static, the output contract is restated
after the block, and the prompt teaches the steering case by example. None of that makes
steering impossible.

**So what does a successful mis-route actually get an attacker?** The two lanes are NOT
symmetric, and this is stated plainly rather than papered over:

- **The DATA lane's writes end at a pre-write human gate.** A mis-route into `data_write`
  produces a proposal card showing verbatim SQL and row counts. Nothing executes without a
  click.
- **The FEATURE lane's writes land on model authority.** A mis-route into `app_change`
  can write a new version of the app WITHOUT a pre-write confirm. That is the same trust
  model as today's builder chat — bounded by versioning, a visible in-place reload, and
  revert — not a gate.

The consequence, stated exactly: a poisoned row or a crafted message that flips a data ask
into `app_change` yields **a reviewable version write, not a silent mutation**. The user
sees the app reload and can revert. The owner chose this posture explicitly (plan §5
decision (e), approved 2026-08-11); the alternative — a pre-write confirm on
classifier-routed `app_change` turns — would change today's builder UX and was deferred.

Fail-closed narrows the window: every unusable classification (bad JSON, unknown intent,
adapter error, thrown exception, low confidence) resolves to a clarifying question, never
to a lane. No unusable reply can reach the feature lane.

## 5. Untrusted data as prompt input

**App DATA is untrusted prompt input.** A row the user (or an app, or an import) wrote can
contain instruction-shaped text, and query results re-enter the model's context. This is a
residual risk that bounding cannot remove: the whole point of the data lane is to show the
model the user's rows.

What is done: query results are wrapped in a `<query_result>` block whose closing tag is
defanged, with the instruction restated AFTER the block — the same two-slot discipline the
classifier and inferrer prompts use for untrusted text. (Results were previously
concatenated raw; the P4 whole-surface review caught it and the delimiting is now
regression-tested with a row containing its own closing tag.) Results are also bounded, the
data-query tool prompt states that row values are the user's data rather than instructions,
and the data lane holds no tool that can write code or docs — so the worst case of a
successful injection inside the data lane is a wrong ANSWER or a proposal the user can read
and decline, not a code write.

## 6. `artifact_edit`

Trust-equivalent to `artifact_write`: both produce a new version through the same sink,
and no write-time validation exists to bypass — app safety at run time is the C2 sandbox,
which is untouched. The edit-specific risk is landing in the wrong place, which the
unique-match-or-fail rule closes: an ambiguous or missing match fails the whole batch with
nothing persisted, and uniqueness is re-checked after each earlier edit in the batch.

## 7. Residual risks — stated, not mitigated

1. **App data can carry prompt injection** (§5). Inherent to the feature.
2. **The feature lane has no pre-write gate** (§4). An owner decision, revisitable.
3. **The C1 credential scanner misses keys embedded in prose.** `KNOWN_KEY_PREFIX` is
   `^`-anchored, so `"Use key sk-ant-…"` passes — on the new `contract` field AND on the
   pre-existing `payload`/`state` envelope path. The contract seat is therefore **no weaker
   than the envelope seat**, which is the claim it makes; it is not airtight. A test pins
   this limit honestly rather than implying otherwise. Widening the pattern is a
   scanner-level change with its own false-positive budget.
4. **Executed-row counts are the re-validated counts, not driver-reported ones.**
   `DbDriverResult` carries no affected-row count, so `executeApprovedWrite` records the
   counts from the re-validation immediately preceding execution. Because it halts on ANY
   drift, a recorded count cannot describe a change the user did not approve — but it is a
   pre-execution measurement, not a post-execution one. A true count needs a wider
   protocol-facing result shape.
5. **Drift detection compares COUNTS, not rows.** A concurrent change that leaves the
   affected-row count identical while changing WHICH rows match passes the check — row 5
   rewritten in place, or one row deleted while another starts matching the same
   predicate. The window is between preview and approval, and the writer would have to be
   the app itself or a concurrent sync. Closing it means hashing the affected rows at
   preview and re-checking at execute. The limit is now stated in the code where the guard
   lives, and the UI copy reports what drift detection actually found ("the number of rows
   this would affect changed") rather than implying the data is otherwise unchanged.

   *Related, and fixed rather than accepted:* the affected-row counts themselves were
   WRONG for any statement after the first. `scratchRun` treated sql.js's
   `getRowsModified()` as cumulative and took a delta, but it is `sqlite3_changes()` — the
   count for the latest completed statement — so a DELETE(2) followed by an UPDATE(1)
   reported `[2, -1]`. The card rendered the negative number, and the drift check could not
   catch it because it re-ran the identical broken arithmetic on both sides and agreed with
   itself. A `RETURNING` clause separately caused the count to be omitted entirely (the
   result shape keyed `changes` on `columns.length === 0`), so a destructive
   `DELETE … RETURNING id` previewed as "0 rows" and could never trip drift — and the model
   authors the SQL text. Both found by the P4 review, both fixed and regression-tested.

6. **Unrouted modes still answer a data question with a rebuild.** Subscription, webllm and
   demo brains keep today's unclassified path (no server twins for the data tools; webllm
   is tool-free by ADR-0015). Stated in-UI rather than silently degraded.

7. **One approval card per turn, and approve is single-flight.** A second
   `data_propose_write` in the same turn used to silently REPLACE the first staged
   proposal (one `dataWrite` slot per message), so the model chose which change the user
   saw; it is now refused with the tool told so. Approve had no re-entrancy guard, so a
   double-click could execute a non-idempotent INSERT twice — each pass cleared its own
   drift check, since that guard addresses staleness rather than re-entrancy. Both found
   by the P4 review and fixed.

8. **A staged proposal does not survive a reload.** `dataWrite` is React state; the
   persisted assistant message says a change is awaiting approval, but after a refresh the
   card is gone. Nothing executes (lossy, not dangerous), but the surviving text is
   misleading about whether the write happened. Queued rather than fixed here: persisting
   it means a new `PersistedMeta` seat and a rehydration path with its own staleness
   question (a proposal previewed against data that has since moved).

## 8. What did NOT change

- **C1**: no new path reads `snug_secrets`; the credential scan gained coverage rather than
  losing it; contracts carry no credential seat by schema.
- **C2**: no sandbox attribute, CSP, or CDN allowlist change. The runner is untouched.
- **Wire protocol v1**: no frame added, removed, or altered. `appMessageSchema` and
  `appRequestEnvelopeSchema` are byte-unchanged, and `schemas/*.json` is unchanged.
