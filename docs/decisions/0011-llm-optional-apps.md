# 0011 — Apps are LLM-optional: the agent is a capability, not a requirement

- **Status:** draft
- **Date:** 2026-08-03
- **Task:** TASK-20260803-hub-ops

## Context
Every layer of the app doctrine currently assumes an app talks to the model. The knowledge base opens by *defining* a Snug app as one that "runs in a sandboxed iframe inside the conversation and **thinks through the host's agent at runtime**", and states "The app is not a static page" (`prompts/knowledge-base/app-authoring/10-overview-and-contract.md`). The catalog reinforces it structurally: the archetype table has an **"Agent's role"** column with a filled-in value for all nine archetypes — there is no row for an app that never calls the LLM. The runtime loop is documented as a five-step announce → ready → `sendMessage` → agent → response cycle.

This is a doctrine artifact, not a technical constraint. The runtime already supports LLM-free apps: `hostReady` advertises `capabilities` (`packages/protocol/src/frames.ts:22-26`) and nothing in `packages/runner` requires an app to ever send an `appMessage`. An app that only announces, renders, and persists via `usePersistedState`/`useAppDB` works today.

The gap has real consequences. Two of the three shipped examples are agent-driven, and the third (`habit-tracker`) is agent-augmented — so every worked example teaches agent-dependence. An LLM asked to build an arcade game will follow the doctrine it was given and wire a model call into a loop that does not need one: added latency on every interaction, a hard dependency on a configured key for a game that should run offline, and cost per frame of gameplay. The owner's framing (2026-08-03): *"the pig game runs independently without calling any LLM for its execution, unlike the Chess game which plays against LLM and calls it for every move — it really depends on the nature and requirements of the app, and the hub should support all such apps."*

## Decision
- **An app is a self-contained HTML program that the host runs; talking to the agent is one capability it MAY use, not part of the definition.** The KB contract is rewritten so agent use is conditional, and the runtime loop is documented as announce → ready → *(optional)* message cycle.
- **The catalog gains an autonomous/local-only archetype** (arcade and reflex games, simulations, timers, calculators, drawing toys, offline reference tools) whose "Agent's role" is explicitly **none at runtime** — the model authors the app, then gets out of the way.
- **Deciding whether a turn needs the model becomes an explicit authoring step.** Guidance: call the agent when the task needs judgment, generation, or open-ended language (a chess opponent, a coach's commentary, natural-language SQL); compute locally when the rule is deterministic and expressible in JavaScript (collision detection, scoring, physics, win conditions). The existing rule that the app is always the referee for its own rules stays, and extends: an app whose rules are *entirely* deterministic needs no agent at all.
- **Agent use is not recorded as data.** No `usesAgent` column, no manifest flag, no protocol change. The property is emergent from the app's code and is not needed at rest: the host already advertises capabilities and degrades gracefully, and adding a flag would mean schema v3 and a spec-sync cycle for something nothing reads. (Revisit only if a UI genuinely needs to pre-filter apps by agent use — e.g. "runs without a key" badging.)
- **The starter shelf demonstrates both poles.** `flying-pig` becomes the LLM-free exemplar (pure local gameplay); `chess` remains the agent-as-opponent exemplar; `habit-tracker` remains the agent-augmented-data exemplar.

## Alternatives considered
- **Add a `usesAgent` flag to the app manifest / user DB** — rejected: forces `packages/protocol` schema v3 plus SPEC_SYNC and a spec-changelog entry, and migrates every existing user file, to store a fact no code currently consumes. The doctrine change delivers the outcome without touching the wire or the storage surface.
- **Leave the KB as-is and rely on the model's judgment** — rejected: the KB is normative for generation, and it currently states the opposite of the desired behavior in its opening definition. Prompts are the product here (ADR-0004); leaving a wrong definition in place guarantees drift in every generated app.
- **Keep the attached pig game verbatim as a "raw" example outside the contract** — rejected: it uses `localStorage` (dead in a null-origin iframe — the high score would silently never persist) and a foreign `postMessage` announce type, so it would teach three broken patterns while demonstrating one good idea. Porting it to the contract preserves the idea and fixes the mechanics.

## Consequences
- `packages/knowledge` prompt changes are behavior changes for every future generated app; the generated `content.ts` is regenerated and the centralization lint keeps DDL/name-rule injection single-sourced (no deviation from ADR-0004's layering).
- No protocol, schema, or spec impact — deliberately.
- The examples suite gains an assertion that an LLM-free app runs end-to-end, so "supported" is enforced rather than merely asserted in prose.
- Future work this unblocks: a "runs without a key" affordance in the hub, and the queued true-offline runtime (vendored-runtime template) becomes meaningful — an LLM-free app plus a vendored runtime is a genuinely network-free app.
