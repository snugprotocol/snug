# Ledger — your money, at home

Every Mint-class app watches your money from someone else's server and pays for itself
with your data. Ledger inverts that: **every account lands in your own Snug file**, every
chart is computed locally, and the only model that ever reads a transaction is the brain
*you* configured. More than a dashboard, it is an analyst on tap and a time machine for
your net worth.

## What it does

- **Consolidates everything** — one [SimpleFIN](https://bridge.simplefin.org/) connection
  syncs every bank and credit-card account you attach to your SimpleFIN Bridge account,
  with balances, pending transactions, and history, into the app's own SQLite tables.
- **The time machine** — your reconstructed net-worth history plus projected branches:
  the current path (median of your last six closed months, math you can check by hand)
  beside any saved plan, with a scrubber from 3 to 36 months out.
- **Money leaks** — a deterministic subscription radar finds recurring charges and flags
  overlapping streaming services, price creep, and possibly-lapsed subscriptions; the
  agent ranks them keep / consider / cut. Mark one cancelled and the feed itself
  verifies it: no charge in the next cycle flips it to "verified — saving $X/mo".
- **Ask your money** — plain-language questions answered from your own rows, with the
  transaction evidence counted, never invented.
- **Plans** — say a goal ("save $6,000 for a Norway trip by June"); the agent turns it
  into monthly steps against your real spending, and the time machine grows a branch.
- **Sample mode** — before any connection, Ledger seeds a deterministic made-up
  household (with deliberately planted leaks) so every surface shows its value; the
  first real sync replaces every sample row wholesale.

## Honesty notes

- The dashboards, radar, budgets and projections are **fully usable with no model in the
  loop** (ADR-0011). Agent lanes fail soft with a visible note, never a fake answer.
- Projections are arithmetic, not prophecy — the card says exactly what math it used.
- Your bank passwords stay with SimpleFIN Bridge (that is its product); Snug holds only
  the read-only access key the claim mints, in your own file (C1).

## Running it

Install from the shelf, then follow the connect flow: create a SimpleFIN Bridge account
(~$1.50/yr), attach your banks there, copy the one-time **setup token**, and paste it
into the wizard — Snug trades it for a permanent read-only access key and verifies it
before anything says "connected". Sync on demand with ↻.

## Data it keeps (in the app's own namespaced tables)

`accounts` · `txns` (transactions, with category + pending + sample provenance) ·
`snapshots` (balance history) · `rules` (categorization, approved-only applied) ·
`budgets` · `scenarios` (saved plans) · `cancels` (marked cancellations + verification)
· `sync_runs` (watermarks + outcomes).
