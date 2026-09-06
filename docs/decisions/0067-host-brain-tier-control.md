# 0067 — The thinking level inside the host's brain is the user's (D15 amended, narrowly)

- **Status:** proposed (drafted at Gate 1 of the task; `accepted` when the owner answers Q1–Q4 and approves the plan)
- **Date:** 2026-09-06
- **Task:** TASK-20260906-host-brain-tier-control (stacks on TASK-20260905-binding-a-artifacts / TASK-20260904-skill-only-snug)

## Context

D15 of the skill-only program (owner's ask, 2026-09-05) made the host kit attach to the host's brain and never ask the user to choose one: no mode, provider, key, URL, account or demo choice anywhere; the brain chip is disclosure only (ADR-0059). One clause went further: *"Model choice inside a binding (for example `sample`'s `modelTier`) is a per-contract host decision made in T4 from S3's numbers, not a control."* T4 implemented that clause as two pinned adapters — app replies on `quick` (T1 S3: median 1.2 s, 48/48 legal chess moves), building and inferring on `default` (T4 S11: `quick` buys nothing on a whole-app rewrite and thinks less).

On 2026-09-06 the owner asked for the opposite of that clause: show the viewer's thinking levels on the runner as a dropdown, default matching the viewer's default, switchable by the user.

What the runtime contract (0.2.41 `sample.d.ts`) offers: ONE knob, `modelTier: "quick" | "default" | "complex"`, and the tier IS the thinking level (`quick` does not think first; `default` and `complex` think before writing, `complex` longest). The viewer's default is `default`. `limits()` names no tiers; a plan that lacks a tier answers on a nearby cheaper one and reports it in `modelTierApplied` — the contract says outright that this is how a tier-choice UI tells the viewer the choice could not be honoured.

## Decision

1. **D15 is amended narrowly.** The BRAIN stays the host's and is never chosen (every other D15 sentence stands). Within a brain whose contract offers tiers, **the tier is the user's**, set from the brain chip's popover — the one disclosure surface — and read by the adapters at call time.
2. **The control exists only where a tier seat exists.** The platform's host brain arm gains an optional `TierSeat` (options, the viewer's default, state, `set`); the kit pins it on the `sample` brain only. No seat → no control: the `complete` brain (no tier in its contract), the demo brain, the web and the desktop render nothing new. Never a dead control.
3. **Switching spends nothing.** A switch changes the option the NEXT call carries; no call on switch, none on load (lesson 2026-09-04: every model call bills the viewer).
4. **Honesty about substitution.** When `modelTierApplied` differs from the ask, the chip says which tier answered and why ("the viewer's plan"); the note derives from the store the adapter writes, never from parallel UI state (ADR-0059 rules 2 and 4). What becomes of the option after a substitution is the owner's Q4 (recommended: listed, disabled, annotated).
5. **The default selection and the per-purpose question are the owner's Q2.** The literal ask (one tier for every turn, initial = the viewer's `default`) costs app replies their `quick` speed; the recommended shape keeps an "auto" entry equal to today's per-purpose pins and lets the three tiers override every turn. The persistence rung is Q3 (recommended: this browser at the artifact origin, never the user file).

## Consequences

- Positive: the user sees and steers the thinking level the viewer already bills them for; the chip stays the one place that says what is thinking; substitution is disclosed by name instead of silently answered on a cheaper tier.
- Negative / residuals: a plan's tier set is unknowable at boot (learned per call); a control now lives in a surface that was pure disclosure — the D15 pin tests gain a positive twin so nothing else creeps in; under the literal-ask shape (Q2 A) app replies get slower by default.
- Where the amendment is recorded: this ADR; a dated amendment line under D15 in the program record; a pointer under ADR-0065's amendments; T4's AC1 note.
