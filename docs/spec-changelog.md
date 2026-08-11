# Spec changelog (append-only)

Every change pushed to `snugprotocol/spec`, newest first. Format: `## YYYY-MM-DD — spec vX.Y — TASK-id — <summary> — <spec commit SHA>`.

---

## 2026-08-10 — INTERNAL DRAFT, not staged for any push — TASK-20260810-p3-wizard (Dynamic Auth v2, P3)
**Excluded from every spec push** (owner decision 2026-08-05 spec-gating; the auth surface
publishes no earlier than Beta exit). **userdb schema v4 → v5: `snug_auth_specs` is
DROPPED.** This is fold B1's named exit and the first DESTRUCTIVE userdb migration.

**What changed in `packages/protocol`.** `USERDB_SCHEMA_VERSION` 4 → 5. The
`snug_auth_specs` CREATE TABLE is REMOVED from `USERDB_DDL` — deliberately not left as a
tombstone, because the Q9 self-heal guard replays the DDL on every open and a surviving
`CREATE TABLE IF NOT EXISTS` would rebuild the surface the migration exists to remove. The
table NAME stays in `USERDB_TABLES` so the v5 migration can name what it drops and so the
DDL-absence test has something to assert against. The DDL snapshot (SPEC_SYNC-gated) moves
by exactly those 9 lines.

**What changed in `packages/db`.** The v5 migration runs `DROP TABLE IF EXISTS
snug_auth_specs` (IF EXISTS because the self-heal path can produce an open whose stamped
version never had its tables created; a throw there would make the file permanently
unopenable). Removed with it: the six accessors (`putAuthSpec`, `approveAuthSpec`,
`reapproveAuthSpec`, `getAuthSpec`, `listAuthSpecs`, `deleteAuthSpec`), `AuthSpecRow`,
`HostFreezeViolation` (v4 STAGES a changed requirement instead of throwing),
`parseAuthSpecStrict`, and the `reconcileImportedAuthSpecs` import pass —
unreachable because `migrate()` runs before reconciliation, so an imported v3-era file has
already had the table dropped. `UserDbImportReport.droppedAuthSpecs` is gone; the
`droppedConnections` half is unchanged.

**CREDENTIAL VALUES ARE NOT TOUCHED.** They live in `snug_secrets` and survive. What a
v3-era user loses is the v3 GRANT, so a previously-connected app re-enters the wizard and
is re-approved into a v4 row. That re-approval is deliberate: v4 freezes a SLOT-KEYED
ceiling that v3's app-keyed row cannot express, and inheriting an approval across that
change would mean honoring consent for a shape the user never saw.

**What changed in `packages/auth`.** The executor's v3 branch is gone: `NetSpecReader`,
`NetSpecRow`, the `specReader` half of the `ConnectedFetchDeps` union (now a plain object
carrying `connectionReader`), and `spec-scope.ts` / `requireApprovedSpecScope`.
`NetConnectionReader` / `NetConnectionRow` are newly EXPORTED — until a host could name
them, the v3 reader was the only reachable path out of this package, which is why the
playground had not cut over. `llmProposalSchema` and `createAuthSpecInferrer` are
deliberately UNTOUCHED: their retirement is P4's named exit item, not this one.

**One error-code rename, no behavior change.** An off-ceiling host now returns
`NET_NOT_APPROVED` rather than `NET_HOST_BLOCKED`. v3 read one app-keyed row and could say
"this host violates THAT row's ceiling"; v4 routes BY host, so an off-ceiling host matches
no row at all — there is no ceiling that was violated, only a host nothing was approved
for. The refusal and the zero-fetch guarantee are identical.

---

## 2026-08-10 — INTERNAL DRAFT, not staged for any push — TASK-20260810-p0-contracts (Dynamic Auth v2, P0)
**Excluded from every spec push** (owner decision 2026-08-05 spec-gating; the auth surface
publishes no earlier than Beta exit, AL-12 stays HELD). The REQUIREMENT/GRANT SPLIT —
ADR-0017, amending ADR-0016. Root cause it fixes, verified at source: `llmProposalSchema`
(render-directive.ts:63–69) is `authSpecHintsSchema.omit({registrationConsoleUrl,
registrationInstructions, headerTemplate, fields, userLayerFields})`, so every static-kind
proposal collapsed to one generic field and a Coinbase-shaped requirement (key + secret +
passphrase + signed CB-ACCESS-* header) was unauthorable through any channel.

**New protocol surface** (`packages/protocol`, INTERNAL — deliberately NOT added to
`json-schemas.ts` SOURCES, the AL-02/AL-03/AL-04 precedent; the publishes-to-spec line is
unchanged and the export-set guard still pins it): `connectionRequirementSchema`
(connection-requirement.ts) — one strict, fully-bounded schema serving three call sites
(build directive, starter manifest, wizard/user entry). Re-admits the five seats
`llmProposalSchema` omits and pays for them differently: bounds at parse, a template lint
+ registry-borrow ban in `packages/auth`, and a strong review that renders every
re-admitted byte verbatim. Seats and bounds: `slot` (`^[a-z0-9][a-z0-9-]{0,39}$`, the
second half of the new PK) · `provider.name` ≤120 printable-ASCII + NFC (the confusable
guard, promoted from AL-10) · `kind` — SIX literals, v3's five `AUTH_KINDS` (derived,
never retyped) plus `none` (Q6, with a parse-time coherence rule: no `fields`, no
`request`, but `declaredApiHosts` still REQUIRED — keyless never means no host gate) ·
`fields` 1..8 · `registration.instructions` ≤10 × ≤300 plain text · `request.headerTemplate`
≤8 entries · `userLayer` (registry-synthesized only) · `declaredApiHosts` 1..32 × ≤253,
`normalizeAuthHost`-normalized · `testRequest` (GET + path only, Q7). Exported alongside:
`CONNECTION_KINDS`, `CONNECTION_PROVENANCES`, `CONNECTION_STATUS(ES)`,
`CONNECTION_SLOT_RULE`, `AUTH_MAX_SLOTS_PER_APP = 8` (fold S-M1),
`deriveConnectionAllowedHosts` (v3 `deriveAuthAllowedHosts` semantics re-homed on the flat
shape; sorted+unique+normalized OUTPUT STABILITY is load-bearing — import branch 1 compares
`allowed_hosts` BYTES, so unstable output would mass-demote every approval on the first
sync pull after cutover), and `canonicalRequirementHash` (recursive KEY sort,
whitespace-free JSON; ARRAY order deliberately PRESERVED — `instructions` is a numbered
walkthrough and `fields` is input order, so sorting would collapse two requirements a user
reads as different into one identity).

**Directive:** new `connection_requirement` kind + `connectionRequirementDirectiveSchema`
(`{v, kind, requirement, confidence?, provenance?}`), added ADDITIVELY to the
`renderDirectiveSchema` union; `confidence`/`provenance` are DISPLAY-ONLY exactly as in
`auth_wizard` (the host computes provenance from the RECEIVING channel and recomputes
confidence from the resolved ladder rung; no gating code reads the wire claim).
`authWizardDirectiveSchema`/`llmProposalSchema` KEEP SHIPPING under the additive cutover
rule (fold B1: `apps/playground/src/starter/starterDeclaration.ts:31` runtime-imports the
latter; 33 files touch the v3 surface) — their deletions are named exit items of P4/P3.

**DELETED:** `authRequiredPayloadSchema` — the orphaned unbounded display payload for the
reserved `AUTH_REQUIRED` code, re-confirmed at ZERO non-test consumers before removal
(test churn only). The R5 reserved wire CODE is untouched; only the internal payload shape
goes.

**Storage schema moves to v4** — new table `snug_connections`, the slot-keyed
requirement/grant split: `PRIMARY KEY (app_id, slot)` (v3's `snug_auth_specs.app_id` was
the whole PK, making one-connection-per-app STRUCTURAL; v4 makes it doctrine, Q4/R6),
`requirement_json` + `requirement_version` (bumps on every persisted replacement whose
canonical form differs, fold T-mn3), `provenance` ∈ {registry, inference, user_docs,
starter, user}, `status` ∈ {declared, approved, revoked} — exactly THREE, "needs
re-approval" is DERIVED (`status='approved' AND pending_requirement_json IS NOT NULL`,
fold B2) and never a fourth value, `pending_requirement_json` (an approved row's staged
change; the grant keeps serving `requirement_json` + its OLD frozen hosts until
re-approval), `imported` (a COLUMN — the strict requirement schema has no seat for an
envelope flag, fold T-M5), `allowed_hosts` (the FROZEN union, unchanged semantics),
`revoked_at` (TOMBSTONE — closes the revoke-reversal finding). v3→v4 is ADDITIVE: a bare
idempotent DDL replay, correct here only because v4 adds a whole NEW table; `snug_auth_specs`
is NOT migrated and keeps shipping alongside (cutover rule), so a v4 file carries both.
Credential VALUES never enter the table — `snug_secrets` under `auth:<appId>:<slot>:<fieldKey>`,
connection state `auth:<appId>:<slot>:_connection`, flow `auth:_flow:<flowId>` (slot in
payload), `auth:_state_hmac` unchanged. ADR-0014 custody byte-for-byte unchanged.

**Two host obligations documented in the draft because omitting them is expensive:** the
DDL-replay SELF-HEAL guard (Q9 — `migrate()` stamps `user_version` unconditionally, so the
stamp claims which migrations RAN, never that their tables EXIST; the expected table set is
verified against `sqlite_master` and idempotent DDL replayed on any miss), and the
FIRST-V4-OPEN legacy-slice wipe (fold T-M4 — v3's `authCredentialSecretKey` builds
`auth:<appId>:<field>` with NO slot, so under v4's shape those rows hold REAL credential
values nothing in v4 lists, reads, or wipes; scoped by SEGMENT COUNT, never by prefix,
since both shapes start `auth:<appId>:` and a prefix delete would take every live v4
credential; run ONCE, not per open, because the v3 writer legitimately keeps running
through the cutover).

**Validation contract** (`packages/auth`, no wire change): the template LINT reconciles the
enforced surface with the pinned one (fold S-M2) — the engine's HELPERS map is TRIMMED from
six to four (`unix_ms`/`hmac_sha512`/`sha256` deleted: shipped with no requirement behind
them, and every unused helper is signing surface), the pinned enum is `timestamp |
hmac_sha256 | hmac_sha256_b64 | base64`, request tokens are exactly `readRequestField`'s
switch (`request.method|url|pathAndQuery|body|timestamp`), and the lint makes the engine's
unknown-token→literal fallback UNREACHABLE from an accepted template. `hmac_sha256_b64` is
the ONE added encoding-capable variant (ADR-0017 §Coinbase): `base64(HMAC-SHA256(base64decode(secret),
concat(parts)))` FUSED into one fixed-shape helper rather than exposing a general
`base64decode()` — Coinbase-Exchange's scheme was inexpressible in three independent ways
at once (hex-only HMAC, utf8-in base64, no grammar nesting).

**Two Gate-2 review blockers, both PROVEN BY EXECUTION against the built package and fixed
in this phase, are folded into the above** (ADR-0017 §`request.timestamp` and §Quoted
helper arguments): (1) **quoted-argument parity was a credential-exfiltration hole** —
the lint skips quoted arguments as literals-by-authorial-intent, but the engine's
`parseHelperArgs` stripped quotes WITHOUT recording quoted-ness and `resolveArgToken`
resolved the bare text as a FIELD, so `{{base64('api_key')}}` linted `ok: true` and
rendered `base64('SUPERSECRET')`. Fixed in the ENGINE (quoted arguments return VERBATIM,
consulting neither `ctx.fields` nor the request tokens), because widening the lint would
have left the engine still able to resolve a quoted token to a secret. The spec draft now
states this as a normative host obligation, not an implementation detail.
(2) **the pinned Coinbase-Exchange template was INEXPRESSIBLE**, so the fourth helper's
justification was unrealized and the timestamp memoization protected nothing reachable: a
helper CALL is not an accepted ARGUMENT form in either the lint or the engine, so
`timestamp()` could be sent but never SIGNED. Fixed by adding the fifth pinned request
token `request.timestamp` — a RENDER fact minted by the pass and served from the SAME
memoized slot as `{{timestamp()}}`, so the two spellings cannot disagree. Nested helper
calls in argument position remain REJECTED by both lint and engine (the grammar stays
flat); that rejection is tested, not assumed. The acceptance property is that an HMAC
recomputed independently from the value SENT in `CB-ACCESS-TIMESTAMP` equals the value
sent in `CB-ACCESS-SIGN`. The timestamp is memoized per render pass (two evaluations can
straddle a second boundary → intermittently-invalid signatures).

**Four post-implementation review findings, all reproduced by probe before fixing and all
mutation-evidenced** (no wire change; admission and storage behavior only):
(1) the registry-borrow ban left ATTACKER-AUTHORED CREDENTIAL-PROMPT COPY intact —
substituting hosts and pinning `provider.name` while passing `fields`,
`request.headerTemplate` and `testRequest` through verbatim made the borrow strictly more
dangerous, because substitution ADDS legitimacy ("Paste your Spotify password" rendered
beside registry-grade hosts). Those three seats have no registry counterpart to substitute
with, so a borrow hit from a non-registry channel that occupies any of them is now REFUSED
outright; the substituted requirement is still returned on the rejection so a "we refused
this" review row can never surface `evil.example` or an attacker's rename.
(2) the AC5 userLayer channel guard had **NO PRODUCTION CALLER** — the property held on
the function while `putDeclaredConnection` persisted requirements without consulting it,
so an `inference`-provenance `userLayer` reached storage and its endpoint hosts were
unioned into the frozen ceiling at approval. Enforcement now sits ON the persist path:
`putDeclaredConnection` and `stagePendingRequirement` call an admission gate before any
write, admission runs BEFORE validation so the SUBSTITUTED requirement is what gets
hashed, host-derived and persisted, and the row's own `provenance` is the channel (staging
inherits it from the stored row), so the channel judged and the channel recorded cannot
drift. **Dependency direction, checked and reported:** `@snugprotocol/auth` already depends
on `@snugprotocol/db`, so calling admission from packages/db would close an import cycle —
the gate is therefore INJECTED (`OpenUserDbOptions.admissionGate`) and assembled at the
composition root (`apps/playground/src/state/userdb.ts`, which depends on both). The seam
is not an on/off switch: packages/db ships `defaultAdmissionGate`, which enforces the
registry-FREE half (the AC5 userLayer channel rule needs only provenance) and is installed
whenever a caller injects nothing, so the persist path fails closed on the motivating seat
even unwired.
(3) `approveConnection` neither cleared nor refused a STAGED PENDING requirement, so the
derived "needs re-approval" pill read TRUE on a row the user had just approved and a later
`reapproveConnection` promoted a never-re-reviewed requirement. It now DISCARDS the staged
edit (it re-affirms the current requirement and derives its ceiling from
`requirement_json`, never from the pending column). Discarding rather than throwing is
deliberate: an app can stage an edit at any time, so throwing would let an attacker deny
the user their own approval. `reapproveConnection` remains the only promotion path.
(4) `putDeclaredConnection` never checked `slot === requirement.slot`, producing rows whose
PK and reviewed content disagreed — the canonical hash and review screen read the
requirement JSON while the PK, the `auth:<appId>:<slot>:*` credential prefix and the
revoke/wipe path key off the COLUMN. Now a named `CONNECTION_SLOT_MISMATCH` at
`putDeclaredConnection`, `stagePendingRequirement` AND `reapproveConnection` (a promoted
pending row can carry a foreign slot that no current accessor validated). Refused rather
than normalized to the column: silently rewriting the requirement would change the exact
bytes the caller is about to hash and show.

Registry-borrow ban now fires on provider-name match **OR** `declaredApiHosts ∩`
registry `apiHosts`, for ALL kinds (fold S-M3), substituting pinned values rather than
merging. `WellKnownOauthProvider.endpoints` becomes OPTIONAL (fold T-M1) so static-kind
providers are representable by `apiHosts`/`registration` alone — TYPE change only, data
entries are P4; placeholder endpoint URLs were rejected as worse than absent because
`deriveConnectionAllowedHosts` unions endpoint hosts into the FROZEN ceiling.

**Wire frames/envelope UNCHANGED at v1; `schemas/*.json` UNCHANGED** (no published schema
delta at all in this phase). Staged prose: `docs/spec-drafts/spec-v0.3-auth.md` — CREATED
under the owner's explicit 2026-08-10 carve-out from HELD AL-12 (only `spec-v0.2-userdb.md`
existed; fold T-M2). Doctrine: ADR-0017 (amends ADR-0016 — clause 2 "never persisted" and
clause 5 "approval is the only writer" amended/refined; "an app may never propose a
connection at runtime" RE-AFFIRMED, not repealed). **SPEC_SYNC steps 1–3 + 6 taken; steps
4–5 (push to `snugprotocol/spec`) explicitly NOT taken** — publication requires an explicit
human ask and the Beta-exit gate stands.

## 2026-08-06 — INTERNAL DRAFT, not staged for any push — TASK-20260806-auth-wizard (AL-04)
Render-directive contract + AUTH_REQUIRED payload, INTERNAL protocol surface out of the
`schemas/` SOURCES (the AL-02/AL-03 precedent; export-set guard extended; prose staged by
AL-12): `authSpecHintsSchema` (packages/protocol/src/auth-schema.ts — the single source of
truth for transformer-input hints; `packages/auth` re-derives `ParamsToAuthSpecInput` via
the inferred type, type-only; evidence-style length bounds added at the fix-first pass
[nonBlocking 8, 2026-08-06]: providerName ≤120 chars, declaredApiHosts entries ≤253
chars/≤32 items, scopes+userLayerScopes entries ≤200 chars/≤64 items — the hints shape
is the chat-persisted directive's proposal surface, so free strings are capped like
`evidence[]`) · `packages/protocol/src/render-directive.ts` —
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
