# plan — Standup

1. Study chess (hooks placement, banner, agent validation, theming) and
   adventure-quest (useAppDB + agent posture); read snug-hooks.js and
   validate.test.mjs to pin the enforced contract.
2. Assemble app.html from three parts so the hooks block is byte-identical:
   head + `<style>` + `<script type="text/babel">` → `cat` of
   packages/sdk/embedded/snug-hooks.js → authored section (section-5 banner,
   RESPONSE_SCHEMA, app).
3. Authored section: pure helpers (header lookup, JSON parse, rate-limit copy,
   age/weight, item slimming, event digestion, rhythm, hard briefing validator),
   DDL for `standup_watchlist` + `standup_briefings`, then one `App()` with
   render-helper functions (not nested components, so the watchlist input keeps
   focus).
4. Refresh flow: `/user` gates the connection phase (checking / ok / unauthed /
   limited / down) → three searches in parallel → dedupe → events → watchlist
   repo stats, sequentially, gently.
5. Verify with a one-off script mirroring the validate rules (hooks identity,
   URL/attr scans, banned tokens, network rule, posture, structure, tokenized
   colors) plus a real Babel JSX compile; validate runtime-contract.json and
   connection.json against the built protocol schemas.
6. Write runtime-contract.json, README.md, authoring prompt + docs.

Out of scope by design: any GitHub write, notifications API, repo browsing,
pagination beyond page 1, per-label colors (theme tokens only).
