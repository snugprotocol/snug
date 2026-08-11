# 0018 — App runtime turns assemble from an authored, version-pinned runtime contract

- **Status:** proposed (drafted at Gate 2; accepts on owner plan approval + merge)
- **Date:** 2026-08-11
- **Task:** TASK-20260811-lean-runtime-data-chat

## Context

An installed app's runtime LLM turn (a Chess move) flows through the app-frame transport as
a single self-contained envelope — no thread history. Yet every such turn today carries the
app-BUILDER system assembly (`buildHostSystemPrompt({appBuilder: true})` at
`apps/playground/src/agent/transport.ts:57` and `apps/server/src/routes/invoke.ts:103`):
~6 KB of authoring instructions (mandatory HTML template, `schema_apply` discipline, wiki
rules) that a runtime move cannot act on, uncached by design (ADR-0012). On top of that,
the KB never taught lean runtime requests, so generated apps over-send (the Chess starter
duplicates `fen`+`history` in both `payload` and `state` and re-sends persona prose every
move), and app turns inherit the 128K output default with no per-turn bound.

The owner's directive (2026-08-11): runtime turns must send the bare minimum for a
best-quality answer — a brief app overview, relevant settings, current state and latest
event, and the minimal expected JSON response shape — and the knowledge enabling that must
be produced at AUTHORING time so the app leverages it at runtime.

The Dynamic Auth v2 rewrite established the pattern this follows: build-time inference
persisted as a first-class artifact before first run, refreshed when an edit touches the
relevant surface (ADR-0017's requirement rows; the post-turn `finalizeConnectionDeclaration`
seam).

## Decision

1. **Runtime turns get their own system assembly.** A new `appRuntime` branch of
   `buildHostSystemPrompt` sends only host identity + the app response-format layer + a thin
   runtime-brain layer. Builder layers never ride an app-frame turn again, in any mode.
2. **Each LLM-using app carries a runtime contract, authored at build time and pinned to the
   app version.** Internal-draft `runtimeContractSchema` (bounded at parse: overview,
   optional persona/state/response guidance, bounded scalar settings, optional
   `maxOutputTokens`), stored in a new nullable `runtime_contract_json` column on
   `snug_app_versions` (userdb v6, additive). Version pinning means factory reset and
   revert restore the contract with the code it describes.
3. **The contract is host-assigned, never app-claimed — at runtime AND at import.** It is
   injected as a per-turn system suffix (after the stable layers, per ADR-0012's cache-order
   rule), read PER SEND (never captured at transport creation — the stale-at-creation
   lesson), by the host page in direct mode and via an optional field on the internal
   `/invoke` HTTP body in subscription mode. The wire carries contract JSON only, parsed
   STRICT against `runtimeContractSchema` at the server boundary and rendered to system
   text by ONE shared renderer in `packages/knowledge` used by both call sites. It never
   rides the wire envelope: `appMessageSchema`/`appRequestEnvelopeSchema` are untouched and
   an app message smuggling a contract field never reaches the system slot (verified:
   explicit-field envelope construction + unknown-key-stripping schemas). **Wire protocol
   v1 is UNCHANGED.** The trust shape is `dbNamespace`/`netAppId` for the running app —
   and because system-slot text must never arrive on an untrusted channel, **a whole-DB
   import DROPS `runtime_contract_json` from imported version rows unless byte-identical
   to a locally known row** (the connection-reconciliation doctrine); the app runs on the
   lean generic layers until re-authored.
4. **Authoring produces it; the version lifecycle preserves it; a post-turn guarantee
   backstops it.** The builder gets a `runtime_contract_write` tool plus KB teaching (lean
   requests: never duplicate `state` into `payload`, minimal `responseSchema`,
   persona/settings live in the contract). `saveAppVersion` copies the contract forward by
   default, so an ordinary edit never strands it (revert/reset copy from the TARGET
   version); the authoring tool and synthesis overwrite on the authored version. If a turn
   ships an artifact that talks to the agent and the app has no contract anywhere in its
   lineage, a tool-free synthesis mini-turn (through `runAgentTurn`, inspector-visible)
   fills it; if that fails the app runs contract-less on the lean generic layers —
   degradation, never blockage. Authoring is byok/local in v1; the subscription tool twin
   joins the queued server-twins item.
5. **Output bounds are contract-opt-in.** `maxOutputTokens` becomes a per-TURN
   `AdapterRequest` field (the ADR-0012 altitude); the app transport sets it only when the
   contract specifies it. Contract-less legacy apps keep today's behavior byte-for-byte.
6. **App-frame caching stays OFF.** Even with a contract, the prefix sits below the
   model-dependent cacheable minimum; ADR-0012's exclusion is reaffirmed, not revisited.

## Consequences

- Every mode — including subscription and the WebLLM 4K-context brain (whose adapter
  accepts a custom system on tool-free turns) — sheds ~3 KB net of misfit system prompt
  per app turn immediately (builder layer + KB summary out; host identity and the
  response-format layer are retained; a thin runtime layer comes in); contract-bearing
  apps additionally send authored-minimal state and receive bounded JSON replies. This is
  the enabling fix for the queued WebLLM app-context truncation item (2026-08-06).
- A new failure mode exists: a WRONG contract (stale overview, over-tight response shape)
  degrades an app's runtime quality. Version pinning contains it (revert restores the pair)
  and the refresh rule (re-emit when the LLM surface changes) is KB-taught and post-turn
  tested.
- ADR-0011 is preserved: no `usesAgent` flag or column exists; the post-turn synthesis
  trigger is a code heuristic over the authored HTML, not persisted state.
- The spec surface grows internally only (userdb v6 + an internal-draft schema, staged in
  `docs/spec-drafts/` under the A12b pattern); nothing publishes without an explicit ask.

## Alternatives considered

- **Store the contract as a `snug_app_docs` slug.** Rejected: docs are free text (no
  parseable bounds), not version-linked (revert would desynchronize code and contract), and
  already injected into builder-chat context (double-injection).
- **Carry the contract in the wire envelope.** Rejected: it would put app-adjacent content
  on a path the iframe can observe and would grow the published wire protocol for something
  only the host needs; worse, an envelope-carried contract is one parser bug away from
  app-controlled SYSTEM content. Host-side injection keeps the system slot host-owned.
- **Cache the now-stable runtime prefix on app turns.** Rejected: still below the cacheable
  minimum for every current model tier; ADR-0012's write-premium argument holds unchanged.
- **A host-enforced response-schema validator (reject non-conforming replies).** Deferred,
  not rejected: `parseAgentReply` + the app-side referee pattern (Chess plays a legal move
  on off-script replies) already bound the damage; strict validation is a follow-up once
  contracts exist to validate against.
