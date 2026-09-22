# 0070 — The model and the thinking level on Binding B are the user's, per machine

- **Status:** accepted (the owner answered Q2 and Q3 and approved the plan on 2026-09-22; Q1, Q4 and Q5 followed the recommendations, Q1's rewritten after a spike)
- **Date:** 2026-09-22
- **Task:** TASK-20260922-binding-b-model-and-thinking-control
- **Relates to:** **ADR-0067** (the same question answered for Binding A — this is its sibling, not its extension) · ADR-0069 §5 (the child pool, the posture) · ADR-0068 (D5, the child env allowlist) · ADR-0059 (the chip is disclosure) · **ADR-0036 D1** (the per-app selector rejected the user file for the same reason, on the other binding). No existing ADR is amended: ADR-0067 already amended D15 to make the thinking level the user's, and this applies that settled principle to the second binding.

## Context

On Binding B the brain is the user's own `claude` CLI, spawned per think by the local host process. The brain chip said `Claude · your CLI` and was a **label** in all five of its states. Three facts about the shipped code, verified 2026-09-22:

- **No model was ever chosen.** `buildStreamArgs` built one argv and never passed `--model`, so every child ran on whatever the CLI's default was.
- **The model field was decoration.** `request.model ?? 'claude'` filled the response envelope only; the page has always sent the literal `claude`, a placeholder rather than an id.
- **Thinking was, and remains, private.** Only `text_delta`s are forwarded; a user's own extended-thinking setting emits `thinking_delta`s that are dropped.

The owner asked, on the first real walk of the shipped plugin, for the chip to become a control: pick the model, pick the thinking level, and on click see which are **active**. Binding A had received exactly this control in ADR-0067; this was the one place where Binding B gave the user less.

## The constraint that bounds everything below

The child is spawned `--tools '' --disallowedTools '*' --max-turns 1 --no-session-persistence --setting-sources local --strict-mcp-config`, and never `--bare`. No tools means no agent loop — single-turn **by construction**, not by convention (measured `num_turns: 1`, `tools: []`). That is a security posture, not an omission: a brain with tools would hold the user's own CLI capabilities under their login, which is what principal C1 forbids. **This decision does not widen it**, and a test pins the whole posture with a model and an effort selected.

## Decision

**1. The model and the effort ride one spawn spec.** `BrainSpec { system, model?, effort? }` is threaded through `buildStreamArgs`, `poolKey`, `acquire`, `prewarm` and `spawn`, so the argv a child runs with and the key that identifies it derive from the same value and cannot drift. With neither chosen the argv is **byte-identical** to the pre-task one, pinned by a frozen literal rather than a recomputation, so the default path is provably untouched.

**2. The pool key is the child's whole identity.** `sha256(system \0 model \0 effort)`. A child pre-warmed for one model is never handed to a request for another — the bug the old `sha256(system)` key would have had the moment a model could be chosen. The separator is load-bearing: without it `model:'a'+effort:'b'` would collide with `model:'ab'`. The tests were run against the old key to prove they catch it.

**3. The thinking axis is the CLI's own `--effort`, and it is NOT ADR-0067's tier.** Measured on 2.1.278: `--effort low | medium | high | xhigh | max`. ADR-0067's `quick | default | complex` is the artifact runtime's `modelTier` contract on Binding A — a different axis, on a different binding, with a different vocabulary. **No mapping between them is invented**, and a test asserts none of the tier words appear among the efforts. Inventing a correspondence that the CLI does not implement was the failure mode this decision most needed to avoid.

**4. The model is free text, validated by the CLI itself.** The spike found **no machine-readable model list**: no `claude model` subcommand, nothing in the command table. So the recommended "ask the CLI for the list" was not available and the acceptance criterion was rewritten. What makes free text safe is that the CLI **already fails by name**: an unknown model exits 1 with `[claude-code:unrecognized_model]` on stderr and a result frame whose text names it ("There's an issue with the selected model (…)"). A hardcoded list is therefore not merely stale-prone but unnecessary — and this CLI has already broken once on exactly that kind of staleness.

**5. The choice is per machine and global across apps.** It lives in the browser at the artifact origin, keyed once, and is **never written to the user file** — not exported, not written into the page on save. It therefore touches no schema: `packages/protocol` is unchanged, with no spec-changelog entry and no sync step. The owner considered and rejected the file: a model id that travelled would name a model the receiving machine's CLI may not have, and would break on arrival. **ADR-0036 D1 rejected the same idea for the same reason** on the playground's selector ("carrying one user's model preference into another user's file"), so this is the project's second consistent answer, not a fresh one.

**6. Resolution happens per think, never at construction.** The brain reads the choice on every request and the page rebuilds its adapter per call. A value read once would freeze the choice until a reload and make "switch now, it lands on your next think" false — ADR-0036 rule 3, applied to one more value.

**7. The chip shows what ANSWERED, never what was asked.** The CLI names the model it resolved in its `system/init` frame; a child remembers its own, and the brain reports it on a turn that succeeded. A model that was merely *chosen* is not named until a think comes back on it. A refusal is shown in the CLI's own words and clears when a think answers again.

**8. Where the brain cannot think, there is no control.** Logged-out, absent, outdated, unknown, and the probe-not-yet-answered case all render the remedy alone (AC8). This is ADR-0067's rule and ADR-0036 rule 4; three surfaces now agree.

**9. Thinking stays private, and the control says so.** A level changes cost and latency, not what is shown. The chip states that thinking itself is never displayed, so the control is honest about what it does.

**10. A switch spends nothing and lands on the next think** — but it **evicts the pre-warmed child**, so that think starts cold. That cost is disclosed on the chip rather than absorbed silently, since the user would otherwise feel it without explanation.

## D1 — The init frame is read at spawn, not during the turn

**Accepted, and it is the reason this was not a one-line change.** The CLI emits `system/init` — the frame naming the resolved model — at **spawn**. For a pre-warmed child that is minutes before its request exists, and `onEvent` early-returned while no request was pending. On the path Binding B is built around, the resolved model was parsed and thrown away. The child therefore remembers its own resolved model regardless of whether a request is pending.

## D2 — A failed turn discloses no model

**Accepted.** The CLI emits `init` **before** validating the model against its catalogue, so on a refused run `init.model` is the asked id echoed back (measured: `"model":"definitely-not-a-model-xyz"`). Treating it as gospel would make the chip confidently name a model that never ran — the parallel UI state ADR-0059 rule 2 forbids. A refused turn discloses the refusal and no model.

## Consequences

- The user can pick any model their CLI supports, including ones released after this code, because nothing here enumerates models.
- A model the CLI does not know fails by name in the page, never silently on another model.
- Switching model or effort costs a warm-up, which the chip states.
- The other CLIs (`codex`, `hermes`, `openclaw`, `ollama`) are untouched; `BrainSpec` does not make them harder, but nothing here claims to serve them.
- Transcript continuation and multi-turn or tool-using brains remain out of scope: that is a posture change, and it needs its own task and ADR rather than arriving through a model picker.
