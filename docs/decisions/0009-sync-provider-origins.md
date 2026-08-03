# 0009 — User-DB sync: OPFS runtime copy, pluggable origin via SyncProvider, last-writer-wins v1

- **Status:** proposed (pending Gate 2 plan approval)
- **Date:** 2026-08-03
- **Task:** TASK-20260803-portable-hub

## Context
The single user DB (ADR-0007) runs in browser OPFS at runtime. Users need it durable and portable: hosted by the hub by default, but switchable to personal storage (Dropbox, OneDrive, Drive, S3), always exportable, and restorable on a new device after login.

## Decision
- **Runtime copy is OPFS**; a background sync loop periodically pushes the serialized DB to the configured **origin** and pulls on session start.
- Origins implement a small **`SyncProvider` interface** (roughly: `pull() → {bytes, revision}`, `push(bytes, baseRevision) → revision`, `info()`). Hub-hosted origin is the default provider; **Dropbox** ships as the example third-party adapter; OneDrive/Drive/S3 are interface-conformant future work.
- **Conflict policy v1: last-writer-wins** with revision tokens and a user-visible "newer copy exists" warning on divergence. Multi-device concurrent-write merge (CRDT/changeset) is explicitly out of scope for v1 and a documented limitation.
- **Export is mandatory hub behavior**: one-click download of the canonical `.sqlite`; import likewise — this is the portability escape hatch that keeps hub providers honest.
- Sync metadata (origin config, revision, last-sync time) lives in the user DB itself (hub-namespace), so the file remains self-describing when ported.

## Alternatives considered
- **Server-mediated sync only** — rejected: contradicts the no-backend principle and re-centralizes the hub.
- **CRDT/changeset merge now** — rejected for v1: large complexity; LWW + explicit export covers the single-active-device reality; revisit when multi-device demand is real.
- **Sync config outside the DB** (hub-side account record) — rejected: the ported file would lose its own sync identity.

## Consequences
- A new browser-side sync module (likely `packages/db` or a new `packages/sync`) with timer + visibility/beforeunload flush; needs careful OPFS locking (single-tab writer v1).
- Dropbox adapter needs OAuth in the hub client — token stored in user-DB settings, same posture as BYOK keys (ADR-0008).
- Divergence UX (LWW warning) becomes part of the reference hub.
