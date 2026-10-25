# TASK-20261024-desktop-v0.1.4: Desktop v0.1.4 — release and publish

- **Status**: in-progress
- **Owner**: Jeetu
- **Risk tier**: high — a GitHub Release every installed client trusts (`latest.json`, the signed updater artifact; ADR-0047)
- **Branch**: `feat/TASK-20261024-desktop-v0.1.4` (off `main` @ `70c32fe`)
- **Packages touched**: `apps/playground` (`desktop-releases.json` — the notes), `apps/desktop` (the three version declarations the script bumps)
- **Spec impact**: none
- **Related**: ADR-0047 (desktop release) · ADR-0078 (the ChatGPT plan — reaches users only with this release) · next-steps 2026-10-09 (the http-scope fix waits on v0.1.4) and 2026-10-24 · PROCESS.md release rules

## Spec (what & why)

The owner's explicit ask (2026-10-24): "release the next snug desktop version and publish it". v0.1.3 (2026-09-05) is the latest; 43 commits have landed since. This release ships what reached the shell in that time: the ChatGPT plan (#214), scheduled tasks and Mac notifications (#193–#197), access between apps (#198), the host broker's chat and schedule doors (#200–#207), the rail-chat fixes (#209) and the RFC-1918 http scope (#191).

**Acceptance criteria:**
1. `desktop-releases.json`'s newest entry is 0.1.4, and `check-release-desktop` and the update-sheet notes tests pass.
2. `release-desktop.mjs 0.1.4 --publish` runs to the end: the release gate, a universal build, notarized and stapled, Gatekeeper `source=Notarized Developer ID`, EULA carried.
3. Verified from the published release: `releases/latest/download/latest.json` serves 0.1.4, the re-downloaded DMG passes `stapler validate` and `spctl`, and the helper pre-release stays beneath it.
4. The version bumps the script wrote land in their own PR (the 0.1.3 pattern, #170).

**Out of scope**: the owner walks this release enables — the 0.1.3→0.1.4 in-app update, the on-glass LAN walk, the ChatGPT-plan walk on a release build.

## Plan

1. Notes PR (this branch): `desktop-releases.json` entry + this task file → CI → merge.
2. On `main`: `node scripts/release-desktop.mjs 0.1.4 --publish`. The app-specific password is prompted, so the owner runs the script or supplies `APPLE_PASSWORD`.
3. Verify (AC3), journal it, bumps PR, done-move.

## Decisions & surprises

## Session journal (append-only, newest last)

### 2026-10-24 — Claude (Opus 5.5) — session

Notes drafted from the merged PRs since v0.1.3 and checked against the shipped copy (`access/copy.ts` durations, `schedule/copy.ts` missed-policy and alert labels, `CHATGPT_DATA_USE`, `DesktopWelcome`).

**Finding (release hardening, not fixed here):** `tauri.conf.json`'s `beforeBuildCommand` is `pnpm build:web`, which never rebuilds `packages/*`. The release therefore bundles whatever `packages/*/dist` is on disk. This checkout's `packages/protocol/dist` predated `jwtShapeInText`, which showed up as 2 reds in `downloadSurfaces.test.tsx` and was cleared by `pnpm -r --filter "./packages/**" build`. Before any release build, rebuild the packages from the tree being released. A `release-desktop.mjs` step should do this itself (queued in next-steps).
