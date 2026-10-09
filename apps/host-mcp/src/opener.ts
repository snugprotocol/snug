// Opening the user's browser — the one act `snug_open` performs (L5).
//
// It carries the launch URL, fragment and all, to the browser as ONE argv entry of a
// program this process starts: the bearer goes from memory to the browser without crossing
// an MCP message, a file or a shell.
//
// WHAT WAS WRONG (found 2026-10-03). `spawn('open', [url])` with no `error` listener. A
// process a desktop host spawns has no user PATH (measured 2026-09-13), so the bare name is
// ENOENT there — and an `error` event with no listener is an uncaught exception. The first
// `snug_open` under Claude Desktop would have killed the runner with its lock held.
//
// So: an ABSOLUTE path where the platform has one, an `error` listener that stays attached
// for the child's whole life, and every failure a rejection — which the caller turns into
// the printed fallback naming the launcher's real path.
//
// WHAT WAS STILL WRONG (Gate 5, security/F2). The Linux opener was the bare `xdg-open`, so
// libuv walked PATH — and an empty entry (a trailing `:`) or `.` is the working directory,
// which for a plugin process is the agent's current project: the reviewer ran an executable
// `xdg-open` planted there, handed the bearer URL. And the child got Node's default
// environment, the WHOLE parent's: the session's `CLAUDE_CODE_MESSAGING_*` (a live channel
// back into it) and any API key, inherited on Linux by the browser `xdg-open` becomes and
// by everything that browser starts. Both openers are now absolute paths, and the child's
// environment is built from nothing by allowlist — the rule every brain child already
// follows (`childEnvFor`, ADR-0071 §3).

import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';

import { CHILD_ENV_ALLOWLIST } from './brains/brain.js';

/** What the opener needs of a child — `node:child_process`'s shape, and a fake's. */
export interface OpenerChild {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'spawn', listener: () => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  unref(): void;
}

export interface OpenerDeps {
  platform?: NodeJS.Platform;
  /**
   * The environment the opener's child is built FROM, by allowlist — the brain registry's one
   * read of the process environment, handed over by the release entry (`main.ts`). Absent,
   * the child gets an empty one: never this process's own by default.
   */
  parentEnv?: Readonly<Record<string, string | undefined>>;
  /** Injected so tests never launch a browser. */
  spawn?: (command: string, args: string[], env: Record<string, string>) => OpenerChild;
  /** How long macOS's `open` may take to report before it is taken as started. */
  settleMs?: number;
}

/**
 * The program per platform, by ABSOLUTE path on both. macOS ships `open` at a fixed path.
 * Linux distributions put `xdg-open` (xdg-utils) at `/usr/bin` — and where one does not, the
 * spawn fails ENOENT, the `error` listener below makes that a rejection, and the caller prints
 * the fallback (`snug open --print`). Not finding a browser is a sentence; running whatever a
 * PATH lookup finds in the agent's project folder is a hole.
 */
const OPENERS: Partial<Record<NodeJS.Platform, { command: string; settlesOn: 'exit' | 'spawn' }>> = {
  // `open` hands the URL to LaunchServices and exits at once; its exit code is the answer
  // (non-zero with no window server — an ssh session, a CI runner).
  darwin: { command: '/usr/bin/open', settlesOn: 'exit' },
  // `xdg-open` may BECOME the browser and live as long as it does, so its exit is not
  // waited for: having started is all that can be known.
  linux: { command: '/usr/bin/xdg-open', settlesOn: 'spawn' },
};

/**
 * What the opener's child may inherit, by name: the brains' allowlist (HOME, PATH, the locale,
 * the shell, the user) and what a Linux opener needs to reach the user's desktop — the X and
 * Wayland displays, XAUTHORITY (the PATH of the X cookie file: under a display manager it is
 * not `~/.Xauthority`, and an X11 browser without it cannot open a window), the session bus
 * `xdg-open` asks through, and the two variables its generic fallback reads to pick a browser.
 * macOS's `open` needs none of the desktop names — LaunchServices starts the browser with
 * launchd's environment, not the opener's — and gets the same list, which costs it nothing.
 */
export const OPENER_ENV_ALLOWLIST = [
  ...CHILD_ENV_ALLOWLIST,
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'DESKTOP_SESSION',
  'BROWSER',
] as const;

/** Families kept whole: the freedesktop directories and desktop name, and the locale categories. */
export const OPENER_ENV_PREFIXES = ['XDG_', 'LC_'] as const;

/**
 * The opener child's environment, built from NOTHING. An allowlist, not a denylist of
 * `CLAUDE_*` and the vendors' keys, for the reason `childEnvFor` gives: the session's own
 * variables are undocumented and grow between versions, and a denylist leaks the first new one.
 *
 * PATH keeps its ABSOLUTE entries only. `xdg-open` is a shell script that looks up `gio`,
 * `kde-open`, a browser, by name — an empty or relative entry would hand those lookups the
 * working directory the opener's own absolute path just took away.
 */
export function openerEnvFor(parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (typeof value !== 'string') continue;
    const allowed = (OPENER_ENV_ALLOWLIST as readonly string[]).includes(name) || OPENER_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (allowed) env[name] = value;
  }
  if (env.PATH !== undefined) {
    const absolute = env.PATH.split(path.delimiter).filter((entry) => path.isAbsolute(entry));
    if (absolute.length > 0) env.PATH = absolute.join(path.delimiter);
    else delete env.PATH;
  }
  return env;
}

/**
 * The real spawn — exported so a test can show the child receives exactly `env`. With no
 * `env` option Node hands the child `process.env` whole, so this line is the guard.
 */
export function spawnOpener(command: string, args: string[], env: Record<string, string>): OpenerChild {
  return nodeSpawn(command, args, { stdio: 'ignore', detached: true, env });
}

const DEFAULT_SETTLE_MS = 5_000;

export function openInBrowser(url: string, deps: OpenerDeps = {}): Promise<void> {
  const opener = OPENERS[deps.platform ?? process.platform];
  if (opener === undefined) return Promise.reject(new Error('no browser opener is known for this platform'));
  const spawn = deps.spawn ?? spawnOpener;
  const env = openerEnvFor(deps.parentEnv ?? {});

  return new Promise<void>((resolve, reject) => {
    let child: OpenerChild;
    try {
      child = spawn(opener.command, [url], env);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    // Attached FIRST and never removed: after the promise settles a late `error` lands on
    // an already-settled promise (a no-op) instead of on nobody (an uncaught exception).
    child.on('error', reject);
    if (opener.settlesOn === 'spawn') {
      child.on('spawn', () => resolve());
    } else {
      const timer = setTimeout(resolve, deps.settleMs ?? DEFAULT_SETTLE_MS);
      timer.unref?.();
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`${opener.command} ended with exit code ${String(code)}`));
      });
    }
    // A browser left open must never hold the runner's exit.
    child.unref();
  });
}
