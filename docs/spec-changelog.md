# Spec changelog (append-only)

Every change pushed to `snugprotocol/spec`, newest first. Format: `## YYYY-MM-DD — spec vX.Y — TASK-id — <summary> — <spec commit SHA>`.

---

## 2026-08-06 — INTERNAL DRAFT, not staged for any push — TASK-20260806-auth-wizard (AL-04)
Render-directive contract + AUTH_REQUIRED payload, INTERNAL protocol surface out of the
`schemas/` SOURCES (the AL-02/AL-03 precedent; export-set guard extended; prose staged by
AL-12): `authSpecHintsSchema` (packages/protocol/src/auth-schema.ts — the single source of
truth for transformer-input hints; `packages/auth` re-derives `ParamsToAuthSpecInput` via
the inferred type, type-only) · `packages/protocol/src/render-directive.ts` —
`llmProposalSchema` (hints MINUS registration copy + headerTemplate + credential field
definitions `fields`/`userLayerFields` [fix-first 2, 2026-08-06]: LLM-authored shapes
structurally cannot carry phishing registration copy, control secret placement, or author
the credential-step labels that dictate WHICH secret the user pastes),
`inferrerProposalSchema` (required confidence in [0,1], strict-rejected when malformed —
never "reads as 0"; bounded wizard-ephemeral `evidence[]`), `authWizardDirectiveSchema`
(versioned `v`, strict, the ONLY and the PERSISTED directive shape — no `evidence[]`, no
docs-derived free text; `confidence`/`provenance` display-only: the host re-runs the
provider ladder at wizard open and computes both), `renderDirectiveSchema` union (one
member v1, pinned discriminator), `authRequiredPayloadSchema` (display fields for the
reserved `AUTH_REQUIRED` code; strict; additive — the R5 open-string wire rule
unchanged). SPEC_SYNC steps 1–3 + 6 taken; steps 4–5 (spec repo) explicitly NOT taken.

## 2026-08-06 — spec v0.2 DRAFT — TASK-20260806-spec-push — Portable User Database Format published as an explicitly-marked DRAFT — ed6e596
First publication of the staged v0.2 draft (owner-authorized, alpha-umbrella Phase-0
decision 2; roadmap A12). Published as a separate `SPEC-v0.2-draft.md` so `SPEC.md`
stays authoritative at v0.1; linked from SPEC.md + README. Body from
`docs/spec-drafts/spec-v0.2-userdb.md` at snug main `6704d95`; the v3-internal-draft
version note carried from auth-core commit `750ca29` (merged to main unchanged in
PR #6, so the published note is in sync) with the internal auth table name
generalized to "a Dynamic Auth storage surface" (the AL-13 zero-auth-literal
exclusion grep forbids the literal; annotation substance intact — v3 exists
internally, v0.2 describes v2, v2→v3 purely additive). Exclusion grep on the pushed
tree: exactly one `AUTH_REQUIRED` hit (the v0.1 R5 reserved code — allowed).

## 2026-08-06 — spec v0.1 — TASK-20260806-spec-push — Wire protocol published: 9 frames + chat envelope, rules R1–R6, 10 normative JSON Schemas — f148c22
First real spec publication (owner-authorized, Phase-0 decision 2). `SPEC.md` prose
from `packages/protocol/SPEC-DRAFT.md`; `schemas/*.json` (10 files incl. the chat
envelope) byte-identical to `packages/protocol/schemas/` at snug main `6704d95`
(currency locked by `schemas-stable.test.ts`). Editorial deltas: publication header
replaces the internal staging note; R5's `AUTH_REQUIRED` reservation reworded
timeline-neutral (roadmap v2 rescheduled the credential layer); the v0.0 skeleton's
"Authenticated connections (reserved)" section retired with it. Push
`43f65e0..ed6e596` at 2026-08-06 08:16:37 UTC; verified by fresh clone (tree
identical to local; schemas byte-identical to `packages/protocol/schemas/`).

## 2026-08-06 — INTERNAL DRAFT, not staged for any push — TASK-20260806-connected-fetch (AL-03)
**Excluded from every spec push (owner decision 2026-08-05 spec-gating; publication of the
net capability is gated at Beta exit, staged prose is AL-12).** Two new INTERNAL-draft
postMessage frames — `snug:net-request` and `snug:net-response` — the envelope net
capability (an app's only governed path to the network it cannot touch itself; C2 keeps
its `connect-src 'none'`). Deliberately NOT added to `json-schemas.ts` SOURCES (the
publishes-to-spec line is unchanged; `net-frames.test.ts` pins the export set, extending
the AL-02 guard). `net-request` carries `{url, method, headers?, body?}` with NO appId
(the runner's net binding is HOST-assigned like `dbNamespace` — R5); it strict-rejects a
`body` on GET/HEAD (R2) and any credential-shaped header (C1).
**One PUBLISHED-schema delta (additive, R2-safe):** `host-ready.json` gains an OPTIONAL
`capabilities.net: boolean` so an app can feature-detect the capability — no `required`
change, no `additionalProperties`, `io:'input'` keeps v1.0 validators accepting it. This
is the ONLY `schemas/*.json` change; the net FRAMES stay out of SOURCES. Committed
`schemas/host-ready.json` regenerated (`schemas-stable.test.ts` currency lock); a spec
push would carry this one additive field. `net-response` carries
`{status, headers (whitelist-only), body, truncated?}` or an envelope error. New size
class `LIMITS.MAX_NET_FRAME_BYTES = 1 MiB + 64 KiB` (`frameWithinLimits` per-type; an
oversized net-response becomes a terminal `NET_SIZE_EXCEEDED`, never a silent drop — B1).
New exported constants: `NET_ERROR_CODES`, `NET_METHODS`, `NET_MUTATING_METHODS`,
`NET_RESPONSE_HEADER_WHITELIST` (+ `x-ratelimit-*` glob; `set-cookie` never crosses).
`host-ready.capabilities` gains an optional `net` boolean (additive, R2-safe). One
tightening to a PUBLISHED-adjacent helper: `normalizeAuthHost` now punycodes (IDNA
toASCII) so declared and URL-derived hosts compare equal (B3, closing the AL-02 IDN
asymmetry) — this changes the FROZEN host union stored for NEW approvals but no wire
schema. Wire frames/envelope otherwise UNCHANGED at v1; `schemas/*.json` unchanged.

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

## 2026-07-31 — spec v0.0 — TASK-20260731-bootstrap — Initial spec repo scaffold (skeleton SPEC.md, empty schemas) — 43f65e0 (SHA backfilled 2026-08-06 by TASK-20260806-spec-push)

## 2026-07-31 — spec v0.1 DRAFT (staged, not pushed) — TASK-20260731-protocol-core
First protocol definition: 9 postMessage frames + chat envelope, rules R1–R6 (versioning,
additivity, terminal-frame guarantee, identity, open error codes, limits). Staged in
`packages/protocol/SPEC-DRAFT.md` + `schemas/*.json` (io:'input' — validators must accept
unknown fields). No push to snugprotocol/spec (needs explicit ask).
