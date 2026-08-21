# Next tasks

- Persist the agent's call per card (advice lives in session state today — a
  reload keeps the journal but drops the agent note from the card).
- Custom decision windows: the schema already stores `day_offset` / `start_hour` /
  `end_hour`, but the composer offers six presets — an hour-range editor, and
  day-3+ windows (the forecast holds five days; presets stop at tomorrow).
- Read the journal back: follow-rate and verdict-vs-outcome patterns (`source`
  and `outcome` are stored but nothing analyses them beyond the last-12 list).
- Honest precipitation in the compare strip: the current-weather endpoint carries
  no `pop`, so the strip's comfort read assumes zero — each place's first
  forecast slot could supply the real number at one extra call apiece.
- A units toggle (`units=metric` is hard-coded; °C and m/s throughout).
- Personal comfort bands ("I run in the rain") — the scoring thresholds and
  good/maybe/skip cut-offs are fixed constants today.
