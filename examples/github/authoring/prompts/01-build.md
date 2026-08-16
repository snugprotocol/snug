# build prompt — 2026-08-15, authored by Claude (Fable 5) for TASK-20260815-starter-apps-rebuild

===BRIEF-START===
# github — "Standup": what needs you, before you ask

Build examples/github/app.html — a single-file Snug starter, web + desktop. Complement github.com, never clone it: GitHub shows everything; Standup shows what needs YOU, in the two minutes before you start your day.

GitHub REST API via useConnectedFetch to https://api.github.com (Bearer token injected host-side; send Accept: application/vnd.github+json): GET /user; /search/issues?q=is:open+review-requested:@me, q=is:open+assignee:@me, q=is:open+mentions:@me; /users/{login}/events (recent activity); /repos/{owner}/{repo} for a small watchlist.

Surfaces (desktop-first):
1. **Queue** (default): the needs-you list — review requests, assigned issues, mentions — as calm prioritized rows (repo, title, age, labels as subtle chips), grouped by kind, with age-based visual weight (old items gently insist). One-tap copy of the item URL (no external navigation from the sandbox — copy affordances + the URL rendered).
2. **Pulse**: your recent activity story — events digested locally into a narrative strip (pushed to X, opened PR Y, reviewed Z) + a CSS-drawn 14-day activity rhythm (no images).
3. **Briefing** (agent): "what needs me today?" — the app sends the fetched queue + pulse compactly; the agent replies {briefing, priorities: [{title, repo, why, suggestedAction}], deferrable: [...]} rendered as a morning-briefing card. Validate hard; off-schema → the raw queue stands with a note. Briefings journal into the app DB (useAppDB) — your standup history.
4. **Watchlist**: a few repos (stored in DB) with open-issue/PR counts and last-push freshness.
5. Empty states teach the provider chat lane ("try asking: label my oldest assigned issue as blocked" — noting writes ask for confirmation).

Un-connected: honest state (PAT or OAuth via the wizard), designed skeleton queue.
===BRIEF-END===
