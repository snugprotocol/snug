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

import { spawn as nodeSpawn } from 'node:child_process';

/** What the opener needs of a child — `node:child_process`'s shape, and a fake's. */
export interface OpenerChild {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'spawn', listener: () => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  unref(): void;
}

export interface OpenerDeps {
  platform?: NodeJS.Platform;
  /** Injected so tests never launch a browser. */
  spawn?: (command: string, args: string[]) => OpenerChild;
  /** How long macOS's `open` may take to report before it is taken as started. */
  settleMs?: number;
}

/**
 * The program per platform. macOS ships `open` at a fixed path. Linux distributions do not
 * agree on where `xdg-open` lives, so it is found on PATH — and where there is no PATH the
 * `error` listener below is what makes that a sentence instead of a crash.
 */
const OPENERS: Partial<Record<NodeJS.Platform, { command: string; settlesOn: 'exit' | 'spawn' }>> = {
  // `open` hands the URL to LaunchServices and exits at once; its exit code is the answer
  // (non-zero with no window server — an ssh session, a CI runner).
  darwin: { command: '/usr/bin/open', settlesOn: 'exit' },
  // `xdg-open` may BECOME the browser and live as long as it does, so its exit is not
  // waited for: having started is all that can be known.
  linux: { command: 'xdg-open', settlesOn: 'spawn' },
};

const DEFAULT_SETTLE_MS = 5_000;

export function openInBrowser(url: string, deps: OpenerDeps = {}): Promise<void> {
  const opener = OPENERS[deps.platform ?? process.platform];
  if (opener === undefined) return Promise.reject(new Error('no browser opener is known for this platform'));
  const spawn = deps.spawn ?? ((command: string, args: string[]): OpenerChild => nodeSpawn(command, args, { stdio: 'ignore', detached: true }));

  return new Promise<void>((resolve, reject) => {
    let child: OpenerChild;
    try {
      child = spawn(opener.command, [url]);
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
