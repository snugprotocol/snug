# Plan / Architecture

## Persistence
- `usePersistedState('coinbase-copilot-prefs', ...)`: selected product id, risk tolerance,
  and the in-progress order form (side/type/sizes). Small, UI-only state.
- SQL (`useAppDB`) for anything that grows or is a log:
  - `orders_log` — every order attempt (submitted/rejected/error), with raw response
    truncated to ~1800 chars for debugging.
  - `copilot_notes` — every AI note (portfolio review / order check / market take) with
    sentiment, risk level, message, suggestion — rendered as the copilot feed.
  - `watchlist` — starred product ids.

## Connected API
- Provider: Coinbase (host-pinned — directive declares only slot/kind/declaredApiHosts,
  no fields/registration/headerTemplate, per the "providers the host already knows" rule).
- Host: `api.coinbase.com`.
- Endpoints used:
  - `GET /api/v3/brokerage/accounts` — portfolio balances.
  - `GET /api/v3/brokerage/market/products?product_type=SPOT` — product list for search
    and USD valuation of non-USD/USDC balances.
  - `GET /api/v3/brokerage/market/products/{product_id}` — ticker/price polling (4s).
  - `GET /api/v3/brokerage/market/product_book?product_id=...&limit=14` — order book
    polling (4s, same cycle as ticker).
  - `POST /api/v3/brokerage/orders` — place order (market IOC or limit GTC). Mutating —
    host asks user to confirm.

## Polling / "real-time"
No websockets available from a sandboxed app (no raw network); ticker + book poll every
4 seconds via `useConnectedFetch`, paused when the tab is hidden (`document.visibilityState`).
Ticker keeps a rolling in-memory array (not persisted) per product for the sparkline.

## AI copilot ("Ledger")
Three actions via `sendMessage`: `review_portfolio`, `review_order`, `market_take`. All
share `RESPONSE_SCHEMA` (kind/message/sentiment/riskLevel/suggestion/flags). Replies are
written into `copilot_notes` and shown in a chat-like feed at the bottom of the dashboard,
across the full width.

## Defensive coding notes
- Every Coinbase call checked for `res.ok` AND `res.status >= 400` before trusting body.
- `parseBody` guards against non-JSON / already-parsed bodies.
- Empty states everywhere data depends on the connection (portfolio, ticker, book).
- Copilot failures shown as a dismissable-by-refresh notice, never thrown.

