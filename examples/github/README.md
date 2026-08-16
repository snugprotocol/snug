# Standup — what needs you, before you ask

A single-file Snug starter over the GitHub REST API. GitHub shows everything;
Standup shows **what needs you**, in the two minutes before you start your day.

## What it demonstrates

- **A connected, agent-driven app in one file.** All network traffic goes through
  `useConnectedFetch()` to `https://api.github.com` — the host injects the saved
  credential per call; no token ever enters the iframe (C1). Rate limits
  (`X-RateLimit-*`), 401s, and seam errors are surfaced as calm, honest copy,
  never as crashes or spinners that lie.
- **Four surfaces**:
  - **Queue** (default) — open review requests, assigned issues, and mentions from
    `GET /search/issues` (`review-requested:@me`, `assignee:@me`, `mentions:@me`),
    deduped across kinds, as prioritized rows with repo, title, age, and label
    chips. Age adds visual weight — old items gently insist. Item URLs are rendered
    as selectable text with a one-tap copy affordance (the sandbox never navigates
    out).
  - **Pulse** — `GET /users/{login}/events` digested **locally** into a narrative
    strip ("pushed 3 commits to…", "reviewed PR #7 in…") plus a CSS-drawn 14-day
    activity rhythm. No images, no chart library.
  - **Briefing** — the one agent surface: the app sends a compact queue + pulse and
    the agent replies `{briefing, priorities[], deferrable[]}`. Replies are
    hard-validated; anything off-schema is refused and the raw queue stands, with a
    note. Valid briefings journal into the app's own SQLite file (`useAppDB`).
  - **Watchlist** — up to six repos (stored in the app DB) with open issue + PR
    counts and last-push freshness from `GET /repos/{owner}/{repo}`.
- **Empty states that teach.** The empty queue and the queue footer point at the
  provider chat lane for writes ("try asking: *label my oldest assigned issue as
  blocked*"), noting that the host confirms writes first — Standup itself never
  writes.

## The complement thesis

This starter deliberately does **not** clone github.com. No repo browser, no code
view, no notifications firehose — GitHub already does all of that better. Standup
answers exactly one question GitHub makes you assemble from four pages: *what
needs me right now?* Everything else (acting on an item, digging into a repo) is
handed back to github.com — via copied URLs — or to the chat lane.

## Connection posture

- **Slot:** `github` (see `connection.json` — `bearer_token`, declared host
  `api.github.com`).
- **Credential shapes:** a fine-grained personal access token (read access is
  enough — the app only ever reads), or an OAuth app sign-in, both set up through
  the host's connection wizard / registry options.
- **Platforms:** web + desktop. The GitHub REST API supports CORS, so the governed
  seam works from the browser host as well as the desktop host.

## LLM posture (ADR-0011)

**Agent-driven.** `RESPONSE_SCHEMA` is non-null and every `sendMessage` carries a
`responseSchema`. The briefing is the agent's *only* surface: the queue, pulse,
and watchlist render entirely from fetched data, so in keyless/demo mode the app
stays fully useful and the briefing degrades honestly ("the agent answered
off-script — your raw queue stands"). The runtime contract
(`runtime-contract.json`, ADR-0018) carries the persona and the response shape
once, instead of re-sending them on every request.

## App database

- `standup_watchlist (id, repo UNIQUE, added_at)` — the watched repos.
- `standup_briefings (id, brief, priorities, deferrable, queue_size, at)` — the
  standup journal: every accepted briefing, with its ranked lists as JSON text.
