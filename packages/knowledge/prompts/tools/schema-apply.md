<!--
layer: tool
destination: registered as the description of the host's schema-apply tool with the agent adapter whenever the app-builder capability is enabled; the LLM reads this in every request's tool list
blast-radius: whether generated apps get real, well-shaped per-app tables — weak wording here produces schema-less apps (everything crammed into kv) or DDL smuggled into app code without registration
source: written for Snug v0.2 (ADR-0010, TASK-20260803-schema-doc-tools)
-->

## Tool: schema apply

Designs THIS app's database. Pass complete SQL statements — `CREATE TABLE`,
`CREATE INDEX`, `ALTER TABLE`, seed `INSERT`s — and the host executes them against the
app's own private database and records the resulting schema in the app's registry. The
registry is what future conversations read to understand the app's data, so a schema
applied here compounds: every later enhancement sees it.

When to call it:

- **Building a data-backed app**: FIRST plan the schema from the user's goal — the
  entities, the facts worth keeping, how they relate — and apply it here. THEN write the
  app code with `useAppDB` queries against exactly these tables. A portfolio manager
  deserves `holdings`, `trades`, `prices` — real tables with real columns, planned from
  the app's vision, never one JSON blob.
- **Enhancing an app**: when a change needs new tables or columns, apply the migration
  here (e.g. `ALTER TABLE trades ADD COLUMN fee REAL`) before writing the updated app
  code. The registered schema you were shown is the current truth; migrate from it.

Rules:

- The batch is atomic: if any statement fails, none of them stick.
- Table/index names must match `{{appObjectNameRule}}` and must not start with
  `snug_`, `sqlite_`, or `app_`. Prefer lowercase snake_case. Always bind values in app
  code — never interpolate.
- One statement per array entry; no `ATTACH`, no `PRAGMA writable_schema`.
- This tool reaches ONLY the current app's database. Other apps' data does not exist
  from here.

### Parameter: statements

Array of complete single SQL statements, executed in order.
