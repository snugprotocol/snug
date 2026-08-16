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

## Smart orders

Added 2026-08-15 (`authoring/prompts/02-twap-extension.md`): a fourth surface, **Smart
order — TWAP**. The app computes the plan locally — equal slices at equal intervals
(15m/1h/4h, 4–12 slices, sizes in whole product increments so any two slices differ by
at most one increment), each slice a market-IOC or limit-at-slice-start order — and
renders it as a CSS-drawn timeline of slice cards. Before a plan can be armed, Ledger
sanity-checks it against a fresh market snapshot (new `twap_check` response kind:
`assessment` / `risks[]` / `adjustment?`, rendered into the plan card; an off-schema
reply degrades to "Ledger had no opinion" and the plan stands). An armed plan executes
client-side on a timer: every slice is a real `POST /api/v3/brokerage/orders` through
the governed connected-fetch seam with a deterministic `client_order_id` (plan id +
slice index — a resend can never double-fill), and every slice passes the host's
confirm gate ("remember for this session" covers the rest of the run). Pause holds the
timer — a slice that comes due while paused is skipped on resume, never fired late.
There is no background execution: closing the app stops the run, and on reopen the
plan is settled as *interrupted* (unsent slices skipped, in-flight ones flagged for a
manual Coinbase check). Plans and slice outcomes journal to app-owned SQLite
(`twap_plans` + `twap_slices`, newest 20 plans kept) and render as run history. The
agent only ever returns a verdict — it never executes, schedules, or edits a plan.
