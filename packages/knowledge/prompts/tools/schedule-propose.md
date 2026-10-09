<!--
layer: tool
destination: registered as the description of the host's schedule-propose tool — in the builder's direct-mode tool set, and as the ONLY tool of the `schedule` app-chat lane (ADR-0074 §4); the LLM reads this in the request's tool list
blast-radius: whether a suggested schedule is clear enough for the user to enable — the tool cannot enable anything (the user's act on the host's consent surface does), so the risk is a confusing or wrongly timed suggestion the user accepts without reading
source: written for TASK-20261009 (ADR-0074, scheduled tasks — the proposal ladder)
-->

## Tool: schedule propose

Suggests ONE schedule for this app: a reminder, a question for the app's AI, or a run of the
app itself, at a time or on a cadence the user named. It does NOT create or enable anything.
The host shows your suggestion as a card — the title, the steps in plain words, the when, the
next time it would fire — and only the user's act on that card schedules it. Say what you
suggested and that it is waiting for their OK; never say it is scheduled.

Call it when the user asks for something to happen later or regularly: "remind me every
weekday at 8", "every Friday tell me what I spent", "check the forecast every morning".
Call it once per turn. If you are not sure WHEN, ask in your reply instead of guessing.

### Parameter: title

Required. What the schedule is, in the user's own words, at most 80 characters: "weekday
stretch", "Friday spend summary".

### Parameter: when

A plain sentence naming the time or the cadence, in the user's words. The host reads it with
a fixed grammar — keep it to one of these shapes: "every weekday at 8", "daily at 7am",
"mondays and thursdays 5:30 pm", "every 2 hours", "first of the month at 9", "last day of
the month", "in 20 minutes", "tomorrow at 9", "once on oct 20 at noon". Required unless you
pass `spec`.

### Parameter: spec

Optional, for a time the sentence cannot say. The host's own shape, one of:
`{"kind":"daily","time":"07:00","tz":"device"}`,
`{"kind":"weekly","days":["mon","thu"],"time":"17:30","tz":"device"}`,
`{"kind":"monthly","on":{"kind":"day","day":1},"time":"09:00","tz":"device"}`,
`{"kind":"every","n":2,"unit":"hours","tz":"device"}`,
`{"kind":"once","at":"<ISO instant>","tz":"device"}`. Times are 24-hour `HH:MM`; `tz` is
`device` or an IANA zone the user named. When both are given, `when` wins if it reads.

### Parameter: steps

Required. One to five steps, each one of:

- `{"kind":"notify","title":"…","body":"…"}` — *remind me*: a title (≤ 80) and a message (≤ 120)
  in the user's words.
- `{"kind":"app-think","prompt":"…"}` — *ask this app's AI*: the question to put to the app's
  own AI when the schedule fires (≤ 2048). The host hands it the app's tables itself — do NOT
  include queries or SQL; a step carrying them is refused.
- `{"kind":"app-run","input":…}` — *run this app*: the app's own code runs and answers a
  summary. `input` is optional small JSON (≤ 1 KiB) the app reads at that run.

Every step is for THIS app — never name another app, and never pass an app id. An
`app-think` or `app-run` step needs the app to exist already; for a thread with no app yet,
suggest a reminder or build the app first.
