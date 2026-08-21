/**
 * The shell update channel's platform seat (ADR-0047, TASK-20260821) — the desktop
 * implementation of `SnugPlatform.appUpdates` over tauri-plugin-updater/-process.
 *
 * Contract notes the playground side leans on (platform.ts doc):
 *  - `check()` resolves undefined when up to date and REJECTS on an unreachable or
 *    malformed manifest — the CALLER picks the temperature (launch check quiet,
 *    Settings check loud). Pre-flip, the private repo 404s: that rejection is the
 *    NORMAL state, not an error to fix.
 *  - The `notes` field is UNTRUSTED display data (the minisign signature covers the
 *    downloaded artifact only, ADR-0047 §5) — passed through verbatim here, kept
 *    plain-text by the renderer.
 *  - `relaunch()` REAPS THE SIDECAR FIRST. AppHandle::restart() skips
 *    RunEvent::Exit delivery on the main thread (verdict in ADR-0047 §10), so the
 *    shell's exit-time reap cannot be assumed to run; a relaunch that skipped it
 *    would orphan the WhatsApp helper, and the next launch's rival would wedge the
 *    linked-device session (lessons 2026-08-18/19). The reap is best-effort — a
 *    helper that is not running answers `running: false` and the relaunch proceeds.
 */

import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';

import type { SnugPlatform } from '@playground/platform/platform';

import { sidecarCtl } from './sidecar.js';

type AppUpdates = NonNullable<SnugPlatform['appUpdates']>;

/** Seam injection for tests only — the shipped wiring uses the real plugin calls. */
export interface AppUpdatesDeps {
  getVersion: typeof getVersion;
  check: typeof check;
  relaunch: typeof relaunch;
  sidecarCtl: typeof sidecarCtl;
}

const REAL_DEPS: AppUpdatesDeps = { getVersion, check, relaunch, sidecarCtl };

export function createAppUpdates(deps: AppUpdatesDeps = REAL_DEPS): AppUpdates {
  // The checked update is a plugin RESOURCE (a rid held Rust-side); download must
  // run on the same handle the check minted, so it is held here between calls.
  let pending: Update | null = null;

  return {
    currentVersion: () => deps.getVersion(),

    async check() {
      const update = await deps.check();
      if (update === null) {
        pending = null;
        return undefined;
      }
      pending = update;
      return {
        version: update.version,
        ...(update.date !== undefined ? { date: update.date } : {}),
        ...(update.body !== undefined ? { notes: update.body } : {}),
      };
    },

    async downloadAndInstall(onProgress) {
      if (pending === null) throw new Error('no update to install — run check() first');
      let total: number | undefined;
      let received = 0;
      await pending.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength;
          onProgress?.(total === undefined ? undefined : 0);
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength;
          onProgress?.(total === undefined || total === 0 ? undefined : Math.min(received / total, 1));
        } else if (event.event === 'Finished') {
          onProgress?.(1);
        }
      });
    },

    async relaunch() {
      // REAP FIRST — see the header. Best-effort: an already-stopped helper (or a
      // build without the sidecar surface) must never block the user's update.
      try {
        await deps.sidecarCtl('stop');
      } catch {
        // No helper to reap — proceed.
      }
      await deps.relaunch();
    },
  };
}
