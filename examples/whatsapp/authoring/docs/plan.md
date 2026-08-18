# Plan

How Telepath is built, layer by layer (TASK-20260817-telepath; the platform work rides the
same task):

1. **Contract first** (`packages/protocol/sidecar-contract.ts`): three new app-reachable
   routes — `GET /events` (long-poll hint stream), `GET /chats/:jid/media/:id`,
   `GET /chats/:jid/picture` — with the `:id` placeholder under the same anchored-matcher +
   decoded-traversal discipline as `:jid`.
2. **Sidecar** (`apps/whatsapp-sidecar`): typed image rows (caption as text, inline
   `jpegThumbnail`, media id), a thread store that OWNS the unread counter (seeded from the
   sync snapshot, self-incremented on live arrivals, overwritten by the phone's read
   state), a bounded hint ring buffer with monotonic cursor + `resync`, media download with
   the expired-link re-request context and a refuse-never-truncate size cap, avatar fetch
   with an in-process cache.
3. **Rust mirror** (`apps/desktop/src-tauri/sidecar.rs`): the widened `APP_ROUTES`, `:id`
   traversal negatives, and the C2 gate's new POSITIVE twin (`ipc-sidecar-fetch-dispatchable`)
   so an unregistered command can never again satisfy an unreachability check.
4. **The host live pump** (`apps/playground/state/sidecarLive.ts`): while RunView has an
   app with an approved sidecar connection mounted, long-poll `/events` through the SAME
   governed executor as every other read, and forward LEAN HINTS
   (`notifyEvent('connection-event', {slot, hints|resync})`) — no bodies, no thumbnails
   (host-event frames ride the 256 KB class and oversized frames drop silently).
   Epoch-tokened against StrictMode double-mount; hints rebuilt field-by-field.
5. **The app** (this folder's `app.html`): WhatsApp-iOS-style list + thread + composer;
   the doorbell listener (shape-gated, hint→refetch, extracted and tested); the persisted
   pseudonym map and the bidirectional privacy boundary; first-run/incremental analysis
   with watermark; ✨ drafts from measured voice + emoji; Chart.js 4 charts from local
   aggregators (validated reference palette, numbers table fallback); helper status
   surfaces.
6. **Doc ingestion** (`apps/playground/starter/starterDocs.ts`, ADR-0035): these
   `authoring/docs` files and the verbatim build prompts seed `snug_app_docs` at install —
   absent slugs only, never clobbering a wiki the user's sessions have grown.

**Test spine:** the protocol contract set-equality + traversal suites; sidecar router/
thread-store/event-buffer/mapping suites; cargo admission tests + the cross-language pin;
pump unit tests (purity, chunking, epochs, backoff) + eligibility on the real user DB; the
extracted app core (pseudonym round-trip, request builder budget, aggregators) + the
doorbell driven with frames built from the protocol's own constants; validate-suite gates
(hooks byte-identical, KB-blessed CDN extras only, literal SQL); install-time doc seeding
incl. partial-state reinstall. The final gate is a human walk on real hardware — the
eight-seam lesson made that part of the work, not verification after it.
