# 0019 — App chat is intent-routed; data agency is scratch-isolated reads + human-approved writes

- **Status:** proposed (drafted at Gate 2; accepts on owner plan approval + merge)
- **Date:** 2026-08-11
- **Task:** TASK-20260811-lean-runtime-data-chat

## Context

The chat rail beside an installed app treats every message as a rebuild instruction: one
unconditional builder-shaped turn carrying the app's name, verbatim DDL, all wiki docs and
the ENTIRE app HTML (≤140 KB), with `artifact_write`/`schema_apply`/`app_doc_write` tools
(`useBuilderChat.send` → `buildAppTurnContext`). A user asking "what did I spend on food
last month?" gets an agent primed to rewrite the app.

The owner's directive (2026-08-11): the chat must first classify the ask — data query /
analysis / add-update / schema change / app feature change / other — then execute with
intent-scoped context, so the user can run ANY analysis, query or data change over the
app's own data, including operations the app's built-in UI never shipped; feature asks get
agentic-engineering treatment (load the right context, edit only what's needed, update
docs, reload in place).

The substrate exists: ADR-0010 materializes each app's data as a private runtime SQLite DB
(physical isolation — hub tables like `snug_secrets` are simply not present), the driver
enforces single-statement + forbidden-statement guards, and `db.getAppSchema` returns the
verbatim DDL the LLM needs to write correct SQL. What's missing is any read-only mode
(every exec marks the namespace dirty and can mutate) and any routing.

## Decision

1. **Classification first, scoped context second.** App-attached chat (byok/local) runs a
   tool-free strict-JSON classifier mini-turn (bounded `chatIntentSchema`; untrusted user
   text delimited in the user slot, the inferrer-prompt pattern). Unparseable or
   low-confidence classification fails closed to a clarifying reply — never to a rebuild.
2. **Context follows intent.** Data intents assemble overview + verbatim DDL + doc titles —
   never the app HTML. Feature intents keep the full builder context. Q&A intents answer
   tool-free from overview + docs + DDL. (v1 collapses `schema_change` execution into the
   feature lane; the classification still shapes the UX copy.)
3. **Reads are isolated by construction, not by flag.** A new `db.scratchRun(appId, …)`
   exports the app's materialized runtime DB into a throwaway sql.js instance and executes
   there under the existing statement guards. A mutation physically cannot reach the user's
   file. There is no read-only flag to misconfigure — the C1 "strictness is not a knob"
   doctrine applied to data. Results are row/byte-bounded for LLM consumption with
   truncation stated in-band.
4. **Writes are propose → preview → human-approve → revalidate → execute.** The
   `data_propose_write` tool dry-runs the statements on the scratch copy and returns a
   preview (verbatim SQL, summary, affected counts); execution happens only from the
   user's explicit approval in host UI code, through the real driver's existing guarded
   exec path, after a FRESH dry-run whose affected-row counts must match the approved
   preview (drift re-renders the card instead of executing — the preview the user approved
   is the preview that runs), and the actually-executed counts are recorded on the
   confirmation message. Decline executes nothing. The LLM never holds the executor.
   **The protocol doctrine extends: the LLM proposes, the human approves, the host
   executes.**
5. **Ungated brains keep the legacy path.** Subscription (no client-side tool loop — the
   data tools operate on the client's user DB), WebLLM (tool-free, ADR-0015) and demo modes
   keep today's behavior with the gap stated in-UI; subscription parity joins the queued
   server-twins item.
6. **Feature edits stay versioned and reviewable.** The feature lane keeps the sink →
   version-row → in-place-reload machinery; a bounded `artifact_edit` tool (unique-match
   host-side patch, fail-closed, same sink) lets small changes land without whole-file
   regeneration.

## Consequences

- A Snug app's data outlives its menus: any analysis or data operation the schema supports
  is one chat message away, on data the user owns, in their file. This is a protocol-level
  differentiator recorded in the roadmap's signature moves (proposed S8) and, at ship,
  `docs/product-vision.md`.
- New attack surface, named: LLM-generated SQL over user data. Mitigations are structural
  (materialized-DB isolation — hub tables are physically absent from the scratch copy, with
  `snug_kv` the stated ADR-0010 exemption; scratch-only reads; single-statement +
  forbidden-statement guards; bounded results; stored data delimited as untrusted in
  prompts) plus procedural (human-approved writes shown verbatim, revalidated at execute).
  Residual and accepted-with-disclosure: stored DATA is untrusted prompt input — a row can
  carry an injection aimed at the classifier or the SQL author. **The two mutating lanes
  are honestly asymmetric:** the DATA lane ends at a pre-write human gate; the FEATURE lane
  lands writes on model authority, bounded by versioning + visible in-place reload + revert
  — the same trust model as today's builder chat, with the routed lane labeled in the rail.
  A poisoned row that escalates a data ask into the feature lane therefore yields a
  reviewable version write, never a silent mutation. Recorded in the task's threat-model
  delta.
- The classifier adds one small LLM round trip of latency to app-chat messages in routed
  modes. Accepted: it is tool-free, bounded, and buys back far more in dropped context
  bytes (data turns stop carrying 140 KB of HTML).
- Every new `runAgentTurn` call site (classifier, data turns) wires `onLlmEvent` and makes
  an explicit caching decision (all OFF in v1) — the code-map's call-site rule grows from
  two sites and its row is updated.

## Alternatives considered

- **One turn with all tools; let the model route itself.** Rejected: context cannot be
  scoped after the fact — every message would keep paying the 140 KB rebuild context, and
  tool choice under a rebuild-primed system prompt is exactly the "jumps to rebuilding"
  behavior the owner is correcting.
- **A read-only flag on the existing driver.** Rejected: a flag is a knob, knobs get
  wired wrong (the audit-bug-3 lesson); the scratch copy makes the safe path the only path
  and yields write previews for free.
- **SQL rewriting/allowlisting to jail queries in the shared user DB.** Rejected at
  ADR-0010 already (injection-prone); the materialized runtime DB IS the jail.
- **Auto-executing "obviously safe" writes (single-row INSERT).** Rejected for v1: the
  approval card is the trust story ("nothing changes your data without your yes"), and
  relaxations (session-remember) can be added behind the same gate later without moving it.
