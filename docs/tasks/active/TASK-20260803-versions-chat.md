# TASK-20260803-versions-chat: App versioning UX + persistent chat, client-authoritative in all modes (child 3 of portable-hub)

- **Status**: in-review (green incl. Playwright; umbrella review folded)
- **Owner**: Jeetu
- **Risk tier**: medium
- **Branch**: `feat/TASK-20260803-portable-hub` (umbrella branch)
- **Packages touched**: `apps/playground`, `apps/server` (artifact event consumption path), `knowledge` (artifact-write prompt edit-in-place semantics)
- **Spec impact**: none (prompt change follows ADR-0004 store rules)
- **Related**: umbrella [TASK-20260803-portable-hub](TASK-20260803-portable-hub.md) (§Amendments F4, F9), ADR-0007/0008

## Spec (what & why)

Every chat surface edits the app in place: `artifact_write` targets a **pinned app id** (per-app chat pins that app; a builder thread pins to the id its first write minted; defined new-app escape hatch). New versions land in `snug_app_versions` (≥5 retained, revert UI). Chat threads/messages persist in the user DB for all modes. Subscription mode becomes client-authoritative: on the SSE `artifact` event the client fetches `/artifacts/:id` and writes the version; server stores are transient cache.

**Acceptance criteria** (umbrella AC7/AC9/AC13):
1. Edit via per-app chat → new version of the same app id (BYOK and subscription modes both).
2. Version list + one-click revert restores exact HTML; 7 edits → 5 retained.
3. Fresh session over the same user-DB bytes → latest version loads; full thread history renders (builder + per-app threads).
4. Subscription edit lands in the user DB (client fetch on artifact event); export afterwards contains the newest version (AC13).
5. `artifact-write` prompt updated for edit-in-place; BYOK/server prompt parity preserved (knowledge lint + frame-literal sync stay green).

**Out of scope**: sync (child 4), auth (child 5).

## Plan

Files: `apps/playground/src/agent/{tools.ts,useBuilderChat.ts,builder.ts}` (target pinning, persistence, artifact-event fetch) → version list/revert UI in `run/RunView.tsx` rail or app sheet → `packages/knowledge/prompts/tools/artifact-write.md`. Tests FIRST per AC.

## Decisions & surprises

—

## Session journal (append-only, newest last)

### 2026-08-03 15:10 — Jeetu/Claude — session
- Done: `agent/artifactSink.ts` (host-side F9 pinning: per-app chat pins the app; builder thread installs-then-versions; new thread = new app escape hatch; pinned-no-row installs under the pinned id) + 4 sink tests; tools/builder rewired to the sink (`ArtifactEvent` gains `version`); `useBuilderChat(threadId, {pinnedAppId})` persists user+assistant messages to `snug_chat_threads/messages` and hydrates them on mount (AC9 test: fresh hook re-renders history); subscription mode client-authoritative (AC13 test: SSE artifact → client fetches `/artifacts/:id` → sink versions the pinned app; card points at the user-DB id, never the hub cache id); RunView rail: pinned `app:<id>` thread, versions tab (`run/VersionsPanel.tsx`, revert = copy-forward + frame remount), artifact events reload html; `artifact-write.md` prompt updated to edit-in-place semantics + `pnpm gen:content` (content-drift test caught the stale generation — regenerated).
- State: playground 45/45, knowledge 55/55. Chat artifact CARDS are not persisted (text history only) — documented limitation, fine for AC9's wording.
- Next step: integration pass (sync/auth UI) then consolidated Playwright run.
