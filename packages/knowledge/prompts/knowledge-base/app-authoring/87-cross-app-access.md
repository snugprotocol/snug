<!--
layer: knowledge-base
destination: served (whole or as ##-sections via searchKnowledge) by the {{appBuilderToolName}} tool when the host LLM is asked for an app that reads ANOTHER app's data — a budget that reads the ledger's transactions, a meal planner that reads the pantry, two apps the user built that should work together — or that changes it where the user ticked that; NOT in the inline core (a tool-free brain gets only the one row in 30's frame table); reachable only when the app-builder capability is enabled
blast-radius: whether a generated app can read — or change — another app's tables at all; a wrong frame shape here produces apps whose asks the runner answers MALFORMED or never answers, an ask on load produces apps that nag on every open, an app that assumes its access is permanent breaks the day the user stops it, and a write shaped outside the one plain statement the runner brokers is refused every time
source: written for TASK-20261010-cross-app-access (ADR-0075 §1 the frame pair, §4 the strip and its answers, §5 what the app learns, §6 the scoped read and its bounds, §9 revocation; spec 1.1 Part VI); v2 for TASK-20261010-host-broker PR-3 (ADR-0076 §4–§8 the brokered write, the undo journal, the refresh, the discover class and the three hints; spec 1.2 §24.5–§24.7); the helper mirrors packages/sdk/src/access.ts, the module-form hook
-->

# Access Between Apps

## Read Another App's Data Only With the User's Say

Every Snug app's data is its own. An app can read ANOTHER app's tables — a budget reading
the ledger's transactions, a meal planner reading the pantry — only under an access the
USER allows, on a host surface your app cannot draw over or imitate. Access is read — and,
when the user ticks it, change — per table (with the columns the user chose), for as long as
the user chose, and the user can stop it at any moment. The app being read keeps a history
of every read and every change, the user can see it, and the user can undo any change your
app made from there.

Your app never names the other app and never sees the user's list of apps. It states a
purpose; the host ranks the user's apps and shows the user the candidates; the user picks
the app, the tables, the columns and how long — and, only when your app asked to change
tables too, ticks which tables it may change. Your app learns only what the user allowed.

Build the app so it is complete without it: reading another app is something the user adds,
never a feature the app depends on. When the user wants your app to read another app's data,
use the helper below. On a host that does not offer it (`capabilities.access` is not `true` in
`{{frameType:hostReady}}`), show what the app does on its own.

## Ask After a User Act, Never on Load

- Ask ONLY when the user has just done something that needs the other app's data — pressed
  "use my ledger", opened the spending view. Never on load, never on every open, never on a
  timer. A hidden scheduled run that asks is answered `ACCESS_UNATTENDED`.
- Say why in ONE plain line, the `purpose`: at most 200 characters, one line, no control or
  invisible characters — "to show spending by category". The host shows it quoted under
  "Budget says:". Say what you will do with the data; never speak as Snug or as the host.
- Optional `hints` help the host rank the user's apps: up to 16 `words` (each at most 32
  characters) and up to 16 `tables` — the table names you expect, like `transactions`.
  Hints are never shown to another app.
- To ask for leave to CHANGE tables too, send `access: 'write'` with the ask. The sheet then
  offers a *can change* tick per table, and the view you get back says `write: true` on each
  table the user ticked. A read-only answer to a write ask is the user's no for writes — do
  not ask again until a new user act. Ask for it only when the app will change rows; a read
  ask is the default and asks for nothing more.
- Before asking, `list` what you already hold — a second visit may already have access.
  `discover` tells you whether the user has anything the hints match at all (a class — `none`,
  `one` or `several` — never a name or a count), so a "use my ledger" button can be shown
  only when there is something to use; it asks the user nothing and records nothing.

What the user sees: a strip above your app — "Budget wants to read another app's data ·
Budget says: “to show spending by category”" (or "wants to read — and change —" when the
ask carried `access: 'write'`) with *review* · *not now* · *stop asking* — never a modal.
*Review* opens the host's own sheet, where the user picks the app, the tables (and, behind
*choose columns…*, the columns) and how long: *while it's open* (the default — it ends
when your app closes), *for a day*, *for a week* or *until I stop it*, plus an opt-in *also
while I'm away* for scheduled runs; under *more options…* the per-table *can change* tick,
the other app's *settings & notes*, and *may ask <the other app> to fetch new data before
reading it*. The sheet also tells the user where your app can send what it reads — its AI,
its connections, any link it asks the user to open. Your `request` waits until the user
acts, and one of three answers comes back:

- the user allowed it → `ok: true` with what was allowed (see "What Your App Learns");
- *not now* → `ACCESS_DECLINED` with `retryable: true` — you may ask again, after another
  user act;
- *don't allow* → `ACCESS_DECLINED` with `retryable: false` — THIS ask (its hints) stays declined.
  Never repeat it; carry on without the other app's data.
- *stop asking* → the same answer for EVERY later ask from your app, whatever its hints or
  purpose, until the user turns asks back on in Settings — stop asking altogether and carry on
  without the other app's data.

## The Two Frames and Their Seven Ops

Two frames, beside the db and net pairs: your app posts `{{frameType:accessRequest}}` and
the host answers each `requestId` with exactly ONE `{{frameType:accessResponse}}`. The
request's `op` is one of seven:

| `op` | Fields you send | What comes back with `ok: true` |
|---|---|---|
| `request` | `purpose`, `hints?` (`words`, `tables`), `renew?` (an id you held, when asking again), `access?` (`'write'` to ask for leave to change tables too) | `grant` — what the user allowed |
| `query` | `grantId`, `sql` (one SELECT, at most 4,096 characters), `params?` (at most 64 scalars) | `columns`, `rows`, `truncated?`, `totalRows?` |
| `write` | `grantId`, `sql` (ONE plain INSERT, UPDATE or DELETE, at most 4,096 characters), `params?` (at most 64 scalars) | `changes` — how many rows it touched |
| `refresh` | `grantId` | `fresh` — whether the other app fetched; `reason?` (`recent` when it fetched within the last five minutes) |
| `list` | nothing more | `grants` — every access this app holds now |
| `release` | `grantId` | nothing more — that access has ended |
| `discover` | `hints?` (`words`, `tables`) | `candidates` — `none`, `one` or `several` |

The request is STRICT: an unknown field is refused as malformed, so send exactly these.
Like every frame it carries `v` and the `instanceId`, which `SnugBridge.post` adds — so it
can only be sent after `{{frameType:hostReady}}`. The answer's fields sit at the TOP LEVEL
of the frame, beside `ok` and `op`. A failure is `{ ok: false, error: { code, message,
retryable } }` — errors are data, never exceptions.

## What Your App Learns

The answer to `request`, and each entry of `list`, is one view:

```text
{ id, access: 'read' | 'write', source: { displayName, iconEmoji?, iconColor? },
  tables: [{ name, columns: [...], write?: true }], kv?: true, refresh?: true,
  duration: 'session' | 'day' | 'week' | 'always', expiresAt?, unattended }
```

That is all your app learns: the other app's display name and icon, the tables with their
columns, how long (`expiresAt` for a day or a week), and whether scheduled runs may read
too (`unattended`). Never the user's other apps, never an app id, never a count of what
else exists. Keep `id` — every `query`, `write` and `refresh` names it. `access` is
`'write'` when at least one table carries `write: true` — the user ticked *can change* for
that table — and `'read'` otherwise; skip a view whose `access` you do not know. A key the
view does not carry means no: a table without `write: true` is read-only, a view without
`kv: true` does not include the other app's settings & notes, a view without
`refresh: true` cannot ask it to fetch. `kv: true` adds the other app's `snug_kv` table
(`key`, `value` — JSON text) to what you may `query`, with its connections and keys and
anything that looks like one left out. Columns whose names look like credentials
(`api_key`, `password`, `secret`, …) are never part of it, and a column the user left
unticked is not there either.

## Query: One Read-Only SELECT

- ONE statement, a `SELECT` (or `WITH … SELECT`) over the tables you were allowed, by the
  names in the view. Anything else — a write, a `PRAGMA`, `ATTACH`, two statements — is
  refused with `ACCESS_QUERY_REFUSED` before it runs.
- Bind values through `params` with `?` placeholders — strings, numbers, booleans, `null`.
  Never splice user text into the SQL.
- The read runs on a copy that holds ONLY the allowed tables: a table you were not allowed
  is not there at all ("no such table" — `ACCESS_QUERY_FAILED`).
- At most 500 rows and 192 KiB (measured in UTF-8 bytes) come back; past either the answer
  is cut and carries `truncated: true` and `totalRows`. Let SQL do the work — `GROUP BY`,
  `SUM`, `WHERE`, `LIMIT` — rather than pulling every row.
- A read has 2 s. A longer one is stopped (`ACCESS_QUERY_FAILED`, "took too long"), and
  three in a row pause the access until the user allows it again.
- At most 60 queries a minute, and one `request` per 10 s. A `write` counts in the same
  minute as a read.
- A value under a credential-named column, or one that looks like a credential, arrives as
  `***`.
- Every read is recorded in the other app's history — the statement, how many rows, when,
  and whether the user was there — and the user can see it. Read what you need.

**Write — only on a table whose view says `write: true`.** `write` takes ONE plain
statement: `INSERT INTO t (c1, c2) VALUES (…)`, `UPDATE t SET c = … WHERE …` or
`DELETE FROM t WHERE …`, with literal values or `?` placeholders bound through `params`,
over the columns in the view, and a WHERE of simple comparisons (`=`, `<>`, `<`, `>`,
`LIKE`, `IN (…)`, `IS NULL`, joined by `AND`/`OR`). No function, no subquery, no `WITH`, no
`RETURNING`, no `ON CONFLICT`, no `OR REPLACE`, no column the view does not list, and never
an UPDATE or DELETE without a WHERE. The host dry-runs it on the copy, refuses past 200
rows, then applies it atomically on the other app — and answers `changes`, the row count,
and nothing more. Every change is recorded in the other app's history with the statement,
and the user can undo it from there for seven days; your app never sees an undo id and
never needs one. A refusal is `ACCESS_WRITE_REFUSED` with a message that says which rule
("too many rows — at most 200 at a time", "a column it names isn't shared", …) — fix the
statement, never resend it unchanged; `ACCESS_BUSY` means the other app was in the middle
of a change — try again; `ACCESS_UNATTENDED` means nobody is present — a write needs a
person at the screen, always. Prefer small, specific changes the user can read in a history
line.

**Refresh — only when the view says `refresh: true`.** `refresh` asks the other app to fetch
new data through its own connections before you read — the host runs that app's scheduled
handler with `input.kind === 'refresh'`, at most once every five minutes, counted on the
user's daily schedule limits, under the same presence rule as a read (an access the user
ticked *also while I'm away* may ask it from a scheduled run; a write, unlike a refresh,
always needs a person present). It answers `fresh: true` when the other app ran, or
`fresh: false` with `reason: 'recent'` when it fetched within the last five minutes (read
what is there). `ACCESS_REFRESH_FAILED` means it could not run — the other app has no such
handler, schedules are off, the day's limit is reached, or it failed; read what is there and
say so. Call it from a user act ("fetch the latest"), never on load.

## When It Stops, Pauses or Ends

The user can stop access at any moment — from the other app's sheet, from yours, or from
Settings. It also pauses on its own when your app is updated from a share link or by the
agent, when the other app's tables change, and it ends when its time runs out. The next
`query` answers `ACCESS_REVOKED` or `ACCESS_EXPIRED`. When it is stopped or paused while your
app is open, the host posts `{{frameType:hostEvent}}` with `event: 'access-changed'` and
`data: { grantId }` — ids only, never content. An expiry is not announced: you learn it from
the next `query` (`ACCESS_EXPIRED`) or a re-`list`. Then re-`list`, show the user what the
app can still read, and offer a button to ask again; never ask again by itself. To give
access back yourself, `release` it.

Three more hints, each ids only, each only while your app is open: `event:
'access-source-changed'` with `data: { grantId }` when the other app's data changed under
an access you hold (its own writes, the chat's, another app's — read again when your app
shows it); `event: 'data-changed'` with `data: { table }` when another app, or the chat,
changed one of YOUR app's tables under an access the user allowed, or the user undid such
a change — re-read that table; and `event: 'access-read'` with `data: { grantId }` when one
of your tables was read under an access your app is the source of — the id only; most apps
do nothing with it. None of them carries a row, a value, a name or a count.

Prefer reading again over copying the other app's rows into your own storage: when the user
stops the access, a copy would outlive it.

## What Each Refusal Means

| Code | When | What your app does |
|---|---|---|
| `ACCESS_INVALID_REQUEST` | The host could not use the ask as sent | Fix the frame; do not resend it unchanged |
| `ACCESS_NOT_GRANTED` | The id is not an access this app holds (or not while it runs unseen); or the table is read-only, or the access does not allow asking for new data | `list`, and ask after a user act |
| `ACCESS_DECLINED` | *not now* (`retryable: true`), or *don't allow* / *stop asking* (`false`) | Carry on without it; ask again only when retryable, after a new user act |
| `ACCESS_PENDING` | An ask is already waiting for the user | Wait for that answer |
| `ACCESS_UNATTENDED` | Asked, or asked to write, while nobody is looking (a scheduled run) | Ask the next time the user is present |
| `ACCESS_NO_SOURCES` | No other app holds data the user could allow | Say so plainly; nothing was recorded |
| `ACCESS_REVOKED` | The user stopped it, or it was paused | `list`; offer to ask again |
| `ACCESS_EXPIRED` | Its time ran out | Offer to ask again (`renew` with the old id) |
| `ACCESS_QUERY_REFUSED` | Not one read-only SELECT | Rewrite the statement |
| `ACCESS_QUERY_FAILED` | A SQL error, an absent table, too long, or the other app is too large to read this way | Show the message; narrow the query |
| `ACCESS_RATE_LIMITED` | Too many asks, reads or writes | Back off, then retry |
| `ACCESS_SIZE_EXCEEDED` | The answer could not fit in one frame | Select fewer columns or rows |
| `ACCESS_WRITE_REFUSED` | Not one plain INSERT/UPDATE/DELETE with literal values, a column that is not shared, too many rows, or a change that could not be undone | Fix the statement; do not resend it unchanged |
| `ACCESS_BUSY` | The other app is in the middle of a change (`retryable: true`) | Try again in a moment |
| `ACCESS_REFRESH_FAILED` | The other app could not fetch: no handler, schedules off, the day's limit, or it failed | Read what is there; say so |

Codes are open strings: treat an unknown one as `HOST_ERROR` and honor `retryable`. Before
`{{frameType:hostReady}}` every call answers `HOST_ERROR` with `retryable: true`; on a host
without `capabilities.access` every call answers `HOST_ERROR` with `retryable: false` —
show the app without the other app's data. A `MALFORMED` answer to `write`, `refresh` or
`discover`, or to an ask that carried `access`, means the runner predates 1.2 — show the
honest fallback, and ask again without `access`.

## The Cross-App Helper (copy beside the hooks block)

Add this AFTER the copy-exactly hook sections (it belongs in "your" zone of the template,
beside the response schema — never inside sections 1–5, which must stay byte-identical). It
is a second `message` listener next to the bridge's own, filtered to the access answer and
the four access hints (`access-changed`, and the three the runner rings about data moving),
and it posts through the bridge's `SnugBridge.post` rather than plumbing of its own:

```javascript
// ============================================================
// ACCESS BETWEEN APPS — read another app's data; see "Access Between Apps"
// ============================================================
const SNUG_ACCESS_PENDING = new Map(); // requestId -> resolve

function snugAccessRequest(op, fields) {
  if (!SnugBridge.ready) return Promise.resolve({ ok: false, error: { code: 'HOST_ERROR', message: 'not connected to host yet', retryable: true } });
  if (SnugBridge.capabilities.access !== true) return Promise.resolve({ ok: false, error: { code: 'HOST_ERROR', message: 'this host does not offer access between apps', retryable: false } });
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    SNUG_ACCESS_PENDING.set(requestId, resolve);
    SnugBridge.post({ type: '{{frameType:accessRequest}}', requestId, op, ...fields });
  });
}

function onAccessChanged(grantId) {
  // YOUR WORK: an access was stopped or paused. Ask what the app still holds —
  // snugAccessRequest('list') — and show it. Never ask for access again from here.
}

function onAccessSourceChanged(grantId) {
  // YOUR WORK: the other app's data changed under this access. Read it again where the
  // app shows it — snugAccessRequest('query', …) — never ask for access from here.
}

function onDataChanged(table) {
  // YOUR WORK: another app, or the chat, changed this table of YOUR app under an access
  // the user allowed (or the user undid such a change). Re-read it where the app shows it.
}

function onAccessRead(grantId) {
  // YOUR WORK (optional): one of this app's tables was read under an access this app is
  // the source of. The id only — the runner's history has the rest. Most apps do nothing.
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (event.source !== window.parent || !data || data.v !== {{protocolVersion}}) return;
  if (data.type === '{{frameType:accessResponse}}') {
    const resolve = SNUG_ACCESS_PENDING.get(data.requestId);
    if (!resolve) return; // not ours, or already answered
    SNUG_ACCESS_PENDING.delete(data.requestId);
    // The answer's fields (grant / columns, rows, truncated, totalRows / changes / fresh, reason / grants / candidates) are at the TOP LEVEL.
    resolve(data.ok ? data : { ok: false, error: data.error });
    return;
  }
  if (data.type === '{{frameType:hostEvent}}' && data.event === 'access-changed') {
    const change = data.data;
    if (change && typeof change.grantId === 'string' && change.grantId) onAccessChanged(change.grantId);
  }
  if (data.type === '{{frameType:hostEvent}}' && data.event === 'access-source-changed') {
    const change = data.data;
    if (change && typeof change.grantId === 'string' && change.grantId) onAccessSourceChanged(change.grantId);
  }
  if (data.type === '{{frameType:hostEvent}}' && data.event === 'data-changed') {
    const change = data.data;
    if (change && typeof change.table === 'string' && change.table) onDataChanged(change.table);
  }
  if (data.type === '{{frameType:hostEvent}}' && data.event === 'access-read') {
    const change = data.data;
    if (change && typeof change.grantId === 'string' && change.grantId) onAccessRead(change.grantId);
  }
});
```

Then ask from something the user pressed — never from a `useEffect` on mount:

```javascript
async function onUseLedgerClick() {
  const asked = await snugAccessRequest('request', {
    purpose: 'to show spending by category',
    hints: { words: ['spending', 'transactions'], tables: ['transactions'] },
  });
  if (!asked.ok) return setNotice(asked.error.message); // declined, nothing to read, … — carry on without it
  const access = asked.grant; // { id, source: { displayName }, tables: [{ name, columns }], duration }
  const read = await snugAccessRequest('query', {
    grantId: access.id,
    sql: 'SELECT category, SUM(amount) AS total FROM transactions WHERE date >= ? GROUP BY category',
    params: ['2026-10-01'],
  });
  if (read.ok) setTotals({ from: access.source.displayName, columns: read.columns, rows: read.rows });
  else setNotice(read.error.message);
}
```

A change, when the user ticked *can change* for the table, is the same call with
`'write'`: `snugAccessRequest('write', { grantId: access.id, sql: 'UPDATE transactions SET
category = ? WHERE id = ?', params: ['food', 7] })` answers `{ ok: true, changes: 1 }`; a
fetch first, when the view says `refresh: true`, is `snugAccessRequest('refresh', { grantId:
access.id })` — both from a button, never on load.

Write `onAccessChanged`, `onAccessSourceChanged` and `onDataChanged` for the app (leave
`onAccessRead` empty unless the app shows who read it); leave the helper and the listener
as they are. Bundler-built apps on the module SDK get the same exchange typed as
`useSnugAccess()` from `@snugprotocol/sdk`: `request(purpose, { hints, renew, access })`,
`query(grantId, sql, params)`, `write(grantId, sql, params)`, `refresh(grantId)`, `list()`,
`release(grantId)`, `discover(hints)`, `onChange(listener)`, `onSourceChanged(listener)`,
`onDataChanged(listener)` and `onRead(listener)`.

## Your App Need Not Read Another App Itself

The runner's own AI beside your app — the chat the user opens next to it — can read what
the user allowed your app to read, once the user allows it (ADR-0076 §1–§3). On a question
about the other app's data, the host copies the allowed tables into the chat's throwaway
working copy as `<source>__<table>` tables (`ledger__transactions`; the other app's settings
& notes as `<source>__snug_kv` when the user allowed them), lists them under *From <Source>
(read-only …)*, and the chat's AI queries them with `data_query` — joins across your app's
tables and theirs included. The chat's AI can also ASK for access on your app's behalf: the
host shows its ask as a card in the chat, and *review* opens the same consent sheet an
app's ask opens. A scheduled *ask <app>'s AI* question sees the same tables when the user
ticked *also while I'm away*. The chat does not change the other app's tables — a change
is your app's own `write`, under the user's tick.

None of this needs code in your app, and none of it reaches your app's frame: the rows go to
the user's own AI, never to your `query`. Build for what your app does on its own; when the
user wants your app itself to show the other app's data, use the helper below. The other
app's history shows every such read as YOUR app's read — the app the user allowed — with
the tables and the rows copied.

## Rules for Reading Another App

- **Ask after a user act, never on load.** One ask per user act; a declined ask is not
  repeated, and after *stop asking* the app asks no more.
- **One plain purpose.** The user decides on your one line — make it true and specific.
- **Assume nothing lasts.** `ACCESS_REVOKED` and `ACCESS_EXPIRED` are ordinary outcomes;
  on `access-changed`, re-`list` and show what is still readable.
- **Name where the data came from.** Show `source.displayName` beside what you read from it,
  so the user always knows whose data is on screen.
- **Write only what the user allowed.** A table is writable only when its view says
  `write: true`; one plain INSERT/UPDATE/DELETE with literal values, at most 200 rows at a
  time, every change undoable by the user from the other app's access — so make each change
  one the user could read and undo as a line in a history. A read-only answer to a write ask
  is the user's no for writes.
- **Only what the user allowed, through the frames.** Your app cannot see the user's other
  apps and reads only the tables (and, when ticked, the settings & notes) the user allowed,
  through `query`; it changes nothing the user did not tick.
- **Keep it complete without access.** Every feature that reads another app has a path
  that works when the answer is no.
- **The chat beside your app may already have it.** A user who allowed access can ask the
  chat next to your app about the other app's data with no code of yours; your app's own
  `query` is for what your app shows on screen.
