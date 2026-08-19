# Plan

Built in three layers, auth-first (TASK-20260818-ledger-starter):

1. **The provider** — a `token-claim` pairing variant in the registry's pairing union
   (beside Hue's `exchange` and WhatsApp's `device-link`), the `simplefin` entry with a
   one-host ceiling, and a pure claim module: decode the pasted setup token → refuse
   anything off the frozen ceiling → POST once → parse the access URL (path checked
   against `/simplefin`) → verify with the minted Basic pair → write credentials and
   `claimVerifiedAt` state together. Wizard gets a paste-and-claim screen; the typed
   credentials screen refuses this family.
2. **The app** — single-file React: DDL array behind a `schemaReady` gate; a
   deterministic sample-data generator (fixed seed, planted leaks); the sync engine
   (watermark minus a 7-day overlap, upsert by id, sample eviction); deterministic
   analytics (recurrence radar, net-worth reconstruction, projections, cash flow,
   heatmap); four agent lanes over one discriminated response schema.
3. **The concierge** (Phase C) — an `open-url` app→host frame with a confirm dialog
   (host-mediated, C2 untouched), cancellation playbooks, and the verified-cancelled
   watcher tallying savings.

Test spine: registry structural suites; claim-module refusal battery incl. the
never-echoes-secrets probe; wizard flow tests with the write-together call-order spy;
the examples validate suite; extracted-core tests for the radar, projection and
cash-flow math; a real-browser pass for DDL and rendering.
