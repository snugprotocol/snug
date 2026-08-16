# Lessons

- Coinbase is a host-pinned provider: the connection_requirement directive must NOT
  include `fields`, `request.headerTemplate`, or `registration` — only `slot`, `kind`
  (`api_key`), and `declaredApiHosts: ["api.coinbase.com"]`. Adding brand-adjacent details
  ourselves would get the whole requirement refused.
- No raw WebSocket access inside the sandboxed app (no network of its own), so "real-time"
  ticker/book is implemented as a 4s poll through `useConnectedFetch`, paused on hidden tab.
- Order placement is a POST — the host will always interject a confirm step; app copy
  should set that expectation rather than surprise the user.
- (02-twap) The ported v1 never created its own tables: `watchlist`/`orders_log`/
  `copilot_notes` had been made out-of-band by the hub, so on a fresh install every
  read/write quietly fell into its catch block. The TWAP DDL now backfills all three
  with CREATE TABLE IF NOT EXISTS alongside the new tables.
- (02-twap) With everything above the RESPONSE_SCHEMA banner byte-locked, new CSS
  cannot go into the head's style block — rendering a second style element from the
  authored JSX works cleanly and keeps the locked region verifiable byte-for-byte.
- (02-twap) A run engine inside React must not live in closures: the timer + awaited
  governed fetches outlive any render, so the active plan is a ref mutated
  synchronously and mirrored into state, and the interval calls a latest-ref step.

