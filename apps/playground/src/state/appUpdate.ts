// appUpdate.ts — the shell update channel's host state (ADR-0047, TASK-20260821).
//
// Everything here renders NOTHING unless the platform supplies `appUpdates` (web
// never does — the web hub's story is the /download page). Two temperatures, one
// check: the LAUNCH check is quiet about failure because pre-flip the endpoint 404s
// for everyone by design (a banner would cry wolf on every boot forever); the
// SETTINGS check reports failure by name, because the user just asked. The launch
// check is TOGGLEABLE (`snug:auto-update-check`) — it is a phone-home (GitHub learns
// IP/version/launch time) and the threat-model delta names it; only the literal
// string 'false' disables, so a corrupted key fails toward the feature (the
// railLayout precedent).
//
// The offer is a CHIP, never a gate: lessons 2026-08-20 — a brand-new surface that
// blocks the hub is a modal with extra steps. Installing is strictly opt-in
// (ADR-0045 doctrine inherited by ADR-0047 §3).

import { getPlatform } from '../platform/platform.js';
import { createStore, useStore } from './store.js';

const AUTO_CHECK_KEY = 'snug:auto-update-check';

export interface AppUpdateOffer {
  version: string;
  date?: string;
  /** UNTRUSTED display data (ADR-0047 §5) — render as plain text, never linkify. */
  notes?: string;
}

export type AppUpdateState =
  | { phase: 'idle' }
  | { phase: 'checking'; quiet: boolean }
  | { phase: 'current'; checkedAt: number }
  | { phase: 'available'; offer: AppUpdateOffer }
  | { phase: 'downloading'; offer: AppUpdateOffer; progress: number | undefined }
  | { phase: 'ready-to-restart'; offer: AppUpdateOffer }
  | { phase: 'check-failed'; message: string };

export const appUpdateStore = createStore<AppUpdateState>({ phase: 'idle' });

export function useAppUpdate(): AppUpdateState {
  return useStore(appUpdateStore);
}

export function autoCheckEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_CHECK_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setAutoCheckEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_CHECK_KEY, String(enabled));
  } catch {
    /* private mode — the choice still applies for this session */
  }
}

/**
 * One check, caller-picked temperature. `quiet: true` (the launch check) folds a
 * failure back to `idle` — silence is the designed pre-flip behavior, and an
 * unreachable manifest on boot is not news. `quiet: false` (the Settings button)
 * lands on `check-failed` with the transport's sentence, because the user asked and
 * an unnamed failure would send them hunting (lessons 2026-08-17: a permanent
 * failure and a normal wait must not render identically).
 */
export async function checkForAppUpdate(options: { quiet: boolean }): Promise<void> {
  const updates = getPlatform().appUpdates;
  if (updates === undefined) return;
  const phase = appUpdateStore.get().phase;
  if (phase === 'checking' || phase === 'downloading' || phase === 'ready-to-restart') return;
  appUpdateStore.set({ phase: 'checking', quiet: options.quiet });
  try {
    const offer = await updates.check();
    appUpdateStore.set(offer === undefined ? { phase: 'current', checkedAt: Date.now() } : { phase: 'available', offer });
  } catch (err) {
    appUpdateStore.set(
      options.quiet ? { phase: 'idle' } : { phase: 'check-failed', message: String(err instanceof Error ? err.message : err) },
    );
  }
}

/**
 * The launch check: fires once per boot, on desktop, unless the user turned it off.
 * Exported as its own act (rather than inlined in App.tsx) so the composition-root
 * test can spy the seat and mutation-kill a dropped wire (plan-review finding 14 —
 * a quiet-by-design check that was never wired is indistinguishable from one that
 * ran and failed, so the WIRING carries its own test).
 */
export function initAppUpdateLaunchCheck(): void {
  if (getPlatform().appUpdates === undefined) return;
  if (!autoCheckEnabled()) return;
  void checkForAppUpdate({ quiet: true });
}

/** Download + install; the state carries progress and lands on ready-to-restart. */
export async function downloadAndInstallAppUpdate(): Promise<void> {
  const updates = getPlatform().appUpdates;
  const state = appUpdateStore.get();
  if (updates === undefined || state.phase !== 'available') return;
  const { offer } = state;
  appUpdateStore.set({ phase: 'downloading', offer, progress: undefined });
  try {
    await updates.downloadAndInstall((fraction) => {
      appUpdateStore.set({ phase: 'downloading', offer, progress: fraction });
    });
    appUpdateStore.set({ phase: 'ready-to-restart', offer });
  } catch (err) {
    // A failed download returns to the OFFER — the release is still real; retrying
    // is legitimate and the sentence says what happened.
    appUpdateStore.set({
      phase: 'check-failed',
      message: `the update could not be downloaded: ${String(err instanceof Error ? err.message : err)}`,
    });
  }
}

/** The second half: reap-then-relaunch lives in the platform seat (ADR-0047 §10). */
export async function relaunchForAppUpdate(): Promise<void> {
  const updates = getPlatform().appUpdates;
  if (updates === undefined || appUpdateStore.get().phase !== 'ready-to-restart') return;
  await updates.relaunch();
}

/** Test seam: reset the module store between cases. */
export function __resetAppUpdateForTests(): void {
  appUpdateStore.set({ phase: 'idle' });
}
