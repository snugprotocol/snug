# pocket ledger

The solo-business rep: money in, money out, honest totals — and the export-your-data
story front and center.

## What it demos

- **LLM-free by declaration (ADR-0011)**: `RESPONSE_SCHEMA = null`, no `sendMessage` in
  authored code (enforced by the validate suite's posture check). A ledger must be
  boring: totals are arithmetic, and money is exactly where model creativity is unwelcome.
- **Integer cents, always**: amounts are parsed once (`parseCents`, comma tolerated,
  positive, capped) and stored as INTEGER cents in `ledger_entries` — floats never touch
  a balance. Totals come from `SUM(cents) GROUP BY kind` in SQL, not from UI state.
- **The export story**: the ownership card points at the host's **export .sqlite**
  button — the books leave as a standard SQLite file for a spreadsheet, an accountant,
  or a backup drive. No subscription, no lock-in.
- **Survey-compliant UX**: two-tap entry removal (no `window.confirm`), visible
  validation messages ("give it a number, like 4.50"), ≥44px targets, both themes.

## Files

- `app.html` — the whole app. Hook block is byte-identical to
  `packages/sdk/embedded/snug-hooks.js`; everything after the `// 5. RESPONSE SCHEMA`
  banner is app code.
