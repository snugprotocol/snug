// Close-requested flush, webview half (ADR-0021 §5; whole-surface review finding 4).
//
// THE HOLE THIS FILLS. Desktop persistence rides the db driver's 250ms write-back
// debounce. The web path narrows that window with a `pagehide` auto-flush, but a
// native window close is not a pagehide — so the last mutation before quitting
// (rename an app, paste a credential, then Cmd-Q) could be dropped with no signal.
// ADR-0021 promised a close-requested flush; it was never implemented.
//
// THE HANDSHAKE. Rust intercepts CloseRequested, calls `api.prevent_close()`, and
// emits `snug:close-flush`. This module awaits the userdb flush and then invokes
// `close_flush_done`, which destroys the window for real.
//
// TIME-BOXED ON BOTH SIDES. Rust closes anyway after its own deadline, and this
// side races the flush against a shorter one so a wedged sql.js write cannot even
// reach that. A flush that FAILS still closes: the user asked to quit, the bytes on
// disk are untouched by a failed write (the Rust write is atomic), and refusing to
// close would trap them in an unquittable app. Losing a debounced write is bad; an
// app that cannot be quit is worse.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Webview-side budget; must stay under the Rust CLOSE_FLUSH_DEADLINE_MS (3000). */
const FLUSH_BUDGET_MS = 2_000;

export interface CloseFlushDeps {
  /** Resolves the live user db. Rejects/hangs when the db never opened — both handled. */
  flush: () => Promise<void>;
  /** Tell the shell the webview is done and the window may close. */
  done: () => Promise<void>;
  budgetMs?: number;
}

/**
 * One close cycle: flush within the budget, then always signal done.
 *
 * Returns what happened, for the gate + tests. Every path calls `done()` exactly
 * once — that is the property that keeps the window closable.
 */
export async function runCloseFlush(deps: CloseFlushDeps): Promise<'flushed' | 'timeout' | 'failed'> {
  const budget = deps.budgetMs ?? FLUSH_BUDGET_MS;
  let outcome: 'flushed' | 'timeout' | 'failed' = 'flushed';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      deps.flush().then(
        () => {
          outcome = 'flushed';
        },
        (err: unknown) => {
          // A failed flush must not block the close (see the header).
          outcome = 'failed';
          console.error('[snug] close flush failed — closing anyway', err);
        },
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          outcome = 'timeout';
          resolve();
        }, budget);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  await deps.done();
  return outcome;
}

/**
 * Register the handler. Desktop-only: on web nothing emits `snug:close-flush`.
 *
 * `flush` is injected rather than imported at module scope so this file does not
 * force a userdb open just by being loaded — the db is resolved lazily, when a
 * close actually happens.
 */
export function registerCloseFlush(flush: () => Promise<void>): void {
  void listen('snug:close-flush', () => {
    void runCloseFlush({
      flush,
      done: () => invoke('close_flush_done'),
    });
  });
}
