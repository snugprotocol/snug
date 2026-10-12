# Threat-model delta — discovery, declarations and the chat's change to another app: apps say what they would like to read, the host suggests and offers, the chat proposes a change you apply, and a fetch can come first

**Task:** TASK-20261010-host-broker (PR-5) · **ADR:** [0076 §2, §6, §7, §11](../decisions/0076-host-as-broker-access-everywhere.md) and its two new decisions (the access history crosses a sync; the imported marker), amending [0009](../decisions/0009-sync-provider-origins.md) and [0075](../decisions/0075-cross-app-data-access.md) · **Spec:** 1.3 — STAGED with PR-4's editorial revision, pushed once by the owner after the merge (§8.1, §9 item 4, §21, §22.1 rule 5, §24.1 item 3, §24.2 item 6, §24.5, §24.6, §25, Part VII); no frame, published schema or wire byte changes · **Date:** 2026-10-12 · **Supersedes** one sentence of [the task-write-authority delta](threat-model-delta-task-write-authority.md): its "the chat door stays read-only for another app's data" (that delta is pinned and is not edited).

Until this change the user found access between apps only when an app asked at runtime, the chat
beside an app could READ another app's tables but never change them, *fetch new data first* was a
grant's tick only an app's own code could use, and a sync divergence lost the losing copy's access
history whole. PR-5 adds five things. **Declarations:** an app may say in its own HTML head what it
would like to read (`<meta name="snug:access-wants">`); the host derives that into a row at every
version it is given and shows it as one sentence on a shared install preview. **Discovery:** from
declarations alone the host suggests pairs (Settings' *apps that could work together*, the Hub
tile's *could read Ledger's data — review…*, the reader's ⋈ sheet), a SOURCE can offer itself from
its ⋈ sheet (*let another app read Ledger's data*), and the Hub tile says in words how many apps an
app reads and is read by. **The chat's change to another app:** under a grant whose table is ticked
*can also change rows*, the chat's brain may PROPOSE one statement; the host renames it to the
source's table, plans it, and shows a card with its own count line; nothing changes until the user
presses *apply to Ledger*, and an applied change can be undone from Ledger's access for seven
days (R-113 names the one exception). **Fetch first:** the chat's toggle and a schedule step's tick ask the sources the caller may
read to run their own fetch first, through the one service, cancellable from the header chip.
**Two-device honesty:** a sync resolution now carries the access-history lines of the losing copy
into the winning one and lets a stop made on either side win, and an untrusted import marks every
app whose code or origin differs from this device's copy as *arrived with a file you imported*.
C1 and C2 are unchanged in policy: no credential path moves, a fetch runs under the same refusing
posture, and no frame, sandbox or CSP byte changes. What follows are the channels those policies
must survive.

## What is new

| Surface | The threat | What holds |
|---|---|---|
| **The access declaration** (`packages/db/src/access-wants.ts` `extractAccessWants`, `findHeadMeta`; `packages/db/src/userdb/access.ts` `writeAccessWantsFor`, `rederiveAccessWants`; `packages/db/src/userdb/userdb.ts` `insertVersion`; `apps/playground/src/access/AccessWantsNote.tsx`) | An app's HTML plants words the host shows as its own, pre-ticks tables, or grants; a foreign file plants an `accessWants:` row the host then reads; the preview and the stored row read the same HTML differently; a 5 MB body is scanned; a lone surrogate or a bidi character rides into host chrome. | A SMALL grammar, pure and total: at most 65,536 UTF-16 units from offset 0, ending at the first U+0000 (what sql.js's text read stops at, G5-9) and at the first `<script`, `<style`, `<body` or `</head` outside a comment; EXACTLY one `<meta name="snug:access-wants">` with one quoted `content`; only `&quot; &apos; &amp; &lt; &gt;` decoded; ≤ 2 KiB UTF-8, ≤ 4 entries, the strict `accessWantsSchema`, every parsed string well-formed — any ambiguity is NO declaration, never a refused install. ONE reader for both paths: `insertVersion` (every admission — builder commit, revert, reset, starter and shared install and update, the hand-in) writes the row from the version it inserts, reading only a TEXT cell; EVERY import, whatever its origin, deletes every `accessWants:` row and re-derives from the apps' own HTML, so a planted or orphan row is never read. Shown on the shared install preview only — one sentence ending *nothing is read until you allow it*, the app's purpose as a block quote, every name in `<bdi>` — and never on the Hub tile. A declaration never writes a grant. A browser may parse a hostile head differently; the HTML is the app author's own, so whichever parser reads it the words are the author's, and every host reads it the same way. |
| **Pairs and the declared form** (`apps/playground/src/access/pairs.ts` `listPairSuggestions`; `apps/playground/src/access/relevance.ts` `registryTables`, `tableTierTables`, `rankPairs`; `apps/playground/src/access/userAsk.ts` `startUserAsk({declared, source})`; `apps/playground/src/access/consent.ts`) | A declaration steers the sheet into ticking tables its words merely resemble; an app that arrived through a share link or an imported file gets its words onto host chrome as a suggestion; a stale wish opens a sheet the app no longer means; the app's purpose is persisted on a grant whose provenance says the user started it; ranking exports every app on a Hub render; a planted registry row takes the surface down. | The signal is the declaration only; a pair needs a TABLE-tier match against the source's REGISTERED schema — an exact hint table, or a hint word equal to a whole `_`-token (≥ 3 characters) of a table name — never a column or description match (S10, SA-5). No runtime is exported to rank (`registryTables` over `getAppSchema`; spies pin zero `exportAppRuntime`/`describeAppData` calls); the registry is read totally (a non-array, a non-string, a name outside `APP_OBJECT_NAME_RULE`, a comment or a quoted name inside the DDL), each app in its own try/catch — one bad row drops that app, never the surface (G5-13). Never a `share` or imported reader, never a `share` or imported source (S11, SA-7); never a pair already joined by any grant that is not revoked (G5-14); never a want the user declined. A tap re-reads the declaration and answers `gone` unless a deep-equal want is still declared (*that changed since it was listed — nothing was allowed*); the sheet is pinned to the one source and ticks only its table-tier tables (`tableTierOnly`) — never write, `kv`, `refresh`, the away box or a non-default duration. The sheet QUOTES the app's purpose after *what Budget says it's for:*; the grant persists the host's words, `ACCESS_SHEET.declaredPurpose`, with provenance `user`. *don't allow* is offered only when the want had hints and records its `accessRequestHash`, so the app's identical runtime ask later answers declined. |
| **The source's offer and the ⋈ door** (`apps/playground/src/access/AccessOffer.tsx`; `apps/playground/src/access/AccessSheet.tsx` `offerReaders`; `apps/playground/src/access/consent.ts` `carryOut`; `apps/playground/src/run/RunHeaderActions.tsx`) | A source's offer becomes a write; an app triggers an offer; a forged decision ticks write; the door shows for an app with nothing behind it. | The offer is host chrome under *what reads Ledger*, started only by the user's act; it is offered only when the app has a registered table and holds no WhatsApp fact, to apps that may use access and hold no grant from it that is not revoked. The ONE consent sheet opens pinned to the source with `canChange={false}` (no *can also change rows*, the options' summary never says "change"); `carryOut` REFUSES any decision carrying `write` on a pending marked `offeredBy: 'source'` and writes nothing (fail closed — a memory-only seat no app can set). Provenance `user`; the outcome shows on both apps' strips. The ⋈ now shows on an owned app with access state OR whenever the file holds another app that may use access (a one-app file shows none). |
| **The Hub tile** (`apps/playground/src/access/AccessTileBadge.tsx`; `apps/playground/src/access/grants.ts` `foundGrants`, `accessCountsByApp`; `apps/playground/src/views/HubView.tsx`) | An app's own words reach the Hub; a glyph-only badge says nothing to a screen reader; a count outlives the grant it counted. | Host words only: *reads 1 other app · read by 2 apps* counts DISTINCT apps joined by a live grant either way (persisted and this tab's session grants), in VISIBLE text inside the tile's link; the *could read Ledger's data — review…* sibling names the source and never the app's purpose. Computed once per shelf, re-read on the access and library revisions and by one timer at the nearest expiry (≤ 24 h). Report-only: the tile acts nowhere but through the same declared form. |
| **The imported marker** (`packages/db/src/userdb/app-provenance.ts` `hashAppIdentities`, `markImportedApps`, `readAppProvenance`; `packages/protocol/src/app-provenance.ts`; `apps/playground/src/access/provenance.ts`) | A file forges `install_source` (`starter:`, `agent:`, `share:`, or none for *built here*) and the consent sheet believes it (R-77); the file vouches for itself with a marker; a planted PAST or pinned version leaves the current HTML identical; the hashing await lets a stop the user makes during the import be undone by the swap. | The UNTRUSTED import drops every incoming `appProvenance:` row, then marks every incoming app whose IDENTITY differs from the local app of the same id — `install_source` plus the ordered `(version, pinned, sha256(storage-class-tagged html))` of EVERY version row; an identical app keeps the local marker state; a fresh device marks every app; a revived deleted app is marked. Both identity maps are hashed BEFORE the import's synchronous snapshots, so nothing but the driver's close is awaited between the first snapshot and the swap (G5-6). A trusted pull keeps; `deleteApp` sweeps; no edit clears. The read is fail-closed — a row that does not parse reads as imported with no date. On the consent sheet the marker overrides every install source: *arrived with a file you imported on 3 Oct · Snug can't tell who made it*. A marked app is never a pair's reader or source. |
| **The access history across a sync, and a stop wins** (`packages/db/src/userdb/history-carry.ts` `snapshotLocalAccessHistory`, `carryAccessHistory`, `applyTombstones`; `packages/db/src/userdb/access-log-prune.ts`; `packages/db/src/sync/loop.ts`; `UserDb.carryFromImage`) | A carry rewrites what happened, evicts the winner's lifecycle lines, or plants an undo inverse for rows the chosen copy never had; a grant revoked on one device is revived by the other's pull; the carry loops two devices forever; a sealed or damaged image blocks the user's choice; a line written while a push is in flight is lost. | HISTORY ONLY: `accessLog:*` lines move; `accessUndo:*` and `ownUndo:*` FOLLOW the winning image (a journal describes rows that went with it); data is never merged. Identity is the natural key `(at, kind, grantId, readerAppId)` by instant; a loser line parses strictly, is newer than `since` or shares its key with a winner line (a coalesced group that straddles `since`, G5-7), and names a source the winner holds; a match MERGES (count and rows the max, every other seat the winner's); a carried `wrote` line loses its `undoId`. The caps never throw: carried lines give way first, by their own tiers — the winner's lines never. **A stop wins:** the pull re-applies this device's revoked rows over the pulled image, and *keep this device's copy* first applies the origin's revoked rows to the live file (`carryFromImage`, one transaction, before the payload); a row the winner already holds revoked is left alone, so two stops never trade `revokedAt` forever. `since` is the sidecar's `lastSyncAt` on a pull and `null` on *keep this device's copy* (G5-4); `lastSyncAt` is stamped at the EXPORT instant of the image both sides agreed on, never after the round trip (G5-5). A pull that moved anything (`carried`, `restopped`, `rewritten`) anchors `SYNC_UNANCHORED_HASH` — no sha256 can equal it — keeping the previous `lastSyncAt`, so the next tick pushes. An image the carry cannot open carries nothing and never blocks the push. |
| **The chat's proposal of a change to another app** (`apps/playground/src/agent/dataTools.ts` the chat path; `packages/db/src/brokered-write.ts` `renameDmlTarget`; `apps/playground/src/access/chatWrite.ts` `planChatWrite`; `apps/playground/src/access/materialise.ts`; `apps/playground/src/agent/sharedDdl.ts` `renderSharedDdlParts`) | The brain changes another app's data without the user; a batch, bound parameters, an `INSERT … SELECT` into the reader's own table, the key-value table or a read-only table slips through; the alias renamed into something the parser reads differently (a quoted alias, a comment before the head, `OR REPLACE`, a qualified alias, a code point SQL has no use for); the card shows text that renders differently from what runs; DML lands on a `read` line; a card for a change that changes nothing or cannot be undone. | In order, every refusal by name, nothing recorded before the counting line: the scheduled variant's shared-name refusal stays first (D-PR4-2); a table of a grant that lets this chat change nothing answers today's *read-only* sentence byte-identical; then ONE statement, its values written in (no `params`), whose DML target is the one alias it names, on a table marked `write` (never `<alias>__snug_kv`); the raw AND the renamed statement pass `accessSqlSchema` with no format character, line or paragraph separator or blank filler (`unsafeText`); `renameDmlTarget` replaces only the head's identifier through a grammar that refuses a comment before the head, `OR …`/`REPLACE`, a non-ASCII code point outside a literal and the alias anywhere past the head, then re-parses the output twice (`parseBrokeredStatement` AND `dmlTargetTable` must name the table; a parser rule answers in the app's words, G5-10/G5-16); `inTransaction(source)` → busy; ONE `read` line with the table and the attendance and NO statement and NO rows (S18); the plan on a fresh scoped copy that never reaches the driver's seat (a spy pins it); 0 rows → no card; a plan too large to undo → refused here. ONE card per turn across the own and the cross-app card; the brain hears *Proposed — it waits for the user's OK on the card* and the alias statement it wrote. The DDL marks a table *· can be changed* only for the chat caller and a `write` table, and the closing rule is never cut by the table block's cap. |
| **The card and its apply** (`apps/playground/src/agent/accessWriteCard.ts` `metaToAccessWrite`, `approveCrossAppWrite`; `apps/playground/src/access/AccessWriteCard.tsx`; `apps/playground/src/access/chatWrite.ts` `writeChatApproved`; `apps/playground/src/access/writeBroker.ts` `brokeredWriteCore`; `apps/playground/src/agent/useBuilderChat.ts`) | A persisted or imported card applies a change the user never saw; an own card that grew a `target` is applied as the app's own change; the grant was stopped and renewed between the card and the press; the source changed since the count; a double press applies twice; the AI's summary or the statement steers the user. | `meta.accessWrite` is its OWN key, re-admitted only WHOLE (any invalid, missing or unknown seat drops the card; `outcome` only from `ACCESS_WRITE_OUTCOMES`; the statement re-checked by the staging rule); the own card's `metaToDataWrite` is allow-list strict and drops a card whose answer seat holds a value outside its vocabulary (G5-1); either card whose app is not the thread's pinned app is dropped; `applyApprovedWrite` refuses a proposal carrying any key outside its shape. The card's anatomy is the host's: the lead *a change to Ledger’s transactions — you can undo it for seven days* (the undo clause only while the card waits or its undo is live, the days derived from `ACCESS_UNDO_TTL_MS`), the count *would change 3 rows in Ledger*, the AI's summary as a quoted, one-line, capped `<q>`, the statement as isolated `<code dir="ltr">`, *apply to Ledger* / *cancel*. The apply rebuilds the chat caller at the press and checks, in order: the grant found and owned, the SAME `grantedAt` (a renewal keeps the id — S9), the same source, the statement's table, ≥ 1 row, the policy's write verdict, `inTransaction` FIRST, a fresh plan whose count must equal the card's (`drifted` before the room check and the seat), room in the journal, then the seat; an access no longer found is `gone` only when its source is gone, else `ended`. Under the `approvalsInFlight` guard; the message re-read and a settled outcome never overwritten. An applied change carries its `undoId` — unless its journal write fails after the commit (R-113) — offered from Ledger's ⋈ sheet opened in place. An ANSWERED card a foreign file carries is kept and shows its settled host words; bounded by: no act on it changes anything, and its undo state is read live from the source's journal. |
| ***Fetch new data first* — the chat's and the scheduler's** (`apps/playground/src/access/fetchFirst.ts`; `apps/playground/src/access/service.ts` `refreshFor`, `refreshableReads`; `apps/playground/src/agent/chatFetch.ts`; `apps/playground/src/run/ChatFetchToggle.tsx`; `apps/playground/src/schedule/executors.ts`; `packages/protocol/src/schedule.ts` `refreshFirst`, `fetched`; `packages/protocol/src/chat-cards.ts` `chatFetchFactsSchema`) | A proposal channel arms an unattended fetch; the fetch bypasses the grant's `refresh` tick or, for a schedule, the away tick; spend beyond the day's ceilings or the run's bound; a failed fetch fails the step; a row carries host-voiced free text a foreign file can plant. | ONE path for both doors, through the service's host-only `refreshFor` — the policy first, never the engine directly (a spy pins it): the caller's admitted grants with `refresh` (a schedule's need `unattended` too), one per source, at most `REFRESH_FIRST_MAX_SOURCES` (2), asked in turn; a door joins a refresh already in flight. `refreshFirst` is set only by the user's tick in the editor; every proposal channel strips it (`withoutUserOnlySeats`). In a run: the budget from both clocks, a source skipped with less left than a frame is given to announce itself, the ceiling counting what the run spent plus earlier sources, the calls merged into every outcome, the AI ceiling re-asked after any fetch, and a failure never fails the step; the outcome is a host fact (`fetched`) beside the AI's words, never inside them. In the chat: the toggle shows only where the chat's data door is open and a chat-usable grant carries `refresh`, and is consumed only when the turn opens that door; what it came to is persisted as STRUCTURED facts on the user's row (`meta.fetched` — a one-line name, an outcome, minutes, ok), re-worded on read from the host's own copy, every name in `<bdi>` (G5-17); an untrusted import drops them. |
| **The abort seam and the chip** (`apps/playground/src/access/refreshRuns.ts`; `apps/playground/src/access/refresh.ts`; `apps/playground/src/schedule/runPlacement.ts` `holdDelegatedRun`, `releaseDelegatedRun`; `apps/playground/src/schedule/RunningChip.tsx`; `apps/playground/src/schedule/copy.ts` `DELEGATED_CONFIRM.afterFetchBody`) | One door's stop cancels another door's wait; a cancel in an OPEN source ends the run's record and turns the source's refused mutating calls into the sticky ASK (S2); a file swap folds an old file's fetch into the new one; a refresh dispatched during a swap writes into the wrong file. | One entry per refresh across its handovers; a door's signal abandons only its own wait — the dispatch's controller is aborted only by the chip, a reset, an app delete (its own refreshes only) or the last waiter leaving. A cancelled LIVE dispatch HOLDS its record (`cancelled: true`): the chip drops it and every waiter is answered at once, while the record keeps refusing mutating calls, keeps the access door closed and keeps counting until the handler's result or the dispatch's ORIGINAL deadline — a cancel never makes a refused call an asked one; a refusal recorded during the hold is written `refused` on release. A cancel writes `refreshed` with `reason: 'failed'` (*Ledger's fetch didn't finish*) and keeps the cooldown. A reset writes NOTHING and clears the cooldowns, with an epoch bumped even when nothing is in flight; a swap LATCHES first (the sync loop's `beforeSwap` on the automatic pull and on *use the origin copy*, and the file import) and every refresh asked until the new file is in answers stopped, writing nothing (G5-18). After a fetch ran in the open app, its later ask says *“Ledger” fetched new data here earlier* — never that a schedule ran. |
| **The host kit** (`apps/host/vite.config.ts`; `apps/host/src/stubs/accessWriteCard.ts`, `apps/host/src/stubs/AccessWriteCard.tsx`; `apps/host/src/plugins/drop-prompt-files.ts`) | Kit bytes reach the chat's write; the page crosses its ceiling. | Ten modules swapped by resolved path; the cross-app card's two modules render no card and refuse the apply by name, and `access/chatWrite.ts` is imported only by swapped modules (pinned); no kit brain opens the data lane. The scheduled agent's three prompt files left the kit (the page 2,692,408 B against the 2,750,000 B ceiling). |

## What is NOT changed

- **No scheduled write of another app's data.** Policy rule 4′ still refuses every scheduled
  `write`; the scheduled `data_propose_write` still refuses a shared name before anything else; a
  schedule's *fetch first* asks a source to fetch, never to change.
- **Only the user creates a grant.** A declaration, a pair, the Hub tile and a source's offer each
  OPEN the one consent sheet; nothing writes a grant but `carryOut` after the user's allow. A grant
  started from the source's side is created read-only (a forged write in the decision that starts
  it is refused); a later *allow again* is a reader-side renewal (R-118). Discovery to an APP is
  still a class only (`discover` unchanged).
- **The chat never applies a change itself.** Every cross-app change is one card the user presses;
  there is no standing chat permission and no batch.
- **The source's *fetch now* is not built** (cut, "fetch-now"): a source still runs only under a
  grant with `refresh: true` (spec §24.6 item 25), always at a reader's door.
- **Data never merges across a sync.** ADR-0009's divergence stays the user's choice for the data;
  only the access history and the stops cross it.
- C1: no credential reaches a frame, a brain or a card; a refresh runs under the same refusing
  posture (GET-only connected calls, nothing remembered) as at PR-3; the cross-app apply goes
  through the same Write Broker seat, column rule and per-cell credential walk.
- C2: no frame, sandbox or CSP byte changes; every new surface is host chrome.
- The wire: no frame, capability flag, error code or published schema byte
  (`packages/protocol/schemas/` untouched); the frame's `write` op answers byte-identical refusals
  through `brokeredWriteCore`. Every new shape is INTERNAL (`chat-cards.ts`, `app-provenance.ts`,
  `schedule.ts`'s `refreshFirst` and `fetched`, outside `json-schemas.ts`).
- The SHAPES of the undo journals and the history lines are as PR-3 and PR-4 left them (no new
  seat); PR-5 changes where and when they are written (above), and a reset clears the cooldowns.

## Residual risks (recorded, not fixed)

- **R-111 — A declaration is app-authored text on host chrome.** The purpose and the hint words
  are the app author's (or the building agent's) words, shown on the shared install preview, in
  Settings' pair rows and quoted on the declared sheet. *Bounded by:* the small grammar (≤ 2 KiB,
  ≤ 4 entries, the strict schema, well-formed strings); quoting, the display rule and `<bdi>`;
  never on the Hub tile; never a grant; preselection only on a table-tier match and never write,
  `kv`, `refresh`, the away box or a longer duration; the grant persists the host's purpose; never
  from a `share` or imported app.
- **R-112 — A source-initiated grant hands a reader rows it never asked for.** The user's offer
  lets an app read data its code was not written to expect, and the reader's chat and scheduler
  doors see it too. *Bounded by:* the user's act on host chrome, with the one sheet naming the
  reader by its library row and provenance line, the tables, the duration and the egress block;
  created read-only (a forged write refused; a later *allow again* may widen it — R-118); every
  read logged on the source; *stop* from either side.
- **R-113 — The chat's change to another app can be steered by what it read.** A row from the source,
  the reader's own rows or the app's contract can shape the change the brain proposes (R-71's
  class, now proposing a write). *Bounded by:* per-card approval — nothing changes without *apply*;
  the host's own lead and count line, the statement shown in the source's names and isolated, bidi
  and invisible characters refused; one statement, one table ticked *can also change rows*, the
  Write Broker's column rule and 200-row cap; a fresh count at the press (`drifted`); every applied
  change undoable for seven days, and at most 20 live undo entries per (source, reader) — the 21st
  change waits until one is undone or expires. As at PR-3 (R-97), a journal refused after the
  commit leaves the change made with no undo; the card then says *can no longer be undone*.
- **R-114 — A history line or a stop planted through the TRUSTED origin.** The user's own sync
  origin can carry `accessLog:*` lines that never happened, or a revoked row that stops a grant.
  *Bounded by:* strict parsing and the natural key; only sources the winner holds; carried lines
  give way first and never evict the winner's; a planted revocation can only STOP access — never
  start it (a revoked id is never re-activated); no more than that origin's power to rewrite the
  file outright (R-75's class).
- **R-115 — A schedule's *fetch first* runs another app unattended.** A step ticked *fetch new data
  first* runs the source's own code while nobody is looking, spending its connections and the
  user's brain (R-91's class, now on a timer). *Bounded by:* the user's tick in the editor only
  (every proposal channel strips it); persisted grants ticked both *fetch new data first* and *also
  while I'm away*; ≤ 2 sources a step, sequential, inside the run's bound; the cooldown; the day's
  ceilings with the run's own spend counted; the refusing posture; the `fetched` fact and the
  `refreshed` line.
- **R-116 — A cancelled fetch in an OPEN source keeps running until its deadline.** *stop waiting*
  frees the person, not the app: the source's handler may still finish what it started. *Bounded
  by:* the held record refuses every mutating call (never asked), keeps the access door closed and
  counts every call until the result or the original deadline; the chip says *stop waiting* — never
  *cancel* — for this case; the cancel is a `refreshed` line.
- **R-117 — A restore onto a new device marks every app imported, for good.** A backup the user
  imports through the file picker is an untrusted import onto a hub that holds no apps, so every
  app reads *arrived with a file you imported* and is never suggested in a pair; no edit clears the
  marker. *Bounded by:* it is true that Snug cannot tell who made it; the recovery restore and a
  sync pull from the user's own origin are trusted and mark nothing; the marker changes words and
  suggestions only, never what an app may do.
- **R-118 — *allow again* on an offered grant can widen it to write.** The offered grant is created
  read-only, but a paused or expired grant is renewed (*allow again*, the same id) from the reader's
  side through the ordinary sheet, where *can also change rows* is offered. *Bounded by:* the user's
  own act on that sheet, the write toggle off by default with its undo note; the history shows the
  renewal.
- **R-119 — A protected file on a personal origin carries no history and no stop on *keep this
  device's copy*.** A sealed image cannot be opened without its passphrase (`carryFromImage`
  carries nothing), the push still goes, and it can overwrite a stop another device had made
  (pulls from a sealed origin are already refused, `LOCKED_IMPORT`, so that stop does not come back
  by a pull either). Declined at Gate 5 (SA-9) — the unseal seam is its own task (reversal
  "unseal"). *Bounded by:* each device keeps its own stops; every device shows its grants with
  *stop*; a hub origin, and an unprotected personal one, carry both ways.
- **R-120 — The carry's `since` compares clocks.** The pull's `since` is this device's last-sync instant and a
  line's `at` is its writer's clock; a line stamped behind that instant is read as one the origin
  already held and is not carried (lost from the winning copy), one stamped ahead is carried again
  (merged by its natural key, so never duplicated). *Bounded by:* history only — never data,
  never authority; a stop never depends on `since`; *keep this device's copy* carries with no
  `since` at all.
- **R-121 — A *clear history* can come back.** *keep this device's copy* carries every origin line
  this file lacks (`since: null`, G5-4), so reads this device cleared since its last sync return
  as the true records they are. *Bounded by:* every carried line is a real line from the user's
  own origin; *clear history* can be made again; change lines were never clearable.
- **R-122 — A pre-PR-5 reader and what PR-5 writes.** An older hub ignores the declaration meta
  and the imported marker (on that hub the provenance line trusts `install_source` again — R-77's
  shape), reads a task carrying `refreshFirst` as no task, drops a run entry carrying `fetched`,
  holds the carried history lines as ordinary lines, and renders no cross-app card. Fail closed is
  the direction. *Bounded by:* a task, a run and a chat that never used a PR-5 seat are
  byte-identical to their pre-PR-5 form; the older hub's own consent sheet still names the reader
  by its library row.

**Amended and extended (the fold carries each into the model's own row):**

- **R-52 amended** — a divergence is still resolved by the user, but on either resolution the
  losing copy's access-history lines are carried into the winning one and a stop made on either
  side wins; DATA, run rows and the undo journals are never merged (ADR-0009 amended by 0076).
- **R-71 amended** — the chat now PROPOSES a change to the source from what it read, applied only
  per card by the user (R-113).
- **R-75 extended** — an OLDER hub's untrusted import drops only `meta.schedule` cards by a text
  pre-filter, so a planted cross-app card in a foreign file survives there and reaches the user's
  trusted origin with the next push, where a PR-5 hub's trusted pull keeps it. *Bounded by:* the
  rehydrate drops a card whose app is not the thread's; the apply needs a live local grant with the
  SAME id AND `grantedAt`, the same source and table, a fresh count equal to the card's and the
  policy's write verdict; the user presses *apply*.
- **R-77 closed for imports from PR-5 on** — the untrusted import marks every app whose identity
  differs, and the marker overrides every install source; a file imported by an older hub carries
  no marker until a PR-5 hub imports it.
- **R-89 restated** — the chat's change to another app is per card, never standing; the standing
  write permission remains the reader's FRAME's alone.
- **R-91 extended** — the chat's and a schedule's *fetch first* make a source run too (R-115 for
  the unattended case); each is the caller's door's, under the same grant tick, cooldown, ceilings
  and refusing posture.
- **R-101 kept open by name** — "a stop wins" covers access grants only; a schedule's write
  authority that a local, unpushed stop took away is still brought back by a pull that carries the
  other copy's task.
