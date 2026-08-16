# trade-copilot — the Coinbase trading copilot

**What it demos:** the full connected story at its most demanding — a real financial
API (Coinbase Advanced Trade, Ed25519 per-request signing via the registry-pinned
`cdp_jwt` template, ADR-0030), live portfolio + market data through the governed
connected-fetch seam, an agent persona ("Ledger") grounded in the user's real
positions, and app-owned SQLite journaling.

**Complement thesis:** Coinbase's own app shows your account; this one *thinks about
it with you* — portfolio review against live data, order sanity-checks before you
place anything, market takes in plain language, and (with the provider chat lane)
ad-hoc questions and TWAP-style smart-order orchestration where every slice is a
governed, user-confirmed POST.

**Provenance:** ported 2026-08-15 from the owner's own hub-built app (the first real
Snug app built against a live financial API). The app-authored code is the original,
verbatim; the embedded hooks block was re-copied from `packages/sdk/embedded/snug-hooks.js`
(the original predated the current reference — surgery journaled in
TASK-20260815-starter-apps-rebuild). Its real authoring wiki (vision, requirements,
plan, lessons, next-tasks) ships in [`authoring/docs/`](authoring/docs/) exactly as the
hub accumulated it.

**Connection posture:** slot `coinbase`, kind `api_key` (key name + Ed25519 secret;
fields/request/testRequest arrive registry-pinned at install review). Desktop-only —
Coinbase's API offers no browser CORS, so the tile unlocks in the desktop app where
the shell's native fetch carries it.

**LLM posture:** agent-driven (`RESPONSE_SCHEMA` + runtime contract shipped in
[`runtime-contract.json`](runtime-contract.json)); degrades to an honest un-connected
state and never crashes keyless.
