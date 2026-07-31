# kept — a habit tracker you actually own

Small promises, kept daily — and the ownership demo: everything this app writes lives in a
real SQLite file the user can walk away with.

## What it demos

- **`useAppDB` end to end**: idempotent DDL on first run (`habits` + `checks` tables),
  parameterized inserts/deletes for add / check-off / retire, streak computation, and a
  last-7-days grid — all against the host-brokered SQLite database.
- **"Ask the agent about my habits"**: the question goes out with the table schema in the
  payload and a `responseSchema` of `{sql, message}`. The agent answers with a SELECT; the
  **app** runs it through `useAppDB` and renders the resulting columns + rows. The SQL
  itself is shown in a mono chip — you watch the query that produced your answer.
- **Guardrails**: only `SELECT`/`WITH` statements are executed (anything else is refused
  with a visible message, not run), query errors render as data, and an erroring agent
  never crashes the app.
- **The ownership moment**: the prominent card up top points at the playground chrome's
  **export .sqlite** button — the actual download lives in the host bar, and what comes
  out is a standard SQLite file. No account, no lock-in, no export tax.
- **Survey-compliant UX**: skeleton rows while the db opens (no spinners), two-tap inline
  "retire → sure?" (no `window.confirm`), ≥44px touch targets, works at 375px.

## Files

- `app.html` — the whole app. Hook block is byte-identical to
  `packages/sdk/embedded/snug-hooks.js`; everything after the `// 5. RESPONSE SCHEMA`
  banner is app code.
