# Requirements

- Load and display real Coinbase portfolio balances (Advanced Trade `/accounts`), with an
  estimated total USD value.
- Real-time-ish market price ticker for a selected product (polled every 4s via
  `/market/products/{id}`), with a small in-memory sparkline and 24h change.
- Real-time-ish order book (bids/asks) for the selected product via
  `/market/product_book`, polled alongside the ticker, rendered as depth bars.
- Asset search + watchlist (persisted in SQL) to switch selected product quickly.
- Trade panel: Buy/Sell toggle, Market/Limit toggle, submits real orders to
  `/api/v3/brokerage/orders`. Mutating call — host will prompt the user to confirm before
  sending.
- Every submitted order is logged to `orders_log` (SQL) and shown in a "Recent orders" list.
- AI copilot ("Ledger"): reviews portfolio on demand, gives a market take on demand, and
  automatically comments after every order submission. Notes persisted to
  `copilot_notes` (SQL) and rendered as a chat-like feed with sentiment/risk tags.
- Works gracefully with no Coinbase connection: empty/connect-hint states everywhere,
  never a blank screen or infinite spinner.
- Both light and dark theme via CSS variables, following host theme.
- Risk tolerance selector (conservative/balanced/aggressive) feeds into copilot's tone.

## Smart order (TWAP) — added 2026-08-15 (02-twap-extension)

- Plan: product (from the products the app already lists), side, total size, duration
  (15m/1h/4h), slice count (4–12, clamped). Computed locally as equal slices at equal
  intervals; each slice a market-IOC or limit order priced at the interval's start.
  Rendered as a CSS-drawn timeline of slice cards with honest copy: what is sent, when,
  and that EVERY slice asks for the user's confirmation at execution (the host's
  governed-write gate, "remember for this session" noted in the UI).
- Sanity check: before arming, the plan + a fresh market snapshot go to the agent; the
  verdict {assessment, risks[], adjustment?} renders into the plan card. Off-schema →
  "Ledger had no opinion", plan unchanged. The agent never executes anything.
- Run: armed plans execute client-side on a timer; slice outcomes
  (accepted/rejected/error/skipped) render live on the timeline; pause/cancel stop
  future slices; nothing fires while paused or after completion; a slice that comes due
  while paused is skipped on resume, never fired late. Closing the app interrupts the
  run and says so on reopen — no background execution exists.
- Journal: plans + slice outcomes persist via useAppDB (`twap_plans`, `twap_slices`;
  literal SQL with params arrays only) and render as run history under the surface.
  Empty state teaches the provider chat lane ("place the next slice of my plan early —
  writes always confirm first").
- Same visual language (tokens, spacing, type), both themes, stacks at 375px.

