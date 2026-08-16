# requirements — Standup

## Functional

- R1. Queue (default surface): open review requests (`review-requested:@me`),
  assigned issues (`assignee:@me`), and mentions (`mentions:@me`) via
  `GET /search/issues`, grouped by kind, deduped across kinds (reviews win, then
  assignments, then mentions), per_page=25 each.
- R2. Queue rows: repo, title, age since creation, up to three label chips;
  age-based visual weight (fresh / aging ≥2d / old ≥7d / ancient ≥21d);
  the item URL rendered as selectable text plus a one-tap copy affordance with
  copied/failed feedback. No external navigation, no `<a href>`.
- R3. Pulse: `GET /users/{login}/events?per_page=100`, digested locally into
  up to 8 narrative lines plus a 14-day CSS bar rhythm (no images, no libraries).
- R4. Briefing (agent): send compact queue + pulse digest with a responseSchema;
  hard-validate `{briefing, priorities[], deferrable[]}` (strings non-empty,
  arrays capped at 6); off-schema or error → note + raw queue stands. Accepted
  briefings insert into `standup_briefings`; last 5 shown as the journal.
- R5. Watchlist: up to 6 repos in `standup_watchlist`; per repo
  `GET /repos/{owner}/{repo}` → open issues + PRs count and last-push freshness;
  add via input (Enter or button, no `<form>`), remove via two-tap arm.
- R6. Un-connected (401): honest connect card naming the `github` slot, PAT or
  OAuth via the wizard, plus a designed skeleton queue.
- R7. Errors: seam `{ok:false}`, 401, 403/429 with `X-RateLimit-Remaining: 0`
  (reset time from `X-RateLimit-Reset`), and unexpected statuses each get calm,
  specific copy. Rate limiting is presented as pacing, not failure.
- R8. Empty states teach the chat lane for writes, noting host confirmation.

## Contract (validate suite)

- One self-contained app.html; exactly 3 CDN scripts + 1 babel script; hooks
  block byte-identical to sdk/embedded/snug-hooks.js; section-5 banner.
- Announce `github-standup` / `Standup` / 🗞 / #35618e via useSnugApp.
- All colors as custom properties under `:root` and `:root[data-theme="dark"]`;
  no `prefers-color-scheme`; ≥44px targets; usable at 375px, composed on desktop.
- No browser storage, no `<form>`, no window.confirm, no direct network APIs,
  SQL literals with params arrays only.
- Agent-driven posture: RESPONSE_SCHEMA non-null, responseSchema on every
  sendMessage; ships runtime-contract.json (ADR-0018).
