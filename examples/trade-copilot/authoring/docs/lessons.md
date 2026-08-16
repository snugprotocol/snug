# Lessons

- Coinbase is a host-pinned provider: the connection_requirement directive must NOT
  include `fields`, `request.headerTemplate`, or `registration` — only `slot`, `kind`
  (`api_key`), and `declaredApiHosts: ["api.coinbase.com"]`. Adding brand-adjacent details
  ourselves would get the whole requirement refused.
- No raw WebSocket access inside the sandboxed app (no network of its own), so "real-time"
  ticker/book is implemented as a 4s poll through `useConnectedFetch`, paused on hidden tab.
- Order placement is a POST — the host will always interject a confirm step; app copy
  should set that expectation rather than surprise the user.

