<!--
layer: knowledge-base
destination: served (whole or as ##-sections via searchKnowledge) by the {{appBuilderToolName}} tool when the host LLM is asked for an app that runs on a schedule — a morning brief, a daily fetch, a recurring reminder, a check "every hour" — or for an app that should suggest a schedule for itself; NOT in the inline core (ADR-0066: a tool-free brain gets only the amended timer rule in 10 and 80); reachable only when the app-builder capability is enabled
blast-radius: whether a generated app can take part in the host's scheduler at all — a wrong frame shape or a wrong kv key here produces apps whose scheduled runs never answer (the host records them as failed after 90 s), and a wrong suggestion rule produces apps that nag on every load
source: written for TASK-20261009-scheduling-framework (ADR-0074 §3 the kv handshake, §4 the suggest-only ladder, §6 the unattended posture); the listener mirrors packages/sdk/src/schedule.ts, the module-form hook
-->

# Scheduled Runs

## The Host's Scheduler Is the One Timer

An app never owns a clock. The ONE timer in Snug is the host's scheduler, and a schedule
exists only because the USER created or enabled it on the host's Schedule page — a
recurring reminder, a question to an app's AI, or a run of an app: a fetch every hour, a
brief every morning, a check every Friday. When a run of your app is due the host wakes
the app itself — inside the open page when your app is on screen, in a hidden frame when it is
closed; never two copies at once — hands it the run's input, and records what the app answers as
a *result* the user reads later. Nobody has to be looking.

So the rule in "Never Think on a Timer" has exactly one sanctioned exception, and it is
not yours to arm: the scheduler wakes you; you never wake yourself. An app takes part in
two ways, and only two —

1. it ANSWERS a scheduled run through the schedule listener below, and
2. it may SUGGEST a schedule for itself, once, after the user has done something.

Everything else — when, how often, what happens after Snug was closed, whether the user
is notified — is the host's and the user's. Never write a schedule into app state, never
build a "remind me" feature on `setInterval`, and never poll the agent "in case".

## The Scheduled-Run Handshake

Three moves, on the frames the app already has. Nothing new enters the protocol: the host
hints over the events channel (ids only) and the content rides the app's own key-value
store, exactly the way `usePersistedState` reads it.

1. The host writes the run's input into the app's OWN key-value store under the key
   `snug:schedule:<runId>` as `{ taskId, runId, input }` — `input` is the JSON the
   schedule's step carries (at most 1 KiB), or absent when the step has none.
2. The host posts a `{{frameType:hostEvent}}` frame with `event: 'schedule-run'` and
   `data: { taskId, runId }`. That is the whole hint — never the content.
3. The app does its work and posts ONE `{{frameType:appEvent}}` frame with
   `event: 'schedule-result'` and `data: { ok, summary?, notify? }`:
   - `ok` — a boolean: did the work succeed.
   - `summary` — one or two sentences a person reads on the Schedule page
     ("3 new issues, 2 assigned to you"). At most 4,096 characters.
   - `notify` — optional `{ title, body }` the host MAY turn into a notification
     (title ≤ 80, body ≤ 120 characters). A suggestion, never a promise.

Then the host clears the key. The host accepts a result only from the frame it hinted,
only for that one outstanding `runId`, and only once — a second result for the same run
is dropped. A run the app does not answer within 90 s is recorded as *failed*; *not
supported* is for an app that never announces at all.

## The Schedule Listener (copy beside the hooks block)

Add this AFTER the copy-exactly hook sections (it belongs in "your" zone of the template,
beside the response schema — never inside sections 1–5, which must stay byte-identical).
It is a second `message` listener next to the bridge's own, filtered to the one host-event
it answers, and it uses the bridge's `snugDbRequest` and `SnugBridge.post` rather than
plumbing of its own:

```javascript
// ============================================================
// SCHEDULED RUNS — the host's scheduler wakes this app; see "Scheduled Runs"
// ============================================================
const SCHEDULE_HANDLED = new Set(); // runIds already answered on this page

async function onScheduledRun({ runId, taskId, input }) {
  // YOUR WORK: read your own data, call your approved API through snugNetRequest
  // (what useConnectedFetch wraps), then answer a SUMMARY — never rows.
  // A mutating call (POST/PUT/PATCH/DELETE) is refused while nobody is present, and asked
  // ONCE in the host's own dialog when the app is open: on a refusal answer ok:false with what
  // you tried, and the host asks the user to run it visibly.
  return { ok: true, summary: 'Checked. Nothing new since yesterday.' };
}

window.addEventListener('message', async (event) => {
  const data = event.data;
  if (event.source !== window.parent || !data || data.v !== {{protocolVersion}}) return;
  if (data.type !== '{{frameType:hostEvent}}' || data.event !== 'schedule-run') return;
  const hint = data.data;
  if (!hint || typeof hint.runId !== 'string' || typeof hint.taskId !== 'string') return;
  if (SCHEDULE_HANDLED.has(hint.runId)) return; // a repeated hint: the first answer stands
  SCHEDULE_HANDLED.add(hint.runId);
  const stored = await snugDbRequest('kvGet', { key: 'snug:schedule:' + hint.runId });
  const input = stored.ok && stored.value && typeof stored.value === 'object' ? stored.value.input : undefined;
  let result;
  try {
    result = await onScheduledRun({ runId: hint.runId, taskId: hint.taskId, input });
  } catch (err) {
    result = { ok: false, summary: (err && err.message) || 'the scheduled run failed' };
  }
  const answer = { ok: !!(result && result.ok) };
  if (result && typeof result.summary === 'string' && result.summary) answer.summary = result.summary;
  if (result && result.notify && result.notify.title && result.notify.body) {
    answer.notify = { title: String(result.notify.title), body: String(result.notify.body) };
  }
  SnugBridge.post({ type: '{{frameType:appEvent}}', event: 'schedule-result', data: answer });
});
```

Write `onScheduledRun` for the app; leave the listener as it is. Bundler-built apps on the
module SDK get the same handshake typed as `useSnugSchedule(handler)` and
`proposeSchedule(proposal)` from `@snugprotocol/sdk`.

## Rules for a Scheduled Handler

- **Idempotent by `runId`.** The host may hint the same run again after a crash; the
  `SCHEDULE_HANDLED` set covers this page, and if your work must not repeat across reloads
  (a message sent, a row appended), remember the `runId` you acted on in your own
  persisted state before acting.
- **One instance — and the same `runId` can reach a different one.** When your app is open,
  a scheduled run executes inside the open page (your UI and the handler share one state —
  update it the normal way); when it is closed, in a hidden frame. If the user opens or closes
  the app mid-run, the host hands the SAME `runId` to the new instance, whose in-memory
  `SCHEDULE_HANDLED` is empty — so before any side effect that must not repeat (a message sent,
  a row appended), write the `runId` to your own persisted state and check it first. Make every
  change one statement (a hidden run's `BEGIN`/`COMMIT` and a whole-database import are refused;
  a handover must never strand half a change).
- **A result is a summary, not data.** The host shows `summary` to a person and never
  reads anything else from it. Keep what you fetched in your own key-value store or
  database, where the app shows it next time it opens.
- **`notify` is a suggestion.** The host decides whether a notification is raised at all
  (the user chose "in Snug" or "with a notification" per schedule), prefixes your app's
  name, caps the text and rate-limits it. Give a good title and body; never depend on it.
- **Say `ok: false`, never throw past the listener.** A failure with a summary that says
  what went wrong ("the forecast API answered 503") is a readable result; a crash is a
  run the user cannot interpret.
- **Reads, not writes, while unattended — and one ask when the app is open.** A mutating
  connected call inside a scheduled run is refused by the host while nobody is present
  (`useConnectedFetch` resolves `{ ok: false, error }` with code `NET_CONFIRM_DENIED`); when the
  app is open the host asks the user ONCE, in its own dialog, and refuses if they say no or do
  not answer within a minute — and a second mutating call in the same run is refused without
  asking. Either way nothing is sent until a person says so, and the host records the run as
  *needs you* with one act — *run now and review*. Design the handler so the refusal is an
  ordinary outcome: answer `ok: false` with a summary naming what it tried ("post the digest to
  GitHub"), and let the visible session do the write.
- **Never own timers.** No `setInterval`, no `setTimeout` loop, no thinking or fetching on
  load, no polling the agent. The scheduler is the one timer; this listener is the only
  way an app takes part.

## Suggesting a Schedule

An app may ask the host for a schedule of its own — propose-only. It posts ONE
`{{frameType:appEvent}}` frame with `event: 'schedule-request'` whose `data` is a schedule
proposal: a `title`, the `steps` (which may name only THIS app — `kind: 'app-run'` with your
`appId`, the one you pass to `useSnugApp` — the host maps it to the id it holds the app under —
and an optional `input` the handler above will receive), and a `spec`:

```javascript
SnugBridge.post({
  type: '{{frameType:appEvent}}',
  event: 'schedule-request',
  data: {
    title: 'Morning forecast',
    steps: [{ kind: 'app-run', appId: 'your-app-id', input: { fetch: true } }],
    spec: { kind: 'daily', time: '07:00', tz: 'device' },
  },
});
```

`spec` is one of `{ kind: 'once', at: <ISO instant> }`, `{ kind: 'every', n, unit:
'minutes' | 'hours' | 'days' }`, `{ kind: 'daily', time: 'HH:MM' }`, `{ kind: 'weekly',
days: ['mon', …], time }`, `{ kind: 'monthly', on: { kind: 'day', day } | { kind: 'nth',
nth, weekday } | { kind: 'last' }, time }` or `{ kind: 'custom', cron }`, each with
`tz: 'device'` (or an IANA zone). The host enforces a floor of fifteen minutes between runs
of an app-suggested schedule.

The rules, and they are the whole point:

- **Suggest ONCE, and only after a user act or a first successful fetch** — never on load,
  never on every open. Remember that you suggested in your persisted state
  (`usePersistedState('schedule-suggested', false)`) so a reload does not ask again.
- **Never assume.** Nothing runs until the user says so. The host shows your suggestion as
  a small strip in the app's header — *schedule it* / *not now* / *stop suggestions from
  this app* — never a modal. *Not now* is remembered for that exact suggestion; two of
  them mute your app for good, and a Settings switch mutes every app.
- **One pending per page.** A second request while one is showing is dropped.
- Keep the app complete without it: a schedule is a convenience the user adds, not a
  feature the app depends on.

## What the Host Shows

The user sees your app's part of a schedule on the host's Schedule page: a *results* feed
(your `summary`, your app's name, when it ran, a status word — *done*, *failed*, *needs
you*, *not supported*), each opening to the step results; a *missed* card when runs fell
due while Snug was closed ("3 schedules were missed while Snug was closed" — *run them* /
*skip*); and the schedule's own row with its switch. A notification, when the user asked
for one and the host raised it, carries your app's name as its title — the host decides
the title, never your handler — and reads "<your app>: <your title> — <your body>" under
it. An app without the listener is still a complete Snug app; a schedule that names it
records *failed* after 90 s until the listener ships (it announces, so it is never *not
supported*).
