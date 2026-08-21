# 0009 — User-DB sync: OPFS runtime copy, pluggable origin via SyncProvider, last-writer-wins v1

- **Status:** accepted — **amended 2026-08-20 by [ADR-0042](0042-snug-file-extension.md)** (the canonical export is `.snug`, with the legacy `.sqlite` still read on input) and **[ADR-0043](0043-passphrase-encryption-at-rest.md)** (a personal origin may carry a protected container; a hub origin keeps receiving secrets-stripped plaintext).
- **Date:** 2026-08-03
- **Task:** TASK-20260803-portable-hub

## Context
The single user DB (ADR-0007) runs in browser OPFS at runtime. Users need it durable and portable: hosted by the hub by default, but switchable to personal storage (Dropbox, OneDrive, Drive, S3), always exportable, and restorable on a new device after login.

## Decision
- **OPFS is authoritative; the origin is a replica.** A background loop pushes the serialized DB to the configured **origin** on an interval gated by a content-hash change check; session start reconciles (see safety rules).
- Origins implement a small **`SyncProvider` interface** (roughly: `pull() → {bytes, revision}`, `push(bytes, baseRevision) → revision`, `info()`). Hub-hosted origin is the default provider; **Dropbox** ships as the example third-party adapter; OneDrive/Drive/S3 are interface-conformant future work.
- **Push-state lives outside the synced image** (OPFS sidecar: last pushed revision, content hash, dirty flag) — the image never contains its own revision, so pushing cannot re-dirty the DB. Origin *config* stays inside the DB (`snug_sync`) so the ported file remains self-describing.
- **Pull is a merge, never a swap**: local `snug_secrets` rows are preserved into any pulled image; pull replaces local state only when local has no un-pushed changes; otherwise divergence is surfaced and last-writer-wins applies only on explicit user action. First login with existing local data **pushes up** — a freshly provisioned empty origin DB never clobbers local state.
- **Corruption fails closed at the user-DB level** (unlike the per-app driver's fail-open): corrupt local bytes are quarantined (`.bak`), restore is attempted from origin, and nothing auto-pushes after recovery without user confirmation.
- **No pagehide network push** (keepalive caps ~64 KiB): pagehide flushes OPFS only; a local copy newer than origin pushes on next session start.
- **Multi-tab**: single writer via Web Lock; reader tabs are read-only with BroadcastChannel invalidation.
- **Export is mandatory hub behavior**: one-click download of the canonical `.snug` (ADR-0042; `.sqlite` before that); import likewise — this is the portability escape hatch that keeps hub providers honest. Default export strips secrets (ADR-0008); imported or first-pulled DBs are treated as executable config — endpoint/provider settings require re-confirmation before use.
- Multi-device concurrent-write merge (CRDT/changeset) is explicitly out of scope for v1 and a documented limitation.

## Alternatives considered
- **Server-mediated sync only** — rejected: contradicts the no-backend principle and re-centralizes the hub.
- **CRDT/changeset merge now** — rejected for v1: large complexity; LWW + explicit export covers the single-active-device reality; revisit when multi-device demand is real.
- **Sync config outside the DB** (hub-side account record) — rejected: the ported file would lose its own sync identity.

## Consequences
- A new browser-side sync module (likely `packages/db` or a new `packages/sync`) with timer + visibility/beforeunload flush; needs careful OPFS locking (single-tab writer v1).
- Dropbox adapter needs OAuth in the hub client — token stored in user-DB settings, same posture as BYOK keys (ADR-0008).
- Divergence UX (LWW warning) becomes part of the reference hub.
