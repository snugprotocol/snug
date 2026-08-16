# extension prompt — 2026-08-15, authored by Claude (Fable 5) for TASK-20260815-starter-apps-rebuild

# trade-copilot 02 — smart orders: a TWAP planner Ledger executes with you

Extend the app with ONE new surface, "Smart order", raising it past the baseline (owner brief 2026-08-15: "the app could suggest smart order executions like TWAP which a user can run; the app dynamically applies basic TWAP fundamentals and orchestrates the Coinbase APIs accordingly").

The surface:
1. **Plan**: user picks product (from the products the app already lists), side (buy/sell), total size, duration (15m/1h/4h), slice count (4-12). The app computes the TWAP plan LOCALLY — equal slices at equal intervals, each slice a market IOC or limit order at the interval's start — and renders it as a timeline of slice cards with honest copy: what will be sent, when, and that EVERY slice asks for the user's confirmation when it executes (the host's governed-write gate).
2. **Sanity check (agent)**: before arming, the app sends the plan + current market snapshot to the agent (extend the existing RESPONSE_SCHEMA with a new kind or field — keep every existing kind working); the agent replies a verdict {assessment, risks[], adjustment?} rendered into the plan card. Off-schema → plan stands with "Ledger had no opinion" note. The agent NEVER executes anything.
3. **Run**: an armed plan executes client-side on a timer — each due slice POSTs /api/v3/brokerage/orders via the existing connectedFetch helper with a client_order_id derived from the plan id + slice index (idempotency), order_configuration matching the app's existing order shapes. Each POST triggers the host's confirm dialog (the user can "remember for this session" — say so in the UI copy). Slice outcomes (accepted/rejected/error/skipped) render live on the timeline. Pausing/cancelling stops future slices; slices never fire while paused or after completion. If the app is closed mid-run, the plan shows as interrupted on reopen (no background execution exists — be honest about that in copy).
4. **Journal**: plans + slice outcomes persist via useAppDB (new tables, params arrays only, no string-built SQL) — a run history view under the surface.

Design: match the app's existing visual language exactly (tokens, spacing, type). The timeline is CSS-drawn. Both themes. 375px stacks. This is REAL trading — the tone is calm, precise, consequence-aware; the empty state teaches the provider chat lane too ("try asking: place the next slice of my plan early — writes always confirm first").
