<!--
layer: knowledge-base
destination: served (whole or as ##-sections via searchKnowledge) by the {{appBuilderToolName}} tool when the host LLM queries persistence, storage, or SQL topics; reachable only when the app-builder capability is enabled
blast-radius: how generated apps store data — errors here produce apps that lose state, teach dead storage APIs, or design unusable schemas
source: rewritten for Snug v0.1 from ancestor KBs (internal/05); db-frame ops from packages/protocol SPEC v0.1
-->

# Persistence and the App Database

## Storage Is Host-Brokered

The app iframe is sandboxed with a null origin: NO browser storage API works there.
`localStorage`, `sessionStorage`, cookies, and IndexedDB are all dead ends — do not write
code that touches them. All persistence flows over `{{frameType:dbRequest}}` /
`{{frameType:dbResponse}}` frames to storage the HOST keeps for the app. The two hooks in
the template wrap this completely; app code never builds db frames by hand.

Two tiers:

- **Key-value** (`kvGet`/`kvSet` ops) — for UI and session state. Use `usePersistedState`.
- **SQL database** (`exec`/`export`/`import` ops) — a per-app database for structured,
  growing data. Use `useAppDB`.

Check `capabilities.db` from the ready signal if the app can degrade gracefully without
persistence; most hosts provide it.

## usePersistedState — Key-Value State

```javascript
const [gameState, setGameState] = usePersistedState('my-app-state', {
  board: createInitialBoard(),
  moveHistory: [],
  captured: { player: [], ai: [] },
  score: 0,
});
```

Behavior you get for free (from the copy-exactly hook):

- Hydration after the host is ready: stored value fetched via `kvGet`, then MERGED over
  your defaults — fields added in newer versions of the app are never `undefined`.
- Every state change is written back via `kvSet` (fire-and-forget).
- Before hydration completes, `state` equals your initial value — the app renders
  immediately and updates when storage arrives. Design the initial value to render cleanly.

Rules:

- The initial value must be COMPLETE (every field present) and JSON-serializable.
- One key per logical document; use a stable, app-specific key like `'chess-state'`.
- Keep it small — this state also rides inside every `sendMessage` request, and frames cap
  at 256 KiB. Big or growing data belongs in the SQL tier.

## useAppDB — SQL Tier

```javascript
const db = useAppDB();

// Once, on first run (CREATE TABLE IF NOT EXISTS makes this idempotent):
await db.exec(`CREATE TABLE IF NOT EXISTS workouts (
  id INTEGER PRIMARY KEY,
  done_at TEXT NOT NULL,
  exercise TEXT NOT NULL,
  reps INTEGER NOT NULL DEFAULT 0,
  weight_kg REAL
)`);

// Writes with bound params (ALWAYS bind — never interpolate values into SQL):
await db.exec('INSERT INTO workouts (done_at, exercise, reps, weight_kg) VALUES (?, ?, ?, ?)',
  [new Date().toISOString(), 'squat', 8, 80]);

// Reads:
const { rows } = await db.exec(
  'SELECT exercise, SUM(reps) AS total FROM workouts GROUP BY exercise ORDER BY total DESC');
```

- `exec(sql, params?)` resolves `{rows, rowsAffected}`; it THROWS on failure (unlike
  `sendMessage`), so wrap calls in try/catch and render the failure.
- `exportDb()` resolves a base64 string of the whole database — offer it as a backup
  download. `importDb(bytesBase64)` restores one.

## Schema Design Guidance

- Run all `CREATE TABLE IF NOT EXISTS` statements once at startup, before any query.
- Prefer a few narrow tables with real columns over one JSON-blob column — real columns are
  what make the agent-SQL pattern below work.
- Timestamps as ISO-8601 TEXT; ids as `INTEGER PRIMARY KEY`; booleans as 0/1.
- Store raw facts, compute aggregates in queries — do not persist derived totals.

## Pattern: Ask the Agent to Write SQL Against Your Schema

For data tools (trackers, analyzers, dashboards), the strongest pattern is to let the agent
write the query. Send your schema and the user's question; get SQL back; run it locally:

```javascript
const result = await sendMessage('analyze', { question: userQuestion }, {
  state: { schema: SCHEMA_DDL },   // the exact CREATE TABLE statements
  responseSchema: {
    sql: 'string: ONE SELECT statement answering the question against the schema provided',
    message: 'string: how to read the result',
  },
});
if (result.ok) {
  try {
    const { rows } = await db.exec(result.data.sql);
    renderResults(rows, result.data.message);
  } catch (e) {
    renderError('That query failed: ' + e.message); // agent SQL is untrusted input — guard it
  }
}
```

Constrain the schema to a single SELECT, always try/catch the exec, and show the agent's
`message` alongside the rows. This gives users free-form natural-language queries over
their own data with zero query UI.
