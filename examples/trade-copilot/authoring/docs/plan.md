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

## Smart order (TWAP) — 02-twap-extension, 2026-08-15

- Plan math is LOCAL: `splitEqualSlices` works in whole increments of the product's
  `quote_increment`/`base_increment` (the first slices absorb the remainder, so any two
  slices differ by at most one increment and the sum is exactly the total); per-slice
  minimums validated against `quote_min_size`/`base_min_size` before a plan drafts.
  Interval = duration / sliceCount; slice k fires at arm + k·interval (#1 immediately).
- Run engine: a 1s `setInterval` alive only while status is `running` (the effect keys
  on plan id + status, so pause/cancel/done tears the timer down), calling a latest-ref
  engine step. A `firing` guard serializes slices — the host's confirm dialog can stay
  open indefinitely and confirms must never stack. Delays postpone a slice (it fires
  late, one at a time), they never skip it — EXCEPT slices that came due while paused,
  which are skipped on resume: firing them in a burst would defeat time-averaging.
  The active plan lives in a ref mutated synchronously and mirrored to React state, so
  the engine never acts on a stale closure.
- Slice orders reuse the app's existing shapes (`market_market_ioc` quote/base-sized,
  `limit_limit_gtc`); limit slices price from a fresh ticker GET at fire time, floored
  to `quote_increment`. `client_order_id = planId + '-s' + index` — idempotent by
  construction, so a retry can never double-fill. A declined host confirm surfaces as
  that slice's error and the run continues; Pause/Cancel are the stop controls.
- Agent seat: one new action `twap_sanity_check` (plan + fresh snapshot for the PLAN's
  product + portfolioUsd + riskTolerance; payload only, no duplicated `state` —
  ADR-0018). RESPONSE_SCHEMA gains kind `twap_check` plus flat `assessment` / `risks` /
  `adjustment` seats. `parseTwapVerdict` is strict: anything off-shape renders as
  "Ledger had no opinion" and the plan stands. Verdicts with a `message` also land in
  `copilot_notes`, so the copilot feed keeps the full story. The verdict is render-only
  — nothing the model says arms, edits, or executes a plan.
- New tables: `twap_plans` (one row per ARMED plan: config, status, verdict, timestamps
  — drafts stay in memory) and `twap_slices` (per-slice due/size/status/
  client_order_id/coinbase_order_id/detail). Retention: newest 20 plans. On load, plans
  left `running`/`paused` settle to `interrupted` BEFORE the journal renders (pending →
  skipped, in-flight `sending` → error with a "check Coinbase" note) — no background
  execution exists, and the copy says so.
- The extension's DDL also backfills `watchlist`/`orders_log`/`copilot_notes` with
  CREATE TABLE IF NOT EXISTS: the ported v1 read/wrote them but never created them (the
  hub had made them out-of-band).
- Byte-lock discipline: everything above the RESPONSE_SCHEMA banner is untouched; the
  surface's CSS ships as a second style element rendered from the authored JSX
  (`TWAP_CSS`), using the same tokens/spacing/radii as the head styles.

