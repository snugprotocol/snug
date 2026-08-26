# 0059 — The active brain is always disclosed, and scripted output carries its provenance

- **Status:** proposed (drafted at Gate 2 of TASK-20260826-demo-brain-clarity; accepted
  when the owner approves that task's plan)
- **Date:** 2026-08-26
- **Task:** TASK-20260826-demo-brain-clarity

## Context

The playground's zero-key default is `byok` mode with the `mock` provider — the "demo
brain", an offline script that fakes the build flow (ADR-0008's serverless-first
posture). That default is deliberate and stays. But as of this writing, nothing ambient
in the shell says the demo brain is what's thinking: the model selector hides itself
under `mock`, and the only "demo brain" strings live in Settings and the webllm
fallback banner. Two failure modes follow, both fatal for a launch audience:

1. A visitor assumes Snug is calling a hosted LLM on Snug's servers — the opposite of
   the product's own C1/serverless story.
2. A visitor judges the product on canned output without knowing it was canned.

A third, sharper case: `createTurnAdapter` falls through to the mock adapter whenever a
keyed provider has no key, so a user who believes they configured a real provider can
receive scripted output with no signal at all.

## Decision

1. **Ambient disclosure is permanent, not first-run.** A live status surface (the brain
   chip) names what's currently thinking — demo brain, a keyed provider, a local model,
   the hub — on every route, at all times. It is a status surface, never a nag: it stays
   after the user switches and keeps being true.
2. **Disclosure derives from the routing decision, never from parallel UI state.** The
   surface consumes the same derivation the adapter constructor uses (`adapterKindFor`),
   so the keyless-fall-through case and every future routing change stay truthful by
   construction.
3. **Scripted output is provenance-tagged at the turn.** Each assistant turn produced by
   the mock adapter persists its brain kind in the message meta and renders a
   "scripted demo" tag — including after reload. Provenance is a property of the row,
   not of the session that renders it.
4. **Disclosure copy claims only what the code vouches for.** BYOK invitation copy says
   the key is saved in the user's file on their device and sent only to the chosen
   provider — never to Snug's servers. It does not say "never leaves your device"
   (the key travels to the provider), and demo copy names the mechanism ("a tiny
   offline script — no model, no server") rather than euphemising it.

## Consequences

- First-contact surfaces (the web builder callout; the existing desktop welcome) become
  reinforcement, not the sole carrier — a user who skips or forgets them is still told.
- Any new brain (webllm GA, future providers) must join the one derivation and the
  chip's label map; a brain the chip cannot name is a routing change the UI would lie
  about, and AC1's matrix test is the tripwire.
- Screenshots of demo output are self-describing, which is the honest-demo posture we
  want in front of a critical audience.
