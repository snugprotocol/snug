# Spec changelog (append-only)

Every change pushed to `snugprotocol/spec`, newest first. Format: `## YYYY-MM-DD — spec vX.Y — TASK-id — <summary> — <spec commit SHA>`.

---

## 2026-08-06 — INTERNAL DRAFT, not staged for any push — TASK-20260805-auth-core (AL-02)
**Excluded from the AL-13 v0.1+v0.2 push by owner decision (2026-08-05 spec-gating):**
storage schema moves to **v3** — new table `snug_auth_specs` (Dynamic Auth spec metadata:
`app_id` PK, `spec_json`, `status` ∈ {unapproved, approved, imported_unapproved},
`allowed_hosts` = the FROZEN derived host union computed at approval (declared ∪ registry
∪ OAuth endpoint hosts INCLUDING refreshUrl), `approved_at`, timestamps). v2→v3 migration
is additive. Credential VALUES never enter the table: they live in `snug_secrets` under
the `auth:` namespace (`auth:<appId>:<field>`, `auth:<appId>:_connection`,
`auth:_flow:<flowId>`, `auth:_state_hmac`) governed by ADR-0014's custody line. The auth
Zod schemas (5-kind strict union in `packages/protocol/src/auth-schema.ts`) are
deliberately NOT added to the `json-schemas.ts` SOURCES export — the publishes-to-spec
line is unchanged and a test pins the export set. Wire frames/envelope UNCHANGED at v1.
Publication of the auth surface is gated at Beta exit (staged v0.3 prose is AL-12).

## 2026-08-03 — spec v0.2 DRAFT amended in place (staged, not pushed) — TASK-20260803-living-apps
The still-unpushed v0.2 draft's storage layer moves to **schema v2** (ADR-0010): per-app
data becomes REAL namespaced tables — `app_<token>__<name>` with a NORMATIVE total
injective token function (`appDataToken`: UUID → 32 hex sans dashes, else `'x'+hex(utf8)`),
object-name rule `^[A-Za-z][A-Za-z0-9_]{0,40}$`, reserved prefixes `snug_`/`sqlite_`/`app_`
(single exemption: driver-internal `snug_kv`), and a per-app registry
(`snug_app_schemas.schema_json`) holding the runtime `sqlite_master` DDL VERBATIM plus
AUTOINCREMENT sequence counters. `snug_app_data` (blob) is dropped; v1→v2 migration is
structural (pre-launch data abandoned, owner-approved). New tables: `snug_app_migrations`
(append-only DDL audit), `snug_app_docs` (per-app knowledge wiki — shape normative, slug
values advisory). New columns: `snug_apps.install_source` (partial unique — a marketplace
identity installs at most once), `snug_app_versions.pinned` (the factory version is never
pruned; retention = factory + newest `VERSIONS_RETAINED` unpinned),
`snug_chat_messages.pinned`/`meta` (the bootstrap turn survives all pruning for the app's
life). Wire frames/envelope UNCHANGED at v1. Source: `packages/protocol/src/userdb-schema.ts`
(DDL + index snapshots regenerated deliberately); staged in
`docs/spec-drafts/spec-v0.2-userdb.md`. No push to snugprotocol/spec (needs explicit ask).

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
