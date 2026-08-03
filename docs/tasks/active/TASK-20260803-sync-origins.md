# TASK-20260803-sync-origins: SyncProvider, sync loop, Dropbox adapter, export/import UI (child 4 of portable-hub)

- **Status**: planned
- **Owner**: Jeetu
- **Risk tier**: medium (client-side only; server endpoints live in child 5)
- **Branch**: `feat/TASK-20260803-portable-hub` (umbrella branch)
- **Packages touched**: `db` (sync module), `apps/playground`
- **Spec impact**: SyncProvider contract described in spec v0.2 prose (child 6)
- **Related**: umbrella [TASK-20260803-portable-hub](TASK-20260803-portable-hub.md) (§Amendments — redesigned sync/secrets state machine, F1/F5/F6/F11/F12), ADR-0009

## Spec (what & why)

Client-side sync of the user DB per amended ADR-0009: OPFS authoritative; interval + changed-hash push; out-of-image push-state sidecar; pull-merge (secrets preserved, no-unpushed-changes precondition, divergence surfaced, LWW only on user action); fail-closed corruption recovery; no pagehide network push; Web Lock single writer + BroadcastChannel. Providers: `hubOrigin` (against mocked endpoints until child 5) + `dropbox` (PKCE public client, raw fetch, token in `snug_secrets`). Export/Import UI (strip secrets by default; opt-in include; re-confirmation of imported executable config per F15).

**Acceptance criteria** (umbrella AC5/AC11/AC12):
1. SyncProvider contract suite passes for both providers (fetch-mocked).
2. Push payload contains zero secret bytes; local secrets survive push→pull round-trip (pull-merge).
3. Stale `baseRevision` → divergence surfaced, no silent overwrite; explicit user action applies LWW.
4. Push loop: content-hash gate (no push when unchanged), interval decoupled from OPFS debounce, sidecar revision never re-dirties the image (F5).
5. Corruption during open → quarantine + origin restore attempt + no auto-push (F6).
6. Local-newer-than-origin at session start → pushes up; empty origin never clobbers local (F1).
7. Export downloads canonical `.sqlite`; import round-trips; import triggers settings re-confirmation (F15).

**Out of scope**: server `/userdb` endpoints + auth binding (child 5), non-Dropbox third-party providers.

## Plan

Files: `packages/db/src/sync/{provider.ts,loop.ts,sidecar.ts,hub-origin.ts,dropbox.ts}` + tests → `apps/playground` origin picker + Export/Import UI (generalizing `run/exportDb.ts` download path). Tests FIRST per AC.

## Decisions & surprises

—

## Session journal (append-only, newest last)
