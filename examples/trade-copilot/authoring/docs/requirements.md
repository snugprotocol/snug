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

