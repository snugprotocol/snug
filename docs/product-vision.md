# Snug — Product Vision

**One-liner:** Snug (the Snug Protocol) is an open protocol that lets users build tiny AI-native apps inside any web app — apps that think through the host's LLM at runtime and own their own isolated database.

**Positioning:** "MCP connects agents to tools. Snug connects agents to apps." Snug is a protocol + embeddable SDK, **not** an app builder and **not** a no-code platform. The hosted Playground is the demo, not the product.

## The three differentiators (the entire pitch)
1. **Runtime agent bridge** — the app's brain is the host agent. A Snug chess game sends moves to the LLM over the envelope protocol and animates the JSON reply. Body/mind split; a runtime relationship, not codegen. **Each app carries a runtime contract** authored when it is built (ADR-0018): its turns are assembled from a compact description of what the app is and what a good answer looks like, never from the conversation that built it — so a Snug app is cheap enough to run on a small local model, and the same app runs well on any brain.
2. **User-owned data** — ONE portable SQLite file per user holding every app (code + ≥5 versions), its isolated data, chats, and settings; runs from the browser (OPFS), syncs to an origin the user picks (hub, Dropbox, …), and exports/imports whole. Your apps, your file, any hub, any LLM provider. **And the data answers to you, not to the app's menu** (ADR-0019): the chat beside an installed app classifies what you asked and can query or change that app's own data directly — "what did I spend on food last month?" works on a budget app that never shipped that screen. Reads run on an isolated copy; changes are proposed with the exact statements and row counts, and apply only when you approve them.
3. **Embeddable + secure by construction** — any SaaS drops in the runner/SDK; tokens never enter the iframe, never reach the LLM, never reach a publisher (v1.1 broker).

## What Snug is not (anti-positioning)
- Not "an alternative to Claude Artifacts / Bolt / v0" — never invite that comparison.
- Not a no-code platform.
- Never claim a capability before it is merged and demoed (per-app DB, host-blind credentials).

## v1 scope
`protocol` · `runner` · `sdk` · `db` (new build) · `knowledge` · `adapters` · Playground · minimal server. MIT. v1.1: `auth` (dual-layer credential broker) as a second launch moment.

## Roadmap shape
v0.1 spec + v1 packages → launch → auth v1.1 → community-driven: multi-implementation (other languages/frameworks), hub features (pin/share/install), KeyProvider/KMS for true host-blind credentials.

## Origin
Extracted from the "Native Apps" feature the founder built twice in production — first as an original implementation, then hardened in a second system — where an 11-year-old built a flying-pig game that plays against the AI.
