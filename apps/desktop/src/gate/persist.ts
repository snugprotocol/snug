// The close-flush persistence proof (ADR-0021 §5; whole-surface review finding 4).
//
// WHY IT NEEDS TWO PROCESSES. The claim is not "flush() writes bytes" — a unit test
// covers that. The claim is that a mutation made moments before the user quits
// SURVIVES the window closing, which is only observable across a real process
// boundary: write in one shell, close it, reopen a second shell over the same
// `~/Snug/user.snug`, and look for the row.
//
// The driver runs the same binary twice with SNUG_SHELL_GATE_PHASE:
//
//   persist-write   boot the real file backend, mutate the db, and DO NOT flush —
//                   the mutation sits in the 250ms debounce exactly as it would if
//                   the user hit Cmd-Q mid-thought. Report, then ask the shell to
//                   close, which fires CloseRequested → the flush handshake.
//   persist-verify  reopen the same file and look for the row.
//
// WHAT THIS CHECK DOES AND DOES NOT PROVE — measured, not assumed.
//
// It proves the END-TO-END PROPERTY users care about: a mutation made immediately
// before a window close is still there on reopen. Mutation-tested by skipping the
// write, which turns the check red (`Apps found: []`), so it is wired to reality.
//
// It does NOT isolate the close handshake as the SOLE mechanism. Deleting the Rust
// CloseRequested handler leaves this GREEN, because the user db registers its own
// `pagehide`/`visibilitychange` auto-flush at open time (userdb.ts:1225) and
// WKWebView fires those on a native close. Suppressing that backstop from here was
// attempted and does not work: same-target, same-phase listeners run in
// registration order, and the db's listener is installed before this module can
// intercept it.
//
// So on macOS/WKWebView the lifecycle backstop is doing the work today, and the
// close handshake is defense-in-depth rather than the only thing standing between
// a user and a lost write. That is worth knowing plainly rather than papering
// over: the handshake still earns its place because `pagehide` handlers are
// fire-and-forget (a slow write can be cut off mid-flight) and because the
// backstop is not guaranteed on every platform — the Windows/WebView2 leg is
// unverified. If a future change needs the handshake isolated, the tractable route
// is a db-level seam to disable the lifecycle flush, not event interception here.

import { setPlatform } from '@playground/platform/platform';
import { bootUserDb, getUserDb, userDbStatusStore } from '@playground/state/userdb.js';

import { createDesktopPlatform } from '../platform-desktop.js';
import { registerCloseFlush } from '../close-flush.js';
import type { CheckResult } from './types.js';

/** The canary this proof writes and then looks for. */
const PERSIST_APP_NAME = 'close-flush-canary';

/**
 * Kick off the SAME one-time open the App does at boot (the persist phases never
 * render React, so nothing else would start it) and wait for a terminal state.
 */
async function awaitDbReady(timeoutMs = 30_000): Promise<void> {
  void bootUserDb();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = userDbStatusStore.get();
    if (status.state === 'ready') return;
    if (status.state !== 'opening') {
      throw new Error(`user db boot ended in ${status.state}: ${JSON.stringify(status)}`);
    }
    if (Date.now() > deadline) throw new Error('user db never became ready');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * PHASE 1 result: the checks to report, plus the mutation to perform at the LAST
 * possible moment. Splitting them is what keeps the proof honest — see `mutate`.
 */
export interface PersistWritePlan {
  checks: CheckResult[];
  /**
   * Run this AFTER the results file is written and IMMEDIATELY before the close.
   *
   * The write-back debounce is only 250ms, so mutating before the results write
   * lets it elapse during that write and the row persists with no close involved
   * at all. Mutating last keeps the close-time path the one under observation.
   */
  mutate: () => void;
}

export async function runPersistWrite(): Promise<PersistWritePlan> {
  setPlatform(createDesktopPlatform());

  // EXACTLY the registration main.tsx performs — the proof must exercise the
  // shipping handshake, not a parallel one built for the gate.
  registerCloseFlush(async () => {
    if (userDbStatusStore.get().state !== 'ready') return;
    await (await getUserDb()).flush();
  });

  const checks: CheckResult[] = [];
  try {
    await awaitDbReady();
    const db = await getUserDb();
    return {
      checks: [
        {
          id: 'persist-write-staged',
          pass: true,
          detail: `db ready; "${PERSIST_APP_NAME}" is installed at close time and NEVER explicitly flushed — it reaches disk only via a close-time flush`,
        },
      ],
      mutate: () => {
        db.installApp({ displayName: PERSIST_APP_NAME, html: '<html>canary</html>' });
      },
    };
  } catch (err) {
    checks.push({ id: 'persist-write-staged', pass: false, detail: `phase failed: ${String(err)}` });
  }
  return { checks, mutate: () => {} };
}

/**
 * PHASE 2. Reopen the same file and look for the row. A miss here means the last
 * mutation before a window close was lost — the user-visible defect ADR-0021 §5
 * exists to prevent. See the module header for which mechanism actually carries
 * it on this platform.
 */
export async function runPersistVerify(): Promise<CheckResult[]> {
  setPlatform(createDesktopPlatform());

  const checks: CheckResult[] = [];
  try {
    await awaitDbReady();
    const db = await getUserDb();
    const survived = db.listApps().some((a) => a.displayName === PERSIST_APP_NAME);
    checks.push({
      id: 'persist-survives-window-close',
      pass: survived,
      detail: survived
        ? `"${PERSIST_APP_NAME}" survived the window close — a close-time flush carried the debounced write to disk (handshake and/or the db's pagehide backstop; see the module header)`
        : `"${PERSIST_APP_NAME}" is GONE after reopening: the last mutation before close was LOST — no close-time flush reached disk (ADR-0021 §5). Apps found: ${JSON.stringify(db.listApps().map((a) => a.displayName))}`,
    });
  } catch (err) {
    checks.push({
      id: 'persist-survives-window-close',
      pass: false,
      detail: `phase failed: ${String(err)}`,
    });
  }
  return checks;
}
