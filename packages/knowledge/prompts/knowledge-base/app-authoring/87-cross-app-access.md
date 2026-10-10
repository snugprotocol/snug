<!--
layer: knowledge-base
destination: served (whole or as ##-sections via searchKnowledge) by the {{appBuilderToolName}} tool when the host LLM is asked for an app that reads ANOTHER app's data — a budget that reads the ledger's transactions, a meal planner that reads the pantry, two apps the user built that should work together; NOT in the inline core (a tool-free brain gets only the one row in 30's frame table); reachable only when the app-builder capability is enabled
blast-radius: whether a generated app can read another app's tables at all — a wrong frame shape here produces apps whose asks the runner answers MALFORMED or never answers, an ask on load produces apps that nag on every open, and an app that assumes its access is permanent breaks the day the user stops it
source: written for TASK-20261010-cross-app-access (ADR-0075 §1 the frame pair, §4 the strip and its answers, §5 what the app learns, §6 the scoped read and its bounds, §9 revocation; spec 1.1 Part VI); the helper mirrors packages/sdk/src/access.ts, the module-form hook
-->

# Access Between Apps

## Read Another App's Data Only With the User's Say

Every Snug app's data is its own. An app can read ANOTHER app's tables — a budget reading
the ledger's transactions, a meal planner reading the pantry — only under an access the
USER allows, on a host surface your app cannot draw over or imitate. Access is read-only,
per table (with the columns the user saw), for as long as the user chose, and the user can
stop it at any moment. The app being read keeps a history of every read, and the user can
see it.

Your app never names the other app and never sees the user's list of apps. It states a
purpose; the host ranks the user's apps and shows the user the candidates; the user picks
the app, the tables and how long. Your app learns only what the user allowed.

Build the app so it is complete without it: reading another app is something the user adds,
never a feature the app depends on. On a host that does not offer it (`capabilities.access`
is not `true` in `{{frameType:hostReady}}`), show what the app does on its own.

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
- Before asking, `list` what you already hold — a second visit may already have access.

What the user sees: a strip above your app — "Budget wants to read another app's data ·
Budget says: “to show spending by category”" with *review* · *not now* · *stop asking* —
never a modal. *Review* opens the host's own sheet, where the user picks the app, the
tables and how long: *while it's open* (the default — it ends when your app closes), *for a
day*, *for a week* or *until I stop it*, plus an opt-in *also while I'm away* for scheduled
runs. The sheet also tells the user where your app can send what it reads — its AI, its
connections, any link it asks the user to open. Your `request` waits until the user acts,
and one of three answers comes back:

- the user allowed it → `ok: true` with what was allowed (see "What Your App Learns");
- *not now* → `ACCESS_DECLINED` with `retryable: true` — you may ask again, after another
  user act;
- *don't allow* → `ACCESS_DECLINED` with `retryable: false` — THIS ask (its hints) stays declined.
  Never repeat it; carry on without the other app's data.
- *stop asking* → the same answer for EVERY later ask from your app, whatever its hints or
  purpose, until the user turns asks back on in Settings — stop asking altogether and carry on
  without the other app's data.

## The Two Frames and Their Four Ops

Two frames, beside the db and net pairs: your app posts `{{frameType:accessRequest}}` and
the host answers each `requestId` with exactly ONE `{{frameType:accessResponse}}`. The
request's `op` is one of four:

| `op` | Fields you send | What comes back with `ok: true` |
|---|---|---|
| `request` | `purpose`, `hints?` (`words`, `tables`), `renew?` (an id you held, when asking again) | `grant` — what the user allowed |
| `query` | `grantId`, `sql` (one SELECT, at most 4,096 characters), `params?` (at most 64 scalars) | `columns`, `rows`, `truncated?`, `totalRows?` |
| `list` | nothing more | `grants` — every access this app holds now |
| `release` | `grantId` | nothing more — that access has ended |

The request is STRICT: an unknown field is refused as malformed, so send exactly these.
Like every frame it carries `v` and the `instanceId`, which `SnugBridge.post` adds — so it
can only be sent after `{{frameType:hostReady}}`. The answer's fields sit at the TOP LEVEL
of the frame, beside `ok` and `op`. A failure is `{ ok: false, error: { code, message,
retryable } }` — errors are data, never exceptions.

## What Your App Learns

The answer to `request`, and each entry of `list`, is one view:

```text
{ id, access: 'read', source: { displayName, iconEmoji?, iconColor? },
  tables: [{ name, columns: [...] }], duration: 'session' | 'day' | 'week' | 'always',
  expiresAt?, unattended }
```

That is all your app learns: the other app's display name and icon, the tables with their
columns, how long (`expiresAt` for a day or a week), and whether scheduled runs may read
too (`unattended`). Never the user's other apps, never an app id, never a count of what
else exists. Keep `id` — every `query` names it. `access` is `'read'` today; skip a view
whose `access` you do not know. Columns whose names look like credentials (`api_key`,
`password`, `secret`, …) are never part of it.

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
- At most 60 queries a minute, and one `request` per 10 s.
- A value under a credential-named column, or one that looks like a credential, arrives as
  `***`.
- Every read is recorded in the other app's history — the statement, how many rows, when,
  and whether the user was there — and the user can see it. Read what you need.

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

Prefer reading again over copying the other app's rows into your own storage: when the user
stops the access, a copy would outlive it.

## What Each Refusal Means

| Code | When | What your app does |
|---|---|---|
| `ACCESS_INVALID_REQUEST` | The host could not use the ask as sent | Fix the frame; do not resend it unchanged |
| `ACCESS_NOT_GRANTED` | The id is not an access this app holds (or not while it runs unseen) | `list`, and ask after a user act |
| `ACCESS_DECLINED` | *not now* (`retryable: true`), or *don't allow* / *stop asking* (`false`) | Carry on without it; ask again only when retryable, after a new user act |
| `ACCESS_PENDING` | An ask is already waiting for the user | Wait for that answer |
| `ACCESS_UNATTENDED` | Asked while nobody is looking (a scheduled run) | Ask the next time the user is present |
| `ACCESS_NO_SOURCES` | No other app holds data the user could allow | Say so plainly; nothing was recorded |
| `ACCESS_REVOKED` | The user stopped it, or it was paused | `list`; offer to ask again |
| `ACCESS_EXPIRED` | Its time ran out | Offer to ask again (`renew` with the old id) |
| `ACCESS_QUERY_REFUSED` | Not one read-only SELECT | Rewrite the statement |
| `ACCESS_QUERY_FAILED` | A SQL error, an absent table, too long, or the other app is too large to read this way | Show the message; narrow the query |
| `ACCESS_RATE_LIMITED` | Too many asks or reads | Back off, then retry |
| `ACCESS_SIZE_EXCEEDED` | The answer could not fit in one frame | Select fewer columns or rows |

Codes are open strings: treat an unknown one as `HOST_ERROR` and honor `retryable`. Before
`{{frameType:hostReady}}` every call answers `HOST_ERROR` with `retryable: true`; on a host
without `capabilities.access` every call answers `HOST_ERROR` with `retryable: false` —
show the app without the other app's data.

## The Cross-App Helper (copy beside the hooks block)

Add this AFTER the copy-exactly hook sections (it belongs in "your" zone of the template,
beside the response schema — never inside sections 1–5, which must stay byte-identical). It
is a second `message` listener next to the bridge's own, filtered to the access answer and
the `access-changed` event, and it posts through the bridge's `SnugBridge.post` rather than
plumbing of its own:

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

window.addEventListener('message', (event) => {
  const data = event.data;
  if (event.source !== window.parent || !data || data.v !== {{protocolVersion}}) return;
  if (data.type === '{{frameType:accessResponse}}') {
    const resolve = SNUG_ACCESS_PENDING.get(data.requestId);
    if (!resolve) return; // not ours, or already answered
    SNUG_ACCESS_PENDING.delete(data.requestId);
    // The answer's fields (grant / columns, rows, truncated, totalRows / grants) are at the TOP LEVEL.
    resolve(data.ok ? data : { ok: false, error: data.error });
    return;
  }
  if (data.type === '{{frameType:hostEvent}}' && data.event === 'access-changed') {
    const change = data.data;
    if (change && typeof change.grantId === 'string' && change.grantId) onAccessChanged(change.grantId);
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

Write `onAccessChanged` for the app; leave the helper and the listener as they are.
Bundler-built apps on the module SDK get the same exchange typed as `useSnugAccess()` from
`@snugprotocol/sdk`: `request(purpose, { hints, renew })`, `query(grantId, sql, params)`,
`list()`, `release(grantId)` and `onChange(listener)`.

## Rules for Reading Another App

- **Ask after a user act, never on load.** One ask per user act; a declined ask is not
  repeated, and after *stop asking* the app asks no more.
- **One plain purpose.** The user decides on your one line — make it true and specific.
- **Assume nothing lasts.** `ACCESS_REVOKED` and `ACCESS_EXPIRED` are ordinary outcomes;
  on `access-changed`, re-`list` and show what is still readable.
- **Name where the data came from.** Show `source.displayName` beside what you read from it,
  so the user always knows whose data is on screen.
- **Read, never write.** Your app cannot change another app's data, cannot see the user's
  other apps, and cannot read another app's key-value store — only the tables the user
  allowed, through `query`.
- **Keep it complete without access.** Every feature that reads another app has a path
  that works when the answer is no.
