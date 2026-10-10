# TASK-20261010-cross-app-access: Access between apps — one app reads another's data through a revocable, scoped, logged grant the user controls

- **Status**: planned — owner delegated end to end on 2026-10-10 ("full permissions to go ahead with your best recommendation … keep running until you deliver it fully"); the Gate-2 stop is therefore replaced by a fresh-context plan review (High tier) whose findings are folded here before implementation
- **Owner**: Jeetu (delegated); planning, design, architecture and every review by the session model (Fable 5.1, extra-high); tests, code generation and mechanical work by Opus 5.5 (high) through the Workflow tool
- **Risk tier**: **high** — `packages/protocol` (two new published frames, a `host-ready` flag, a schema regeneration → spec 1.1), `packages/runner` (a new routed capability beside db/net/open-url), a new consent surface in every shell, and a threat-model delta
- **Branch**: `feat/TASK-20261010-cross-app-access` (off `main` @ `54d5048`)
- **Packages touched**: `packages/protocol` · `packages/runner` · `packages/sdk` · `packages/db` · `packages/knowledge` · `apps/playground` (engine + UI + e2e) · `apps/host` (capability table + e2e) · `apps/host-mcp` (instructions only) · `apps/desktop` (inherits; test rows) · `apps/website` (sync) · `docs/` (ADR-0075, spec draft 1.1, whitepaper edition 4, threat model v3.7, architecture, code-map, glossary, product-vision, spec-changelog, next-steps, lessons)
- **Spec impact**: **spec 1.1 planned** (→ [SPEC_SYNC.md](../../engineering/SPEC_SYNC.md)): Part I §2 inventory 13 → 15 frames (`snug:access-request` / `snug:access-response`, strict), `host-ready.capabilities.access?`, new **Part VII — Access between apps** (§21–§24), Part VI conformance rows, Appendix A `ACCESS_*` codes, Appendix B constants, Appendix C sixteen schema files, §8.1 transparency keys. Whitepaper edition 4 (the 1.1 edition). Staged in the local `snugprotocol/spec` clone as ONE commit; the owner's sentence "add this to the specs (separate repo) and increment the specs version and … output the whitepaper too" is read as the explicit in-session ask PROCESS.md requires — the push is performed last, after this PR merges, and journaled with UTC time + SHA (SPEC_SYNC step 5–6).
- **Related**: ADR-0075 (this task; drafted at Gate 2) · ADR-0016/0017 (who may propose; requirement/grant split) · ADR-0019 (reads on an isolated copy, writes proposed) · ADR-0034 (hints, never content) · ADR-0036/0046/0063/0074 (settings-keyed host state; no v7) · ADR-0045 §7 / ADR-0074 E8 (an update pauses what trusted the old code) · ADR-0063 (app sharing — a different "share"; the vocabulary here is **access**) · threat model v3.6 → v3.7 · `docs/security/threat-model-delta-cross-app-access.md` (new)

## Spec (what & why)

Today every Snug app is an island: its data lives as `app_<token>__*` tables materialised into its own runtime database, its `dbNamespace` is host-assigned, and no frame lets one app see another's rows. That isolation is a security property (ADR-0010, C2) and a product gap: a budget app cannot read the ledger, a meal planner cannot read the pantry, two apps the same person built cannot cooperate. The owner asked for **cross-app data sharing where the user is in full control and has complete transparency**: App A reads App B's data only with the user's explicit permission; that permission can be one-time, time-limited or indefinite, and is revocable at any moment; the user is told plainly what is shared and **where the data can go** (the reader's AI, its approved connections); once allowed, reads are frictionless until expiry; **the app giving access keeps the log**; one app may share with many, in either direction (two grants); and a running app can **discover** relevant apps — with the user's permission — rather than guessing. The UX must feel native to the runner (Apple-grade: one screen, plain words, one decision per act) and ship in every shell: the web Playground, Snug for Mac, the host kit under every binding (artifact and the local runner), all from one source.

The design in one paragraph (ADR-0075): an **access grant** is a host record — `{ reader app, source app, tables, read-only, purpose, duration, status }` — written **only by the user's act on a host surface the app cannot forge**, kept as a namespaced `snug_settings` row so it travels with the file and needs no storage-version bump. A reader asks over a new strict frame pair (`snug:access-request` with `op ∈ request | query | list | release` / `snug:access-response`), routed by the runner to a **host-assigned** access handler exactly as db/net are (value-blind runner; the announce `appId` never identifies anyone). `request` opens the **consent sheet**: the host ranks the user's apps by relevance to the reader's stated purpose and hints, the user picks the source and the tables, chooses a duration (just this once · a day · a week · until I turn it off), reads **where this data can go** (the reader's brain by name; every host its approved connections may call; "may connect later" for declared ones; "no network of its own" otherwise) and allows or declines — the app learns only what was granted (source name, tables, columns, expiry), never the user's inventory. `query` runs ONE read-only `SELECT` on an **isolated scratch copy of the source's data from which every object outside the granted tables has been physically dropped** (ADR-0019's physical-isolation posture, scoped), capped in rows and bytes, credential-shaped cells masked, every read **logged on the source's row** (`accessLog:<sourceAppId>` — time, reader, statement, rows, attended or unattended). Revoke anywhere — the source app's header, the reader's header, Settings, or the reader itself (`release`) — takes effect on the next query and rings the reader a hint (`host-event 'access-changed'`, ids only). An untrusted import lands every grant **suspended** unless intent-identical to a local one; an update of the reader that is not the user's own authoring (shared, agent hand-in, starter) suspends its grants and the update confirm names them; deleting either app sweeps the grants and the log. Nothing about this crosses a network: the whole exchange is postMessage on one page routed by `event.source`, and the read happens inside the host page's own database — there is no man in the middle to exploit, and a planted file cannot arm a grant.

**Acceptance criteria** (each becomes at least one test; the test file is named so the next phase is red until the seam is wired — lesson 2026-10-09):

1. **Protocol frames** — `packages/protocol/src/__tests__/access.test.ts`, `frames.test.ts`: `parseFrame` admits every `snug:access-request` op (`request`, `query`, `list`, `release`) and `snug:access-response` variant; both are `strictObject` (an unknown key → `MALFORMED`); bounds hold at cap and refuse at cap+1 (`purpose` 200, hint words 16×32, hint tables 16, `sql` 4096, `params` 64 scalars, tables per grant 32, columns 128); `host-ready.capabilities.access` is optional (a pre-1.1 ready frame still parses). `buildJsonSchemas()` carries `access-request.json` + `access-response.json` (sixteen files, both `additionalProperties: false`); `schemas/` regenerated and `schemas-stable.test.ts` green.
2. **Protocol records** — `access.test.ts`: `accessGrantSchema` is strict at every level, caps the serialised grant at 4 KiB (+1 refuses), refuses a credential-shaped `purpose` (the one credential walk, moved to `record-guards.ts` and re-exported by `schedule.ts` so every scheduling test is unchanged); `canonicalAccessGrantIntent` covers `{id, readerAppId, sourceAppId, scope, access, purpose, duration, provenance}` and NOT status, counters or timestamps; `accessLogEntrySchema` strict with caps; the tolerant readers answer `undefined` on junk; `accessRequestHash` hashes `{purpose, hints, renew}` only (a reworded `requestId` is the same ask); `isReadOnlySelect` is importable from `record-guards.ts` and byte-identical in behaviour (schedule's own tests stay green).
3. **Runner routing** — `packages/runner/src/__tests__/host-access.test.ts`, `snug-app-frame.test.tsx`: a `snug:access-request` reaches the handler with the HOST-assigned `accessAppId` (announce `appId: 'evil'` ignored); the posted response parses against `accessResponseSchema`; a handler error maps to the error frame; a thrown handler → `HOST_ERROR`; no handler → `capabilities.access: false` and a `HOST_ERROR` answer; with handler → `true`; a stale `instanceId` is dropped silently; a duplicate `requestId` in flight is refused; `MAX_IN_FLIGHT` shared discipline; a result over the 256 KiB class becomes a SMALL terminal `ACCESS_SIZE_EXCEEDED`, never silence; a malformed request carrying a `requestId` is answered `MALFORMED` on the wire (the `answerUnparseable` arm); `SnugAppFrame` forwards `access`+`accessAppId` as a pair (the explicit-forward pin).
4. **Runner stays value-blind (C1/C2 negative)** — `net-value-blind.test.ts` extended: no shipped runner source imports `@snugprotocol/db`, `sql.js` or the access engine; the runner never reads a row (it routes a frame and posts a result); the access pair rides `MAX_FRAME_BYTES` (the 256 KiB class) in `frameWithinLimits`.
5. **SDK** — `packages/sdk/src/__tests__/access.test.ts` + the contract suite: `useSnugAccess()` exposes `request`, `query`, `list`, `release`, `onChange`; each posts the right frame with a fresh `requestId` and resolves on its terminal response (errors as data, never a throw); before host-ready every call resolves a `HOST_ERROR` result; `onChange` subscribes to `host-event 'access-changed'` through `onHostEvent`; `types.ts` gains `HostCapabilities.access?`, `AccessGrantView`, `AccessQueryResult`, `SnugAccess`. The embedded hooks block is UNCHANGED (Q9) — `examples/validate.test.mjs` admits the KB's access snippet as a second listener the way it admits the schedule listener.
6. **Scoped scratch read** — `packages/db/src/userdb/__tests__/scratch-run-scoped.test.ts`: `scratchRunScoped(appId, statement, { tables })` answers rows ONLY from granted tables — a `SELECT` on a non-granted table fails because the table is physically absent from the copy (mutation: skip the drop → red); `snug_kv`, every view and every trigger are dropped; a write statement is refused and the real data is byte-identical afterwards; `forbiddenStatementReason`'s ATTACH/PRAGMA/load_extension refusals apply; row and byte caps mark `truncated` with `totalRows`; a multi-statement string is refused; the inner statement runner is shared with `scratchRun` (one definition).
7. **Describe app data** — `describe-app-data.test.ts`: `describeAppData(appId)` lists the registered tables with their column names (from the verbatim DDL through a throwaway sql.js `PRAGMA table_info`, quoted identifiers and table constraints included) and row counts read from the rest tables; an app with no registered tables answers `tables: []`; an unknown app answers `undefined`.
8. **Access accessors** — `access.test.ts` (db): `putAccessGrant` parses before it writes (a credential-shaped purpose → `ACCESS_INVALID`, the file byte-identical), caps at 100 grants (`ACCESS_LIMIT`), `getAccessGrant`/`listAccessGrants`/`revokeAccessGrant`/`deleteAccessGrant`; `appendAccessLog` coalesces consecutive `read` entries of one grant within 60 s into one entry with `count`, caps 200 entries / 64 KiB per source and 1 MiB across sources (oldest pruned first, mutation-checked), `listAccessLog`, `clearAccessLog`; declines (`accessDeclined:<readerAppId>:<hash>`), mute (`accessMuted:<readerAppId>`), the asking switch (`accessAskingOff`); keys single-homed in `app-settings-keys.ts`.
9. **Delete cascade** — `delete-app.test.ts`: deleting an app removes every grant where it is reader OR source, its `accessLog:` row, its declines and its mute, inside the cascade's transaction; a sibling app's grants, log and declines are untouched (each sweep mutation-checked).
10. **Import, pull, export** — `userdb.test.ts`: an UNTRUSTED import lands every grant whose canonical intent differs from a local grant of the same id `status: 'suspended', suspendedReason: 'imported'`; an intent-identical one stays `active`; a TRUSTED pull keeps grants as they are; untrusted drops declines, mutes and the asking switch; logs are kept on every path; the export carries grants and logs; a grant row that does not parse is removed on an untrusted import and reported.
11. **The handler — `request`** — `apps/playground/src/__tests__/accessHandler.test.ts`: ONE pending per reader instance (a second → `ACCESS_PENDING`); ≤ 1 request per 10 s per instance (`ACCESS_RATE_LIMITED`, retryable); a recorded decline for the request's hash → `ACCESS_DECLINED` with no prompt; a muted reader or the asking switch off → `ACCESS_DECLINED`; the pending entry carries the reader's name, purpose, the ranked candidates (with tables, columns, row counts), the pre-selection (`renew`), the egress disclosure and a resolver; the user's `allow` writes a persisted grant for `day`/`week`/`always` and a MEMORY grant for `session` (bound to the reader's `instanceId`), logs `granted` on the source, bumps `accessRevisionStore`, answers the view (source name + icon, tables with columns, duration, `expiresAt`); `decline` records the hash — the second decline mutes the reader; a reader frame that retracts while pending is dismissed with NO decline recorded; a hidden (unattended) frame's `request` is refused `ACCESS_DECLINED` ("ask while the user is looking").
12. **The handler — `query`** — `accessHandler.test.ts`: a live grant answers rows from the scoped scratch and logs `read` (sql ≤ 200 chars, rows, `attended`); `reads`/`lastReadAt` bump; an expired grant → `ACCESS_EXPIRED` and ONE `expired` log line; revoked or suspended → `ACCESS_REVOKED`; another reader's grant id → `ACCESS_NOT_GRANTED` (existence never leaks — same answer as an unknown id); a session grant from another instance → `ACCESS_NOT_GRANTED`; a non-SELECT → `ACCESS_QUERY_REFUSED` with no scratch built; an engine error → `ACCESS_QUERY_FAILED`; > 60 queries/min per instance → `ACCESS_RATE_LIMITED`; a cell matching a high-confidence credential shape (`scanForCredentialValues` reject) is masked `***` (C1 belt); a result over the class → `ACCESS_SIZE_EXCEEDED`.
13. **The handler — `list` / `release`** — `list` answers only THIS reader's live grants as views; `release` revokes the reader's own grant (status `revoked`, log `released`, hint rung) and refuses another reader's grant `ACCESS_NOT_GRANTED`.
14. **Revocation and expiry from the host** — `accessGrants.test.ts`: `revokeAccess(id)` sets `revoked`, logs `revoked` on the source, and rings `access-changed { grantId }` (ids only) to the reader's live frame when there is one; expiry is derived at read and marked once; a user-initiated grant (provenance `user`) rings the reader too; `resetAccessSession()` drops every memory grant at the file-swap seams (import, pull, restore, recover-fresh, app delete — the `resetThreadSessions` list).
15. **Egress disclosure** — `accessEgress.test.ts`: `egressFor(readerAppId)` names the brain the reader's turns go to (demo → "nothing leaves"; byok with a key → the provider by name; a keyless pin → honest "(key missing)"; local → the endpoint host; a host brain → the platform's label; subscription → the hub), every approved connection host as *connected*, every declared one as *may connect later*, a revoked one not at all, the sidecar symbolic host as the helper by name, and "no network on this host" where `appMayReachNetwork` is false.
16. **Relevance** — `accessRelevance.test.ts`: `rankSources` scores exact table-name hints highest, then words in table names, column names, the app's name and description; order is deterministic (score, then name); matched tables are pre-selected (all tables when none matched); the reader itself, apps with no tables, and apps holding a sidecar connection fact are excluded with a named reason.
17. **Copy** — `accessCopy.test.ts`: every user-facing sentence lives in `access/copy.ts` and is pinned; the vocabulary scan refuses `grant`, `reader` or `scope` spelled inside a string literal in any other file under `access/` (planted-sentence proof).
18. **The consent sheet** — `accessConsentSheet.test.tsx`: renders the reader's name and purpose as TEXT nodes (a hostile purpose carrying markup renders inert), the ranked candidates, the table chooser with column chips and row counts, the four durations with the primary button naming the choice ("allow for a week"), the egress block naming the brain and each connected host, the sentence that every read is logged in the source; `Don't allow` records a decline; Escape = don't allow; roles/labels for assistive tech; the queue head only; dismissed when the reader frame retracts.
19. **The access sheet and the Settings card** — `accessSheet.test.tsx`, `accessSettingsCard.test.tsx`: the run header's sheet lists both directions for the app (what it can read · who can read it) with tables, expiry words, reads and last read, a `stop` act with inline confirm, the source side's log; "read another app's data…" opens the consent sheet with provenance `user`; Settings lists every grant across apps with suspended ones marked "needs your OK again", the asking switch, per-app unmute, and clear-log; header control `⇄` named "access" renders for owned apps only (`runHeaderIcons.test.tsx`).
20. **Composition** — `appRuntime.test.tsx`, `appRunHandshake.test.tsx`, `appShellAccess.test.tsx`: `composeAppRuntime` binds `access`+`accessAppId` for an owned app where `allows('access')` and never for a starter or shared preview; RunView's frame is `attended: true`, the scheduled hidden frame `attended: false`; `App.tsx` mounts `AccessConsentSheet` beside `NetConfirmDialog` (composition-root spy); `hostCapabilities().access === true` and `HostSurface` carries `'access'` (`hostCapabilitiesFactory.test.ts` updated).
21. **Reader updates suspend** — `accessDrift.test.ts` + rows in `sharedUpdateDrift.test.ts`, `agentUpdateControls.test.tsx`, `starterUpdate.test.ts`, host `handin.test.ts`: a shared, agent or starter update of a READER sets its grants `suspended / reader-updated`, logs it on each source and rings the reader; the update confirms name the access that will pause; the user's own builder edit changes nothing; re-allowing from the sheet is one tap on a prefilled consent (same source, same tables).
22. **End to end (Playground)** — `apps/playground/e2e/access.spec.ts` over two fixture apps on real runner bytes: the reader's `request` opens the sheet → `allow for a week` → `query` returns rows → the source's log shows the read → Settings `stop` → the next `query` is `ACCESS_REVOKED` and the reader's UI reacts to `access-changed`; `Don't allow` → `ACCESS_DECLINED`; a `SELECT` on a non-granted table fails by absence; the reader never sees the user's app list.
23. **Every shell** — `apps/host/e2e/kit-access.spec.ts` on the BUILT page: the Settings card and the header control render under the kit, `hostCapabilities().access` is true; `apps/desktop` suites green (inherits the source); `apps/host-mcp` `instructions.md` and the skill name the capability (byte-compare gate kept green).
24. **Knowledge** — `packages/knowledge/src/__tests__/cross-app-access-kb.test.ts`: `87-cross-app-access.md` exists with the mandatory header, is NOT in the inline core, its snippet names the real frame types through placeholders and the real event name, its error-code table equals `ACCESS_ERROR_CODES`, `searchKnowledge('read another app's data')` ranks it first; `30-bridge-protocol.md`'s frame table lists the pair; the skill has an *Access between apps* section; goldens/snapshots updated deliberately.
25. **Spec, whitepaper, website, threat model** — `docs/spec-drafts/SPEC-1.1.md` (renamed from 1.0; every reference updated) carries the 1.1 header, §2's fifteen frames, Part VII, Part VI rows, Appendices A–C; `scripts/check-whitepaper.mjs` passes with edition 4 (fifteen frames, a new numbered figure cited in prose, the cover meta at three cells); `pnpm run check-website-sync` green after `/sync-website`; `pnpm run check-threat-model` green with the new delta pinned, R-71+ residuals, "nineteen" deltas; `docs/spec-changelog.md` entry; ADR-0075 accepted; architecture, code-map, glossary, product-vision updated.

**Out of scope** (deferred by name in ADR-0075 §8): write access (`access: 'write'` — the seat is reserved; cross-app writes stay ADR-0019 proposals); column-level scope; sharing an app's key-value store (`snug_kv`) — tables only; live change hints from source to reader (ADR-0034's doorbell shape — a follow-up); a builder-time declaration of access needs (the connection-directive analogue); grants that travel in a shared bundle; sources that hold a sidecar connection fact (third-party PII stays in its app); absorbing `useSnugAccess` into the embedded copy-exactly hooks block (the starter release wave, ADR-0073); a Hub tile badge for apps with active access; Windows.

## Interview — the owner delegated, so the five questions are answered by defaults, each reversible by one word

| # | Question | Default taken |
|---|---|---|
| Q1 | Read-only, or writes too? | **Read-only at v1.** "Bidirectional" is two read grants. Cross-app writes would need their own consent copy, the data-write doctrine (ADR-0019) and R-70's two-instances problem; `access` is a single-member enum so a later minor can add `write`. |
| Q2 | Scope granularity | **Per table**, chosen in the sheet; columns disclosed, not filtered; `snug_kv` never shared. |
| Q3 | Durations | **just this once (while the app is open)** = a memory grant bound to the frame instance · **for a day** · **for a week** (default selection) · **until I turn it off**. Every read logged whatever the duration. |
| Q4 | Who may ask | The running app (`op: 'request'`, on a user act inside the app — the KB forbids asking on load) and the user from the host (the source's or reader's header sheet, Settings). The builder LLM does not declare access needs at build time (deferred). |
| Q5 | Discovery | Host-side, deterministic ranking shown to the USER in the consent sheet; the app learns only the grant. No LLM call, no inventory leak. |
| Q6 | Sidecar-fact sources | Not shareable (the R-9 egress scrub binds the source app, not a reader). |
| Q7 | Reader updates | A shared, agent or starter update suspends the reader's grants (ADR-0074 E8's shape); a builder edit by the user does not. |
| Q8 | Spec shape | Minor 1.0 → 1.1; two strict published frames; a new Part VII at the end so existing section numbers do not move; schemas 14 → 16; whitepaper edition 4. |
| Q9 | Embedded hooks | Unchanged; the KB ships `useSnugAccess` as a snippet beside the block (the 85-scheduled-runs precedent); the module SDK gets the typed hook. |
| Q10 | Spec repo push | Treated as asked in-session (see the header); performed last, after the merge, as one commit with the PDF, journaled with UTC time + SHA. |
| Q11 | Merge | Owner-delegated (the 2026-10-09 precedent): `gate:local --legs=workspace,smoke,e2e` green → squash-merge; deselected legs disclosed in the PR body. |

## Design (the contract every implementation lane reads)

### Vocabulary

- **Access** — the user-facing noun. "Budget has access to Ledger's transactions · until Oct 17 · 14 reads". Verbs: *allow* · *stop*. The reader *reads*; the source *is read by*.
- **Grant** (code only: `AccessGrant`) — the record. **Reader** — the app that reads (`readerAppId`). **Source** — the app whose tables are read (`sourceAppId`). **Scope** — the granted tables. **Access log** — the source's record of every read (`accessLog:<sourceAppId>`).
- Never "share" for this feature in UI copy: *share* is ADR-0063's hand-an-app-to-a-person control, already in the run header.

### Protocol (`packages/protocol/src/access.ts`, published; `record-guards.ts` new, internal)

Constants (exported; Appendix B):

| Constant | Value |
|---|---|
| `FRAME_TYPES.accessRequest` / `accessResponse` | `snug:access-request` / `snug:access-response` |
| `ACCESS_OPS` | `request`, `query`, `list`, `release` |
| `ACCESS_PURPOSE_MAX_CHARS` | 200 |
| `ACCESS_HINT_WORDS_MAX` / `ACCESS_HINT_WORD_MAX_CHARS` | 16 / 32 |
| `ACCESS_HINT_TABLES_MAX` | 16 |
| `ACCESS_MAX_TABLES` (per grant) | 32 |
| `ACCESS_MAX_COLUMNS` (per table view) | 128 |
| `ACCESS_SQL_MAX_CHARS` | 4096 |
| `ACCESS_MAX_PARAMS` | 64 (scalars: string ≤ 4096 · number · boolean · null) |
| `ACCESS_MAX_ROWS` | 500 |
| `ACCESS_MAX_RESULT_BYTES` | 192 KiB (196 608) — under `MAX_FRAME_BYTES` with the envelope margin |
| `ACCESS_GRANT_MAX_BYTES` | 4 KiB |
| `ACCESS_MAX_GRANTS` | 100 per file |
| `ACCESS_LOG_MAX_ENTRIES` / `ACCESS_LOG_MAX_BYTES` / `ACCESS_LOG_TOTAL_MAX_BYTES` | 200 / 64 KiB / 1 MiB |
| `ACCESS_LOG_SQL_MAX_CHARS` | 200 |
| `ACCESS_LOG_COALESCE_MS` | 60 000 |
| `ACCESS_REQUEST_MIN_GAP_MS` | 10 000 (per reader instance) |
| `ACCESS_QUERY_RATE_PER_MINUTE` | 60 (per reader instance) |
| `ACCESS_DURATIONS` | `session`, `day`, `week`, `always` → `durationToExpiry(kind, now)`: day = +24 h, week = +7 d, `always`/`session` = none |
| `ACCESS_GRANT_STATUSES` | `active`, `revoked`, `suspended` (`expired` is DERIVED from `expiresAt < now`, never stored) |
| `ACCESS_SUSPEND_REASONS` | `imported`, `reader-updated` |
| `ACCESS_PROVENANCES` | `app`, `user` |
| `ACCESS_LOG_KINDS` | `granted`, `read`, `refused`, `revoked`, `expired`, `released`, `suspended` |
| `ACCESS_CHANGED_EVENT` | `access-changed` (host-event; data `{ grantId }` — ids only, R7) |

Error codes (`ACCESS_ERROR_CODES`, Appendix A; the open-string R5 rule applies):
`ACCESS_INVALID_REQUEST` · `ACCESS_NOT_GRANTED` · `ACCESS_DECLINED` · `ACCESS_PENDING` (retryable) · `ACCESS_REVOKED` · `ACCESS_EXPIRED` · `ACCESS_QUERY_REFUSED` · `ACCESS_QUERY_FAILED` · `ACCESS_RATE_LIMITED` (retryable) · `ACCESS_SIZE_EXCEEDED`.

Frames (strict, like net/open-url; `v`, `type`, `requestId`, `instanceId` as every app-origin frame):

```ts
accessRequestSchema = discriminatedUnion('op', [
  strictObject({ …base, op: 'request', purpose: string(1..200, single line), hints?: strictObject({ words?: string[1..32][≤16], tables?: APP_OBJECT_NAME[≤16] }), renew?: id }),
  strictObject({ …base, op: 'query', grantId: id, sql: string(1..4096), params?: scalar[≤64] }),
  strictObject({ …base, op: 'list' }),
  strictObject({ …base, op: 'release', grantId: id }),
]);
accessGrantViewSchema = strictObject({ id, access: 'read', source: strictObject({ displayName: string(1..80), iconEmoji?: ≤8, iconColor?: ≤32 }),
  tables: strictObject({ name: APP_OBJECT_NAME, columns: string(≤64)[≤128] })[1..32], duration: enum(ACCESS_DURATIONS), expiresAt?: isoInstant });
accessResponseSchema = union([
  strictObject({ …resp, ok: true, op: 'request', grant: accessGrantViewSchema }),
  strictObject({ …resp, ok: true, op: 'query', columns: string[], rows: unknown[][], truncated?: boolean, totalRows?: int }),
  strictObject({ …resp, ok: true, op: 'list', grants: accessGrantViewSchema[] }),
  strictObject({ …resp, ok: true, op: 'release' }),
  strictObject({ …resp, ok: false, error: responseErrorSchema }),
]);
```
`frameWithinLimits` keeps both in the 256 KiB class. `json-schemas.ts` SOURCES gains both (strict publish, like the net pair). `host-ready.capabilities.access?: boolean` (optional, R2-safe).

Records (internal shapes the host persists; normative prose in spec §22, not JSON Schema — the Part III–V rule):

```ts
accessGrantSchema = strictObject({
  id: string(1..64), readerAppId: id, sourceAppId: id,
  scope: strictObject({ tables: APP_OBJECT_NAME[1..32] }), access: literal('read'),
  purpose: string(1..200), duration: discriminatedUnion('kind', [{ kind: 'until', at: isoInstant }, { kind: 'always' }]),  // 'session' never persists
  status: enum(ACCESS_GRANT_STATUSES), suspendedReason?: enum(ACCESS_SUSPEND_REASONS), provenance: enum(ACCESS_PROVENANCES),
  readerVersion: int ≥ 1, grantedAt: iso, updatedAt: iso, revokedAt?: iso, reads: int ≥ 0 (default 0), lastReadAt?: iso,
}).superRefine(byte cap 4 KiB + findRecordCredential);
accessLogEntrySchema = strictObject({ at: iso, kind: enum(ACCESS_LOG_KINDS), grantId: id, readerAppId: id, readerName: string(≤80),
  tables?: APP_OBJECT_NAME[≤32], sql?: string(≤200), rows?: int, count?: int ≥ 1, attended?: boolean, reason?: string(≤120) });
canonicalAccessGrantIntent(grant) → key-sorted JSON of { id, readerAppId, sourceAppId, scope, access, purpose, duration, provenance };
accessRequestHash({ purpose, hints, renew }) → FNV-1a 64 hex (the `proposalHash` discipline: a dedupe key, never a boundary);
parseAccessGrant / parseAccessLogEntry — tolerant readers.
```
`record-guards.ts` (new): `isReadOnlySelect`, `findRecordCredential` (moved from `schedule.ts`, which re-exports them under their old names — zero behaviour change). `index.ts` exports everything above.

### Runner (`packages/runner`)

`transport.ts`: `AccessHandler { handle(accessAppId: string, request: AccessRequestFrame): Promise<AccessHandlerResult> }`; `AccessHandlerResult` = the ok variants' payloads (`{ ok: true; op: 'request'; grant }` · `{ ok: true; op: 'query'; columns; rows; truncated?; totalRows? }` · `{ ok: true; op: 'list'; grants }` · `{ ok: true; op: 'release' }`) or `{ ok: false; code; message; retryable }`. `host.ts`: `RunnerHostOptions` gains `({ access: AccessHandler; accessAppId: string } | { access?: undefined; accessAppId?: undefined })`; `postHostReady` adds `access: options.access !== undefined`; `handleAccessRequest` mirrors `handleNetRequest` (stale instance, no capability → `HOST_ERROR 'this host has no access capability'`, duplicate/in-flight cap, try/catch → `HOST_ERROR`, `frameWithinLimits` → `ACCESS_SIZE_EXCEEDED`); `answerUnparseable` gains the arm; `onMessage` admits the type. `SnugAppFrame` forwards the pair explicitly.

### Storage (`packages/db`)

- `app-settings-keys.ts`: `ACCESS_GRANT_SETTING_PREFIX = 'accessGrant:'`, `accessGrantSettingKey(id)`, `grantIdFromAccessGrantSettingKey`; `ACCESS_LOG_SETTING_PREFIX = 'accessLog:'`, `accessLogSettingKey(sourceAppId)`, `appIdFromAccessLogSettingKey`; `ACCESS_DECLINED_SETTING_PREFIX = 'accessDeclined:'` + `accessDeclinedSettingKey(readerAppId, hash)` + `accessDeclinedSettingPrefixFor`; `ACCESS_MUTED_SETTING_PREFIX = 'accessMuted:'` + `accessMutedSettingKey`; `ACCESS_ASKING_OFF_SETTING_KEY = 'accessAskingOff'`.
- `userdb/access.ts` (the `schedules.ts` shape — injected seams, writes fail closed, reads fail open): `createAccessAccessors(seams)` → `listAccessGrants`, `getAccessGrant`, `putAccessGrant`, `deleteAccessGrant`, `listAccessLog`, `appendAccessLog`, `clearAccessLog`, `listAccessDeclines`, `addAccessDecline`, `isAccessMuted`, `setAccessMuted`, `isAccessAskingOff`, `setAccessAskingOff`; `sweepAccessForDeletedApp(sql, appId)`; `snapshotLocalAccessGrants(sql)`; `reconcileImportedAccessGrants(sql, local, trusted, now)`. `USERDB_ERROR_CODES` += `ACCESS_INVALID`, `ACCESS_LIMIT`.
- `userdb.ts`: the interface + factory spread; `deleteApp` step 3c''' (after the scheduler's sweep); the import slot beside `reconcileImportedSchedules`; `describeAppData(appId)`; `scratchRunScoped(appId, statement, scope, caps?)` sharing one `runScratchStatement` helper with `scratchRun`.

### The engine (`apps/playground/src/access/`)

- `accessHandler.ts` — `createAccessHandlerFor(appId, { attended }): AccessHandler`. Ops as specified in AC11–13. Session grants: `Map<grantId, { grant; readerAppId; instanceId }>`. Rate limiters bounded to one entry per reader (the `scheduleRequest` M10 rule). Result scrub: any string cell whose `scanForCredentialValues` scan rejects → `'***'`.
- `grants.ts` — `accessRevisionStore`; `grantsForApp(db, appId)` (both directions, session included, with derived `expired`); `isLive(grant, now)`; `createGrantFromDecision`; `revokeAccess(id, reason, by)`; `releaseAccess`; `markExpiredOnce`; `ringReader(grantId)` → `notifyAppHost(readerAppId, ACCESS_CHANGED_EVENT, { grantId })`; `resetAccessSession()` (memory grants + limiters) wired at every file-swap seam.
- `consent.ts` — `accessPendingStore` (FIFO queue, head rendered — the `netConfirmStore` shape) with `PendingAccessRequest { readerAppId, readerName, readerIcon?, instanceId, purpose, provenance, candidates, preselect?, egress, resolve(decision) }` and `AccessDecision = { granted: false; silent?: boolean } | { granted: true; sourceAppId; tables; duration }`; `requestAccessForUser(readerAppId, sourceAppId?)` — the user-initiated path parks the same shape with `provenance: 'user'`.
- `egress.ts` — `egressFor(db, readerAppId)` per AC15; labels through `copy.ts`.
- `relevance.ts` — `rankSources(candidates, { purpose, hints })` per AC16 (pure).
- `appDrift.ts` — `suspendAccessForAppVersion(db, appId, version, source, now)` (reader-side; called beside `pauseSchedulesForAppVersion` at its three sites: `schedule/acts.ts`, `share/installShared.ts`, `apps/host/src/handin.ts`) + `accessNamingApp` for the confirm notes.
- `copy.ts` — WORDS (`access`, `reads`, `read by`, `allow`, `stop`, `log`, `just this once (while it's open)`, `for a day`, `for a week`, `until I turn it off`, `needs your OK again`), every sentence, the egress phrases, the error sentences the reader sees.
- UI: `AccessConsentSheet.tsx` (portaled `ConfirmOverlay`, mounted once in `App.tsx`), `SourcePicker.tsx`, `TableChooser.tsx`, `DurationControl.tsx`, `EgressNote.tsx`, `AccessSheet.tsx` (run header), `GrantRow.tsx`, `AccessLog.tsx`, `AccessSettingsCard.tsx`; `theme/access.css` (tokens only; imported from `app.css`).
- Wiring: `run/appRuntime.ts` (`access`/`accessAppId` + `attended`), `run/RunHeaderActions.tsx` (`⇄`, aria-label "access", owned apps, `allows('access')`), `views/SettingsView.tsx` (section "access between apps"), `platform/platform.ts` (`HostSurface` += `'access'`), `platform/hostCapabilities.ts` (`access: true`), `state/library.ts` (delete → `resetAccessSession` for the app), `run/UpdatePausesNote.tsx` (names access too).

### UX (the sheet — one screen, three beats, Apple-grade calm)

```
┌──────────────────────────────────────────────────────────────┐
│ ◉ Budget wants to read data from another app                 │
│ “to show spending by category”                               │
│                                                              │
│ FROM                                                         │
│  ● 📒 Ledger         transactions · accounts     412 rows   │
│    ☑ transactions   amount · category · date · note (412)    │
│    ☐ accounts       name · balance (3)                       │
│  ○ 🥫 Pantry        items                          48 rows   │
│  ○ ♟ Chess          — no data tables                         │
│  ○ 📱 Telepath      stays in Telepath (messages from others) │
│                                                              │
│ FOR   ( just this once | a day | ● a week | until I turn it off )
│       until Fri 17 Oct, 09:14                                │
│                                                              │
│ WHERE THIS CAN GO                                            │
│  → Budget’s AI: Claude (Anthropic) via your key              │
│  → api.github.com — connected                                │
│  → beta-bridge.simplefin.org — may connect later             │
│  Reads stay on this device. Every read is logged in Ledger.  │
│                                                              │
│                         [ don’t allow ]  [ allow for a week ] │
└──────────────────────────────────────────────────────────────┘
```
Rules: text nodes only; the primary button names the duration; a declined request is remembered ("Budget won't ask this again"); two declines mute the reader (Settings unmutes); the run header's `⇄` sheet is the per-app home (what it reads · who reads it · the log · *read another app's data…* · *let another app read this…*); Settings is the cross-app home. Monochrome glyph `⇄`, `aria-label="access"`, `title="what this app can read, and who can read it"`.

### Security posture (the delta's spine)

Identity is host-assigned (`accessAppId` ≡ `dbNamespace`), never the announce. The runner is value-blind. The read is a scoped scratch copy — non-granted objects are **absent**, not filtered (mutation-tested). Writes are refused twice (`isReadOnlySelect` + `PRAGMA query_only` on the scratch). The consent sheet is host UI the iframe cannot draw over (C2); the app learns only the grant. A grant is written only by the user's act; a file cannot arm one (untrusted import → suspended); a non-authoring update of the reader suspends; deleting either app sweeps. Logs are the source's and travel with the file. The MITM question has no network leg: postMessage routed by `event.source`, the database in the host page. Disclosed residuals: the reader's AI sees what it reads (named in the sheet); a reader with an approved connection can carry data to that host in a GET (named: "where this can go"); prompt injection through source rows (R-8's class); the user's own builder edits keep grants (R-7's class); two instances of the source (R-70) can make a read observe mid-write state.

## Plan

### Order (dependency-driven; each lane tests first)

1. **W0 — fresh-context plan review** (Fable; four lenses: security · feasibility-against-the-code · UX/design · scope/spec). Findings folded into this file and ADR-0075 before any code.
2. **W1 — `packages/protocol`** (Opus): `record-guards.ts`, `access.ts`, `constants.ts` (frame types), `frames.ts` (host-ready flag, `FRAME_SCHEMAS`, `frameWithinLimits`), `json-schemas.ts`, `index.ts`, tests (AC1–2), `pnpm gen:schemas`. Then `pnpm --filter @snugprotocol/protocol test`; dependents build.
3. **W2 — three disjoint lanes in parallel** (Opus): `packages/runner` (AC3–4) · `packages/sdk` (AC5) · `packages/db` (AC6–10). Each lane runs its own suite; the orchestrator runs `turbo run test --force --filter=...` for the three.
4. **W3a — the engine** (Opus): `access/*.ts`, `appRuntime`, platform flags, library seam, drift hook (AC11–17, AC20–21). **W3b — the UI** (Opus, after W3a's module APIs exist; may overlap with W3c): sheets, card, header, App.tsx mount, CSS (AC18–19). **W3c — knowledge + SDK snippet + skill + instructions** (Opus, parallel with W3b; disjoint files) (AC24, AC23's host-mcp line).
5. **W4 — shells + e2e** (Opus): playground e2e fixtures + spec (AC22), host kit capability + e2e (AC23), desktop/host test rows.
6. **W5 — documents**: spec draft 1.1 Part VII + edits (Fable authors the normative prose; Opus applies the rename and reference updates), ADR-0075 final (Fable), threat delta + fold (Fable), whitepaper edition 4 section + figure + build + checker (Opus drafts from the spec prose; Fable reviews), architecture/code-map/glossary/product-vision/next-steps (Opus), `/sync-website` (Opus), spec-changelog (Fable).
7. **W6 — diff review** (Fable lenses: C1/C2 adversarial · correctness · maintainability · testing · copy/UX) → fixes (Opus) → re-verify.
8. **Gate 5/6**: `pnpm run gate:local --legs=workspace,smoke,e2e` (Node 22 on PATH; `turbo --force` once), journal, lessons, done-move, PR, squash-merge; then the spec clone: stage `SPEC.md` + `schemas/` + `whitepaper/*.pdf` + README badge, one commit `spec 1.1: access between apps (from snug TASK-20261010-cross-app-access)`, push, changelog SHA.

### Cross-package impact (graph in architecture.md)

`protocol` → everything rebuilds; `runner` → playground, server (server imports runner for types only — run its suite), host, desktop; `sdk` → knowledge's KB≡SDK suites; `db` → sdk, playground, host, host-mcp (the `/userdb` server imports nothing new; run it); playground source → desktop + host (+ kit e2e on the rebuilt page). The website derives from the spec draft, the schemas, product-vision and `packages/sdk/src/types.ts` → `/sync-website`.

### Test plan (tests FIRST per lane; negative tests for C1/C2)

See AC1–25 — each names its file. Mutation checks required (lesson 2026-08-04) for: the scoped drop (AC6), the cascade sweeps (AC9), the import demotion (AC10), the host-assigned id (AC3), the `attended` flag (AC20), the suspend-on-update (AC21), the credential mask (AC12). Every refusal has a passing twin.

### Spec-sync (SPEC_SYNC.md)

Schemas: `access-request.json`, `access-response.json` added; `host-ready.json` changed (new optional flag). Version 1.0 → 1.1 (additive minor). Migration notes: none for files (settings rows); a 1.0 host ignores the keys and answers no `access` capability, so a 1.1 app renders its honest fallback. Changelog entry drafted at Gate 6; the push is the final step (see header).

### Workflow and model assignment

Dynamic `Workflow` scripts per phase; implementation agents `model: 'opus', effort: 'high'`; review agents inherit the session model. Agents edit disjoint files per lane; the orchestrator commits between phases (task-id-prefixed). Run ids journaled on start (lesson 2026-09-05).

## Decisions & surprises

- D1 **"access", not "share".** ADR-0063 owns *share* in the header. (Gate 2)
- D2 **Two frames with an `op` discriminator**, not four pairs: 13 → 15 in the inventory, one row in §2, one pair in Appendix C. The db frames set the precedent. (Gate 2)
- D3 **Part VII at the end** rather than a §4a: section numbers 5–20 are cited by the whitepaper, the website and external readers. (Gate 2)
- D4 **Scoped scratch, not a parser allowlist.** Non-granted tables are dropped from the copy; absence is the control. (Gate 2)
- D5 **Session grants never persist**; they bind to the reader's frame instance, so a hidden scheduled frame never inherits one. (Gate 2)
- D6 **Sidecar-fact apps are not sources** — the R-9 scrub binds the source app's own egress, not a reader's. (Gate 2)
- D7 **Unattended `request` is refused** — consent needs a person at the sheet; an unattended `query` under a persisted grant is allowed and logged `attended: false`. (Gate 2)
- D8 **`record-guards.ts`** hosts `isReadOnlySelect` + the credential walk; `schedule.ts` re-exports — one definition, no behaviour change. (Gate 2)
- D9 **Spec draft renamed to `SPEC-1.1.md`** with every reference updated; the spec repo's `SPEC.md` stays the document. (Gate 2)

## Session journal (append-only, newest last)

### 2026-10-10 — Fable 5.1 — Gate 1–2 (planning session)
- Done: read PROCESS/TDD/SPEC_SYNC, architecture, code-map, lessons, threat model, glossary, the protocol/runner/sdk/db sources, the scheduling precedent end to end, the spec and whitepaper structure, the gates (`check-whitepaper`, `check-website-sync`, `check-threat-model`), the app-request intake and consent patterns; designed the feature (this file + ADR-0075 draft); branch cut.
- State: planned; W0 (fresh-context plan review) next; nothing implemented.
- Next step: run the W0 workflow (four review lenses), fold, then W1.
- W0 run id: `wf_501d8026-f43` (script `cross-app-access-plan-review-wf_501d8026-f43.js`; four lenses security · feasibility · design · scope; started 2026-10-10).
- Open questions: none blocking — the owner's defaults (Q1–Q11) stand as written and each is reversible by one word.
