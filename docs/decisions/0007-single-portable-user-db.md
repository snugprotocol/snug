# 0007 — Single portable per-user SQLite DB with per-app namespaces and app versioning

- **Status:** proposed (pending Gate 2 plan approval)
- **Date:** 2026-08-03
- **Task:** TASK-20260803-portable-hub

## Context
v1 ships a per-app DB (sql.js + OPFS, `.sqlite` export) — ADR-0003 called it the hard differentiator. The next evolution makes the **user** the unit of portability across three actors (LLM provider, hub provider, end user): a user must be able to take *everything* — app code, app data, chat threads, settings, profile — to any hub provider, any LLM provider, or fully offline, as one file.

## Decision
One physical SQLite file per user is the canonical artifact. Inside it:
- **Hub-namespace tables** (`snug_*`): apps, app_versions (≥5 retained per app, revert supported), chat threads/messages, settings (incl. provider/model choice and BYOK keys), profile, sync metadata.
- **Per-app data namespaces**: each app's tables live under a driver-enforced namespace (prefix); the SDK/db driver guarantees an app can only touch its own namespace — the v1 isolation property is preserved logically instead of physically.
- **Per-app export stays**: a per-app `.sqlite` can be derived on demand from the user DB.
- The user-DB layout (table names, columns, versioning semantics, namespace rule) becomes **normative spec surface** (spec v0.2 draft) — portability across hub providers requires hubs to agree on the schema.
- A `schema_version` + forward migration mechanism ships with the layout from day one.

## Alternatives considered
- **Per-app files + user manifest, export = archive** — rejected: "one `.sqlite` file" is the portability story; an archive is not openable by standard SQLite tooling as a unit.
- **Single DB without namespace enforcement** — rejected: gives up the isolation differentiator; a misbehaving/prompt-injected app could read or corrupt another app's data.

## Consequences
- `packages/db` grows a user-DB layer (schema, migrations, namespace enforcement, per-app export) — every dependent (`sdk`, `playground`) is affected; High-tier work.
- The DB schema joining the spec means schema changes now flow through SPEC_SYNC like envelope changes.
- Supersedes the per-app-file posture of ADR-0003 (isolation property retained, physical layout changed).
