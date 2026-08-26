/**
 * helperInstall — the on-demand helper download's host state (ADR-0060 §§3,6).
 *
 * One store per helper NAME. `refreshHelperStatus` is a disk + pin read through the
 * platform seat (no network); `installHelper` is the download and runs ONLY from a user
 * click — nothing in this module calls it unasked. A second click while one install is in
 * flight joins the first (one promise per name), mirroring the Rust-side lock.
 *
 * Web has no seat: every reader gets `undefined` and every surface stays hidden.
 */
import { getPlatform, type HelperInstallProgressSeat, type HelperStatusSeat } from '../platform/platform.js';
import { createStore, useStore } from './store.js';

export const WHATSAPP_HELPER = 'whatsapp-sidecar';

export type HelperInstallState =
  | { phase: 'unknown' }
  | { phase: 'ready'; status: HelperStatusSeat }
  | { phase: 'installing'; status: HelperStatusSeat | undefined; progress: HelperInstallProgressSeat | undefined }
  | { phase: 'error'; status: HelperStatusSeat | undefined; message: string };

const stores = new Map<string, ReturnType<typeof createStore<HelperInstallState>>>();
const inFlight = new Map<string, Promise<HelperStatusSeat>>();
const refreshing = new Map<string, Promise<HelperStatusSeat | undefined>>();

function storeFor(name: string) {
  let s = stores.get(name);
  if (s === undefined) {
    s = createStore<HelperInstallState>({ phase: 'unknown' });
    stores.set(name, s);
  }
  return s;
}

export function useHelperInstall(name: string): HelperInstallState {
  return useStore(storeFor(name));
}

/** Is a download offer warranted? Absent, or a downloaded tree that no longer matches the pin. */
export function helperNeedsInstall(status: HelperStatusSeat | undefined): boolean {
  if (status === undefined) return false;
  // absent, or a downloaded tree that lost its runtime (`broken`) — both are "not installed"
  if (!status.installed) return true;
  return status.kind === 'downloaded' && status.mismatch;
}

/** Re-read disk + pin. `undefined` on web (no seat) — callers hide their surface. */
export async function refreshHelperStatus(name: string): Promise<HelperStatusSeat | undefined> {
  const seat = getPlatform().helperStatus;
  if (seat === undefined) return undefined;
  // Coalesced: the header chip, the run view and the card all ask at the same moment on
  // mount — one IPC round trip answers all of them (review: efficiency 6).
  const pending = refreshing.get(name);
  if (pending !== undefined) return pending;
  const store = storeFor(name);
  const run = seat(name)
    .then((status) => {
      const current = store.get();
      if (current.phase !== 'installing') store.set({ phase: 'ready', status });
      return status;
    })
    .catch((err: unknown) => {
      store.set({ phase: 'error', status: undefined, message: err instanceof Error ? err.message : String(err) });
      return undefined;
    })
    .finally(() => {
      refreshing.delete(name);
    });
  refreshing.set(name, run);
  return run;
}

/** THE CLICK. Download → verify → install → start, with progress; joins an in-flight install. */
export async function installHelper(name: string): Promise<HelperStatusSeat> {
  const seat = getPlatform().helperInstall;
  if (seat === undefined) throw new Error('helpers can only be installed from the desktop app');
  const existing = inFlight.get(name);
  if (existing !== undefined) return existing;
  const store = storeFor(name);
  const before = store.get();
  // Carry whatever status is known (may be none) — never a fabricated one.
  const status = before.phase === 'unknown' ? undefined : before.status;
  store.set({ phase: 'installing', status, progress: undefined });
  const run = seat(name, (progress) => {
    const now = store.get();
    if (now.phase === 'installing') store.set({ ...now, progress });
  })
    .then((done) => {
      store.set({ phase: 'ready', status: done });
      return done;
    })
    .catch((err: unknown) => {
      store.set({ phase: 'error', status, message: err instanceof Error ? err.message : String(err) });
      throw err;
    })
    .finally(() => {
      inFlight.delete(name);
    });
  inFlight.set(name, run);
  return run;
}

export function formatMegabytes(bytes: number): string {
  if (bytes <= 0) return '?';
  return `${Math.max(1, Math.round(bytes / 1048576))} MB`;
}

export function __resetHelperInstallForTests(): void {
  stores.clear();
  inFlight.clear();
  refreshing.clear();
}
