# next-tasks — Standup

- Queue depth honesty: each search runs at per_page=25, page 1 only (pagination
  is out of scope by design), and the response's `total_count` is discarded — a
  "showing 25 of N" line would admit when the queue goes deeper than the screen.
- Read the journal back in full: `standup_briefings` stores each briefing's
  priorities and deferrable lists as JSON, but the journal query selects only
  `brief, queue_size, at` — the ranked lists are written and never shown again.
- Forgiving briefing-to-queue matching: `urlForTitle` is an exact `===` against
  the verbatim title the runtime contract demands, so an agent that trims or
  re-cases a title silently loses its URL (the row still renders). Normalised
  matching would keep the link without loosening the validator.
- Split watchlist counts: GitHub's `open_issues_count` lumps issues and PRs —
  the on-screen copy says so honestly. Separate numbers cost one extra search
  per repo, weighed against the deliberately sequential, gentle refresh.
- Pulse beyond one page: a busy fortnight can outrun the single `per_page=100`
  events call, so the 14-day rhythm undercounts; paginate, or say "at least"
  when the page comes back full.
- Label chips in GitHub's own label colors, once a contrast-safe mapping onto
  the theme tokens exists (chips are token-coloured today by design — plan.md
  rules per-label colors out).
