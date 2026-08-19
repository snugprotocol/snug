# 0037 — Sidecar durable thread cache and launch-time sync resume

- **Status:** proposed (drafted at Gate 2 of TASK-20260818-telepath-linking-sync; awaiting owner
  approval with the task plan)
- **Date:** 2026-08-18
- **Task:** TASK-20260818-telepath-linking-sync

## Context

Everything the WhatsApp sidecar syncs — chats, messages, contacts, the LID→phone map, group
rosters — lives in in-process `Map`s (`thread-store.ts`). The session keys and the access token
already live on disk (`useMultiFileAuthState`, `createFileStore` — ADR-0032), so the *link*
survives a restart but the *content* does not. TASK-20260818-sidecar-shutdown made the shell
reap the helper on exit (correctly — two writers wedge one session store), which turned every
desktop restart into a full, invisible re-sync. Nothing starts the helper until the wizard or an
app read asks for it, so sync also cannot resume before the user opens Telepath. The owner asked
(interview 2026-08-18) for visible sync progress and for sync to resume across app close and
desktop restart.

## Decision

1. **The thread store gains a persistence seat.** v1 is a debounced atomic JSON snapshot
   (write temp + rename, magic + version header) stored beside the session keys under
   `~/Snug/whatsapp-session/`, loaded at helper boot. A corrupt, empty, or magic-less file is
   quarantined and treated as absent — never as "fresh" truth. The snapshot carries text
   content and metadata only; media blobs, avatar bytes, and the event-hint ring stay
   memory-only (they are re-fetchable and the ring's `resync` contract already handles a
   restart). SQLite is the named successor if snapshot size or write amplification hurts;
   the seat is designed so the format can change without touching the store's callers.
2. **The helper resumes on boot.** If the session material is resumable — `account` plus
   non-empty `signalIdentities`, the flow-agnostic material predicate (lessons 2026-08-18) —
   the helper connects to WhatsApp at startup without waiting for a wizard or app request,
   so ingestion continues in the background.
3. **The shell auto-starts the helper at launch** when the session store exists on disk
   (cheap existence check in the Tauri setup hook; the helper's own honest predicate decides
   whether to actually connect). The exit reap from TASK-20260818-sidecar-shutdown stays —
   lifecycle is now symmetric: spawn at launch, reap at exit, one writer per session store.
4. **Sync progress is surfaced on existing routes.** `sync` rides `GET /chats` by design,
   and `/session/status` is WIZARD-ONLY (the ADR-0025 verify seat) — so the host poll rides
   `/chats` through the same governed executor as every other read, extracts ONLY
   `{progress, complete}` (the extraction is the scrub — names, jids and previews in that
   response never reach header state), polls on a slow gap while incomplete, and retires
   itself on the complete report. The run header renders a `syncState` seat; the app renders
   the same number in its own UI. No new route, no protocol change, no content in the pump.

## Alternatives considered

- **SQLite in the sidecar now** — right long-term shape for 5 000 msgs/thread × N threads, but
  a heavier first step (native dep or WASM in the helper); the snapshot seat gets the
  resume behavior shipped and leaves the format swappable.
- **No auto-start; resume only when Telepath opens** — rejected by the owner at interview:
  the point is that sync progresses before the app is opened.
- **Keeping the helper alive across shell exits** — rejected: re-opens the orphan-rival wedge
  that TASK-20260818-sidecar-shutdown closed.
- **Pushing progress over a new event kind in the hint ring** — unnecessary: polling an
  existing app-authorized route from the host pump costs one small read every few seconds
  only while sync is incomplete.

## Consequences

- A restart no longer implies re-sync; WhatsApp's incremental/offline delivery fills the gap
  since the last snapshot, and `syncFullHistory` re-pushes are absorbed by upsert semantics.
- The snapshot is a second durable artifact in `~/Snug/whatsapp-session/`; "forget" (unlink /
  delete) must delete it with the session directory — same sweep, no new path.
- The helper now runs whenever a linked session exists, not only while Telepath is open —
  a standing background process the user opted into by linking; the connections surface
  already shows helper state.
- The run header gains its first live-updating, connection-fed indicator; its tests pin that
  it renders from `syncState` and disappears on completion.
