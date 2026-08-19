# Next tasks

- Light up the recently-played lane (repeat-rate and fresh-face chips from the real
  last-50 plays) the day a registry pin grants `user-read-recently-played` — the code
  path ships and self-labels its absence today.
- Rewind card archive: persist every accepted card, not just the last one, and let
  the reader page back through past columns.
- Journal genres alongside artists so Trends can chart genre drift, not just artist
  churn.
- Export/import surface for the journal (the DB hooks carry export already; there is
  no UI for it).
- Device picker on Now — transfer playback between devices as another governed write.
- "Then vs now" diff: pick two journaled days and render the portrait delta — seats
  gained and lost, rotation and discovery movement.
