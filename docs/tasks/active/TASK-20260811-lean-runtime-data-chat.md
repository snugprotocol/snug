# TASK-20260811-lean-runtime-data-chat: Lean runtime turns (authored contracts) + intent-routed app data chat

- **Status**: **COMPLETE — P0–P4 implemented, whole-surface reviewed, awaiting owner review + PR** (2026-08-11). Plan approved by owner (all of §5 (a)–(e) as planned); every AC has tests; 19/19 turbo tasks green uncached at **2156 tests + 185 examples** (from 1881 at pickup).
- **Owner**: Jeetu (commissioned 2026-08-11); planning session by Claude; implementation session by Claude (took Owner 2026-08-11 on plan approval)
- **Risk tier**: **High** (auto-escalated: `packages/protocol` schemas + `userdb-schema.ts`, prompt-store changes under ADR-0004, a new LLM→SQL surface adjacent to C1)
- **Branch**: `feat/TASK-20260811-lean-runtime-data-chat` (off `main` at `4b9c49c` — the Dynamic Auth v2 chain is MERGED as of PR #33/#34, so this builds on the v4 world directly)
- **Packages touched**: `protocol`, `db`, `knowledge`, `playground` (agent/appContext, transport, tools, run views); `sdk` (possibly — hook guidance only); `adapters` (possibly — response-format plumbing); dependents per graph: change `protocol` → run everything
- **Spec impact**: **internal-staged only** (A12b pattern). userdb schema bump (runtime-contract storage) → `docs/spec-drafts/spec-v0.2-userdb.md` update; new internal-draft runtime-contract + chat-intent shapes in `packages/protocol` (OUT of `schemas/` SOURCES, like net frames). **Nothing pushes to `snugprotocol/spec` — AL-12 stays HELD.**
- **Related**: TASK-20260810-dynamic-auth-rewrite (the v4 patterns this mirrors: build-time inference persisted before first run, staged re-inference on surface-touching edits, propose/approve/freeze) · ADR-0004 (prompt store) · ADR-0010 (native app schemas + verbatim-DDL registry) · ADR-0011 (LLM-optional apps) · ADR-0012 (per-turn caching scope) · queued items absorbed: WebLLM 4K app-context truncation rule (2026-08-06), app-attached context caps

## Spec (what & why)

Two owner-commissioned features for INSTALLED apps at runtime (owner message 2026-08-11, verbatim intent preserved):

**F1 — Lean runtime turns.** Today every runtime LLM call from an installed app (e.g. a Chess
move) carries the app's original authoring context/instructions, spending tokens and latency
on a prefix the turn does not need. At AUTHORING time the builder LLM must additionally
produce a compact, persisted **runtime contract**: a brief app overview, the app-settings
slice relevant to LLM turns (e.g. difficulty), what state the app sends per turn (current
board + last move, not history), and the minimal JSON response shape expected back. At
runtime the app's turns are assembled FROM the contract — never from the authoring
conversation — so request and response payloads are the bare minimum for a best-quality
answer. Contract updates ride app edits that touch the LLM surface (mirroring the v4
"requirements are inferred at build time, staged on auth-touching edits" pattern).

**F2 — Intent-routed app data chat.** The chat window next to an installed app must stop
treating every message as a rebuild instruction. Each message is first classified —
data query / data analysis / data add-update / schema change / app feature change / other —
and then executed with intent-scoped context: data intents get the app's DDL (from the
ADR-0010 verbatim-DDL schema registry) + LLM-generated SQL over ONLY that app's native
tables (reads run free, writes require explicit user approval — the propose/approve
doctrine extended to data); feature intents get agentic-engineering treatment (load app
code + docs, edit only the needed parts, update docs, write the version delta, in-place
reload). The user is no longer limited to the app's built-in menus: any analysis, query, or
data-management ask the data can answer is honored. "Find my most recurring expenses in the
last 3 months" or "add this expense to last week" work on a budget app that never shipped
those features.

**Why (protocol objectives):** both features are protocol USPs, not app features. F1 makes
every Snug app cheap and fast on ANY brain (and is the enabling fix for WebLLM's 4K context
at 1.2). F2 makes the user's ownership of the data *operational* — the app store category
claim ("own your apps") extends to "and your data answers to you, not to the app's menu".
Doctrine preserved throughout: the LLM proposes, the human approves, the host freezes/executes.

**Acceptance criteria** (each becomes at least one test; exact test list in the Plan):
1. **AC-F1-1 (lean assembly, decision altitude):** a runtime turn from a contract-bearing app is assembled from {contract system block + app-sent state/event payload} only; the authoring conversation is absent. Asserted at the call site that decides the assembly (per lessons 2026-08-05), not at the adapter.
2. **AC-F1-2 (authoring + persistence; byok/local):** building an LLM-using app in byok/local mode persists a runtime contract with the app before first run; the contract is version-linked (factory revert restores the factory contract) and **survives ordinary edits via copy-forward** (a cosmetic edit does not strand it). Subscription-mode authoring is a stated gap that joins the queued server-twins item (see fold-in F-M2).
3. **AC-F1-3 (response contract):** the turn requests the contract's minimal JSON response shape; a conforming reply parses and reaches the app; a malformed reply fails closed per the existing app-frame error path (no silent retry loop).
4. **AC-F1-4 (legacy + LLM-optional):** an app with no contract behaves exactly as today (no regression), and an ADR-0011 LLM-optional app is untouched.
5. **AC-F1-5 (edit staging):** an app edit that touches the LLM surface refreshes/stages the contract; an edit that does not, does not.
6. **AC-F1-6 (KB delivery; byok/local for the tool call):** the app-authoring KB teaches contract emission; the emission format is scanner-sync-tested (the auth-directive pattern); build-time retrieval queries hit the new section.
6b. **AC-F1-7 (imported contracts are untrusted):** a whole-DB import never injects a foreign `runtime_contract_json` — imported contracts are dropped unless byte-identical to a locally known version row (the connection-reconciliation doctrine); the app runs on the lean generic layers until re-authored. Negative test at the import reconciler.
7. **AC-F2-1 (classification, fail-closed):** each app-chat message yields a strict-schema intent; unparseable classification fails closed to a clarifying reply — never to a rebuild.
8. **AC-F2-2 (scoped context):** data intents assemble DDL + samples, never app code; feature intents assemble code + docs; asserted at the assembler.
9. **AC-F2-3 (namespace jail):** generated SQL executes only inside the app's own materialized runtime DB; another app's tables and every hub table (`snug_secrets`, `snug_connections`, …) are **physically absent** from the scratch copy — tests assert absence (a query naming them errors as missing), not a bolt-on name guard. Stated exemption: `snug_kv` (the app's OWN kv, ADR-0010's one exemption) is present; it is excluded from the schema context shown to the SQL author but a query touching it is the app's own data, not a breach.
10. **AC-F2-4 (read/write split + TOCTOU):** query/analysis intents run read-only (a generated UPDATE under a query intent physically cannot reach the real DB); add/update intents produce a human-readable proposal + affected-row preview and execute ONLY after explicit user approval; decline executes nothing. **At execute time the dry-run re-runs against the live DB: if the affected-row counts drifted from what was approved, execution halts and the card re-renders; the message `meta` records the actually-executed counts, never the previewed ones.**
11. **AC-F2-5 (feature-change path):** a feature intent produces a scoped edit (code + docs + version bump + in-place reload), and a data intent can never produce an artifact/code write (negative test).
12. **AC-F2-6 (result bounds):** query results are row/byte-capped before re-entering the LLM context; the cap is stated in the reply when it truncates.
13. **AC-BOTH (observability):** contract turns and chat-intent turns appear in the existing round-trip observability with token usage; no new blind spots (both `runAgentTurn` call-site rules hold).

**Out of scope:** publishing any spec text (AL-12 held; staging only) · multi-app/cross-app
queries (isolation story, needs its own ADR) · background/scheduled data jobs (post-2.0) ·
subscription-mode server twins for the new data tools (joins the queued `schema_apply`/
`app_doc_write` twins item — the gap is stated in-UI, same as today) · retrofitting
contracts onto already-built apps automatically (a re-author path exists via F2's feature
intent; bulk migration is a follow-up) · WebLLM-specific truncation polish (1.2; F1 is its
enabler, not its completion).

## Interview → answers (from the commissioning message; assumptions for owner confirmation at plan approval)

- **Behavior**: as specified above — owner's message was the interview.
- **Assumption A1**: contract-bearing turns still flow through the existing app-frame envelope path (no new iframe capability; C2 untouched). The contract changes WHAT the host assembles, not WHO may call.
- **Assumption A2**: data-write approval is per-proposal (each mutation batch approved explicitly), with no session-remember in v1 — conservative first, relaxable later. [Owner may relax.]
- **Assumption A3**: F2 lands in byok/local direct mode first (where `schema_apply`/`app_doc_write` already run); subscription parity is documented, not built (matches the existing queued-twins precedent).
- **Assumption A4**: schema-change intents route through the EXISTING `schema_apply` tool (verbatim-DDL registry) with its guards, not a new DDL path.

## Plan

> Gate 2, written 2026-08-11 from a three-way code recon of main-post-merge (`4b9c49c`).
> Every file:line below was verified in that tree. Tests come FIRST in every phase (TDD.md);
> High tier ⇒ this plan gets a fresh-context AI review before any implementation code, and
> the run ends with a WHOLE-SURFACE review (lessons 2026-08-10 — phase reviews are blind to
> phase-boundary bugs).

### 0. Ground truth the plan stands on (recon findings, corrected hypotheses)

**F1 — where the runtime tokens actually go.** The app-frame turn is ALREADY minimal in the
messages slot: exactly one user message = the tagged envelope (`[SNUG_APP_REQUEST]` +
`{appId, requestId, action, payload, state, responseSchema}`), no thread history, no
authoring conversation replay (`apps/playground/src/agent/transport.ts:53–98`,
`apps/server/src/routes/invoke.ts:100–106`). The owner-observed "original build
instructions on every move" is real but lives elsewhere:
1. **Misfit system prompt**: both app-turn call sites send the app-BUILDER system assembly —
   `buildHostSystemPrompt({appBuilder: true, artifacts: false})` at `transport.ts:57` and
   `invoke.ts:103` — ~6 KB/~1.4K tokens of authoring instructions (`system/30-app-builder-summary.md`
   + KB `00-summary.md` inlined) that a runtime move cannot use, uncached by design (ADR-0012).
2. **App-authored payload duplication**: the KB never teaches lean runtime requests, so
   generated apps over-send. The Chess starter itself sends `fen`+`history` TWICE (payload
   AND `state`), the full legal-move list, and persona prose on every move
   (`examples/chess/app.html:555–562`).
3. **No output bound**: app turns inherit the 128K default (`DEFAULT_MAX_TOKENS`,
   `packages/adapters/src/anthropic.ts:33`); `responseSchema` is prose-enforced only
   (`system/40-app-response-format.md`), never validated (`packages/protocol/src/reply.ts:16–34`).

**F2 — what the app chat is today.** Every rail-chat message beside an installed app is
unconditionally a REBUILD-shaped builder turn: `useBuilderChat.send()` →
`buildAppTurnContext` (`apps/playground/src/agent/appContext.ts:47–100`) assembles name +
verbatim DDL + all wiki docs + the ENTIRE app HTML (cap 140 000 chars) and instructs "write
the ENTIRE updated file"; tools are `snug_app_builder`/`artifact_write`/`schema_apply`/
`app_doc_write` (`agent/tools.ts:37–148`). No intent concept exists anywhere. There is no
diff/edit path (whole-file rewrite is the pinned tool contract, `prompts/tools/artifact-write.md`).

**The executor F2 needs already half-exists.** `userDb.driver.handle(appId, {op:'exec', sql,
params})` runs single-statement SQL against the app's **materialized private runtime DB**
(ADR-0010) — physical isolation from `snug_secrets`/`snug_connections`/other apps is
inherent (those tables are simply not present in the materialized DB). Guards today:
single-statement, `ATTACH`/`PRAGMA writable_schema`/`load_extension` blocked, bound params,
result-size cap (`packages/db/src/driver.ts:123–132, 229–272`). What's missing: any
read-only mode (every exec marks the namespace dirty), and any row-count bound shaped for
LLM consumption. Schema introspection exists: `db.getAppSchema(appId)` returns verbatim DDL
(`packages/db/src/userdb/userdb.ts:1874–1878`).

**Persistence/versioning machinery to reuse, not rebuild:** version rows with factory pin +
revert/reset (`snug_app_versions`, `db.revertApp` copy-forwards), the artifact sink's
host-pinned target (`agent/artifactSink.ts:48–108`), the post-turn finalizer seam
(`finalizeConnectionDeclaration` from `useBuilderChat.ts:408–438` — the v4 precedent for
"authoring produces a persisted contract"), in-place reload via `contentEpoch`/`frameEpoch`
(`RunView.tsx:209–215, 685`), and the starter install-act channel
(`starterDeclaration.ts` + `installStarterConnections`).

### 1. Design decisions (D1–D10; ADR-0018/0019 drafted alongside this plan)

- **D1 — Runtime turns get their own system assembly.** New `HostSystemPromptOptions`
  branch `appRuntime: true` → layers `10-host-identity` + `40-app-response-format` + a new
  thin `system/45-app-runtime.md` (runtime-brain doctrine: answer from the request's
  state/payload only, minimal JSON, no prose outside the object). The builder layers stop
  riding app turns in ALL modes — this alone removes ~3 KB/turn net including subscription
  (layers 30 + KB 00-summary ≈ 3.4 KB out, thin new 45 layer in; 10 and 40 are retained —
  fold-in F-m6), before contracts exist. (Golden assembly snapshots gain the new combination.)
- **D2 — The runtime contract is a version-pinned artifact.** New internal-draft
  `runtimeContractSchema` in `packages/protocol/src/runtime-contract.ts` (OUT of `schemas/`
  SOURCES, like `connection-requirement.ts` — the export guard test is extended). All
  fields bounded at parse (lessons: bounds-at-parse): `overview ≤600`, `personaNote? ≤400`,
  `stateGuidance? ≤500`, `responseGuidance? ≤500`, `settings?` ≤16 scalar entries with
  bounded keys/values, `maxOutputTokens? ∈ [256, 8192]`. Whole serialized contract ≤ 2.5 KB.
  Storage: new nullable column `runtime_contract_json` on **`snug_app_versions`** —
  version-linked by construction. **Lifecycle rules (fold-in F-B1/F-SB1):**
  (i) `saveAppVersion` COPIES the contract forward from the app's current version by
  default, so an ordinary edit never strands it; `runtime_contract_write`/synthesis then
  overwrite on the authored version (this also kills the tool-ordering hole — a contract
  written before the artifact still propagates). (ii) `revertApp`/`resetToFactory` copy
  from the **target** version, never the pre-revert current one (the naive copy-forward
  gets revert wrong — tested with a revert-then-turn sequence). (iii) **Imported contracts
  are untrusted**: the import reconciler drops `runtime_contract_json` from imported
  version rows unless byte-identical to a locally known row (the connection-reconcile
  doctrine — a foreign contract must never speak with system authority); the implementation
  session verifies whether sync pulls share the `importUserDb` seam and applies the same
  rule there. `USERDB_SCHEMA_VERSION` 5→6, additive `addColumnIfMissing` migration +
  self-heal path untouched (no new table). Rejected: a `snug_app_docs` slug (free text, not
  version-linked, and docs already inject into builder context — would double-inject).
- **D3 — The contract never rides the wire envelope; wire protocol v1 stays UNCHANGED.**
  Injection is host-side at the two call sites: direct mode appends the contract as a
  per-turn system SUFFIX after the stable layers (ADR-0012's end-of-system rule).
  **The transport reads the contract PER SEND, never at creation** (fold-in F-M1: the
  transport memo does not depend on `contentEpoch` — RunView threads only `appId` in, and
  the wrapper reads the contract inside `send()`, exactly like `currentBrain()`/the
  settings stores per the transport's own 2026-08-06 lesson; AC-F1-1's test runs a
  turn → revert → turn sequence and asserts the second turn carries the reverted
  contract). Subscription mode adds an optional `contract` field to the **`/invoke` HTTP
  body** (an internal hub API, not protocol surface): the wire carries **JSON only**,
  `invokeBodySchema` parses it with `runtimeContractSchema` STRICT (over-bound or
  extra-field contract → 400, negative test — fold-in F-M3), the server's credential scan
  covers it (defense-in-depth), and ONE shared renderer in `packages/knowledge`
  (`renderRuntimeContract`) converts JSON → system text for BOTH call sites — the contract
  never exists as two hand-maintained renderings (lessons 2026-08-03, shared-literal fork). `appMessageSchema` and
  `appRequestEnvelopeSchema` are untouched; an app-frame message attempting to carry a
  contract field is ignored by the tolerant parser (negative test). Contract is therefore
  **host-assigned, never app-claimed** — same trust shape as `dbNamespace`/`netAppId`.
- **D4 — Output caps are contract-opt-in.** New per-turn `maxOutputTokens?: number` on
  `AdapterRequest` (per-TURN like `cache`, per ADR-0012's altitude rule; adapters clamp to
  their construction ceiling; local mode's 8K cap wins). App transport sets it ONLY when the
  contract specifies it — contract-less legacy apps keep today's behavior exactly (AC-F1-4;
  capping a legacy story-teller app would be a silent regression). App-frame caching stays
  OFF (ADR-0012 unchanged: even with contract the prefix sits below the cacheable minimum).
- **D5 — Contract authoring mirrors the v4 connection pattern.** New builder tool
  `runtime_contract_write` (zod-validated payload, sink-pinned target app, writes onto the
  version being authored; tool prompt in `packages/knowledge/prompts/tools/`). KB teaches:
  artifact first, then contract, whenever the app talks to the agent and its LLM surface
  changed. Post-turn guarantee (the `finalizeConnectionDeclaration` precedent, same seam in
  `useBuilderChat`): if this turn wrote an artifact whose HTML uses `sendMessage(` and
  **the app has no contract anywhere in its version lineage** (fold-in F-B1: with D2's
  copy-forward this effectively means first builds/installs — the trigger must NOT fire on
  every cosmetic edit, and a synthesized contract must never silently replace an authored
  one), run a cheap tool-free contract-synthesis mini-turn (prompt in the store) **through
  `runAgentTurn` with `onLlmEvent` wired** (fold-in F-m7 — its inferrer-adapter precedent
  bypasses the inspector; this must not; the `runAgentTurn` call-site count grows by three:
  classifier, data turns, synthesis — code-map row updated accordingly); if THAT fails, the
  app runs contract-less (lean generic layers only — graceful, never blocking the build).
  **Contract authoring is byok/local-scoped in v1** (fold-in F-M2): the server tool set has
  no twin, so the contract twin JOINS the queued subscription server-twins item
  (`schema_apply`/`app_doc_write`) and the in-UI subscription gap note names it — D3's
  subscription injection still ships (it serves synced/exported apps built elsewhere).
  ADR-0011 is respected: no `usesAgent` flag/column; the HTML probe is a post-turn
  heuristic, not persisted state.
- **D6 — App chat becomes classification-first, scoped-context-second (byok/local).** New
  stage in `useBuilderChat.send()` active only when `pinnedAppId` is set: a tool-free
  strict-JSON classifier mini-turn (`chatIntentSchema`, internal: intent ∈ `data_read` |
  `data_write` | `schema_change` | `app_change` | `app_question` | `other`, confidence,
  optional clarification) using the two-slot untrusted-input prompt pattern of
  `buildConnectionRequirementInferrerPrompt` (user message delimited in the user slot).
  Classifier context is tiny: app name/description, table+column names (compact from
  `getAppSchema`), doc titles, last 2 turns. Malformed/failed classification →
  clarifying reply, NEVER a rebuild (AC-F2-1). **Fallback rule:** subscription, webllm and
  demo brains keep today's path unchanged with the gap stated in-UI (subscription's data
  tools would need server twins — joins the queued `schema_apply`/`app_doc_write` twins
  item; webllm is tool-free by ADR-0015).
- **D7 — Data reads are read-only BY CONSTRUCTION, not by flag.** New `packages/db` scratch
  executor `db.scratchRun(appId, statements, opts)`: export the app's materialized runtime
  DB bytes (the `applyAppDdl` snapshot pattern, `userdb.ts:1880+`), open a throwaway sql.js
  instance, run through the SAME statement guards (single-statement, forbidden-statement),
  collect `{rows, columns, changes, error}`, discard the instance. Mutations physically
  cannot reach the real file — no strictness knob exists to get wrong (the C1 doctrine
  applied to data). Bonus: reads stop marking the namespace dirty, and write DRY-RUN
  previews come for free. `data_query` tool (data_read/data_write turns) = scratchRun +
  LLM-shaped result bounds: `MAX_QUERY_ROWS = 200`, `MAX_QUERY_RESULT_BYTES = 32 KiB`,
  truncation stated in-band (AC-F2-6). `snug_kv` is PRESENT in the scratch copy (ADR-0010's
  one exemption) — omitted from the schema context shown to the SQL author, not
  execution-guarded (no name-guard knob; fold-in F-m5/F-Sm2). While touching the guards,
  tighten `forbiddenStatementReason`'s `writable_schema` match to catch quoted/qualified
  variants (`PRAGMA "writable_schema"`, `PRAGMA main.writable_schema`) — pre-existing,
  verified bypassable, cheap to close here (fold-in F-Sm3b).
- **D8 — Data writes are propose → preview → human-approve → execute.** `data_propose_write`
  tool: `{statements[], summary}` → host dry-runs on the scratch copy (per-statement
  `changes()` + errors + affected-row sample), returns the preview to the LLM AND stages a
  proposal; the UI renders an approval card (verbatim SQL + summary + counts — the
  NetConfirmDialog/wizard-review precedent). Execution happens ONLY from the user's approve
  action in host code, via the real driver's existing exec path, **after a fresh dry-run
  against the live DB whose affected-row counts must match the approved preview — on drift
  the card re-renders instead of executing** (TOCTOU, fold-in F-Sm1); the executed
  statements and ACTUALLY-executed counts (never the previewed ones) are recorded on the
  confirmation chat message's `meta`. Decline executes nothing. Per-proposal
  approval, no session-remember in v1 (Assumption A2). The LLM cannot reach the real
  executor — the tool result is the preview, never the execution (AC-F2-4 negative tests at
  the tool-handler altitude).
- **D9 — Intent-scoped context assembly is a function, and the tests sit on it.** New
  `buildIntentTurnContext(db, appId, intent, …)` beside `buildAppTurnContext`: data intents
  get overview + verbatim DDL + doc TITLES (no HTML, no doc bodies beyond caps); feature
  intents (`app_change`, and `schema_change` which v1 collapses into it execution-wise —
  the classification still shapes copy) get today's full builder context; `app_question`/
  `other` get overview + docs + DDL, tool-free. Per lessons 2026-08-05, AC-F2-2's tests
  assert at this assembler and at the tool-set selection, not downstream.
- **D10 — Targeted edits land as a bounded v1.** New `artifact_edit` tool (feature intents
  only): `{edits: [{oldString, newString}]}` applied host-side to the CURRENT version's
  HTML with uniqueness-of-match required, then the result flows through the SAME sink →
  `saveAppVersion` path as `artifact_write` (version row, reload, docs discipline
  unchanged). Any failed/ambiguous match fails the whole tool call closed with a precise
  error (the model retries or falls back to whole-file). KB teaches: small change → edit;
  structural change → whole file. This honors the owner's "edit only the needed parts /
  like Claude Code" while keeping the artifact-is-what-lands invariant. If the plan review
  rates this the riskiest slice, it is severable to a follow-up without touching F1/F2 data
  paths (it is phase P3, last before close).

### 2. Phases (implementation session order; each phase = tests first, then code)

**P0 — Contracts & storage (`packages/protocol`, `packages/db`)**
1. `runtime-contract.ts` (internal draft; bounds; parse helpers) + export-guard extension.
2. `chat-intent.ts` (internal draft; the intent enum + confidence + clarification bounds).
3. `userdb-schema.ts` v6: `snug_app_versions.runtime_contract_json` column in
   `USERDB_DDL`, version-history note; `packages/db` migration entry (additive
   `addColumnIfMissing`), accessors `getRuntimeContract(appId, version?)` /
   `putRuntimeContract(appId, version, json)`; **contract lifecycle per D2(i–iii):**
   `saveAppVersion` copy-forward (red-first: cosmetic edit keeps the contract),
   `revertApp`/`resetToFactory` copy from the TARGET version (red-first: revert-then-turn
   serves the reverted contract), import reconciler drops foreign contracts unless
   byte-identical to a local row (red-first: crafted import → contract not injected;
   verify whether sync pulls share the seam). Plus a stale-v5 fixture through self-heal.
4. `db.scratchRun` executor + bounds; negative tests: an INSERT through scratchRun leaves
   the real DB byte-identical; `ATTACH`/multi-statement refused; result caps enforced.
5. `adapters`: per-turn `maxOutputTokens` on `AdapterRequest`; both adapters clamp;
   local 8K rule preserved (tests at both adapters + the type).
   *Spec-sync: internal-draft entries in `docs/spec-changelog.md`; staged updates to
   `docs/spec-drafts/spec-v0.2-userdb.md` (v6) + NEW `docs/spec-drafts/spec-v0.4-runtime.md`
   (contract artifact + intent surface + scratch semantics) using the v0.3-auth blockquote
   pattern. NOTHING pushes (AL-12 held).*

**P1 — Lean runtime turns (`packages/knowledge`, `apps/playground`, `apps/server`)**
1. `system/45-app-runtime.md` + `appRuntime` assembly option + golden snapshots
   (4-combination matrix grows; heading-stability + header-check obey store rules).
2. Call-site swap with tests AT THE CALL SITES (ADR-0012's altitude lesson):
   `transport.ts:57` and `invoke.ts:103` assemble `{appRuntime: true}`; contract appended
   as end-of-system suffix when present via the ONE shared `renderRuntimeContract` from
   `packages/knowledge`; `RunView` threads `appId` only — **the transport reads the
   contract PER SEND** (F-M1; test: turn → revert → turn carries the reverted contract);
   `/invoke` body gains optional `contract` parsed STRICT with `runtimeContractSchema`
   (F-M3; negative test: over-bound/extra-field contract → 400) and covered by the
   credential scan (server tests: absent → identical to today; present → suffix; an
   app-frame message smuggling a contract field never reaches the SYSTEM slot — assert on
   system content, not on request absence, since the raw wire string still carries unknown
   fields to the user slot, F-m8).
3. `maxOutputTokens` from contract only; legacy apps unchanged (AC-F1-4 regression tests
   on a contract-less fixture app: byte-identical request assembly vs today).
4. Observability: contract turns visible in the LLM inspector as today (both call sites
   already wire `onLlmEvent`; assert usage totals still flow — AC-BOTH).

**P2 — Contract authoring (`packages/knowledge`, `apps/playground`, `examples`)**
1. `tools/runtime-contract-write.md` prompt + `getToolPrompt` union extension +
   `runtime_contract_write` tool in `agent/tools.ts` (sink-pinned; version-attached;
   rejects when no artifact exists yet).
2. KB: new `knowledge-base/app-authoring/` section teaching lean runtime requests
   (never duplicate `state` into `payload`; minimal `responseSchema`; persona/settings live
   in the contract; when to re-emit the contract on edits) + doctrine line in
   `30-app-builder-summary.md`. Retrieval tests: build-time queries hit the new section
   (the `authKbEmission` pattern); scanner-sync test for the emission format (AC-F1-6).
   **Read the Anthropic prompt-engineering reference before authoring any of these files
   (standing memory + store README rule).**
3. Post-turn synthesis fallback in `useBuilderChat` (the `finalizeConnectionDeclaration`
   seam): artifact-with-`sendMessage(` + no contract → tool-free synthesis mini-turn →
   `putRuntimeContract`; failure degrades gracefully (AC-F1-2 both branches; AC-F1-5 both
   directions).
4. Starters: authored `runtime-contract.json` for the LLM-using starters (chess,
   adventure-quest, quiz-me); starter install writes it onto v1 (the
   `installStarterConnections` precedent); `examples` validate suite: contract parses +
   LLM-posture starters must ship one; Chess `app.html` payload dedup (drop the
   payload-side `fen`/`history` duplication; keep legal moves — genuinely needed state).
   Embedded-hooks sync untouched (`packages/sdk` not in this phase's blast radius, but
   run the examples suite FORCED — the turbo-inputs gap is a known liar, next-steps
   2026-08-06).

**P3 — Intent-routed app chat (`packages/knowledge`, `apps/playground`)**
1. `tools/chat-intent-classifier.md` (two-slot, untrusted user text delimited) +
   `buildChatIntentClassifierPrompt` assembler + contract-tested few-shot fixtures fed
   through the real `chatIntentSchema` parser (the p2-pipeline pattern).
2. Router stage in `useBuilderChat.send()` (pinned apps, byok/local only): classify →
   fail-closed clarify → dispatch. NOTE the existing lifecycle is deliberate
   (context assembled BEFORE the user message persists, so history holds strictly prior
   turns — the classifier slots in respecting that order). Tests at the router: every
   intent → its context assembler + tool set; malformed JSON → clarify, no tools invoked
   (AC-F2-1); **plus three lifecycle tests (F-M4): (a) abort during classify — the
   classifier mini-turn takes the turn's `AbortController.signal`, stop button and
   unmount-abort work; (b) the clarify path settles the already-rendered streaming
   placeholder (`streaming:false`, text set) AND persists the exchange via
   `appendChatMessage` (no forever-spinner, survives rehydration); (c) a THROWN classifier
   error routes to the clarify lane, never to the outer `TURN_FAILED` catch.**
3. `buildIntentTurnContext` (D9) + tests (AC-F2-2). Data turns: tools `data_query`
   (+ `data_propose_write` for data_write), modest `maxIterations`, cache OFF, `onLlmEvent`
   wired (the "every `runAgentTurn` call site wires observability + decides caching" rule —
   update the code-map row that today says "two call sites").
4. `data_query`/`data_propose_write` handlers over `db.scratchRun` (D7/D8); approval card
   UI + approve/decline handlers in RunView chat; executed-statement audit on message
   `meta`; negative suites: cross-namespace SQL refused BY the materialized scratch
   (probe: another app's rest table name errors as missing), `snug_secrets` unreachable
   (AC-F2-3), query-intent UPDATE refused (read path has no real-DB writer to reach),
   decline path executes nothing, data intents cannot invoke `artifact_write`
   (AC-F2-4/-F2-5).
5. UX copy: rail-chat empty state stops promising only rebuilds; status line copy per
   intent; truncation notices (AC-F2-6).

**P4 — Targeted edit + whole-surface close (`apps/playground`, `packages/knowledge`, docs)**
1. `artifact_edit` tool (D10): host-side apply with unique-match requirement, sink-integrated,
   fail-closed on any miss; KB teaching (edit vs whole-file decision rule); tests incl.
   ambiguous-match refusal, resulting version equals whole-file-equivalent, reload fires.
2. **Whole-surface review** (lessons 2026-08-10): one fresh-context review tracing a
   single user message end-to-end (classify → route → execute → approve → persist →
   reload) and one runtime turn end-to-end (contract authored → stored → injected → reply
   parsed), asking at every handoff "what does the receiver trust that the sender never
   guaranteed?".
3. Threat-model delta `docs/security/threat-model-delta-lean-runtime-data-chat.md`:
   LLM-generated SQL surface (mitigations: physical materialized-DB isolation, scratch
   read-only-by-construction, single-statement + forbidden-statement guards, human-approved
   TOCTOU-revalidated data writes, bounded results; residual: app DATA is untrusted prompt
   input — a stored row can carry an injection; stored data and query results are DELIMITED
   as untrusted in every prompt that carries them); contract-in-system surface
   (host-assigned at runtime, bounded at strict parse on both call sites, no credential
   seats by schema, **imported contracts dropped unless byte-identical** — F-SB1); the
   classifier as a steerable router with an HONEST asymmetry stated plainly (F-SM1): the
   DATA lane's writes end at a pre-write human gate; the FEATURE lane's writes land on
   model authority and are bounded by versioning + visible in-place reload + revert — the
   same trust model as today's builder chat, NOT a pre-write gate; a poisoned row that
   flips a data ask into `app_change` therefore yields a reviewable version write, not a
   silent mutation, and the routed lane is visibly labeled in the rail so the user sees
   the escalation. Also note: `forbiddenStatementReason` hardening (F-Sm3b) and the
   in-UI fallback-mode note naming that unrouted modes (subscription/webllm/demo) may
   still respond to a data question with a rebuild.
4. Docs close (Gate 6 of the implementation session): code-map rows (call-site count, new
   tools, scratch executor, contract), architecture.md status para, INDEX if needed,
   spec-changelog internal entries, lessons, next-steps; ADR-0018/0019 proposed→accepted on
   owner merge; `docs/product-vision.md` differentiators gain the two USPs (public twin of
   the internal S7/S8 rows).

### 3. Test plan summary (mapping ACs → suites; all red-first)

| AC | Where the test sits |
|---|---|
| F1-1 | playground `transport` + server `invoke` route tests (call-site altitude): assembled system for an app turn contains runtime layers + contract, NEVER `30-app-builder-summary` content; messages = envelope only |
| F1-2 | playground post-turn seam test (build with `sendMessage` → contract row exists on the authored version; synthesis-failure branch degrades) + db accessor tests |
| F1-3 | runner/host reply-path unchanged tests + a contract-bearing fixture round trip (mock adapter) |
| F1-4 | byte-comparison regression: contract-less app's assembled request identical to pre-change snapshot; ADR-0011 LLM-free starter untouched (examples validate) |
| F1-5 | post-turn seam: artifact-with-LLM-surface edit refreshes contract; doc-only turn leaves it byte-identical |
| F1-6 | knowledge retrieval + scanner-sync suites (authKbEmission pattern); few-shot fixtures through real parsers |
| F2-1 | router unit tests: malformed/low-confidence → clarify, zero tools; each intent → dispatch table |
| F2-2 | `buildIntentTurnContext` tests: data intent context contains DDL and NOT the HTML fence; feature intent contains HTML |
| F2-3 | db scratch tests: cross-app table → SQL error, real DB untouched (byte-compare); `snug_secrets` probe; C1 canary strings never in any data-turn prompt |
| F2-4 | tool-handler tests: propose returns preview + stages, never executes; approve executes via real driver; decline leaves DB byte-identical |
| F2-5 | router negative: data intents' tool set excludes `artifact_write`/`artifact_edit` (assert at tool-set selection) |
| F2-6 | scratch bounds tests + reply-includes-truncation-notice test |
| BOTH | inspector reducer tests: classifier + data turns appear with usage; mutation-check by unwiring `onLlmEvent` (goes red) |

Suites run per dependents rule: protocol change ⇒ everything (`pnpm test` at root, with
`--force` for any green claim used as evidence — lessons 2026-08-10). Playwright: one new
journey per feature (a data question answered on a starter with seeded rows incl. the
approve-a-write flow; a chess-class move under a contract asserting the wire request stayed
lean via the inspector), plus the existing 7 starter journeys stay green.

### 4. Cross-package impact & risks

- `protocol` v6 + internal schemas ⇒ full-graph test runs; the userdb column is additive
  and self-heal-safe (no table-set change, `USERDB_TABLES` untouched).
- `adapters` gains one per-turn field — same altitude as `cache`, mirrored tests.
- `sdk` untouched (hooks/embedded unchanged) — but examples suite runs FORCED (turbo gap).
- `runner` untouched (no envelope change, no capability change, C2 untouched) — keeps this
  out of the runner's High surface; High tier still stands via protocol + the new SQL lane.
- Biggest risks, called by name: (1) the classifier mis-routing (mitigated: fail-closed +
  every lane's writes human-gated + fallback modes keep legacy path); (2) `artifact_edit`
  correctness (bounded: unique-match-or-fail, severable phase); (3) contract quality from
  small local models (mitigated: synthesis fallback + graceful contract-less degradation);
  (4) scratch-copy cost on big app DBs (bounded by the existing 64 MiB file cap; export is
  per-app materialized bytes, typically KBs; measure in P3 and note).

### 5. Owner decisions folded in / still open at approval

- Folded: build-time contract authoring with post-turn guarantee (mirrors v4 R1);
  classification-first scoped context; propose/approve for data writes; wire v1 untouched.
- **Open for the owner at plan approval:** (a) A2 — per-proposal write approval only, or
  allow "approve similar for this session" later? (planned: per-proposal); (b) D10 in or
  out of v1 (planned: in, severable); (c) v1 collapse of `schema_change` execution into the
  feature lane (planned: yes); (d) default `maxOutputTokens` for contract-SYNTHESIZED
  contracts (planned: model decides per app nature, clamp to schema bounds); (e) **the
  feature lane's trust model (from review F-SM1):** planned = today's builder trust
  (writes land on model authority, bounded by versioning + visible reload + revert, lane
  labeled in the rail) with the asymmetry stated honestly in the threat model — the
  alternative is a pre-write confirm on classifier-routed `app_change` turns, which
  changes today's builder UX; owner picks.

### 6. Fresh-context plan review record (2026-08-11, two lenses, both REVISE → all folded)

Two read-only fresh-context reviewers (architecture+correctness; security) attacked this
plan and the ADR drafts against the source pre-implementation, refute-first. Every
surviving finding is folded into the sections above (marked `F-…`); dispositions:

| # | Finding (compressed) | Disposition |
|---|---|---|
| F-B1 (arch, BLOCKER) | `saveAppVersion` copies nothing forward → a cosmetic edit strands the contract; synthesis would then fire per edit and overwrite authored contracts; tool-ordering hole | **Folded**: D2(i–ii) copy-forward (+ revert copies from TARGET), D5 trigger re-scoped to no-contract-in-lineage, P0.3 red-first tests incl. the cosmetic-edit case |
| F-SB1 (sec, BLOCKER) | Whole-DB import plants a hostile contract that speaks with system authority — import reconciler touches only `snug_connections` | **Folded**: D2(iii) drop-unless-byte-identical at import, AC-F1-7 + negative test, ADR-0018 corrected; sync-path seam check assigned to implementation session |
| F-M1 (arch) | Plan's `contentEpoch` refresh premise is false — transport memo never re-reads; stale contract after edit/revert | **Folded**: D3 per-send read (the transport's own 2026-08-06 lesson), P1.2 turn→revert→turn test |
| F-M2 (arch) | Subscription contract *authoring* silently unscoped (no server tool twin; synthesis has no client brain) | **Folded**: byok/local-scoped v1 (AC-F1-2/F1-6), twin joins the queued server-twins item, in-UI gap note; injection (D3) still ships for synced apps |
| F-SM1 (sec) | "Every lane's writes still gated" is false — feature lane auto-lands code | **Folded**: honest asymmetry in P4.3 + lane labeling; pre-write confirm surfaced as owner decision (e) |
| F-M3 (arch) | `/invoke` contract = client-controlled system content with unstated validation; renderer risks two-artifact fork | **Folded**: strict `runtimeContractSchema` parse + 400 negative test, credential-scan coverage, ONE `renderRuntimeContract` in `packages/knowledge`, JSON-only wire (D3/P1.2) |
| F-M4 (arch) | Classifier stage's turn-lifecycle obligations unstated (abort signal; placeholder settlement + persistence; error-lane separation) | **Folded**: P3.2's three lifecycle tests |
| F-Sm1 (sec) | Preview→approve TOCTOU — counts can drift before execute | **Folded**: D8/AC-F2-4 re-dry-run at execute, halt-on-drift, actual counts on `meta` |
| F-m5/F-Sm2 (both) | AC-F2-3's "refuse any `snug_*`" unsatisfiable — `snug_kv` physically present; name-guard would be a knob | **Folded**: AC-F2-3 restated as physical-absence assertion + `snug_kv` exemption stated; kv omitted from SQL-author context |
| F-m6 (arch) | ~4.5 KB/turn savings overstated (40 is retained) | **Folded**: ~3 KB net in D1 + ADR-0018 |
| F-m7 (arch) | Synthesis via the inferrer-adapter precedent would bypass the LLM inspector | **Folded**: synthesis goes through `runAgentTurn` + `onLlmEvent`; call-site count grows by three, code-map row updated |
| F-m8 (arch) | Smuggling negative test should assert absence from SYSTEM (raw wire still carries unknown fields to the user slot); envelope credential scan runs on parsed, not raw | **Folded**: P1.2 test target corrected; noted in threat-model delta |
| F-Sm3a (sec) | New `/invoke` contract field bypasses the credential scan | **Folded** into F-M3's fix (scan covers it) |
| F-Sm3b (sec) | `forbiddenStatementReason` bypassable for quoted/qualified `writable_schema` (pre-existing, verified by execution) | **Folded**: tightened in P0.4/D7; threat-model note |

Reviewer-VERIFIED claims worth keeping (refutations that held): the iframe genuinely cannot
smuggle a contract (explicit-field envelope construction + unknown-key-stripping schemas,
double-dropped); `artifact_edit` is trust-equivalent to whole-file writes (no write-time
validation exists to bypass — app safety is the C2 sandbox at run time); scratchRun cannot
reach the real DB through any indirect channel (independent sql.js instance, write-back
only on the driver's own save path); the WebLLM adapter accepts a custom system on
tool-free turns, so D1/D3 genuinely reach the 4K brain; virtual tables cannot exist in a
materialized DB; every file:line citation in §0 checked accurate.

## Decisions & surprises

- 2026-08-11: Dynamic Auth v2's six branches are MERGED (PRs #33/#34, main `4b9c49c`) — the
  2026-08-10 "none merged" state is stale; this task branches off main normally.

## Session journal (append-only, newest last)

### 2026-08-11 — Claude (planning session) — session
- Done: Gate 1 spec drafted from the owner's commissioning message; recon fanned out.
- State: Gate 2 plan in progress.
- Next step: complete plan, fresh-context plan review (High tier), stop for owner approval.
- Open questions: A2 (mutation approval granularity), A3 (subscription parity depth) — see Interview.

### 2026-08-11 — Claude (planning session, close) — session
- Done: Gate 2 plan written from three-agent code recon (runtime path / app-chat+data /
  pipeline+spec); ADR-0018/0019 drafted (proposed); S7/S8 recorded in the internal roadmap
  (proposed, disk-only); **two fresh-context plan reviews run (arch + security lenses),
  both REVISE, 2 BLOCKERs + 5 MAJORs + minors ALL FOLDED** (§6 record; the plan text above
  is post-fold). Memory updated (Dynamic Auth v2 merge state corrected; this task's
  planning memory added).
- State: branch `feat/TASK-20260811-lean-runtime-data-chat` holds task file + both ADR
  drafts; NO implementation code exists (High-tier gate honored).
- Next step: **owner reviews this plan (esp. §5 open decisions a–e) → on approval, a fresh
  session runs `/pickup TASK-20260811-lean-runtime-data-chat` and starts P0 tests-first.**
- Open questions: §5 (a)–(e).

### 2026-08-11 — Claude (implementation session, P0) — session

- **Owner approval received** for the whole plan including §5 (a)–(e) exactly as planned;
  Owner line updated, status planned → in progress.
- Done: **P0 complete, all five items, tests-first throughout** (every suite shown red for
  the right reason before its implementation):
  - **P0.1** `packages/protocol/src/runtime-contract.ts` — internal-draft
    `runtimeContractSchema` (strict, per-seat bounds + a whole-artifact 2.5 KB cap),
    `parseRuntimeContract` (tolerant read → `undefined`, never throws, so a bad row
    degrades to lean generic layers per AC-F1-4), `canonicalRuntimeContract` (key-sorted
    bytes for the import guard). 15 tests incl. the publication-line guard.
  - **P0.2** `chat-intent.ts` — `chatIntentSchema` + `parseChatIntent` (fail-closed:
    every unusable reply → `undefined`, no default lane, explicitly tested that garbage
    never resolves to `app_change`), lane predicates. 12 tests.
  - **P0.3** userdb **v5 → v6**: `snug_app_versions.runtime_contract_json` (nullable,
    additive). Migration uses `addColumnIfMissing` — the first column-add since v2, and
    exactly the case the v4 MIGRATIONS comment warned a bare DDL replay would silently
    botch. Accessors `getRuntimeContract`/`putRuntimeContract` (validate-on-write,
    tolerate-on-read) + the three lifecycle rules: copy-forward in `saveAppVersion`
    (F-B1), revert/reset copy from the **target** version via a new explicit
    `contractSourceVersion` arg (F-B1 — both delegate to `saveAppVersion`, so a naive
    copy-forward would have served the pre-revert contract), and
    `reconcileImportedRuntimeContracts` dropping foreign contracts unless canonically
    byte-identical to a locally known row (F-SB1/AC-F1-7, `droppedRuntimeContracts` added
    to `UserDbImportReport`). 20 tests incl. a stale-v5 fixture through the migration.
  - **P0.4** `db.scratchRun` — throwaway sql.js instance over the app's exported
    materialized bytes; read-only BY CONSTRUCTION (no flag). Byte-compare proofs that
    UPDATE/INSERT/DROP leave the real DB untouched; namespace jail asserted as PHYSICAL
    ABSENCE (other apps' + hub tables error as missing); result bounds `MAX_QUERY_ROWS`
    200 / `MAX_QUERY_RESULT_BYTES` 32 KiB with honest `totalRows`. Guards shared with the
    real executor by EXPORTING `forbiddenStatementReason`/`isSqlTailEmpty`/`normalizeCell`
    from driver.ts rather than copying them. **F-Sm3b closed**: the `writable_schema`
    match now catches quoted and schema-qualified spellings. 24 tests.
  - **P0.5** per-turn `maxOutputTokens` on `AdapterRequest` (same altitude as `cache`);
    both adapters CLAMP (narrow-only) so local mode's 8K rule survives a contract asking
    for more; absent ⇒ today's default byte-for-byte (AC-F1-4). 9 tests.
- **Two corrections worth recording** (both mine, both caught by the existing guards):
  (a) the `snug_kv` presence test initially asserted the table exists unconditionally — it
  is created LAZILY on first kv use (`driver.ts` `ensureKvTable`), so the test now seeds a
  kv write first; the ADR-0010 exemption claim is unchanged and still asserted. (b) I first
  reached for a `SQL_ERROR` userdb code that does not exist — added
  `SCRATCH_UNAVAILABLE` instead, which is the honest distinction (the sandbox never
  existed vs. a SQL error inside it, the latter being per-statement DATA). Caught by
  `db:build`'s tsc, NOT by `db:test` — **db's test script does not typecheck**, so a
  package-level green is not a type-clean claim; run the root turbo build/test.
- State: **all 19 turbo tasks green, uncached (`--force`): 1963 tests** (protocol 250,
  knowledge 120, runner 108, db 280, server 110, adapters 101, sdk 41, auth 357,
  playground 596). Baseline at pickup was 1881, so +82. No test deleted or weakened; the
  one snapshot update is the single additive DDL line, reviewed before accepting.
- Next step: **P1 — lean runtime turns**: `system/45-app-runtime.md` + the `appRuntime`
  assembly branch and golden snapshots, then the two call-site swaps (`transport.ts:57`,
  `invoke.ts:103`) with the shared `renderRuntimeContract` in `packages/knowledge`, the
  per-send contract read (F-M1: turn → revert → turn), and `/invoke`'s strict `contract`
  field (F-M3, 400 on over-bound + credential-scan coverage).
- Open questions: none new. Note for P1: `renderRuntimeContract` must land in
  `packages/knowledge` as ONE renderer used by both call sites (F-M3's two-artifact-fork
  risk).

### 2026-08-11 — Claude (implementation session, P1) — session

- Done: **P1 complete — lean runtime turns, tests-first.** A four-probe recon workflow
  verified the seams before any code; it overturned two plan premises (below).
  - **45-app-runtime.md** + `appRuntime` branch on `buildHostSystemPrompt`. The branch is
    checked FIRST and returns: an app turn must never carry authoring layers whatever else
    the caller passed (a test pins `appRuntime` winning over `appBuilder`). Golden
    snapshot matrix grew to 5.
  - **`renderRuntimeContract` + `SYSTEM_BLOCK_SEPARATOR` exported from `packages/knowledge`**
    — ONE renderer for both call sites (F-M3's two-artifact fork), and the separator is
    exported rather than retyped at call sites (ADR-0004). The renderer strips any
    embedded layer separator so a contract cannot forge a system-block boundary.
  - **Playground transport**: reads the contract PER SEND inside `send()` (F-M1), appends
    it as a system suffix, and applies `maxOutputTokens` only when the contract sets one.
    `appId` threaded from RunView through `createAppTransport`/`resolveAppTransport` into
    all three direct-transport constructions. DB failures and unknown appIds degrade to
    contract-less rather than throwing.
  - **Server `/invoke`**: optional `contract` field parsed STRICT with the real
    `runtimeContractSchema` (400 on over-bound/extra-field/wrong-type/out-of-range, and
    the adapter is never reached), covered by the C1 credential scan, rendered through the
    same shared renderer. The hub is stateless about apps, so this is the only channel by
    which a synced app's contract can reach the model.
- **Three findings the plan did not have** (all folded into the code + tests):
  (a) **`runAgentTurn` had no `maxOutputTokens` seat** — `AdapterRequest` accepted the
  field but nothing populated it, so P0.5's cap had NO path from a call site to the wire.
  Added to `RunAgentTurnOptions` and forwarded; `spyAdapter` now captures it for the same
  reason it captures `cache`.
  (b) **The saving is ~1.26 KB/turn, not ~3 KB.** MEASURED: 30-app-builder-summary (1439)
  + inlined KB summary (864) out = 2303; new 45 layer (1043) back in. The plan's estimate
  (already corrected once by F-m6 from ~4.5 KB) counted the removals and forgot the new
  layer is not free. ADR-0018 and the test comment now carry the measured number.
  (c) **The C1 scanner's `KNOWN_KEY_PREFIX` is `^`-anchored**, so a key embedded in prose
  is missed — on the new contract field AND on the pre-existing `payload`/`state` path.
  The contract seat is therefore no weaker than the envelope seat, which is what F-Sm3a
  actually claims; a test PINS this limit honestly rather than implying the scan is
  airtight. Widening the pattern is a scanner-level change with its own false-positive
  budget — out of scope, and going into the P4 threat-model delta.
- **Process note:** prompt content is code-generated into `src/generated/content.ts`
  (`pnpm --filter @snugprotocol/knowledge gen:content`, run automatically by `build`), and
  downstream packages consume `dist/` — so a new prompt file needs BOTH a regen and a
  build before dependents see it. Two failures this session were stale `dist`, not logic.
- State: **all 19 turbo tasks green, uncached: 1996 tests** (protocol 250, knowledge 132,
  runner 108, db 280, server 123, adapters 103, sdk 41, auth 357, playground 602).
- Next step: **P2 — contract authoring**: `runtime_contract_write` tool + prompt, the
  app-authoring KB section (scanner-sync + retrieval tested), the post-turn synthesis
  fallback on the `finalizeConnectionDeclaration` seam (through `runAgentTurn` with
  `onLlmEvent` wired, per F-m7), and starter contracts + the Chess payload dedup.
- Open questions: none new.

### 2026-08-11 — Claude (implementation session, P2) — session

- Done: **P2 complete — contract authoring, tests-first.** A six-probe recon workflow
  (P2+P3 surfaces) ran first and corrected the plan twice (below).
  - **`runtime_contract_write` tool** + `tools/runtime-contract-write.md`. Sink-pinned
    like every other write tool (no appId seat in the schema); version-attached; refuses
    before the first artifact write, because a contract with no version to attach to
    would be silently lost.
  - **KB section `95-runtime-contract.md`** teaching lean requests (state vs payload, no
    duplication, no persona prose per turn) and contract emission. Content-sync tests pull
    the tool name and every bound from the shipped constants; retrieval tests pin the
    phrasings that must reach it.
  - **Post-turn synthesis fallback** (`runtimeContractSynthesis.ts`) on the
    `finalizeConnectionDeclaration` seam: fires only when the app's whole version lineage
    has no contract (F-B1), goes through `runAgentTurn` with `onLlmEvent` wired (F-m7 —
    tested by asserting both event kinds), runs tool-free, takes the turn's abort signal,
    and degrades to contract-less on every failure path. byok/local-scoped via the shared
    `liveInferenceAdapter` ladder (F-M2).
  - **Starter contracts** for all four LLM-using starters + `installStarterRuntimeContract`
    on the install act. Never overwrites an existing contract; drops malformed or
    over-bound ones rather than installing something the runtime would refuse.
  - **Chess payload dedup**: `fen` was in BOTH payload and state; `state.history` was
    UNBOUNDED while the payload copy was capped at 12; persona PROSE was re-sent every
    move. Now: state carries `fen` + last-12 only, and the payload carries the persona's
    ID while the contract carries the persona itself.
- **Two plan corrections from recon** (both folded):
  (a) **There are FOUR LLM-using starters, not three** — the plan named chess,
  adventure-quest and quiz-me and missed **habit-tracker**, which calls `sendMessage` at
  `examples/habit-tracker/app.html:487`. All four now ship contracts, and the examples
  suite asserts posture BOTH ways (agent-driven ⇒ must ship one; LLM-free ⇒ must not).
  (b) **`agent/tools.ts` uses hand-written JSON Schema + manual narrowing, not zod** —
  D5's "zod-validated payload" describes a pattern this file does not use. Resolved by
  keeping the file's convention for `inputSchema` and validating with the REAL
  `runtimeContractSchema.safeParse` in the handler, so the contract keeps ONE definition.
- **One test I had to correct, and why it is not a weakening:** `starterInstall.test.tsx`
  waited for `db.listApps().length > 0` and then asserted the route had changed. Install
  now performs more awaited work after the row lands, so "row exists" no longer implies
  "navigated". It now waits for the navigation it actually asserts. The AC is unchanged;
  the timing assumption was the bug.
- Also corrected **ADR-0018's own consequence line** with the measured ~1.26 KB (was ~3 KB).
- State: **all 19 turbo tasks green, uncached: 2030 tests + 185 examples** (protocol 250,
  knowledge 145, runner 108, db 280, server 123, adapters 103, sdk 41, auth 357,
  playground 638, examples 185).
- Next step: **P3 — intent-routed app chat**: the classifier prompt (two-slot, untrusted
  user text delimited) + `buildChatIntentClassifierPrompt`, the router stage in
  `useBuilderChat.send()` with F-M4's three lifecycle tests, `buildIntentTurnContext`,
  then `data_query`/`data_propose_write` over `db.scratchRun` with the approval card.
- Open questions: none new.

### 2026-08-11 — Claude (implementation session, P3) — session

- Done: **P3 complete — intent-routed app chat, tests-first**, in two commits.
  - **Classifier**: `tools/chat-intent-classifier.md` in the two-slot shape (static system
    slot; user message delimited; output contract restated AFTER the block). Few-shot
    fixtures are SCRAPED from the rendered prompt and run through the shipped
    `parseChatIntent` + schema, so prompt and fixtures cannot drift. Replayed history is
    defanged too — prior user text is exactly as untrusted as the live message.
  - **Router** (`chatRouter.ts`): classify → dispatch, failing closed on every path (bad
    JSON, unknown intent, adapter error, thrown exception, low confidence). A test asserts
    no unusable reply EVER reaches the feature lane.
  - **`buildIntentTurnContext`** (D9): data intents get DDL + doc TITLES and neither the
    HTML nor the rewrite instruction; feature intents keep today's builder context;
    `app_question`/`other` get docs without code.
  - **Data tools** over `db.scratchRun`: `data_query` (bounded, truncation stated in-band)
    and `data_propose_write` (dry-run preview + staged proposal). `executeApprovedWrite`
    is host-only, re-runs the dry run, and HALTS on drift (F-Sm1).
  - **Router wired into `useBuilderChat.send()`** with the three F-M4 lifecycle tests
    (abort reaches the classifier; the clarify path settles the placeholder AND persists
    both sides; a thrown error routes to clarify, never to the outer TURN_FAILED).
  - **Lane-scoped TOOLS** via a new `BuilderTurn.tools` override — the second lock beside
    context scoping (AC-F2-5). `data_read` gets the read tool only; the answer lane gets
    none.
  - **Approval card** in `ChatLog` showing the summary, the VERBATIM SQL and the row
    counts, with approve/decline wired through RunView to `executeApprovedWrite`; once
    resolved the buttons are gone so an approved change cannot be re-applied unreviewed.
    Rail empty-state copy no longer promises only rebuilds.
- **Three things worth recording:**
  (a) **The driver has no affected-row count.** `DbDriverResult` is
  `{rows, columns, value, bytesBase64}`, so `executeApprovedWrite` records the
  RE-VALIDATED counts. Because it halts on ANY drift, a recorded count can never describe
  a change the user did not approve — but the honest fix (a real count out of the driver)
  means widening a protocol-facing result shape, which belongs in its own change. Noted at
  the call site and going into the P4 threat-model delta.
  (b) **A test-only mock defect I had to fix properly.** `vi.mock` with `importOriginal`
  spread let the REAL `liveInferenceAdapter` answer on the first call in a fresh module
  graph (`ok:false`, no key configured), so the router silently skipped and two lifecycle
  tests failed for a reason unrelated to their subject. The stub is now total and
  deterministic; the ladder keeps its own tests.
  (c) **`playground:build` caught two type errors `playground:test` did not** — a missing
  `db` export and a props interface that never received its new fields. Same lesson as
  P0's: package-level green is not a type-clean claim.
- State: **all 19 turbo tasks green, uncached: 2132 tests + 185 examples** (protocol 250,
  knowledge 160, runner 108, db 280, server 123, adapters 103, sdk 41, auth 357,
  playground 710, examples 185).
- Next step: **P4 — `artifact_edit`, the whole-surface review, the threat-model delta, and
  the docs close** (code-map rows, architecture status, ADRs proposed→accepted, lessons,
  next-steps, product-vision differentiators).
- Open questions: none new.

### 2026-08-11 — Claude (implementation session, P4 + close) — session

- Done: **P4 complete; the task is implemented end to end.**
  - **`artifact_edit`** (D10): unique-match-or-fail, atomic, uniqueness re-checked after
    each earlier edit in the batch, through the SAME sink as `artifact_write` (so an
    edited version pins, reloads and carries the contract forward like any other). An
    invariant test asserts it produces exactly the file a whole-file write would have.
  - **Whole-surface review** (8 agents: 4 end-to-end traces + 4 adversarial verifiers).
    It found **two BLOCKERs that 2100+ passing tests had missed**, both fixed:
    1. **Wrong affected-row counts.** `scratchRun` treated sql.js `getRowsModified()` as
       cumulative and took a delta; it is `sqlite3_changes()` (per statement), so any
       second write reported a wrong, often NEGATIVE count — rendered on the approval
       card. The drift guard could not catch it: it re-ran the same broken arithmetic on
       both sides and agreed with itself. A `RETURNING` clause separately suppressed the
       count entirely, so a destructive `DELETE … RETURNING id` previewed as "0 rows" and
       could never trip drift. **Why it survived:** the one multi-statement test paired a
       write with a SELECT, and a SELECT leaves `sqlite3_changes()` untouched.
    2. **Contract could forge a system-block boundary.** `renderRuntimeContract` stripped
       only the EXACT separator; `\n\n\n---\n\n\n` passed through and its own newlines
       supplied the blank lines the separator needs, making attacker text a PEER of
       `10-host-identity` (verified: 5 blocks where 4 expected; reproduced from every
       free-text seat AND a settings VALUE). Now neutralizes any horizontal-rule LINE.
    Also fixed from the same round: query results ride a defanged `<query_result>` block
    instead of raw concatenation; one approval card per turn (a second proposal used to
    silently replace the first); approve is single-flight; **subscription mode now SENDS
    the contract** (`createHttpTransport` gained a per-send `getContract` seat — the
    server half had been unreachable from the shipped client).
  - **Threat-model delta** written with the residual risks stated rather than implied
    away, including the ones this task chose NOT to close.
  - **Docs close**: code-map rows (call-site count corrected to a VERIFIED four — the data
    lane reuses the builder's call site via the tools override, so it is not a fifth), the
    architecture status paragraph, ADR-0018/0019 proposed → accepted, product-vision
    differentiators 1 and 2 extended with the two USPs, lessons, next-steps.
  - **The plan's deferred question answered:** sync pulls DO share the `importUserDb`
    seam (`pullMerge`, the recovery restore and the manual import all funnel through it),
    so imported-contract reconciliation covers sync. Pinned by a behavioral test rather
    than a grep, so a future bespoke sync-import fails loudly.
- **State: 19/19 turbo tasks green, uncached — 2156 tests + 185 examples** (protocol 250,
  knowledge 164, runner 108, db 284, server 123, adapters 103, sdk 41, auth 357,
  playground 726, examples 185). Baseline at pickup was 1881.
- Next step: **owner review + PR.** Nothing is blocked. Queued follow-ups are in
  `docs/next-steps.md` (subscription server twins; the `^`-anchored C1 scanner limit;
  driver-reported row counts; row-identity drift detection; persisting a staged proposal
  across reload; an optional pre-write confirm on classifier-routed `app_change`).
- Open questions: none.
