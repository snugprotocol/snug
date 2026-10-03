// AC7 — one process, one file (D-B23).
//
// The races this closes, all named by the plan review:
//  * SIMULTANEOUS SPAWN. Two sessions opening at once both find no lock, both bind (two
//    ephemeral binds NEVER collide), both write the file — last writer wins and the loser
//    is an unreapable orphan holding the user file. `O_EXCL` decides the winner BEFORE any
//    bind, so exactly one process owns the port.
//  * PID RECYCLING. A recycled pid belonging to a stranger is live and does not answer our
//    socket, so a naive "dead OR unresponsive ⇒ stale" rule classifies it stale — and if
//    take-over ever grows a kill, it kills the stranger. The desktop's own reaper says why:
//    "a number alone is never enough … a fix that killed strangers would be worse than the
//    conflict loop it repairs." Command identity decides.
//  * A LIVE PRIMARY'S SOCKET. The sidecar unlinks its socket before binding because it is
//    the only writer of that path. Here every peer is symmetric, so an unconditional
//    unlink would cut a live primary's socket out from under it and freeze its client
//    count. Only a proven-dead owner's socket is removed.

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquireLock,
  controlSocketPath,
  readLock,
  reassertLock,
  recordBoundPort,
  releaseLock,
  STARTING_WINDOW_MS,
  TAKEOVER_EXIT_WAIT_MS,
  TAKEOVER_MUTEX_STALE_MS,
  TAKEOVER_PROBE_SPREAD_MS,
  TAKEOVER_PROBES,
  takeoverMutexPath,
  type LockDeps,
} from '../lock.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'snug-host-lock-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Deps with everything injected: no real processes, no real sockets, no real waiting.
 *
 * The default sleep has a VALVE. `acquire` has waits whose end is a guard under test; with
 * that guard broken, a loop of instantly-resolved sleeps starves the test runner's own
 * timeout and the suite hangs instead of failing. A thousand sleeps is far past anything
 * the real rules ask for (the longest is the exit wait: fifty).
 */
const deps = (over: Partial<LockDeps> = {}): LockDeps => {
  let slept = 0;
  return {
    pid: 4242,
    isAlive: () => false,
    commandLineOf: () => undefined,
    probeSocket: async () => undefined,
    probePort: async () => false,
    sleep: async () => {
      if (++slept > 1_000) throw new Error('acquire is waiting for ever');
    },
    kill: () => {},
    now: () => 1_700_000_000_000,
    ...over,
  };
};

describe('acquiring', () => {
  it('writes the lock and reports ownership when nothing holds it', async () => {
    const got = await acquireLock(dir, { port: 43127, tokenHash: 'h', socket: `${dir}/s.sock` }, deps());
    expect(got.role).toBe('primary');
    const onDisk = readLock(dir);
    expect(onDisk).toMatchObject({ port: 43127, pid: 4242, tokenHash: 'h' });
  });

  it('is EXCLUSIVE — the second of two simultaneous acquires attaches instead of winning', async () => {
    // Both callers see no lock; only one may create the file. Without O_EXCL both "win",
    // both bind their own ephemeral port, and one becomes an orphan.
    const live = deps({ isAlive: () => true, commandLineOf: () => 'node /x/snug-mcp.mjs', probeSocket: async () => ({ tokenHash: 'h', port: 43127 }) });
    const first = await acquireLock(dir, { port: 43127, tokenHash: 'h', socket: `${dir}/s.sock` }, live);
    const second = await acquireLock(dir, { port: 43200, tokenHash: 'h2', socket: `${dir}/s2.sock` }, { ...live, pid: 9999 });
    expect(first.role).toBe('primary');
    expect(second.role).toBe('attached');
    if (second.role === 'attached') expect(second.port).toBe(43127);
    // the winner's record is untouched
    expect(readLock(dir)).toMatchObject({ port: 43127, pid: 4242 });
  });

  it('attaches to a live primary whose socket answers with the recorded hash', async () => {
    writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({ port: 43127, pid: 111, tokenHash: 'h', startedAt: 1, socket: `${dir}/s.sock` }));
    const got = await acquireLock(
      dir,
      { port: 0, tokenHash: 'mine', socket: `${dir}/mine.sock` },
      deps({ isAlive: () => true, commandLineOf: () => 'node /x/snug-mcp.mjs', probeSocket: async () => ({ tokenHash: 'h', port: 43127 }) }),
    );
    expect(got).toMatchObject({ role: 'attached', port: 43127 });
  });
});

describe('taking over a stale lock', () => {
  it('takes over when the recorded pid is dead', async () => {
    writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({ port: 43127, pid: 111, tokenHash: 'old', startedAt: 1, socket: `${dir}/s.sock` }));
    const got = await acquireLock(dir, { port: 43127, tokenHash: 'new', socket: `${dir}/s.sock` }, deps({ isAlive: () => false }));
    expect(got.role).toBe('primary');
    expect(readLock(dir)).toMatchObject({ tokenHash: 'new', pid: 4242 });
  });

  it('does NOT take over from a live process whose command line is a stranger — pids recycle', async () => {
    writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({ port: 43127, pid: 111, tokenHash: 'old', startedAt: 1, socket: `${dir}/s.sock` }));
    const got = await acquireLock(
      dir,
      { port: 43127, tokenHash: 'new', socket: `${dir}/s.sock` },
      deps({ isAlive: () => true, commandLineOf: () => '/usr/bin/some-unrelated-daemon --serve', probeSocket: async () => undefined }),
    );
    expect(got.role).toBe('refused');
    if (got.role === 'refused') expect(got.reason).toMatch(/another process/i);
  });

  it('takes over when a live pid IS ours by command line but its socket is gone (a wedged primary)', async () => {
    // MIGRATED with L8 (2026-10-03): the fixture's pid used to stay alive for ever and the
    // lock was taken anyway — i.e. the test pinned "signal, then do not wait", which is two
    // writers on one user file. The wedged owner now EXITS on the signal, as a real one does.
    writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({ port: 43127, pid: 111, tokenHash: 'old', startedAt: 1, socket: `${dir}/s.sock` }));
    let alive = true;
    const kill = vi.fn(() => {
      alive = false;
    });
    const got = await acquireLock(
      dir,
      { port: 43127, tokenHash: 'new', socket: `${dir}/s.sock` },
      deps({ isAlive: () => alive, commandLineOf: () => 'node /x/snug-mcp.mjs', probeSocket: async () => undefined, kill }),
    );
    expect(got.role).toBe('primary');
    // and the wedged owner is signalled, because it still holds the user file
    expect(kill).toHaveBeenCalledWith(111);
  });

  it('never signals a stranger', async () => {
    writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({ port: 43127, pid: 111, tokenHash: 'old', startedAt: 1, socket: `${dir}/s.sock` }));
    const kill = vi.fn();
    await acquireLock(
      dir,
      { port: 43127, tokenHash: 'new', socket: `${dir}/s.sock` },
      deps({ isAlive: () => true, commandLineOf: () => '/usr/bin/postgres', probeSocket: async () => undefined, kill }),
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it('treats a corrupt lock file as stale rather than crashing', async () => {
    writeFileSync(path.join(dir, 'lock.json'), '{not json');
    const got = await acquireLock(dir, { port: 43127, tokenHash: 'new', socket: `${dir}/s.sock` }, deps());
    expect(got.role).toBe('primary');
  });
});

describe('releasing', () => {
  it('removes our own lock', async () => {
    await acquireLock(dir, { port: 43127, tokenHash: 'h', socket: `${dir}/s.sock` }, deps());
    await releaseLock(dir, 'h');
    expect(readLock(dir)).toBeUndefined();
  });

  it('does NOT remove a lock another process has since taken', async () => {
    // Our exit must not clear the newcomer's record — that would let a third process win a
    // port two others are already using.
    await acquireLock(dir, { port: 43127, tokenHash: 'h', socket: `${dir}/s.sock` }, deps());
    writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({ port: 43200, pid: 777, tokenHash: 'theirs', startedAt: 2, socket: `${dir}/t.sock` }));
    await releaseLock(dir, 'h');
    expect(readLock(dir)).toMatchObject({ tokenHash: 'theirs' });
  });

  it('is idempotent', async () => {
    await releaseLock(dir, 'h');
    await expect(releaseLock(dir, 'h')).resolves.toBeUndefined();
  });
});

describe('what the lock file may contain', () => {
  it('records the token HASH, never the token', async () => {
    // The hash is the attach handshake's identity check. A 256-bit CSPRNG token's SHA-256
    // has no preimage worth publishing, but the token itself must never touch disk (D-B8).
    await acquireLock(dir, { port: 43127, tokenHash: 'sha256-of-it', socket: `${dir}/s.sock` }, deps());
    const raw = readFileSync(path.join(dir, 'lock.json'), 'utf8');
    expect(raw).toContain('tokenHash');
    expect(raw).not.toMatch(/"token"\s*:/);
  });
});

// ------------------------------------------------------------------ L1 / L8
//
// Added with the lifecycle range (TASK-20261003). Two findings shaped these:
//
//  * THE ATTACH PATH WAS DEAD IN THE SHIPPED BUILD. `acquire` read the command line FIRST and
//    the release wired that reader to `() => undefined`, so every live holder was a stranger
//    and a second window was always refused. Attaching must not depend on a process table at
//    all: a runner that answers its socket with the hash the lock records IS the lock's
//    owner. So the socket is probed first, and identity is read in exactly one situation.
//  * TAKE-OVER COULD KILL A HEALTHY RUNNER. One missed probe (a busy event loop, a slow
//    disk) was enough to signal a primary with pages open, and the lock was taken without
//    waiting for it to go — two writers on one user file for as long as its shutdown took.

const OURS = 'node /plugin/scripts/snug-mcp.mjs';
const lockFile = (): string => path.join(dir, 'lock.json');
const writeHeld = (over: Record<string, unknown> = {}): void =>
  writeFileSync(lockFile(), JSON.stringify({ port: 43127, pid: 111, tokenHash: 'old', startedAt: 1, socket: controlSocketPath(dir), ...over }));
const claim = (): { port: number; tokenHash: string; socket: string } => ({ port: 43127, tokenHash: 'new', socket: controlSocketPath(dir) });

describe('the socket is asked FIRST (L1)', () => {
  it('attaches without reading the command line or the process table — the hash is the identity', async () => {
    writeHeld();
    const commandLineOf = vi.fn(() => undefined);
    const isAlive = vi.fn(() => true);
    const got = await acquireLock(dir, claim(), deps({ commandLineOf, isAlive, probeSocket: async () => ({ tokenHash: 'old', port: 51000 }) }));
    expect(got).toMatchObject({ role: 'attached', port: 51000, pid: 111 });
    // The shipped build could not read a command line at all, and this is why that no
    // longer matters: nothing here asks for one.
    expect(commandLineOf).not.toHaveBeenCalled();
    expect(isAlive).not.toHaveBeenCalled();
  });

  it('a socket answering with a DIFFERENT hash is never attached to', async () => {
    // The mutant this kills: dropping the hash compare. Whoever answers is then joined —
    // including a runner for another lock generation, whose port and bearer are not ours.
    writeHeld();
    const kill = vi.fn();
    const got = await acquireLock(dir, claim(), deps({ isAlive: () => true, commandLineOf: () => OURS, probeSocket: async () => ({ tokenHash: 'somebody-else', port: 51000 }), kill }));
    expect(got).toMatchObject({ role: 'refused', code: 'lock-contended', pid: 111 });
    expect(kill).not.toHaveBeenCalled();
    expect(readLock(dir)).toMatchObject({ tokenHash: 'old', pid: 111 });
  });

  it('a dead pid with a silent socket is taken over — still without reading a command line', async () => {
    writeHeld();
    const commandLineOf = vi.fn(() => undefined);
    const got = await acquireLock(dir, claim(), deps({ commandLineOf, isAlive: () => false }));
    expect(got.role).toBe('primary');
    expect(commandLineOf).not.toHaveBeenCalled();
  });

  it('reads identity in exactly ONE situation: a live pid that does not answer', async () => {
    writeHeld();
    const commandLineOf = vi.fn(() => '/usr/sbin/cupsd -l');
    await acquireLock(dir, claim(), deps({ commandLineOf, isAlive: () => true }));
    expect(commandLineOf).toHaveBeenCalledTimes(1);
    expect(commandLineOf).toHaveBeenCalledWith(111);
  });

  it('a refusal names its row and the pid, for the refusal table', async () => {
    writeHeld();
    const got = await acquireLock(dir, claim(), deps({ isAlive: () => true, commandLineOf: () => '/usr/sbin/cupsd -l' }));
    expect(got).toMatchObject({ role: 'refused', code: 'lock-held-by-stranger', pid: 111 });
  });

  it('a stranger is refused AT ONCE — there is nothing to wait for, and nothing is signalled', async () => {
    writeHeld();
    const sleep = vi.fn(deps().sleep);
    const kill = vi.fn();
    await acquireLock(dir, claim(), deps({ isAlive: () => true, commandLineOf: () => 'vim /plugin/scripts/snug-mcp.mjs', sleep, kill }));
    expect(sleep).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('an unreadable command line is a stranger — the identity read is all that stands before a signal', async () => {
    // The mutant: dropping the identity read. Every silent live pid would then be signalled,
    // and pids recycle.
    writeHeld();
    const kill = vi.fn();
    const got = await acquireLock(dir, claim(), deps({ isAlive: () => true, commandLineOf: () => undefined, kill }));
    expect(got).toMatchObject({ role: 'refused', code: 'lock-held-by-stranger' });
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('identity survives an install path with a SPACE in it (L1, L8)', () => {
  // macOS's `ps` joins argv with spaces. The rule used to split on them, so a runner under
  // `~/Library/Application Support/…` was never "ours": wedged, it was refused as a stranger —
  // with a remedy to delete the lock of a process still holding the user file.
  let install: string;
  beforeEach(() => {
    install = path.join(dir, 'Application Support', 'plug', 'snug-mcp.mjs');
    mkdirSync(path.dirname(install), { recursive: true });
    writeFileSync(install, '');
  });

  it('a WEDGED runner of ours started from such a path is recognised, signalled, waited for and replaced', async () => {
    writeHeld();
    let alive = true;
    const kill = vi.fn(() => {
      alive = false;
    });
    const got = await acquireLock(dir, claim(), deps({ isAlive: () => alive, commandLineOf: () => `/opt/homebrew/bin/node ${install}`, kill }));
    expect(got.role).toBe('primary');
    expect(kill).toHaveBeenCalledWith(111);
    expect(readLock(dir)).toMatchObject({ tokenHash: 'new', pid: 4242 });
  });

  it('…and a process merely READING that bundle from such a path is still a stranger: refused, never signalled', async () => {
    writeHeld();
    const kill = vi.fn();
    const got = await acquireLock(dir, claim(), deps({ isAlive: () => true, commandLineOf: () => `/usr/bin/less ${install}`, kill }));
    expect(got).toMatchObject({ role: 'refused', code: 'lock-held-by-stranger', pid: 111 });
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('a primary that is still STARTING is waited for (the simultaneous-spawn race, second half)', () => {
  // `O_EXCL` picks the winner before anything binds — so for a moment the winner holds the
  // lock and has no socket yet. The loser, arriving in that moment, used to go straight to
  // "silent and alive": a process-table read, and on a path `ps` cannot split, a refusal
  // telling the user to delete the lock of a runner that was a second from being ready.
  const NOW = 1_700_000_000_000;
  const young = (ageMs: number): void => writeHeld({ startedAt: NOW - ageMs });
  /**
   * A clock that only moves when `acquire` sleeps. The valve turns a wait with no end into
   * a failed test: a loop of instantly-resolved sleeps would otherwise starve the runner's
   * own timeout and hang the suite.
   */
  const clockwork = () => {
    let elapsed = 0;
    const sleep = vi.fn(async (ms: number) => {
      elapsed += ms;
      if (sleep.mock.calls.length > 1_000) throw new Error('acquire is waiting for ever');
    });
    return { now: () => NOW + elapsed, sleep, elapsed: () => elapsed };
  };

  it('a record written a moment ago by a live pid is asked again, shortly — with no identity read and no signal', async () => {
    young(200);
    const clock = clockwork();
    let asked = 0;
    const commandLineOf = vi.fn(() => undefined);
    const kill = vi.fn();
    const got = await acquireLock(
      dir,
      claim(),
      deps({
        ...clock,
        isAlive: () => true,
        commandLineOf,
        kill,
        // Its socket comes up on the fourth ask.
        probeSocket: async () => (++asked < 4 ? undefined : { tokenHash: 'old', port: 51000 }),
      }),
    );
    expect(got).toMatchObject({ role: 'attached', port: 51000 });
    expect(commandLineOf).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    // Soon, not after the take-over rule's seconds.
    expect(clock.elapsed()).toBeLessThan(1_000);
  });

  it('is taken over at once if that young pid dies before it ever answers', async () => {
    young(200);
    let polls = 0;
    const got = await acquireLock(dir, claim(), deps({ ...clockwork(), isAlive: () => ++polls < 3 }));
    expect(got.role).toBe('primary');
  });

  it('only for the WINDOW: a record older than it gets the ordinary questions', async () => {
    writeHeld({ startedAt: NOW - STARTING_WINDOW_MS - 1 });
    const clock = clockwork();
    const got = await acquireLock(dir, claim(), deps({ ...clock, isAlive: () => true, commandLineOf: () => '/usr/sbin/cupsd -l' }));
    expect(got).toMatchObject({ role: 'refused', code: 'lock-held-by-stranger' });
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('…and a young record that NEVER answers falls through to them once the window has passed', async () => {
    young(200);
    const clock = clockwork();
    const got = await acquireLock(dir, claim(), deps({ ...clock, isAlive: () => true, commandLineOf: () => '/usr/sbin/cupsd -l' }));
    expect(got).toMatchObject({ role: 'refused', code: 'lock-held-by-stranger' });
    expect(clock.elapsed()).toBeGreaterThanOrEqual(STARTING_WINDOW_MS - 200);
    expect(clock.elapsed()).toBeLessThan(STARTING_WINDOW_MS + 1_000);
  });

  it('a record dated in the FUTURE is not young for ever — a clock that jumped must not make a stale lock immortal', async () => {
    writeHeld({ startedAt: NOW + 60 * 60_000 });
    const clock = clockwork();
    const got = await acquireLock(dir, claim(), deps({ ...clock, isAlive: () => true, commandLineOf: () => '/usr/sbin/cupsd -l' }));
    expect(got).toMatchObject({ role: 'refused', code: 'lock-held-by-stranger' });
    expect(clock.sleep).not.toHaveBeenCalled();
  });
});

describe('take-over cannot kill a healthy runner (L8)', () => {
  /** A wedged runner of OURS: alive, silent, and gone `exitsAfter` polls after the signal. */
  const wedged = (options: { exitsAfter?: number } = {}) => {
    const log: string[] = [];
    let signalled = false;
    let polls = 0;
    let clock = 0;
    const kill = vi.fn(() => {
      signalled = true;
      log.push('kill');
    });
    const isAlive = (): boolean => {
      if (!signalled) return true;
      polls += 1;
      return options.exitsAfter === undefined || polls <= options.exitsAfter;
    };
    const valve = deps().sleep;
    const sleep = vi.fn(async (ms: number) => {
      await valve(ms);
      clock += ms;
      log.push(`sleep ${ms}`);
    });
    const probeSocket = vi.fn(async () => {
      log.push(`probe@${clock}`);
      return undefined as { tokenHash: string; port: number } | undefined;
    });
    return { log, kill, isAlive, sleep, probeSocket, elapsed: () => clock };
  };

  it('signals only after THREE failed probes spread over at least five seconds', async () => {
    writeHeld();
    const w = wedged({ exitsAfter: 0 });
    const got = await acquireLock(dir, claim(), deps({ ...w, commandLineOf: () => OURS }));
    expect(got.role).toBe('primary');
    expect(TAKEOVER_PROBES).toBe(3);
    expect(TAKEOVER_PROBE_SPREAD_MS).toBeGreaterThanOrEqual(5_000);

    const probes = w.log.filter((entry) => entry.startsWith('probe@')).map((entry) => Number(entry.slice('probe@'.length)));
    expect(probes).toHaveLength(3);
    expect(probes[2]! - probes[0]!).toBeGreaterThanOrEqual(5_000);
    // …and the signal comes after the LAST of them, never between.
    expect(w.log.indexOf('kill')).toBeGreaterThan(w.log.lastIndexOf(`probe@${probes[2]}`));
    expect(w.kill).toHaveBeenCalledTimes(1);
    expect(w.kill).toHaveBeenCalledWith(111);
  });

  it('a primary that answers a LATER probe is joined, not signalled — one slow answer is not a wedge', async () => {
    writeHeld();
    const w = wedged();
    let asked = 0;
    const probeSocket = vi.fn(async () => (++asked < 3 ? undefined : { tokenHash: 'old', port: 51000 }));
    const got = await acquireLock(dir, claim(), deps({ ...w, probeSocket, commandLineOf: () => OURS }));
    expect(got).toMatchObject({ role: 'attached', port: 51000 });
    expect(w.kill).not.toHaveBeenCalled();
  });

  it('is NOT signalled while its recorded port still answers — it is serving somebody’s page', async () => {
    writeHeld({ port: 51234 });
    const w = wedged();
    const probePort = vi.fn(async () => true);
    const got = await acquireLock(dir, claim(), deps({ ...w, probePort, commandLineOf: () => OURS }));
    expect(got).toMatchObject({ role: 'refused', code: 'lock-contended', pid: 111 });
    expect(probePort).toHaveBeenCalledWith(51234);
    expect(w.kill).not.toHaveBeenCalled();
    expect(readLock(dir)).toMatchObject({ tokenHash: 'old' });
  });

  it('WAITS for the signalled pid to exit before it touches the lock or the socket', async () => {
    writeHeld();
    writeFileSync(controlSocketPath(dir), 'the wedged runner’s socket');
    const w = wedged({ exitsAfter: 3 });
    const seenWhileAlive: Array<{ lock: string | undefined; socket: boolean }> = [];
    const sleep = vi.fn(async (ms: number) => {
      await w.sleep(ms);
      if (w.kill.mock.calls.length > 0) seenWhileAlive.push({ lock: readLock(dir)?.tokenHash, socket: existsSync(controlSocketPath(dir)) });
    });
    const got = await acquireLock(dir, claim(), deps({ ...w, sleep, commandLineOf: () => OURS }));
    expect(got.role).toBe('primary');
    // While it was still alive: its record and its socket, untouched.
    expect(seenWhileAlive.length).toBeGreaterThanOrEqual(3);
    for (const seen of seenWhileAlive) expect(seen).toEqual({ lock: 'old', socket: true });
    expect(readLock(dir)).toMatchObject({ tokenHash: 'new', pid: 4242 });
    expect(existsSync(controlSocketPath(dir))).toBe(false);
  });

  it('a signalled runner that shuts down CLEANLY takes its lock with it — and the newcomer leads, not "contended"', async () => {
    // A runner that can still hear SIGTERM runs its own stop: it releases the lock and
    // unlinks its socket before it exits. What the newcomer then finds is no record at all —
    // which used to read as "the lock changed hands" and refuse, naming the pid it had just
    // watched exit.
    writeHeld();
    const w = wedged({ exitsAfter: 0 });
    const kill = vi.fn(() => {
      w.kill();
      rmSync(lockFile());
    });
    const got = await acquireLock(dir, claim(), deps({ ...w, kill, commandLineOf: () => OURS }));
    expect(kill).toHaveBeenCalledWith(111);
    expect(got.role).toBe('primary');
    expect(readLock(dir)).toMatchObject({ tokenHash: 'new', pid: 4242 });
  });

  it('REFUSES when the signalled pid does not exit — never a second writer beside a live one', async () => {
    // The mutant: dropping the wait. The old code took the lock the instant it had signalled.
    writeHeld();
    writeFileSync(controlSocketPath(dir), 'the wedged runner’s socket');
    const w = wedged(); // never exits
    const got = await acquireLock(dir, claim(), deps({ ...w, commandLineOf: () => OURS }));
    expect(got).toMatchObject({ role: 'refused', code: 'lock-contended', pid: 111 });
    expect(w.kill).toHaveBeenCalledTimes(1);
    // The wait is bounded, and it is the bound that was spent.
    expect(w.elapsed()).toBeGreaterThanOrEqual(TAKEOVER_PROBE_SPREAD_MS + TAKEOVER_EXIT_WAIT_MS);
    expect(readLock(dir)).toMatchObject({ tokenHash: 'old', pid: 111 });
    expect(existsSync(controlSocketPath(dir))).toBe(true);
  });

  it('does not signal when the lock changed hands while it was waiting', async () => {
    // Another newcomer finished the same take-over first: the pid in OUR copy of the record
    // is history, and the socket now belongs to the new owner.
    writeHeld();
    const w = wedged();
    const sleep = vi.fn(async (ms: number) => {
      await w.sleep(ms);
      writeHeld({ pid: 222, tokenHash: 'a-newer-owner' });
    });
    const got = await acquireLock(dir, claim(), deps({ ...w, sleep, commandLineOf: () => OURS }));
    // …and when that owner cannot be joined either, the refusal names IT. The sentence used
    // to name pid 111 — a process that is gone — with a remedy to "stop that runner".
    expect(got).toMatchObject({ role: 'refused', code: 'lock-contended', pid: 222 });
    expect(w.kill).not.toHaveBeenCalled();
    expect(readLock(dir)).toMatchObject({ tokenHash: 'a-newer-owner' });
  });

  it('never signals ITSELF: a record naming this very pid was left by a runner that is gone', async () => {
    // Our own number in the lock is either a dead runner's (pids recycle, and this one came
    // to us) or this process's own, from a start that failed half-way. "Alive, silent, and
    // its command line is ours" is true of it — and the next step of that rule is a SIGTERM.
    writeHeld({ pid: 4242, tokenHash: 'left-behind' });
    const kill = vi.fn();
    const got = await acquireLock(dir, claim(), deps({ pid: 4242, isAlive: () => true, commandLineOf: () => OURS, kill }));
    expect(kill).not.toHaveBeenCalled();
    expect(got.role).toBe('primary');
    expect(readLock(dir)).toMatchObject({ tokenHash: 'new', pid: 4242 });
  });
});

// ------------------------------------------------------------------ the take-over is ONE step
//
// Found by the lifecycle range's verifier (2026-10-03), on the built bundle: a stale lock —
// what a crash, a SIGKILL or a reboot leaves — and two processes started at once. Both read
// the dead record, both passed "is it still the one I judged?", and then each ran
// remove → remove the socket → create: the second DELETED THE FIRST'S NEW LOCK and wrote its
// own. Both led. 77 rounds in 80 the loser's first answer was a refusal naming the DEAD pid
// ("stop that runner"); 3 in 80 the split was permanent — a primary with no lock.json, and
// every later window refused for ever.

describe('a take-over is one step, and its loser JOINS the winner (L1, L7, L8)', () => {
  const NOW = 1_700_000_000_000;
  /** The socket answers as whoever holds the lock now — once that is no longer the dead record. */
  const answersAsTheHolder = async (): Promise<{ tokenHash: string; port: number } | undefined> => {
    const now = readLock(dir);
    return now === undefined || now.tokenHash === 'old' ? undefined : { tokenHash: now.tokenHash, port: 51000 };
  };

  it('two newcomers that judged the SAME dead record: one replaces it, the other attaches to that one', async () => {
    writeHeld();
    const newcomer = (pid: number): LockDeps => deps({ pid, isAlive: (asked) => asked !== 111, probeSocket: answersAsTheHolder });
    // Both read the dead record before either acts on it: each yields at its socket probe.
    const [a, b] = await Promise.all([
      acquireLock(dir, { port: 43127, tokenHash: 'newcomer-a', socket: controlSocketPath(dir) }, newcomer(1001)),
      acquireLock(dir, { port: 43127, tokenHash: 'newcomer-b', socket: controlSocketPath(dir) }, newcomer(1002)),
    ]);
    expect([a.role, b.role].sort()).toEqual(['attached', 'primary']);
    const winner = a.role === 'primary' ? 1001 : 1002;
    // The loser is told who to work through — never refused with the dead pid's number.
    expect(a.role === 'attached' ? a : b).toMatchObject({ role: 'attached', pid: winner, port: 51000 });
    expect(readLock(dir)).toMatchObject({ pid: winner });
  });

  it('while ANOTHER process is inside its take-over, this one touches nothing — and then joins the winner', async () => {
    writeHeld();
    writeFileSync(controlSocketPath(dir), 'the dead runner’s socket');
    // The other newcomer is between "it is still the dead record" and "replace it".
    writeFileSync(takeoverMutexPath(dir), '');
    let asked = 0;
    const seenWhileHeld: Array<{ lock: string | undefined; socket: boolean }> = [];
    const got = await acquireLock(
      dir,
      claim(),
      deps({
        isAlive: (pid) => pid !== 111,
        probeSocket: async () => {
          asked += 1;
          if (asked === 1) return undefined;
          if (asked === 2) {
            // What this process had done to the files while the other one was still inside:
            seenWhileHeld.push({ lock: readLock(dir)?.tokenHash, socket: existsSync(controlSocketPath(dir)) });
            // …and now the other one finishes: its record is in place and it lets go.
            writeHeld({ pid: 222, tokenHash: 'the-winner', startedAt: NOW });
            rmSync(takeoverMutexPath(dir));
            return undefined;
          }
          return answersAsTheHolder();
        },
      }),
    );
    expect(seenWhileHeld).toEqual([{ lock: 'old', socket: true }]);
    expect(got).toMatchObject({ role: 'attached', pid: 222, port: 51000 });
    expect(readLock(dir)).toMatchObject({ tokenHash: 'the-winner', pid: 222 });
  });

  it('a socket that answers as the NEW holder is the winner speaking — not "another generation" to back away from', async () => {
    // The winner was quick: by the time this newcomer probes the socket the dead record
    // named, the winner's runner is already answering there — with a hash the record this
    // newcomer READ does not have. That used to be `lock-contended`, naming the dead pid.
    writeHeld();
    let asked = 0;
    const got = await acquireLock(
      dir,
      claim(),
      deps({
        isAlive: (pid) => pid !== 111,
        probeSocket: async () => {
          asked += 1;
          if (asked === 1) writeHeld({ pid: 222, tokenHash: 'the-winner', startedAt: NOW });
          return { tokenHash: 'the-winner', port: 51000 };
        },
      }),
    );
    expect(got).toMatchObject({ role: 'attached', pid: 222, port: 51000 });
    expect(readLock(dir)).toMatchObject({ tokenHash: 'the-winner' });
  });

  it('a loser that cannot join the winner either names the WINNER — and never escalates to a signal', async () => {
    // The winner took the lock and has not come up. That is one runner's start to finish,
    // not this one's to interrupt: the five-second rule and its signal belong to the first
    // record an acquire judges, so one acquire can never signal the process that beat it.
    writeHeld();
    let elapsed = 0;
    let asked = 0;
    const kill = vi.fn();
    const got = await acquireLock(
      dir,
      claim(),
      deps({
        now: () => NOW + elapsed,
        sleep: async (ms) => {
          elapsed += ms;
          if (elapsed > 60_000) throw new Error('acquire is waiting for ever');
        },
        isAlive: (pid) => pid === 222,
        commandLineOf: () => OURS,
        kill,
        probeSocket: async () => {
          asked += 1;
          // Between this newcomer's read of the dead record and its take-over, another one wins.
          if (asked === 1) writeHeld({ pid: 222, tokenHash: 'the-winner', startedAt: NOW });
          return undefined;
        },
      }),
    );
    expect(got).toMatchObject({ role: 'refused', code: 'lock-contended', pid: 222 });
    expect(kill).not.toHaveBeenCalled();
    // It waited for the winner's start, and no longer: not the wedge rule's five seconds on top.
    expect(elapsed).toBeGreaterThanOrEqual(STARTING_WINDOW_MS - 200);
    expect(elapsed).toBeLessThan(STARTING_WINDOW_MS + TAKEOVER_PROBE_SPREAD_MS);
    expect(readLock(dir)).toMatchObject({ tokenHash: 'the-winner', pid: 222 });
  });

  it('a STARTING runner that gives the lock back is not waited out — the next in line leads', async () => {
    // It took the lock and then could not lead (no port, say): it released, and stays alive
    // as a degraded runner. Waiting the rest of its window for a socket that will never
    // come — and then judging its live pid — would refuse a start nothing stands in the way of.
    writeHeld({ startedAt: NOW - 100 });
    let elapsed = 0;
    const got = await acquireLock(
      dir,
      claim(),
      deps({
        now: () => NOW + elapsed,
        sleep: async (ms) => {
          elapsed += ms;
          if (elapsed === 200) rmSync(lockFile());
          if (elapsed > 60_000) throw new Error('acquire is waiting for ever');
        },
        isAlive: () => true,
        commandLineOf: () => OURS,
      }),
    );
    expect(got.role).toBe('primary');
    expect(elapsed).toBeLessThan(1_000);
  });

  it('leaves nothing behind: no mutex, no temp file', async () => {
    writeHeld();
    expect((await acquireLock(dir, claim(), deps())).role).toBe('primary');
    expect(readdirSync(dir)).toEqual(['lock.json']);
  });

  it('a mutex left by a process that DIED inside its take-over does not block the next one for ever', async () => {
    // The section it guards is three synchronous file operations — microseconds. A mutex
    // older than the bound was not left by a slow process; it was left by a dead one.
    writeHeld();
    writeFileSync(takeoverMutexPath(dir), '');
    const longAgo = new Date(Date.now() - TAKEOVER_MUTEX_STALE_MS - 5_000);
    utimesSync(takeoverMutexPath(dir), longAgo, longAgo);
    const got = await acquireLock(dir, claim(), deps());
    expect(got.role).toBe('primary');
    expect(existsSync(takeoverMutexPath(dir))).toBe(false);
    expect(TAKEOVER_MUTEX_STALE_MS).toBeGreaterThanOrEqual(5_000);
  });

  it('…but a FRESH one is never broken: with the other process still inside, this one ends refused, the record untouched', async () => {
    writeHeld();
    writeFileSync(takeoverMutexPath(dir), '');
    const got = await acquireLock(dir, claim(), deps());
    expect(got).toMatchObject({ role: 'refused', code: 'lock-contended' });
    // The record still names pid 111, which is dead: the sentence must not send anyone after it.
    expect(got).not.toHaveProperty('pid');
    expect(readLock(dir)).toMatchObject({ tokenHash: 'old', pid: 111 });
    expect(existsSync(takeoverMutexPath(dir))).toBe(true);
  });

  it('a corrupt lock is replaced the same way — and the second newcomer joins the one that repaired it', async () => {
    writeFileSync(lockFile(), '{not json');
    const newcomer = (pid: number): LockDeps => deps({ pid, isAlive: () => true, probeSocket: answersAsTheHolder });
    const [a, b] = await Promise.all([
      acquireLock(dir, { port: 43127, tokenHash: 'newcomer-a', socket: controlSocketPath(dir) }, newcomer(1001)),
      acquireLock(dir, { port: 43127, tokenHash: 'newcomer-b', socket: controlSocketPath(dir) }, newcomer(1002)),
    ]);
    expect([a.role, b.role].sort()).toEqual(['attached', 'primary']);
  });
});

// ------------------------------------------------------------------ a refusal never names the dead
//
// Found by the verifier's second pass (2026-10-03), on the built bundle: a HEALTHY runner on
// the socket, and a lock.json left by a process that has since died (the runner's own lock
// went missing — deleting it is the stranger row's own remedy — and the newcomer that won
// the empty lock died before giving it back). Every later process read the dead record,
// heard the socket answer with another hash, and was refused "Another Snug runner (pid
// <dead>) holds this home" — on every retry, until somebody stopped the healthy runner.

describe('`lock-contended` never names a DEAD pid (L2, L8)', () => {
  /** The healthy runner: it answers on the socket, as a lock generation the record does not name. */
  const anotherGeneration = async (): Promise<{ tokenHash: string; port: number }> => ({ tokenHash: 'the-live-runner', port: 51000 });

  it('a dead record beside a runner that answers is REPLACED — and that runner’s socket is left exactly where it is', async () => {
    writeHeld();
    writeFileSync(controlSocketPath(dir), 'the LIVE runner’s socket');
    const kill = vi.fn();
    const commandLineOf = vi.fn(() => undefined);
    const got = await acquireLock(dir, claim(), deps({ isAlive: (pid) => pid !== 111, probeSocket: anotherGeneration, kill, commandLineOf }));
    // It holds the lock now. What it does next is the runner's: it meets the live socket,
    // gives the lock back and joins — "the socket is the last word" (`runner.test.ts`).
    expect(got).toEqual({ role: 'primary' });
    expect(readLock(dir)).toMatchObject({ tokenHash: 'new', pid: 4242 });
    // The mutant: the ordinary take-over, which unlinks ctl.sock — here a LIVE runner's.
    expect(readFileSync(controlSocketPath(dir), 'utf8')).toBe('the LIVE runner’s socket');
    // Nobody was signalled and no process table was read: a dead pid needs neither.
    expect(kill).not.toHaveBeenCalled();
    expect(commandLineOf).not.toHaveBeenCalled();
    expect(readdirSync(dir).sort()).toEqual(['ctl.sock', 'lock.json']);
  });

  it('…but only a DEAD one: a record whose pid is alive is still that runner’s, and is named', async () => {
    writeHeld();
    const got = await acquireLock(dir, claim(), deps({ isAlive: () => true, probeSocket: anotherGeneration }));
    expect(got).toMatchObject({ role: 'refused', code: 'lock-contended', pid: 111 });
    expect(readLock(dir)).toMatchObject({ tokenHash: 'old', pid: 111 });
  });

  it('when another newcomer is inside that very replacement, this one is refused with NO pid — the record still names the dead one', async () => {
    writeHeld();
    writeFileSync(takeoverMutexPath(dir), '');
    const got = await acquireLock(dir, claim(), deps({ isAlive: (pid) => pid !== 111, probeSocket: anotherGeneration }));
    expect(got).toMatchObject({ role: 'refused', code: 'lock-contended' });
    expect(got).not.toHaveProperty('pid');
    expect(readLock(dir)).toMatchObject({ tokenHash: 'old', pid: 111 });
  });

  it('a runner of ours that DIES while it is being probed is taken over — a port that still answers is then somebody else’s', async () => {
    // "Its recorded port answers" protects a LIVE runner with pages open. Asked of a dead
    // one it is a stranger's listener on the same number, and the refusal it produced named
    // a process that was gone.
    writeHeld({ port: 51234 });
    let asked = 0;
    const kill = vi.fn();
    const got = await acquireLock(
      dir,
      claim(),
      deps({
        // Alive for the identity read; gone by the time the three probes have been spread out.
        isAlive: () => ++asked <= 1,
        commandLineOf: () => OURS,
        probePort: async () => true,
        kill,
      }),
    );
    expect(got.role).toBe('primary');
    expect(kill).not.toHaveBeenCalled();
    expect(readLock(dir)).toMatchObject({ tokenHash: 'new', pid: 4242 });
  });
});

describe('a lock is created WHOLE', () => {
  it('is never visible empty to another process — an empty lock reads as corrupt, and a corrupt lock is taken', async () => {
    // The lock used to be opened `wx` and written a moment later. In between it existed and
    // was empty; a second process reading it then called it corrupt, removed it and led —
    // beside the first. A reader in ANOTHER process is the only thing that can see that
    // window, so that is what looks for it.
    const reader = spawn(
      process.execPath,
      [
        '-e',
        `const { readFileSync } = require('node:fs');
         const file = process.argv[1];
         let reads = 0, partial = 0;
         const until = Date.now() + 600;
         while (Date.now() < until) {
           let text;
           try { text = readFileSync(file, 'utf8'); } catch { continue; }
           reads += 1;
           try { if (typeof JSON.parse(text).tokenHash !== 'string') partial += 1; } catch { partial += 1; }
         }
         process.stdout.write(JSON.stringify({ reads, partial }));`,
        lockFile(),
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    reader.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    const done = new Promise<void>((resolve) => reader.on('close', () => resolve()));
    let finished = false;
    void done.then(() => (finished = true));
    let cycles = 0;
    while (!finished) {
      expect((await acquireLock(dir, claim(), deps())).role).toBe('primary');
      recordBoundPort(dir, 'new', 50_000 + (cycles % 1_000));
      await releaseLock(dir, 'new');
      cycles += 1;
      // Let the reader's exit be heard: the loop above never leaves the microtask queue.
      if (cycles % 200 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    const seen = JSON.parse(out) as { reads: number; partial: number };
    // The reader must have been LOOKING while locks came and went, or it proved nothing.
    expect(cycles).toBeGreaterThan(200);
    expect(seen.reads).toBeGreaterThan(200);
    expect(seen.partial).toBe(0);
  });
});

describe('the runner puts a MISSING lock back (the socket is the last word)', () => {
  const mine = { port: 51777, pid: 4242, tokenHash: 'mine', startedAt: 5, socket: '/x/host/ctl.sock' };

  it('re-creates its record when the file is gone — a runner that owns the socket must be findable by the lock', () => {
    reassertLock(dir, mine);
    expect(readLock(dir)).toEqual(mine);
    expect(readdirSync(dir)).toEqual(['lock.json']);
  });

  it('never replaces a record that is THERE — somebody else’s, its own, or an unreadable one', () => {
    writeHeld({ tokenHash: 'theirs', pid: 777 });
    reassertLock(dir, mine);
    expect(readLock(dir)).toMatchObject({ tokenHash: 'theirs', pid: 777 });

    writeFileSync(lockFile(), '{not json');
    reassertLock(dir, mine);
    expect(readFileSync(lockFile(), 'utf8')).toBe('{not json');
  });
});

describe('what take-over may unlink (L8)', () => {
  it('only the canonical ctl.sock — never the path lock.json names', async () => {
    // The record is a file another process wrote. `rm` of a path read out of it is an
    // arbitrary-unlink primitive for anyone who can write one JSON file.
    mkdirSync(path.join(dir, 'elsewhere'));
    const decoy = path.join(dir, 'elsewhere', 'precious.txt');
    writeFileSync(decoy, 'not a socket, and not ours');
    writeFileSync(controlSocketPath(dir), 'a dead runner’s socket');
    writeHeld({ socket: decoy });

    const got = await acquireLock(dir, claim(), deps({ isAlive: () => false }));
    expect(got.role).toBe('primary');
    expect(readFileSync(decoy, 'utf8')).toBe('not a socket, and not ours');
    expect(existsSync(controlSocketPath(dir))).toBe(false);
  });

  it('the canonical path is <hostDir>/ctl.sock', () => {
    expect(controlSocketPath('/x/Snug/host')).toBe('/x/Snug/host/ctl.sock');
  });

  it('never unlinks a LIVE stranger’s — a refusal leaves every file where it was', async () => {
    writeHeld();
    writeFileSync(controlSocketPath(dir), 'whatever this is');
    await acquireLock(dir, claim(), deps({ isAlive: () => true, commandLineOf: () => '/usr/sbin/cupsd -l' }));
    expect(existsSync(controlSocketPath(dir))).toBe(true);
    expect(readLock(dir)).toMatchObject({ tokenHash: 'old' });
  });
});

describe('the port the lock records', () => {
  it('is corrected to the port actually bound — the claim is written before anything listens', async () => {
    // The fixed port may be busy and the listener fall back to an ephemeral one. Take-over
    // asks the RECORDED port whether the old runner still serves; a record that kept the
    // claimed port would ask somebody else’s listener.
    await acquireLock(dir, { port: 43127, tokenHash: 'mine', socket: controlSocketPath(dir) }, deps());
    recordBoundPort(dir, 'mine', 51777);
    expect(readLock(dir)).toMatchObject({ port: 51777, tokenHash: 'mine', pid: 4242 });
  });

  it('never rewrites a lock that is no longer ours', async () => {
    writeHeld({ tokenHash: 'theirs', port: 43127 });
    recordBoundPort(dir, 'mine', 51777);
    expect(readLock(dir)).toMatchObject({ port: 43127, tokenHash: 'theirs' });
  });
});

describe('a lock that cannot be WRITTEN is not a lock that is held', () => {
  // Root ignores directory permissions, so there the directory below IS writable and the
  // case cannot be made; everywhere else it is the case a read-only home produces.
  it.skipIf(process.getuid?.() === 0)('throws the system’s own error instead of reporting contention', async () => {
    // "Held" is EEXIST and nothing else. A host directory that cannot be written used to
    // read as "the lock is being contended" — a remedy about another runner, for a problem
    // that is a permission. The runner turns this throw into `home-unwritable`.
    const readOnly = path.join(dir, 'host');
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    try {
      await expect(acquireLock(readOnly, claim(), deps())).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      chmodSync(readOnly, 0o700);
    }
  });
});

describe('a record that cannot be trusted', () => {
  it('without a socket path it is unreadable — and an unreadable lock is stale', async () => {
    writeFileSync(lockFile(), JSON.stringify({ port: 43127, pid: 111, tokenHash: 'old', startedAt: 1 }));
    expect(readLock(dir)).toBeUndefined();
  });
});
