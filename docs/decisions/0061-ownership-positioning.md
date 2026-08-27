# 0061 — Snug is positioned by what the user owns, not against MCP

- **Status:** accepted (2026-08-27 — the owner approved TASK-20260827-ownership-positioning's
  plan, and separately approved carrying the change into the spec's §1 opener and the org banner)
- **Date:** 2026-08-27
- **Task:** TASK-20260827-ownership-positioning
- **Supersedes:** the "MCP connects agents to tools. Snug connects agents to apps." positioning
  line recorded in `docs/product-vision.md` since the project's extraction.

## Context

Every public surface — the website hero, both repo READMEs, the org profile banner, the docs
hub, and §1 of the normative specification — opened by defining Snug against MCP:

> MCP connects agents to tools. Snug connects agents to apps.

The line is memorable and it parses. It also has three problems that compound as the project
becomes public:

1. **It makes MCP the reference point and Snug the derivative.** A reader who does not already
   know MCP learns nothing; a reader who does now files Snug as an MCP variant. The whitepaper's
   own §11 has always said the opposite — the two protocols address inverse directions of the
   same boundary and a host may well implement both — so the front door contradicted the paper.
2. **It invites a competitive framing we do not want and cannot win.** Positioning against
   complementary infrastructure attracts the comparison "why not just use MCP?", which is not a
   question the architecture is trying to answer.
3. **It leads with a mechanism instead of a consequence.** "Connects agents to apps" describes
   what the wire does. It says nothing about what a user gets, which is the part of Snug that is
   actually unusual: the application and its accumulated state are the user's, and survive the
   host, the model vendor, and the project.

The consequence is also the more defensible claim. Runtime-agent bridging, portable local files
and sandboxed codegen are each things other systems do; **the ownership boundary is the design
decision that makes them cohere**, and it is the one thing a competitor cannot adopt without
giving up the SaaS backend their business rests on.

## Decision

1. **Snug is defined by the ownership boundary.** The canonical statement is: *the application
   and its accumulated state belong to the user, while a conforming host supplies runtime
   intelligence.* Portability, model choice, local-first operation and reduced SaaS custody are
   stated as **consequences** of that boundary, never as a feature list beside it.

2. **MCP is never the foil.** MCP is complementary infrastructure and may be discussed as such
   wherever interoperability or prior art is genuinely useful (the whitepaper's Related Work is
   the model). No public surface introduces Snug by comparison to it. "MCP alternative" and "MCP
   competitor" join the anti-positioning list in `docs/product-vision.md`.

3. **The claims discipline is part of the positioning, not a caveat on it.** Recorded in
   `docs/product-vision.md` and enforced by tests:
   - Snug removes the need for an **application-specific** SaaS backend accumulating the user's
     application state. It does **not** remove every external service.
   - A hosted model **sees the app data sent to it for inference**. Only local inference keeps
     inference data on-device.
   - "Nothing leaves the machine" is true of the **fully local configuration only** — never of
     the hosted Playground, and never as a blanket claim.
   - Credentials and application data are different security concerns; say which is meant.

4. **The specification carries the definition too, in its own terminology.** §1's opener states
   the architectural definition using the spec's established terms — **LLM provider** (§7) and
   **conforming host** — rather than the marketing phrasing. This is an editorial correction on
   ADR-0050's path: prose only, version held at 1.0, zero normative semantics touched.

5. **The body/mind framing survives as architecture, not as the brand promise.** It explains the
   runtime relationship well and stays on both the homepage and the architecture page — beneath
   the ownership framing rather than in front of it.

## Consequences

- **The vision doc is the single upstream source.** `docs/product-vision.md` is hashed in
  `apps/website/docs-sync.json`; changing positioning there reds the sync gate until the derived
  pages are walked. That is the intended coupling and is why the doc moved first.
- **Claims are test-enforced, in both directions.** `apps/website/src/__tests__/positioning.test.ts`
  and `apps/playground/src/__tests__/ownershipCopy.test.ts` pin the new positioning AND the
  absence of the overclaims above — including a check that the fully-local sentence appears only
  in figures that depict a local model. Half of the value is the negative assertions: a future
  copy edit cannot keep the promise and quietly drop the caveat.
- **The desktop app lags until its next release.** The desktop shell compiles the playground's
  source, so the changed copy ships only when a new build is cut. The shipped v0.1.2 copy is
  older, not wrong; folding this into the next release (rather than cutting one for messaging)
  was the owner's call.
- **The spec repo is downstream and pushes separately.** `spec/SPEC.md` carries the same §1 text,
  prepared but not pushed; `docs/spec-changelog.md` holds a PREPARED entry awaiting the SHA.
- **What this does NOT change:** protocol behaviour, wire format, schemas, sandbox/CSP posture,
  database format, SDK surface, or any normative requirement. This ADR is about how the project
  describes itself.

## Alternatives considered

- **Keep the MCP line and add ownership beneath it.** Rejected: two positioning statements is
  none, and the comparison would still be the first thing read.
- **Lead with privacy.** Rejected as both weaker and less honest — Snug cannot promise privacy in
  the hosted Playground or against a hosted model provider. Ownership is true in every
  configuration; privacy is a consequence available in one of them.
- **Leave the specification alone.** Initially planned (normative artifact, push rules, hash
  gate), and reversed by the owner: a spec whose §1 defines the protocol by comparison to another
  protocol is a spec with a positioning bug, and the fix is available on the existing
  editorial-correction path without touching a single requirement.
