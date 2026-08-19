# TASK-20260818-telepath-linking-sync: Telepath — QR on first click, name/avatar resolution, sync progress + resume

- **Status**: in-review (plan owner-approved 2026-08-18 — "go"; Phases A–D implemented, Gate 5 in progress)
- **Owner**: Jeetu
- **Risk tier**: medium (owner-confirmed at interview, 2026-08-18)
- **Branch**: `fix/TASK-20260818-telepath-linking-sync`
- **Packages touched**: `apps/whatsapp-sidecar`, `examples/whatsapp` (Telepath app), likely `apps/desktop` (wizard + run header)
- **Spec impact**: none expected (no `packages/protocol` change anticipated; re-check at plan)
- **Related**: ADR-0037 (drafted by this task, proposed), ADR-0032 (sidecar), ADR-0034 (surface v2 / live pump), ADR-0036 (run-header icon buttons), `docs/solutions/2026-08-17-eight-seam-defects-in-one-feature.md`, lessons 2026-08-17 (avatar negative-caching, LID mapping, unreadCount), TASK-20260818-registered-flag, TASK-20260818-sidecar-shutdown

## Spec (what & why)

The owner's hardware walk of Telepath (the re-owed verification in next-steps) surfaced five defects
in the linking and sync experience. The link wizard needs a second click of "Start linking" before
the QR renders (first click sits on "waiting for the code to be scanned…" with no code shown). After
linking, name and avatar resolution is partial: group participants mostly render "Unknown contact",
1:1 chat-list rows show the raw JID (`…@s.whatsapp.net`) instead of the contact name, and profile
pictures load for only some chats. Finally, the initial history sync is long and invisible — there is
no progress indication, and sync must survive the app being closed and the desktop shell restarting.

**Reported issues** (owner, 2026-08-18):
1. QR appears only on the second click of "Start linking"; first click shows the waiting state with no code and no error.
2. Inside a group thread most participants show "Unknown contact"; only some resolve.
3. Chat list: group names+avatars mostly correct; 1:1 rows show `<number>@s.whatsapp.net` instead of the contact name (WhatsApp Web shows the name).
4. Profile pictures (groups and 1:1) load only partially.
5. Initial sync: show progress/animation in the app header area (app name + icon buttons); sync must continue/resume if the app is closed mid-sync, and resume on next launch if the desktop app itself is shut down.

**Acceptance criteria** (each becomes at least one test; refined at plan):
1. One click of "Start linking" produces a scannable QR (asserting rendered structure/state, not copy — per lessons). A regression test drives the real first-click path.
2. In a group thread, every participant with a resolvable identity (contact record, pushName, or LID mapping) renders that name; "Unknown contact" appears only when no source has a name.
3. 1:1 chat-list rows never render a raw JID when a name source exists; fallback order is defined and tested.
4. Avatar fetch failures are retried/not permanently cached as "no picture"; avatars resolve for chats where WhatsApp serves one.
5. Sync progress is visible in the app header area while history sync is in flight, and disappears when complete; closing the app mid-sync does not stop the sidecar's sync; restarting the desktop shell resumes/continues sync without data loss.

**Interview outcomes (owner, 2026-08-18):**
- Sync progress lives in the **host run header** (ADR-0036 chrome — app name + icon row), not only in-app. → `apps/desktop` is in scope.
- On desktop relaunch after a mid-sync shutdown: **auto-start the helper at shell launch** when a linked session exists and sync is incomplete, so sync resumes before Telepath is opened.
- Risk tier: **Medium**.
- 1:1 name fallback = **WhatsApp Web order**: saved contact name → push name (`~` prefix) → formatted phone number; raw JID never rendered; LID chats resolve through the LID→phone mapping first.

**Out of scope**: helper packaging/bundled Node runtime; auto-reply/arming surface (ADR-0033); starter-rebuild delivery to installed apps (next-steps 2026-08-17); read receipts; unread-count live increment beyond what already ships.

## Plan

Root causes were established by code investigation (2026-08-18, verified against `baileys@7.0.0-rc14`
sources). Summary, then phases. **No `packages/protocol` change is planned** — the sidecar route
table (`packages/protocol/src/sidecar-contract.ts`) is untouched; every fix rides existing routes.
If any phase turns out to need a route/table change, STOP: re-tier to High + spec-sync.

### Root causes (file:line)

| # | Root cause | Where |
|---|---|---|
| 1 | `beginDeviceLink` reads `GET /pair/qr` exactly once, immediately after `POST /pair/start` — a guaranteed race against the WhatsApp websocket+Noise handshake (QR lands 1–3 s later via `connection.update`). The empty result returns `{ok:true}` with no `qr`, which the sheet renders as a silent waiting state. Second click wins because `startLink` is idempotent and the QR is cached by then. Also: the QR rotates (~20 s) and the sheet never refreshes it. | `apps/playground/…/connectionWizard.ts:1056-1059`, `ConnectionWizardSheet.tsx:323,333-344,411-413`; sidecar `baileys-socket.ts:340-349,440-460` |
| 2 | `pushName` — present on every history message row, the only name source for group members with no 1:1 chat — is discarded by `toWaMessage` (not in `MessageContent`/`WaMessage`), and Baileys emits `contacts.update` from pushName only for LIVE messages, never history rows. History-sync contact rows only cover existing conversations. | sidecar `baileys-socket.ts:201-239,322-337`; cf. `baileys/lib/Utils/history.js:55-62` |
| 3 | Baileys leaves `Chat.name` unset for 1:1s (protobuf expects address-book resolution) and its synthesized contact row often carries no name either, so `rememberChat` keeps its raw-JID placeholder — and the app prints `chat.name` verbatim with no fallback (`fallbackLabel` exists but is only used for message senders). | sidecar `thread-store.ts:127-145`; `examples/whatsapp/app.html:1361,1363,1400` |
| 4 | Avatars: `profilePictureUrl` returns `undefined` for privacy-restricted contacts AND missing/expired tcTokens; `pictureOf` caches that as **permanent** `null` ("has none") — the 2026-08-17 "failure is not a fact" lesson was applied to the `catch` but not the `undefined`-URL branch, which is where most real misses arrive. Plus: no concurrency cap/backoff — every visible row fires its own iq, bursts get rate-limited, retries re-enter the burst. | sidecar `baileys-socket.ts:533-570` (esp. 549-553) |
| 5 | All synced content (chats/messages/contacts/LID map/rosters) lives in in-process `Map`s (`createThreadStore`) — nothing durable; the shell kills the helper on exit (deliberate, TASK-20260818-sidecar-shutdown) and nothing auto-starts it, so every desktop restart is a full invisible re-sync. `sync.progress` is computed, transmitted on `/chats` + `/session/status`, stored by the app (`helper.sync`) and **rendered nowhere** once one chat exists; the host run header has no seat for it. | sidecar `thread-store.ts:77-84`, `baileys-socket.ts:384-428`; `apps/desktop/src-tauri/src/sidecar.rs:423-437`; `app.html:1008,1341-1356`; `apps/playground/src/run/RunHeaderActions.tsx` |

### Phases (each: tests first → implement → green → commit; independently landable)

**Phase A — QR on first click (+ rotation)** — `apps/playground`
1. Tests first (`linkedDeviceWizard.test.ts`, `linkedDeviceSheet.test.tsx`): `beginDeviceLink` polls `/pair/qr` until a QR or ~20 s deadline (fake timers; first N replies empty, then QR ⇒ resolves with QR); a deadline miss returns a **named error state**, never a silent `{ok:true}` (lesson 2026-08-17: a permanent failure must not render identically to a normal wait); sheet asserts rendered STRUCTURE (a QR img/canvas present after one click — not copy).
2. Implement: poll loop in `beginDeviceLink` (bounded, ~500 ms interval); sheet re-polls `/pair/qr` while unscanned and swaps in rotated QR codes; explicit timeout copy.

**Phase B — names (issues 2+3)** — `apps/whatsapp-sidecar` + `examples/whatsapp`
1. Sidecar tests first: `toWaMessage` carries `raw.pushName`; `ingest` feeds `rememberContacts([{id: sender, notify: pushName}])` for history AND live rows; `thread-store` upgrade path already covered — add: pushName never overwrites an address-book `name`; chats/participants expose a `nameKind: 'contact'|'push'|'verified'` (optional field on existing JSON payloads — not a route change) so the app can render WhatsApp's `~` convention.
2. New `baileys-socket.test.ts` seam test with a scripted fake Baileys event emitter (closes the named coverage gap: today nothing drives the event wiring, which is exactly where issue 2 lived).
3. App tests first (`whatsapp-analysis.test.mjs`): add a `chatDisplayName(chat)` helper INSIDE the `ANALYSIS-CORE` block (testable by the existing loader): saved name → `~`+push name → formatted phone via `fallbackLabel` → **never** a raw JID (`@s.whatsapp.net` and `@lid` fixtures; LID resolves through mapping first, and is never rendered as a phone number — existing rule).
4. Implement: sidecar harvest + `nameKind`; app routes chat rows (`app.html:1361,1363,1400`) through `chatDisplayName`.

**Phase C — avatars (issue 4)** — `apps/whatsapp-sidecar`
1. Tests first (extend `baileys-socket.test.ts`): `undefined` picture URL is cached as a TTL'd miss (retryable after expiry), NOT permanent `null`; permanent `null` only on a clean "no picture" answer; thrown errors still uncached; fetches run through a small concurrency limiter (assert ≤ N in flight against a slow fake) with backoff on failure; LID→phone canonicalization unchanged.
2. Implement in `pictureOf` (`baileys-socket.ts:533-570`): split the `undefined`-URL branch from clean absence, TTL negative cache, limiter (~3 concurrent) + jittered retry.

**Phase D — sync progress + resume (issue 5)** — `apps/whatsapp-sidecar`, `apps/desktop` (TS+Rust), `apps/playground`, `examples/whatsapp` — governed by **ADR-0037 (drafted, proposed)**
1. **D1 durable thread cache** (sidecar): persistence seat on `createThreadStore` — v1 debounced atomic JSON snapshot (temp+rename, magic+version header) under `~/Snug/whatsapp-session/`, loaded on boot; corrupt/empty ⇒ quarantine + fresh (lesson 2026-08-03: zero bytes are CORRUPT, never "fresh"). Tests first, mirroring `store.persistence.test.ts`: survives restart; corrupt file quarantined; snapshot excludes media/avatar bytes (size posture) and excludes nothing the unread rules need. Sqlite is the named follow-up if snapshot size hurts; out of scope now.
2. **D2 helper auto-resume** (sidecar): on boot, if session material is resumable (`account` + non-empty `signalIdentities` — the flow-agnostic material predicate, lesson 2026-08-18), `connect()` without waiting for a request. Test: fake store with resumable material ⇒ connect called on boot; fresh/half-linked store ⇒ not.
3. **D3 shell auto-start** (desktop Rust): in the setup hook (`lib.rs` where `SidecarState` is managed), spawn the helper at launch iff the session store exists on disk; the exit reap stays. Positive twin test per lessons: auto-start fires with a session present AND stays quiet without one.
4. **D4 progress surfacing**: app — render `helper.sync.progress` while `!complete` regardless of chat count (`app.html:1341-1356` + thread header). Host — the existing pump (`sidecarLive.ts`, which already resolves the slot and holds a governed executor) additionally polls `GET /session/status` (app-authorized, existing route) while sync is incomplete and exposes `{progress, complete}` to `RunView` → new `syncState` prop on `RunHeaderActions` rendering an indeterminate spinner + percent beside the connection icon. Tests first: `sidecarLive.test.ts` (poll stops on complete + epoch supersession; emits no message content — hints/progress only), `runHeaderIcons.test.tsx` + `connectionSurfaces.test.tsx` (indicator present while syncing, gone when complete; existing icon locators unbroken — grep for label-based locators before touching, lesson 2026-08-18).

### Cross-package impact
- `packages/protocol`: **untouched** (tripwire above). `packages/runner`/`auth`: untouched. C1/C2: no new channels — progress rides existing governed reads; the pump still forwards no content.
- Dependency direction: sidecar changes are self-contained; desktop/playground consume existing routes. Root `turbo run test --force` at each phase end (touched + dependents; lesson 2026-08-15 re stale `dist/`).
- Rust: `cargo test` for `sidecar.rs`/`lib.rs` changes; the macOS shell gate must stay green (`ipc-sidecar-fetch-dispatchable` etc.).

### Verification beyond suites
Owner hardware walk (the eight-seam lesson — a feature is done when someone walks it): fresh link
shows QR on FIRST click; scan; watch header progress; close app mid-sync (sidecar keeps syncing);
quit desktop mid-sync; relaunch (helper auto-starts, sync resumes, cache intact); group thread names
resolve; 1:1 rows named or `+number`, never JID; avatars fill in over a few minutes.

### Spec-sync impact
None (no protocol schema change). Re-check at Gate 5; tripwire in Phases table.

## Decisions & surprises

- Prior art to respect: lessons 2026-08-17 — avatar "failure is not a fact" negative-caching rule; LID (`@lid`) vs phone-JID aliasing (`lidPnMappings` + `lid-mapping.update`); `unreadCount` snapshot-only. Verify whether those fixes shipped and where these five symptoms sit relative to them.
- **Plan deviation (D4, in-scope):** the plan named `GET /session/status` as the host poll's source, but the contract (`sidecar-contract.ts` `WIZARD_ONLY_PREFIXES`) makes `/session/*` wizard-only — the app-door executor cannot reach it, and widening the table would be a protocol change (High + spec-sync). The poll rides `GET /chats` instead, whose response carries `sync` by design; `syncStateFromChatsBody` extracts ONLY `{progress, complete}` and a test pins that nothing else (names/jids/previews) reaches header state. ADR-0037 §4 updated to match. No route table touched; tier stays Medium.
- **Name tiers were forced by the pushName harvest (B):** feeding every message row's pushName through `rememberContacts` meant the newest message would rename saved contacts; the store now tracks the tier a name came from (contact > verified > push) and lower never displaces higher. `nameKind: 'push'` rides chats/participants (optional field on existing JSON payloads, not a route change) so the app renders WhatsApp's `~` convention.
- **The cache payload carries `history` beside the store snapshot (D1):** without it, a restored fully-synced session would report "still syncing" forever — the exact rendered-ambiguity lesson from 2026-08-17.
- **`startLink`'s idempotence guard widened (D2):** boot resume means a socket can exist with link still `idle`; the old guard would have fallen through to `resetAuthStore` and destroyed the working session mid-resume. `idle`-with-a-socket now returns; only `closed` retries.

## Gate-5 review outcome (2026-08-18)

Six-angle fresh-context review (line-scan, removed-behavior, cross-file trace, reuse,
simplification, altitude, efficiency + conventions). **Fixed in `0c4c2ad`:** already-linked
wizard dead-end; `~`-prefix privacy-scrub regression; SIGKILL reap voiding the exit flush
(now SIGTERM-first, test-pinned); needsRelink poll retirement + header hide; seat/tier order
mismatch (verified before notify — migrated test); prototype-walking `in` on restore;
duplicated QR read and creds-material read; store-owned `onChange` persistence trigger.

**Accepted residuals (documented, not fixed here):**
- A hung boot-resume (socket stuck `idle`) still ends in the QR deadline's named error; only a
  helper restart clears it. Rare (needs a half-dead network exactly at resume).
- A second app linking to WhatsApp after the one-shot token release hits "linked but no key" —
  pre-existing one-mint-per-link posture, now more reachable; follow-up filed.
- `start_helper` holds the state mutex through its 600 ms survival wait (pre-existing for the
  command; autostart adds one such window at launch).
- A half-linked wedge still grows an idle helper at launch (existence check is deliberately
  shallow; the helper's own predicate refuses to connect).
- A deleted address-book entry never demotes a saved (contact-tier) name — push names can't
  displace it by design.
- v1 snapshot is a whole-store synchronous JSON write every debounce during heavy sync;
  SQLite successor named in ADR-0037.
- Epoch-loop scaffold exists twice (pump + sync poll); thread-cache vs token-store file
  primitives unshared; `/chats` poll pulls the full list for two numbers (an `/events` sync
  seat is the spec-sync'd fix). All filed in next-steps.

## Session journal (append-only, newest last)

### 2026-08-18 — Claude (with Jeetu) — session
- Done: task file created from owner's 5-issue report; repo/docs recon (PROCESS, lessons, ADR-0032/0034, next-steps); interview held (progress in host run header; auto-start at shell launch; Medium; WhatsApp-Web name fallback); deep code investigation completed with root causes verified against baileys@7.0.0-rc14 sources; plan written (Phases A–D); ADR-0037 drafted (proposed); branch cut.
- State: Gates 1–2 complete on the branch; STOPPED for owner plan approval. No implementation code written.
- Next step: on approval → Phase A tests first (`linkedDeviceWizard.test.ts` QR poll deadline + named timeout state).
- Open questions: none blocking; residual for AC2 noted (a group member who never spoke, has no 1:1 chat, and no PUSH_NAME chunk stays unresolved — allowed by AC wording).

### 2026-08-18 (hardware walk 5) — Claude (with Jeetu) — session
- Done: rosters WERE climbing on the backoff helper (127→129 observed live) but the pill hid after 20 s of no movement — the stall guard was tuned for the old aggressive cadence while backoff gaps are minute-plus by design, and a retired poll never restarts short of an app relaunch. Fixed (`fd871b6`): guard waits ~3 min of true silence and treats a shrinking total (write-offs) as movement; roster attempts tuned to 5×20s-doubling (~10 min coverage) so convergence lands in minutes; failure classes now aggregate into `rosterDiagnostics` in the cache (a failing-only steady state previously wrote nothing, making stalls undiagnosable from disk). Sidecar 144 + playground affected 40 green; helper reinstalled (18:02). Owner told: do NOT re-pair — link and data are healthy.
- State: awaiting owner restart; the cache's `rosterDiagnostics.errors` will name the failure classes for the ~100 hard groups.
- Next step: owner restarts; read diagnostics; expect Names to climb with a shrinking denominator and converge; then merge.
- Open questions: none.

### 2026-08-18 (hardware walk 4) — Claude (with Jeetu) — session
- Done: pill climbed to 127/233 then froze and (correctly) hid via the stall guard; cache sampling 35 s apart confirmed the helper was idle — the retry-per-sweep-beat cadence had burned all 5 attempts per group inside one throttle window, writing off 106 rosters. Fixed (`bfce7e5`): exponential backoff per group (30 s base doubling, 8 attempts, ~1 h coverage — a throttle now costs one attempt, not all), `rostersGivenUp` reported in the sync detail, and the playground subtracts it from the pill's target so "Names n/m" converges on the achievable count and retires honestly. Sidecar 143, playground affected suites 39 green; helper rebuilt + reinstalled.
- State: a fresh helper process resets attempt counters, so the next desktop restart re-tries all 106 on the gentle cadence; genuinely dead groups (left/community containers) will be written off and leave the target.
- Next step: owner restarts, expects Names to climb past 127 over the following minutes (backoff-paced — slower but durable), pill converging then disappearing; then merge.
- Open questions: none.

### 2026-08-18 (hardware walk 3) — Claude (with Jeetu) — session
- Done: post-restart the pairing fix was measurably biting (LID mappings 159→760, named seats 577→758, unmapped LIDs 1079→156) but names STALLED — rosters loaded only on `/chats` reads and failures waited for the next read (98/233 after 14 min). Fixed (`5a9c385`): the helper sweeps missing rosters on its own paced beat (bounded 5 attempts/group, cache-restored rosters count as loaded, injectable `rosterSweepMs`), and `historyState()` carries `detail: {groups, rostersLoaded, names, messages}`. Owner UX ask delivered: the header indicator is now a two-phase capsule — "Syncing · N%" (history) then "Names · n/m" (roster sweep) — with tooltip detail, tabular numerals, fade-in, and a stall guard (the poll retires and clears the seat rather than freeze at 230/233). Sidecar 142, playground 1220, examples 204 green; helper rebuilt + reinstalled.
- State: owner needs one desktop restart to load the swept helper; the pill should show "Names · n/233" climbing, then disappear.
- Next step: owner restart + verify names fill; then remaining walk items and merge.
- Open questions: none.

### 2026-08-18 (hardware walk 2) — Claude (with Jeetu) — session
- Done: owner re-paired on the NEW helper — sync completed explicitly in ~5 min (674 chats, 16.6k messages, 1,561 names cached durably; the progress indicator was correctly absent because sync finished before the app was opened). Remaining "Unknown contact"s diagnosed FROM THE CACHE: 1,079 of 1,677 roster seats were unmapped LIDs — `groupMetadata` participants carry `phoneNumber` beside the LID id (baileys groups.js:337) and `ensureGroupRoster` dropped everything but `{id}`; also only 82/233 rosters had loaded (unpaced burst → rate limiting). Fixed (`30e8fb3`): full roster rows feed the directory (a new pairing alone triggers the refresh), roster fetches share the 3-slot limiter (`createSlotLimiter`). Sidecar 138 green; helper rebuilt + reinstalled.
- State: owner needs one more desktop restart to load the fixed helper; the cache then re-derives names as rosters (re-)load. Honest residuals: members who never spoke and carry no phoneNumber pairing stay unknown; unsaved silent DM partners render as +number; some avatars are genuinely absent (privacy) or still queued (3-slot drip).
- Next step: owner restarts, opens a big group, confirms names; then the remaining walk items and merge.
- Open questions: none.

### 2026-08-18 (hardware finding) — Claude (with Jeetu) — session
- Done: owner's restart test failed — root cause READ from artifacts: `~/Snug/helpers/whatsapp-sidecar` was the 13:42 (pre-task) build; `install:helper` had never been re-run, so the running sidecar had no thread cache, no boot resume, and no way to reconnect — an empty store reporting "syncing 0%" forever. New helper built + installed (thread-cache.js now present). Second, real gap fixed on the branch: a RESUMED session gets no history re-push from WhatsApp, so an empty-store resume showed "still syncing" forever even with the new code — the helper now infers completion (`explicit:false`) after a grace window with no history chunk, and the app's empty state names the situation and the fix (unlink on phone → relink). Sidecar 135, examples 204 green; helper reinstalled with the fix.
- State: owner's historical data from the pre-restart session was only in the old helper's memory (app-side sqlite kept opened threads + analyses); full history requires a fresh pairing.
- Next step: owner quits + relaunches desktop (autostart spawns the NEW helper), then unlinks Snug on the phone and relinks via the wizard → full history re-syncs, this time with visible progress and a durable cache. Then merge PR #71.
- Open questions: helper staleness is a recurring hazard — version-stamp follow-up filed in next-steps.

### 2026-08-18 (Gate 5/6) — Claude — session
- Done: six-angle fresh-context review ran; six findings fixed (`0c4c2ad` + tsc-narrowing follow-up), residuals + follow-ups recorded (task file, next-steps 2026-08-18 entries, lessons ×3), code-map row added, ADR-0037 §4 amended. Final verification: sidecar 132, playground 1214 (tsc-gated), examples 204, cargo 87, forced root `turbo run test --force` 23/23 `Cached: 0`, exit 0.
- State: in-review; PR opened. Owner hardware walk owed (next-steps 2026-08-18 walk entry): first-click QR, names, avatars, sync progress + resume across app close and desktop restart, and a pseudonymization spot-check.
- Next step: human review + merge; then the hardware walk; ADR-0037 flips to accepted at merge.
- Open questions: none.

### 2026-08-18 (later) — Claude (with Jeetu) — session
- Done: owner approved the plan ("go"). Phases A–D implemented tests-first and committed individually: A `4243bf4` (QR poll + rotation), B (pushName harvest + name tiers + chatDisplayName), C (avatar miss TTL + 3-slot limiter), D1+D2 (thread cache + boot resume), D3 (Rust launch autostart), D4 (sync poll on `/chats` + header indicator + in-app banner). Suites green per phase: sidecar 131, playground 1209, examples 204, cargo 86; forced root `turbo run test --force` green; app.html babel script parse-checked.
- State: Gate 5 in progress — fresh-context AI review running; one confirmed finding queued (Rust reap is SIGKILL, so the sidecar's exit-flush never runs on shell exit).
- Next step: land review fixes, then Gate 6 close-out (lessons, doc drift, PR) and the owner hardware walk (verification section).
- Open questions: none.
