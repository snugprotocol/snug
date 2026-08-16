# Vision

Forecasts turned into decisions. Every weather app answers "what will the weather
be?"; *Should I?* answers the question underneath it — "should I run at 6, hang the
laundry, water the garden tonight?".

Three surfaces: **Today** (a CSS-composed scene of the current sky, a 24-hour
comfort timeline, the sun's arc), **Decisions** (the signature — user-created
decision cards with good/maybe/skip verdicts from local rules, an optional
agent second opinion, and an outcome journal), and **Places** (saved geocoded
places with a same-hour compare strip).

The app must be a gold-standard Snug starter: fully useful with no model in the
loop (local verdicts are deterministic and explainable), honest in every degraded
state (no connection, bad key, rate limit, off-schema agent reply), and the owner
of its own data — places, cards, and journal live in the app's SQLite file.
