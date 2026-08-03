# Spec changelog (append-only)

Every change pushed to `snugprotocol/spec`, newest first. Format: `## YYYY-MM-DD — spec vX.Y — TASK-id — <summary> — <spec commit SHA>`.

---

## 2026-08-03 — spec v0.2 DRAFT (staged, not pushed) — TASK-20260803-portable-hub
New normative layer on top of v0.1 (wire frames/envelope UNCHANGED): **Portable User
Database Format** — one SQLite file per user (schema v1 via `PRAGMA user_version`; DDL +
limits snapshot-locked in `packages/protocol/src/userdb-schema.ts`), `snug_*` hub tables
(apps + versions ≥5 with copy-forward revert, chats, settings, secrets, blob-embedded
per-app databases, sync config), `MAX_USERDB_BYTES` 64 MiB, secrets stripped+VACUUMed
from hub pushes and default exports. Hub obligations: no backend required for app
execution; mandatory Export/Import; optional hosted origin via `GET/PUT /userdb`
(ETag/If-Match CAS, 401/403/412/413/428 ladder, CSRF double-submit `x-snug-csrf`,
fail-closed CORS); SyncProvider contract with divergence surfaced and LWW only on
explicit user action; client-authoritative writes in every execution mode
(byok/local/subscription). Staged in `docs/spec-drafts/spec-v0.2-userdb.md`. No push to
snugprotocol/spec (needs explicit ask).
Two amendments from runner implementation loop-backs: (1) **R1 — recoverable requestId on
parse failures**: `FrameParseResult` failure variants (`UNSUPPORTED_VERSION`, `MALFORMED`)
now carry `requestId?` recovered from the raw frame when it held a plausible string id, so
hosts can answer those failures on the wire instead of leaving the app's request hanging;
frames with no recoverable requestId are still never answered. (2) **R6 — db frame size
class**: `db-request`/`db-response` frames get `LIMITS.MAX_DB_FRAME_BYTES = 8 MiB`
(`frameWithinLimits` is now per-type; all other frames keep 256 KiB) so a base64-encoded
5 MiB `.sqlite` artifact can round-trip through the db bridge. No JSON-schema shape
changed — `schemas/*.json` unchanged. Staged in `packages/protocol/SPEC-DRAFT.md`.

## 2026-07-31 — spec v0.0 — TASK-20260731-bootstrap — Initial spec repo scaffold (skeleton SPEC.md, empty schemas) — (SHA recorded at first push)

## 2026-07-31 — spec v0.1 DRAFT (staged, not pushed) — TASK-20260731-protocol-core
First protocol definition: 9 postMessage frames + chat envelope, rules R1–R6 (versioning,
additivity, terminal-frame guarantee, identity, open error codes, limits). Staged in
`packages/protocol/SPEC-DRAFT.md` + `schemas/*.json` (io:'input' — validators must accept
unknown fields). No push to snugprotocol/spec (needs explicit ask).
