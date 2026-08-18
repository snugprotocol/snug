# 0034 — Sidecar surface v2: event long-poll, media reads, and the host live pump

- **Status:** proposed (drafted at Gate 2 of TASK-20260817-telepath; accept/reject with that task's
  plan approval)
- **Date:** 2026-08-17
- **Task:** TASK-20260817-telepath

## Context

The WhatsApp Twin (ADR-0032) shipped a four-route, text-only, pull-only app surface. The Telepath
rebuild needs three things the surface cannot express: live incoming messages while the app is open
(the owner chose a true push seam over app polling, interview 2026-08-17), image messages and
avatars, and chat-list metadata (unread counts, last-message previews). The sidecar already holds a
live WebSocket to WhatsApp; the platform already has an open additive host→app event channel
(`snug:host-event`, R2: unknown events MUST be ignored) that only `theme-change` uses today.

## Decision

1. **Three routes join the app-reachable contract** (`sidecar-contract.ts`, mirrored in Rust,
   same one-home/derived-subset/decoded-traversal discipline):
   - `GET /events?cursor=N` — long-poll over a bounded ring buffer of live events (message
     received, chat metadata changed), hold ≤ 8 s (inside the server's 10 s request timeout),
     monotonic cursor, `resync:true` when a cursor has aged out (the app then refetches lists
     instead of trusting a gap).
   - `GET /chats/:jid/media/:id` — image bytes as base64 JSON, only when the raw size fits the
     existing 1 MiB transport cap with base64 headroom; otherwise a structured `{tooLarge:true}`
     with the inline thumbnail — the cap refuses, never truncates.
   - `GET /chats/:jid/picture` — preview-size avatar bytes, fetched by the sidecar itself
     (the app never receives a WhatsApp CDN URL it could not dial anyway).
   `/pair/*` and `/session/*` stay wizard-only; the widened table changes nothing about who may
   reach what.
2. **Push is a HOST PUMP, not an app capability.** A playground module long-polls `/events`
   through the governed connected-fetch executor (same deps assembly, same credential injection,
   same gates — C1 identical to every other read) on behalf of the running app, and forwards
   batches into the iframe via `RunnerHost.notifyEvent('connection-event', {slot, events})`. The
   pump starts when RunView mounts an app holding an approved sidecar-symbolic-host connection and
   stops on unmount. No new protocol frame, no schema change, no new iframe capability: the app
   still cannot open a connection, name a socket, or hold a token — it just receives events on the
   channel that already existed.
3. **Media bytes stop at the app frame.** Images render from base64 data URIs (`img-src data:`
   is already allowed), are cached in memory only, never written to the app DB, and never included
   in any LLM-bound payload. The pseudonymization boundary (Twin AC12) is unchanged; pictures of
   third parties are shown only where WhatsApp itself already shows them to this user.

## Alternatives considered

- **App-side polling** (`setInterval` + `useConnectedFetch`) — no platform work, but the owner
  explicitly chose push; polling also multiplies executor traffic per open app.
- **A new host→app protocol frame** (`snug:connection-push`) — C3 spec-sync, schema, size class,
  review surface; rejected because `snug:host-event` was designed exactly for additive events and
  the payload is host-composed (trusted side) either way.
- **Streaming over the unix socket** (SSE/WebSocket through a new Rust command) — real push all the
  way down, but a second transport shape in Rust (the current command is strictly request/response
  with a while-reading cap) for latency the ≤8 s long-poll already makes imperceptible.
- **Sidecar → Tauri event push** (sidecar initiates) — inverts the supervision relationship and
  gives the helper an unsolicited channel into the shell; the pull-based pump keeps the helper a
  pure servant.

## Consequences

- The event buffer makes the sidecar stateful-per-cursor; the bound + `resync` flag keep that
  honest (a consumer can always fall back to the list routes).
- The pump is the first host component that acts as a standing on-behalf-of-an-app reader;
  its tests must pin that emitted events carry no credential material and that unmount stops it.
- `connection-event` becomes the second consumer of `snug:host-event`; an SDK `useHostEvents`
  hook is recorded in next-steps as a follow-up (Telepath hand-rolls its listener outside the
  byte-checked embedded block).
- Media size posture: refuse-don't-truncate at the sidecar, cap-while-reading in Rust (unchanged),
  thumbnail as the graceful floor.
