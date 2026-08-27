# Snug — Product Vision

**One-liner:** Snug (the Snug Protocol) is an open protocol for portable, agent-backed personal software: users build tiny AI-native apps inside any web app, the app and its accumulated state live in one file the user keeps, and the host supplies the intelligence at runtime.

**Positioning:** "Your software shouldn't need a landlord." A Snug application is personal software that can live with the user rather than existing as a row in somebody else's SaaS database: the user keeps the app and its accumulated state, moves it between compatible hosts, chooses the intelligence behind it, and — paired with local inference — runs the whole system on-device. Snug is a protocol + embeddable SDK, **not** an app builder and **not** a no-code platform. The hosted Playground is the demo, not the product.

Portability, model choice, local-first operation and reduced SaaS custody are **consequences** of that ownership boundary, not separate features — that is the order to state them in.

## The three differentiators (the entire pitch)
1. **Runtime agent bridge** — the app's brain is the host agent. A Snug chess game sends moves to the LLM over the envelope protocol and animates the JSON reply. Body/mind split; a runtime relationship, not codegen. **Each app carries a runtime contract** authored when it is built (ADR-0018): its turns are assembled from a compact description of what the app is and what a good answer looks like, never from the conversation that built it — so a Snug app is cheap enough to run on a small local model, and the same app runs well on any brain.
2. **User-owned data** — ONE portable SQLite file per user holding every app (code + ≥5 versions), its isolated data, chats, and settings; runs from the browser (OPFS), syncs to an origin the user picks (hub, Dropbox, …), and exports/imports whole. Your apps, your file, any hub, any LLM provider. **And the data answers to you, not to the app's menu** (ADR-0019): the chat beside an installed app classifies what you asked and can query or change that app's own data directly — "what did I spend on food last month?" works on a budget app that never shipped that screen. Reads run on an isolated copy; changes are proposed with the exact statements and row counts, and apply only when you approve them.
3. **Embeddable + secure by construction** — any SaaS drops in the runner/SDK; tokens never enter the iframe, never reach the LLM, never reach a publisher (v1.1 broker).

## What Snug is not (anti-positioning)
- Not "an alternative to Claude Artifacts / Bolt / v0" — never invite that comparison.
- Not an MCP competitor or an MCP alternative. MCP standardises how a model reaches outward; Snug is about what a user's application can ask and keep. They are complementary and a host may implement both (whitepaper §11). **Never define Snug through MCP** — leading with the comparison makes MCP the reference point and Snug the derivative (superseded the 2026-08 "MCP connects agents to tools" line, 2026-08-27).
- Not a no-code platform.
- Never claim a capability before it is merged and demoed (per-app DB, host-blind credentials).

### Claims discipline (what the architecture actually earns)
- Snug removes the need for an **application-specific SaaS backend** accumulating the user's application state. It does **not** remove every external service: model providers, financial aggregators and other APIs still process what an app sends them.
- A hosted model **sees the app data sent to it for inference**. Only local inference keeps inference data on-device.
- "Nothing leaves the machine" is true of the **fully local configuration only** (local model + local host + local file) — never of the hosted Playground, and never as a blanket claim.
- Credentials and application data are different security concerns with different guarantees. Say which one is meant.

## v1 scope
`protocol` · `runner` · `sdk` · `db` (new build) · `knowledge` · `adapters` · Playground · minimal server. MIT. v1.1: `auth` (dual-layer credential broker) as a second launch moment.

## Roadmap shape
v0.1 spec + v1 packages → launch → auth v1.1 → community-driven: multi-implementation (other languages/frameworks), hub features (pin/share/install), KeyProvider/KMS for true host-blind credentials.

## Origin
Extracted from the "Native Apps" feature the founder built twice in production — first as an original implementation, then hardened in a second system — where an 11-year-old built a flying-pig game that plays against the AI.
