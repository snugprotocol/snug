/**
 * THE ORPHAN WATCH (TASK-20260818-sidecar-orphan-reap).
 *
 * WHY A HELPER MUST NOTICE ITS OWN PARENT DYING. WhatsApp permits one live connection per
 * linked device. Two helpers against the same Baileys auth store therefore do not merely
 * duplicate work — they replace each other's stream, forever, and the user's terminal fills
 * with `stream:error … conflict type=replaced` while neither one holds a usable session.
 *
 * The shell already reaps this process on a CLEAN exit (`sidecar.rs::shutdown`, ADR-0037).
 * Nothing covered the unclean one: a crash, a `kill -9`, or a `tauri dev` rebuild leaves
 * this process alive with a dead parent, and the next launch spawns the rival. Observed live
 * 2026-08-19 — an orphan from 18:23 (ppid 1) fighting a supervised helper from 22:41.
 *
 * The signal is REPARENTING, not "ppid === 1". On macOS launchd adopts orphans, but a Linux
 * subreaper (systemd --user, a container init) adopts them to some other pid instead — so
 * the only portable fact is that the ppid we were born with is no longer the ppid we have.
 *
 * Polling, not a signal: Unix offers no portable "parent died" notification (`prctl`'s
 * PDEATHSIG is Linux-only and does not survive the exec Node performs). A cheap integer read
 * every couple of seconds costs nothing measurable against a process that holds a websocket.
 */

export interface ParentWatchOptions {
  /** Injected so tests never fork a real parent. Defaults to this process's ppid. */
  getPpid?: () => number;
  /** How often to look. Default 2s — fast enough that a rival never gets a foothold. */
  intervalMs?: number;
  /**
   * Run the SAME clean shutdown SIGTERM runs: the final thread-cache flush (ADR-0037 §1)
   * and the socket-file removal. An orphan that exited hard would drop the last debounce
   * window of synced content, which is the very thing ADR-0037 set out to stop.
   */
  onOrphaned: () => void;
}

const DEFAULT_INTERVAL_MS = 2000;

/**
 * Watch for reparenting; call `onOrphaned` at most once. Returns a stop function.
 *
 * FIRES ONCE, deliberately: the handler closes a server and exits, and a second call
 * partway through would race its own cleanup.
 */
export function watchParent(options: ParentWatchOptions): () => void {
  const getPpid = options.getPpid ?? ((): number => process.ppid);
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  let initial: number | undefined;
  try {
    initial = getPpid();
  } catch {
    // Cannot read a baseline, so there is nothing to compare against later. Watching is
    // an optimisation on top of the shell's own reap — never a reason to refuse to start.
    return () => {};
  }

  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    let current: number;
    try {
      current = getPpid();
    } catch {
      // An unreadable ppid is UNKNOWN, not orphaned. Treating a transient failure as a
      // death sentence would kill a healthy helper mid-session.
      return;
    }
    if (current === initial) return;
    fired = true;
    clearInterval(timer);
    options.onOrphaned();
  }, intervalMs);

  // Never hold Node open on our own account: a watch that outlived the work it guards is
  // the exact species of process this file exists to prevent.
  timer.unref?.();

  return () => {
    fired = true;
    clearInterval(timer);
  };
}
