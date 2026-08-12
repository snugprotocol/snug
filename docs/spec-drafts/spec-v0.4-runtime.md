# Spec v0.4 draft — Runtime contracts and the app data surface (staging)

> **Status: DRAFT, staged locally. NOT staged for any push.** Created under
> TASK-20260811 so the runtime-contract and app-data-chat surfaces have a written home
> while they are being built. Nothing here has been pushed to `snugprotocol/spec`, and
> pushing requires an explicit human ask in that session (PROCESS release rules, C3).
> **AL-12 remains HELD.**
>
> Source of truth for every constant and shape below:
> `packages/protocol/src/runtime-contract.ts`,
> `packages/protocol/src/chat-intent.ts`, and
> `packages/protocol/src/userdb-schema.ts` (the last locked by the DDL snapshot test).
> Where this prose and those files disagree, **the files win and this document is the
> bug**.
>
> **Version note (2026-08-11):** the reference implementation carries an **internal v6
> draft** of the storage schema (`PRAGMA user_version = 6`), adding the nullable column
> `snug_app_versions.runtime_contract_json`. v6 is **additive over v5**: no table is
> added, removed, or reshaped. Published `SPEC-v0.2-draft.md` describes **v2** and is
> unaffected.
>
> **Wire protocol is UNCHANGED at v1.** No frame is added, removed, or altered by this
> draft. A runtime contract NEVER rides the app-frame wire: it is host-side state that
> shapes what the host sends to the model. `appMessageSchema` and
> `appRequestEnvelopeSchema` are untouched, and an app frame that attempts to carry a
> contract field is ignored by the tolerant parser.

## 1. Why runtime contracts exist

An installed app's LLM turn is already ONE self-contained request — no authoring
conversation is replayed. What such a turn has historically carried instead is the
app-BUILDER system assembly: several kilobytes of authoring instructions (HTML template
rules, schema-tool discipline, wiki conventions) that a runtime move cannot act on, sent
on every turn and uncacheable at that size.

A **runtime contract** replaces that with the handful of facts a turn genuinely needs:
what the app is, which of its settings shape an answer, what state arrives each turn, and
the minimal response shape expected back. The effect is protocol-level rather than
app-level: every conforming app becomes cheap enough to run on a small local model, which
is what makes a 4K-context browser brain a viable host at all.

## 2. The contract shape (normative)

A contract is a JSON object. Every field is bounded at parse; a hub MUST reject a
contract that violates any bound rather than truncating it.

| Field | Type | Bound | Meaning |
|---|---|---|---|
| `overview` | string, **required** | 1–600 chars | What the app is and what the model's role in it is |
| `personaNote` | string, optional | ≤400 chars | Voice/tone guidance |
| `stateGuidance` | string, optional | ≤500 chars | What the app sends each turn (state, never history) |
| `responseGuidance` | string, optional | ≤500 chars | The minimal response shape expected back |
| `settings` | object, optional | ≤16 entries; keys `[a-z0-9_]{1,40}`; scalar values ≤120 chars | The app-settings slice that shapes answers |
| `maxOutputTokens` | integer, optional | 256–8192 | Per-turn output ceiling |

The serialized contract MUST additionally be **≤2560 bytes** as a whole. The per-field
bounds sum to more than that deliberately: a contract may spend its budget on any field,
but the total is what rides every turn.

The object is **strict** — an unknown key is a rejection, not a passthrough. This differs
from the deliberately tolerant app-frame parsers, and the difference is the point:
unknown fields on the wire are data, whereas an unknown field here would be unreviewed
text reaching the model's system instructions.

`maxOutputTokens` is **opt-in and narrowing only**. A host applies it as a ceiling that
can lower, never raise, whatever cap that execution mode already imposes; a contract
asking for more than a local runtime can deliver is clamped down, not honored. An absent
value MUST mean "behave exactly as an app with no contract" — silently capping a
contract-less app would truncate legitimate long outputs.

## 3. Custody rules (normative)

**A contract is host-assigned, never app-claimed.** It is read by the host from the app's
version row and rendered into the model's system instructions. An app cannot supply,
amend, or read its own contract through any frame. This is the same trust shape the
protocol already applies to `dbNamespace` and the network app identity.

**Version-linked storage.** A contract lives on the app VERSION row, not on the app. Two
consequences a conforming hub MUST implement:

1. **Copy-forward.** Writing a new version copies the contract forward from the version
   being superseded, so an ordinary edit never strands it.
2. **Revert copies from the target.** Revert and factory-reset copy the contract from the
   version being RESTORED, never from the version being left. Reverted code must run
   under the contract that shipped with it; reverting to a contract-less version clears
   the contract.

**Imported contracts are untrusted.** When a hub imports a whole user database, it MUST
drop every `runtime_contract_json` it cannot match, byte-for-byte after canonical
serialization, against a contract it already holds. A contract speaks with system
authority at runtime, so accepting one from an untrusted file would let that file dictate
the model's instructions. The affected app simply runs contract-less until re-authored —
degraded, never compromised. Comparison MUST be canonical (key-sorted) rather than raw,
or ordinary round-trips through sync and backup would strip legitimate contracts.

**Graceful degradation.** A stored contract that is absent, malformed, or over-bound MUST
read as "this app has no contract" and the turn MUST proceed on generic instructions. A
corrupt row is not a reason to fail a user's move.

## 4. The app data surface

A conforming hub MAY offer a chat surface beside an installed app. Where it does, this
draft constrains how that surface may touch the app's data.

**Classification precedes execution.** A message is first classified into an intent —
`data_read`, `data_write`, `schema_change`, `app_change`, `app_question`, `other` — and
the intent selects both the context assembled and the tools offered. Classification MUST
fail closed: an unusable classification produces a clarifying reply, never a default
lane. In particular it must never fall through to the lane that writes code.

**Reads are isolated by construction.** Generated SQL MUST execute against a throwaway
copy of the app's own materialized database, never against live storage and never behind
a "read-only" flag. Isolation is then a property of what the copy CONTAINS: another app's
tables and every hub-namespace table are physically absent, so a query naming them fails
as a missing table rather than being caught by a name filter. The app's own key-value
table is the one in-namespace exemption; it is omitted from the schema description shown
to the query author rather than blocked at execution.

**Results are bounded** before re-entering the model's context (reference implementation:
200 rows / 32 KiB), and a truncated result MUST say so in-band.

**Writes are proposed, previewed, approved, then re-validated.** A data write MUST be
presented to the user as verbatim statements plus an affected-row preview computed on the
throwaway copy, and MUST execute only on explicit approval. At execution the hub MUST
re-run the dry run against live data and **halt if the affected-row counts have drifted**
from what was approved; the record of the operation states the counts actually executed,
never the previewed ones. Declining executes nothing.

**Stored data is untrusted input.** Rows may contain text crafted to read as
instructions. Any prompt carrying stored data or query results MUST delimit it as
untrusted.

## 5. Relationship to other drafts

- **v0.2 (userdb)** — owns the storage format. v6's column and its custody rules are
  summarized there and specified here.
- **v0.3 (auth)** — owns credential custody. Nothing in this draft admits a credential
  seat: contracts carry no secrets by schema, and the data surface runs on app data
  only, never on the credential namespace.
