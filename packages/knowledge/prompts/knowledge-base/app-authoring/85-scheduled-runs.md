<!--
layer: knowledge-base
destination: served (whole or as ##-sections via searchKnowledge) by the {{appBuilderToolName}} tool when the host LLM is asked for an app that runs on a schedule — a morning brief, a daily fetch, a recurring reminder, a check "every hour" — or for an app that should suggest a schedule for itself; NOT in the inline core (ADR-0066: a tool-free brain gets only the amended timer rule in 10 and 80); reachable only when the app-builder capability is enabled
blast-radius: whether a generated app can take part in the host's scheduler at all — a wrong frame shape or a wrong kv key here produces apps whose scheduled runs never answer (the host records them as failed after 90 s), and a wrong suggestion rule produces apps that nag on every load
source: written for TASK-20261009-scheduling-framework (ADR-0074 §3 the kv handshake, §4 the suggest-only ladder, §6 the unattended posture); TASK-20261010-host-broker PR-6 retired the copied listener snippet: the schedule hook is section 6 of the copy-exactly hooks block (packages/sdk/embedded/snug-hooks.js), its module twin packages/sdk/src/schedule.ts — this page teaches the component that mounts it
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

1. it ANSWERS a scheduled run through the schedule hook below, and
2. it may SUGGEST a schedule for itself, once, after the user has done something.

Everything else — when, how often, what happens after Snug was closed, whether the user
is notified — is the host's and the user's. A schedule may make changes on its own — only the
user turns that on, for its own app's data, with an undo. Never write a schedule into app
state, never build a "remind me" feature on `setInterval`, and never poll the agent "in case".

## The Scheduled-Run Handshake

Three moves, on the frames the app already has — the schedule hook below makes the app's
part for you. Nothing new enters the protocol: the host hints over the events channel (ids
only) and the content rides the app's own key-value store, exactly the way
`usePersistedState` reads it.

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

**A fetch another app asked for.** The same handshake can arrive without any schedule:
when the user allowed another app to ask yours to fetch new data before reading it (see
"Access Between Apps"), the host wakes your app exactly as above — the kv key, the hint, your
one result. The ONE signal is `input.kind === 'refresh'`; `taskId` is `'access-refresh'` and
names no schedule of the user's; `input.requestedBy` is the asking app's display name, for
your summary if you want it. Fetch and answer as for a schedule — read your data, call your
approved API, answer a summary — under the same unattended posture (a mutating call is
refused, never asked). The host counts the run on the user's daily schedule limits and runs
it at most once every five minutes; the asking app learns only whether your app ran, never
your summary. An app without the hook cannot be asked. The same wake comes when the
user ticked *fetch new data first* on a schedule that asks another app's AI: just before that
question runs, the host asks the apps it may read while the user is away — yours among them —
to fetch new data first, each through this handshake and on the same limits.

## The Schedule Hook

Section 6 of the copy-exactly hooks block (see "The Mandatory HTML Template") answers the
handshake: `useSnugSchedule(onScheduledRun)` hears the run's hint, reads its input under
`scheduleInputKey(runId)`, calls your handler ONCE per `runId` with `{ runId, taskId, input }`
(`input` absent when the step has none), and posts the one result — bounded to the limits
above, extra keys dropped, a throw turned into `ok: false` with its message. Mount it once,
in the component that calls `useSnugApp`, before any early return, and declare
`onScheduledRun` INSIDE that component, so it reads your hooks and the hook always calls
the latest one:

```javascript
function App() {
  const { isReady } = useSnugApp({
    appId: 'morning-forecast',
    displayName: 'Morning Forecast',
    description: 'Fetches the forecast every morning and keeps the last one.',
    iconEmoji: '🌤️',
    iconColor: '#0984e3',
  });
  const db = useAppDB();
  const net = useConnectedFetch();
  const [suggested, setSuggested] = usePersistedState('schedule-suggested', false);

  // YOUR WORK: read your data, call your approved API, keep what you fetched in your own
  // tables — then answer a SUMMARY, never rows. A mutating call is refused while nobody is
  // present: answer ok:false naming what you tried, and the host asks the user to run it visibly.
  const onScheduledRun = useCallback(async ({ runId, taskId, input }) => {
    const res = await net.fetch('https://api.example.com/v1/forecast?days=1');
    if (!res.ok) return { ok: false, summary: 'The forecast API did not answer: ' + res.error.message };
    const today = JSON.parse(res.body);
    await db.exec('INSERT OR REPLACE INTO forecast (day, text) VALUES (?, ?)', [today.day, today.text]);
    return { ok: true, summary: today.text, notify: { title: 'Today', body: today.text } };
  }, [db, net]);
  useSnugSchedule(onScheduledRun); // once, here, before any early return

  // A user act, never on load: true means the suggestion was sent.
  const onSuggestClick = () => {
    if (proposeSchedule({
      title: 'Morning forecast',
      steps: [{ kind: 'app-run', appId: 'morning-forecast', input: { fetch: true } }],
      spec: { kind: 'daily', time: '07:00', tz: 'device' },
    })) setSuggested(true);
  };

  if (!isReady) return <div className="connecting">Connecting…</div>;
  return (
    <main>
      {/* …the app, showing what is stored in `forecast`… */}
      {!suggested && <button onClick={onSuggestClick}>Fetch this every morning</button>}
    </main>
  );
}
```

Write `onScheduledRun` for the app; the hook does the rest. Bundler-built apps on the module
SDK get the same two names — `useSnugSchedule(handler)` and `proposeSchedule(proposal)` —
from `@snugprotocol/sdk`. An app that still carries the older schedule listener: delete it,
`SCHEDULE_HANDLED` included, when you copy section 6 — both would answer.

## Rules for a Scheduled Handler

- **Idempotent by `runId`.** The host may hint the same run again after a crash. The hook
  remembers the runs it answered for this page only, so a repeated hint on the same page
  reaches your handler once; when your work must not repeat across pages (a message sent, a
  row appended), guard it in your own database: check the `runId`, and write it through
  `db.exec` first, before acting — never `usePersistedState`, whose write is a
  fire-and-forget store after a render and may not have landed when the next page asks.
- **One instance — and the same `runId` can reach a different one.** When your app is open,
  a scheduled run executes inside the open page (your UI and the handler share one state —
  update it the normal way); when it is closed, in a hidden frame. If the user opens or closes
  the app mid-run, the host hands the SAME `runId` to a fresh page, whose hook has answered
  nothing yet — so the database guard above is what stops a side effect running twice. Make
  every change one statement (a hidden run's `BEGIN`/`COMMIT` and a whole-database import are
  refused; a handover must never strand half a change).
- **A result is a summary, not data.** The host shows `summary` to a person and never
  reads anything else from it. Keep what you fetched in your own key-value store or
  database, where the app shows it next time it opens.
- **`notify` is a suggestion.** The host decides whether a notification is raised at all
  (the user chose "in Snug" or "with a notification" per schedule), prefixes your app's
  name, caps the text and rate-limits it. Give a good title and body; never depend on it.
- **Say `ok: false`, never throw past the hook.** A failure with a summary that says
  what went wrong ("the forecast API answered 503") is a readable result; the hook turns a
  throw into `ok: false` with the error's message, which the user may not be able to read.
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
  load, no polling the agent. The scheduler is the one timer; the schedule hook is the only
  way an app takes part.

## Suggesting a Schedule

An app may ask the host for a schedule of its own — propose-only. `proposeSchedule` (section
6; the component above shows the call) posts ONE `{{frameType:appEvent}}` frame with
`event: 'schedule-request'` whose `data` is the schedule proposal you pass: a `title`, the
`steps` (which may name only THIS app — `kind: 'app-run'` with your `appId`, the one you pass
to `useSnugApp` — the host maps it to the id it holds the app under — and an optional `input`
the schedule hook hands your handler), and a `spec` — those three keys and no other.

`spec` is one of `{ kind: 'once', at: <ISO instant> }`, `{ kind: 'every', n, unit:
'minutes' | 'hours' | 'days' }`, `{ kind: 'daily', time: 'HH:MM' }`, `{ kind: 'weekly',
days: ['mon', …], time }`, `{ kind: 'monthly', on: { kind: 'day', day } | { kind: 'nth',
nth, weekday } | { kind: 'last' }, time }` or `{ kind: 'custom', cron }`, each with
`tz: 'device'` (or an IANA zone). The host enforces a floor of fifteen minutes between runs
of an app-suggested schedule.

The rules, and they are the whole point:

- **Suggest ONCE, and only after a user act or a first successful fetch** — never on load,
  never on every open. `proposeSchedule` answers a boolean: `true` means the suggestion was
  sent — remember it only then, in your persisted state
  (`usePersistedState('schedule-suggested', false)`), so a reload does not ask again; `false`
  means nothing was sent (the host was not ready, the page already suggested, or the proposal
  was not a `title`, `steps` and `spec`).
- **Never assume.** Nothing runs until the user says so. The host shows your suggestion as
  a small strip in the app's header — *schedule it* / *not now* / *stop suggestions from
  this app* — never a modal. *Not now* is remembered for that exact suggestion; two of
  them mute your app for good, and a Settings switch mutes every app.
- **One per page.** `proposeSchedule` sends only the first suggestion a page makes, and the
  host drops a second request while one is showing.
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
it. An app without the schedule hook is still a complete Snug app; a schedule that names it
records *failed* after 90 s (it announces, so it is never *not supported*).

A schedule that asks your app's AI can also leave changes to your app's data behind:

- *changes it made* — when the user let that schedule make changes on its own, the host
  applies them to your app's own tables after the run and lists them on the result with an
  *undo* for seven days; every other change waits there for the user's OK. Your data can
  change while your app is closed, so show what is stored rather than a copy you kept.
