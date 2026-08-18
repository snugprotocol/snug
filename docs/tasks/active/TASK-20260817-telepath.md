# TASK-20260817-telepath: Telepath — the WhatsApp client rebuild (live inbox + insight)

- **Status**: planned (awaiting Gate-2 owner approval)
- **Owner**: jeetu
- **Risk tier**: **high** — touches `packages/protocol` (`sidecar-contract.ts`), the desktop Rust route admission (`sidecar.rs`, C2 gate scope), and the connected-fetch path. High-tier extras apply: negative tests, fresh-context AI plan review BEFORE implementation, journal self-sign-off.
- **Branch**: `feat/TASK-20260817-telepath`
- **Packages touched**: `protocol` (sidecar contract — run everything), `whatsapp-sidecar`, `desktop` (Rust + gate), `playground` (live pump, RunView, starter doc ingestion, HubView look), `examples/whatsapp` (full rebuild)
- **Spec impact**: internal-draft only (`sidecar-contract.ts` is outside `schemas/` SOURCES, same line as the Twin task) → spec-changelog INTERNAL-DRAFT entry per SPEC_SYNC
- **Related**: ADR-0032 (linked-device/sidecar), ADR-0033 (standing approval — untouched, app surface removed), draft ADR-0034 (sidecar surface v2 + live pump), draft ADR-0035 (starter doc ingestion), `docs/solutions/2026-08-17-eight-seam-defects-in-one-feature.md` (the verification doctrine for this rebuild)

## Spec (what & why)

Rebuild the WhatsApp Twin POC (`examples/whatsapp`, shipped TASK-20260816, owner-verified) into
**Telepath** — a full WhatsApp-client experience that keeps the POC's two loved features (the
registry connection wizard, the psychological/thread analysis) and adds: an official-WhatsApp-iOS-style
chat list + thread UI with real names, images and avatars; live incoming messages with unread badges
(true push into the iframe via a host pump); an AI draft-reply button that writes in the user's own
voice and measured emoji habits; implicit history fetch replacing the paste-an-export flow, with
incremental re-analysis (prior analysis + delta only); a charts tab of deterministic conversation
analytics; the app's vision/requirements/plan/wiki docs AND the verbatim build prompt seeded into
`snug_app_docs` at install. Auto-respond is removed entirely (the platform's StandingApprovalGate
stays, untouched). The POC is replaced in place (owner interview 2026-08-17); folder stays
`examples/whatsapp` (registry entry, manifest tests, install_source identity all key on it — display
name is what changes).

**Privacy invariant (retained from AC12, now bidirectional):** the app shows exactly the
names/numbers WhatsApp shows (the user already has this data); every LLM-bound payload is
pseudonymized (`YOU`/`P1`/`P2`…, JIDs and phone numbers scrubbed from author AND body); the
pseudonym map is **persisted in the app DB** so labels stay stable across incremental runs; analysis
output is stored pseudonymized at rest and mapped back to real names at render time. Real
names/numbers never reach the LLM; pseudonyms never reach the user's eyes.

**Owner interview (2026-08-17):** replace Twin ✓ · name "Telepath" ✓ · true push seam (not app
polling) ✓ · images + avatars in v1 ✓.

**Acceptance criteria** (each becomes at least one test):

1. **Chat list**: with a linked connection, app open renders chats sorted by most-recent activity
   with avatar, name, last-message preview, timestamp, unread badge. (sidecar `/chats` field tests +
   app-core sort/format tests)
2. **Thread view**: opening a chat renders newest-at-bottom bubbles with real sender names, date
   separators; image messages render inline thumbnails, tap fetches full image through the media
   route when within cap. (sidecar media route tests + app-core message-mapping tests)
3. **Pseudonymization round-trip**: no raw name/number/JID survives into any LLM-bound payload
   (POC negative fixtures retained + extended); the persisted map keeps labels stable across runs
   and extends monotonically for new participants; `deanonymize` maps labels in analysis output back
   to display names, whole-word, without touching ordinary text. (app-core tests)
4. **Live updates**: a message arriving while the app is open appears in the open thread, re-sorts
   the chat list, and bumps the badge without user action — hint in, governed refetch out. (sidecar
   `/events` cursor + long-poll tests; host pump unit tests incl. stop-on-unmount, epoch/StrictMode
   double-mount, backoff, and hint-size budget; app-core hint-handling reducer tests; one
   bridge-altitude test driving a real `RunnerHost.notifyEvent` through the frame harness into the
   listener)
5. **Send + AI draft**: user sends text through the existing governed POST (confirm gate intact,
   journaled); the draft button produces an editable draft whose request state carries voice samples
   + a measured emoji-frequency table (emoji stats function tested; request-builder shape tested);
   drafts are never auto-sent.
6. **Analysis lifecycle**: first analyze fetches full history (paginated) **into local storage**
   (charts and the message cache see everything), records the max-message-ts watermark in the app
   DB, and sends a **byte-budgeted** transcript to the model (recent-window truncation under the
   256 KB app-message frame class, truncation disclosed to the model — review F8: "full history"
   reaches the DB, never necessarily the prompt); a subsequent analyze builds its request from the
   stored prior analysis + only messages after the watermark. (request-builder tests prove
   full-vs-delta composition AND the byte budget; DB layer tests prove watermark/run persistence)
7. **Charts**: charts tab renders ≥4 charts (share-of-messages doughnut, hour-of-day profile,
   weekday distribution, response-time or emoji leaderboard) from local deterministic aggregators.
   (aggregator unit tests on fixture corpora)
8. **Sidecar always up**: app mount fires a status/chats fetch through the auto-start transport
   (helper spawns if down); helper-unavailable renders a retry surface with the real preflight
   detail, never a blank screen. (transport ordering test exists — extend with mount-fetch test)
9. **Docs ingestion**: installing the starter seeds `snug_app_docs` with
   vision/requirements/plan/lessons + a `build-prompt` slug carrying the owner's verbatim task
   prompt; existing user docs are never clobbered on re-install, and a partial prior state (some
   slugs present) fills only the absent slugs. (playground install tests incl. partial-state
   reinstall; AC9 provenance gate still green)
10. **C1/C2 negatives (High tier)**: new routes refuse traversal (TS + Rust twins, decoded-form);
    `/pair/*`+`/session/*` still refused to apps with the widened table; **`/events` refuses
    without the bearer token identically to `/chats`** (review F6); pump-emitted host-events carry
    no credential material AND no message bodies/thumbnails (hint-shape scan test); media/base64
    responses enforce the 1 MiB cap while reading (Rust) and the sidecar refuses oversized media
    with a structured `{tooLarge:true}` rather than truncating.

**Out of scope**: voice/video/document/sticker media (images only); sending media; sending read
receipts to WhatsApp (badge clear is local-only display state); the POC's translate feature
(dropped — not in the rebuild spec; ADR-0027 distill); auto-reply/arming in any form (platform gate
untouched, next-steps item unaffected); browser-playground support (sidecar is desktop-only by
construction); helper packaging/bundling (unchanged next-steps item); SDK embedded-hooks changes
(the app hand-rolls its `snug:host-event` listener outside the byte-checked block — an SDK
`useHostEvents` hook is a recorded follow-up, not this task); subscription-lane twins.

## Plan

**Design decisions already made (owner may veto at approval; D1/D5 rewritten and D9 added after
the 2026-08-17 fresh-context plan review — findings F1–F9 below):**
- **D1 — Push rides the existing `snug:host-event` channel, and events are LEAN HINTS** (R2: open,
  additive, unknown events ignored). No new protocol frame, no C3 spec-sync on `schemas/`. The
  "true push seam" = sidecar event buffer + long-poll route + a host-side pump forwarding
  `RunnerHost.notifyEvent('connection-event', {slot, hints})` where each hint is
  `{jid, kind: 'message'|'chat-update', ts}` — **no message bodies, no thumbnails, no names**. The
  app refetches through its governed reads (`/chats`, `/chats/:jid/messages?since=`) on a hint.
  Why (review F1, verified): `hostEvent` frames ride the ordinary 256 KB class
  (`frames.ts` gives only db/net frames bigger classes) and `post()` drops ANY oversized frame
  **silently** (`host.ts:183`) — content-bearing batches would vanish without an error. Hints keep
  frames at bytes, avoid touching `frames.ts`, and make stale delivery harmless (F2): a stale hint
  triggers at worst one redundant governed refetch of the app's own data. Verified: `hostEvent`
  frames carry no `instanceId` (`host.ts:643-650`), so hint-refetch — not an instanceId compare —
  is the staleness defense.
- **D2 — Long-poll, hold ≤ 8 s. Timeout headroom VERIFIED** (review F7): the sidecar server's
  `REQUEST_TIMEOUT_MS` is 10 s (`server.ts:36`); the Rust unix-socket read loop has no independent
  timeout (`sidecar.rs` read loop runs to EOF under the byte cap). 2 s margin stands.
- **D3 — Pump goes through the governed executor** (`connectedFetchDepsFor(appId)` GET to
  `snug-connection://whatsapp/events?cursor=`), not a private transport — token injection, gates,
  and C1 hold identically to every other read. GET = non-mutating = no confirm friction.
- **D4 — Media as base64 JSON** through the existing 1 MiB-capped transport: inline `jpegThumbnail`
  rides with each message on the `/history`/`/messages` responses (net class, 1 MiB), with a
  sidecar-side page cap (~50 messages) so thumbnail-bearing pages stay bounded; full image via
  `GET /chats/:jid/media/:id` only when raw bytes ≤ ~700 KB (base64 headroom under the cap), else
  `{tooLarge:true}` + thumbnail. `mediaOf` wires Baileys' `DownloadMediaMessageContext`
  (`reuploadRequest` from the live socket + logger) so expired CDN links re-request instead of
  silently failing (review F5) — with a test on the expired path. Avatars via
  `GET /chats/:jid/picture` (sidecar fetches the preview-size URL itself, returns bytes; in-memory
  cache sidecar-side, in-memory cache app-side). Images never enter the app DB and never go to the LLM.
- **D5 — The sidecar OWNS the unread counter** (review F4, verified against baileys@7.0.0-rc14):
  Baileys exposes `unreadCount` only as a snapshot field on synced conversations, not a live
  counter — so the sidecar seeds from the sync snapshot and increments per live incoming message
  itself (mirroring `shouldIncrementChatUnread` semantics). The app clears its badge locally on
  thread-open; nothing is ever sent to WhatsApp (no read receipts).
- **D6 — Analysis stored pseudonymized at rest**, de-mapped at render (the map lives in the app DB;
  a DB export therefore carries no de-anonymized analysis prose).
- **D7 — Folder stays `examples/whatsapp`**; Telepath is the display identity (app.html, HubView
  STARTER_LOOKS, README). Registry/provider/slot unchanged.
- **D8 — Doc ingestion is generic** (any starter shipping `authoring/docs` gets seeded at install),
  implemented as a sibling of `installStarterConnections`/`installStarterRuntimeContract`, hooked
  at the real install site (`RunView.tsx` `installThisStarter` — the hub's tiles deliberately have
  no install path). The new `?raw` glob lives in its **own module** `starterDocs.ts` (review F3:
  the AC9 glob-shape pin asserts every glob in `starterApps.ts` ends with `/examples/*/app.html`,
  so a second glob there would fail the existing test); validate gains a dedicated assertion
  pinning the new module's glob to `authoring/{docs,prompts}/*.md`. Seeding is per-slug,
  absent-only — a partial prior state (some slugs present) fills only the gaps (review F9).
  ADR-0035 records the deliberate reversal of "provenance never ships".
- **D9 — The app's hand-rolled `snug:host-event` listener is shape-gated and hint-driven**
  (review F2): it sits outside the byte-locked hooks block, accepts only
  `{v:1, type:'snug:host-event', event:'connection-event'}` frames, and never trusts hint content
  as state — every UI change flows from a governed refetch. The pump itself is epoch-tokened:
  RunView effect cleanup stops the loop, and a superseded epoch's late responses are discarded, so
  StrictMode's double-mount can never run two loops against one cursor or double-forward a hint.

**Phases (tests FIRST in every phase, per TDD.md):**

- **A — Protocol contract** (`packages/protocol`): extend `SIDECAR_ROUTES` with
  `GET /events`, `GET /chats/:jid/media/:id`, `GET /chats/:jid/picture` (new `:id` single-segment
  placeholder, same anchored-matcher + decoded-traversal discipline). Tests: new routes
  app-reachable, wizard prefixes still refused, traversal negatives on `:id`. Spec-changelog
  INTERNAL-DRAFT entry. *Protocol touched → full root suite is the verification bar.*
- **B — Sidecar** (`apps/whatsapp-sidecar`): extend `WaMessage` (`kind: 'text'|'image'|'unsupported'`,
  `caption`, `thumbnailBase64`, `mediaId`), `WaChat` (`unreadCount`, `lastMessage{text,ts,fromMe}`,
  `lastActivityTs`); add to `WaSocket`: `eventsSince(cursor)` + a wait/notify hook for the long-poll,
  `mediaOf(jid,id)`, `pictureOf(jid)`. `baileys-socket.ts`: image mapping (inline thumbnail,
  `downloadMediaMessage` with the `DownloadMediaMessageContext` wired from the live socket so
  expired CDN links re-request — F5 — plus the size refusal), `profilePictureUrl` fetch, the
  sidecar-owned unread counter (seed from sync snapshot, self-increment per live message — F4),
  bounded event ring buffer of LEAN HINTS with a monotonic cursor (drop-oldest + `resync:true`
  when a cursor has aged out), page cap (~50) on thumbnail-bearing message responses. `router.ts`:
  three handlers incl. the ≤8 s hold. Tests extend
  `router.test.ts`/`fake-wa-socket.ts`/`message-mapping.test.ts`: cursor semantics, hold-until-event,
  empty-timeout shape, media cap refusal, expired-media re-request path, unread seed+increment,
  auth required on every new route (incl. `/events` — F6), hint records carry no bodies.
- **C — Rust admission + gate** (`apps/desktop`): mirror the widened `APP_ROUTES` in `sidecar.rs`;
  cross-language pin test updated; cargo traversal negatives on the new segments. Fold the
  next-steps 2026-08-17 hardening item: give the C2 gate's negative IPC check its **positive twin**
  (main-window `sidecar_fetch` invoke succeeds) so an unregistered command can't fake unreachability
  again. macOS gate run is part of this phase's definition of done.
- **D — Host live pump** (`apps/playground`): new `src/state/sidecarLive.ts` — start/stop keyed to
  the RunView frame lifecycle for an app holding an approved sidecar-symbolic-host connection;
  epoch-tokened loop (F2/F9: cleanup stops it, superseded epochs discard late responses); cursor
  state; exponential backoff on failure; forwards lean hint batches via `notifyEvent` under an
  explicit per-emit byte budget (F1). Wire in `RunView.tsx` beside `controlsRef`. Tests: fake
  executor → hints reach `notifyEvent`; stop-on-unmount kills the loop; StrictMode-shaped
  mount→unmount→remount never double-forwards or races the cursor; pump starts ONLY for an app
  with an approved sidecar connection, driven through the real deps assembly with a fake platform
  seat (F9 — the seam of eight-seams defect #7); no credential material and no message bodies in
  any emitted payload; backoff verified with fake timers.
- **E — The app** (`examples/whatsapp` rebuild): marker-block core v2 (pure, extracted+tested by the
  rewritten `examples/whatsapp-analysis.test.mjs`): persisted-pseudonym-map merge, `redactIdentifiers`
  (retained verbatim + fixtures), `deanonymizeText` (new), `emojiFrequency` (new),
  transcript/request builders with byte budget + full-vs-delta composition (new), chart aggregators
  (new), hint-handling reducer + message dedupe-by-id (new), the shape-gated host-event listener
  (D9, outside the byte-locked block, testable via marker extraction). One bridge-altitude test
  drives a real `RunnerHost.notifyEvent('connection-event', …)` through the runner frame harness
  into the listener (F9 — the seam of eight-seams defect #3). UI: iOS-style list/thread/tabs
  (Chat · Insights · Charts), composer + draft icon + analyze icon, Chart.js 4 from the allowlisted
  CDN (follow the dataviz discipline), image bubbles, avatars, badges, live listener on
  `snug:host-event`, helper-status surfaces. `runtime-contract.json` v2 keeps the POC's persona/
  analysis knowledge base (owner ask: reuse it) + adds `reanalyse_thread` and the richer
  `draft_reply` contract. App DB v2: `threads` (watermarks), `messages` (text cache for
  analysis/charts/instant render), `pseudonyms`, `analyses` (runs), `activity` (journal chokepoint
  retained). README rewrite (ToS honesty retained verbatim in spirit). `authoring/` bundle:
  `prompts/01-build.md` = the owner's verbatim task prompt; docs vision/requirements/plan/lessons.
  HubView look. Embedded-hooks block stays byte-identical (validate suite enforces).
- **F — Doc ingestion** (`apps/playground` + `examples` validate): `installStarterDocs` in a NEW
  `starterDocs.ts` module holding its own `authoring/{docs,prompts}/*.md` glob (F3 — the existing
  AC9 pin asserts every glob in `starterApps.ts` is app-html-shaped, so that file stays
  single-glob); seeds absent slugs only, per-slug (partial prior state fills gaps — F9);
  `build-prompt` slug from numbered `prompts/*.md`. Wire beside `installStarterConnections` in
  `RunView.tsx`'s `installThisStarter` (verified real install site; the hub's tiles have none).
  Tests: seeding, no-clobber, partial-state reinstall, a DEDICATED glob-shape assertion for the
  new module (the existing pin untouched). ADR-0035 accepted here.
- **G — Verify** (the eight-seams doctrine: the first hardware walk is PART of the work): root
  `turbo run test --force` + cargo + macOS `pnpm --filter desktop gate`; then an owner hardware
  pass scripted in the journal: open Telepath (helper auto-starts) → list with avatars/badges →
  receive a live message with app open → image renders → draft → send (confirm) → analyze →
  send one more message → re-analyze (delta) → charts → wiki docs visible. Every seam in that walk
  maps to a phase above; none is "verification of finished work".
- **H — Close** (Gate 6): ADR statuses, spec-changelog, threat-delta addendum (events carry message
  content host→app only; third-party images reach the app frame as user-visible data, never the
  LLM; media route size posture), README/docs drift, lessons, next-steps (retire the Twin-specific
  lines, add the SDK `useHostEvents` follow-up), memory update.

**Cross-package impact**: protocol → everything (root suite). `whatsapp-sidecar` standalone +
cross-language pin. `desktop` cargo + gate. `playground` suite (pump, ingestion, RunView).
`examples` validate + manifests + analysis suite. No `packages/auth`, `packages/runner`,
`packages/sdk`, or `packages/db` source changes anticipated — if any becomes necessary,
stop and re-plan (each is its own review surface).

**Spec-sync**: internal-draft line only (sidecar-contract is outside `schemas/` SOURCES);
spec-changelog entry in Phase A; no push to `snugprotocol/spec` (release rules).

## Decisions & surprises

- 2026-08-17 — Owner interview: replace Twin · "Telepath" · true push seam · images+avatars. D1–D8
  above made at plan time and surfaced for approval.
- POC's translate feature dropped (not in the rebuild's 10 requirements; distill doctrine).

## Session journal (append-only, newest last)

### 2026-08-17 — claude (fable) — session (Gates 1–2)
- Done: explored POC + platform (two fresh-context sweeps), owner interview (4 answers), task file,
  draft ADR-0034/0035, branch created. High-tier fresh-context adversarial plan review RAN and
  returned 3 blockers + 3 majors + seam list — all folded:
  **F1** (hostEvent frames are 256 KB class and `post()` drops oversized SILENTLY → events became
  lean hints, no content; `frames.ts` untouched) · **F2** (hand-rolled listener can't check
  `instanceId` — hostEvent frames don't carry one; hint-refetch + epoch-tokened pump is the
  staleness defense → D9) · **F3** (AC9 glob pin would reject a second glob in `starterApps.ts` →
  new `starterDocs.ts` module + dedicated assertion) · **F4** (Baileys has no live unread counter —
  sidecar owns seed+increment) · **F5** (`downloadMediaMessage` needs `reuploadRequest` ctx for
  expired links) · **F6** (`/events` bearer-token negative test added) · **F7** (timeout headroom
  verified: 10 s server / no Rust read timeout) · **F8** (AC6 reworded: full history to DB,
  byte-budgeted prompt) · **F9** (four seam-altitude tests named and added: pump gating through
  real deps, StrictMode double-mount, bridge-altitude listener e2e, partial-state doc reinstall).
  Review also verified sound: route derivation/traversal generalization, install-site choice, and
  the no-auth/runner/sdk/db-source-changes claim.
- State: plan hardened; awaiting Gate-2 OWNER APPROVAL. No implementation code written.
- Next step: on approval → Phase A failing tests (`sidecar-contract`), then B→H per plan.
- Open questions: owner may veto any of D1–D9 or the two draft ADRs at approval.
