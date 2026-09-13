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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { acquireLock, readLock, releaseLock, type LockDeps } from '../lock.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'snug-host-lock-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Deps with everything injected: no real processes, no real sockets. */
const deps = (over: Partial<LockDeps> = {}): LockDeps => ({
  pid: 4242,
  isAlive: () => false,
  commandLineOf: () => undefined,
  probeSocket: async () => undefined,
  now: () => 1_700_000_000_000,
  ...over,
});

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
    writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({ port: 43127, pid: 111, tokenHash: 'old', startedAt: 1, socket: `${dir}/s.sock` }));
    const kill = vi.fn();
    const got = await acquireLock(
      dir,
      { port: 43127, tokenHash: 'new', socket: `${dir}/s.sock` },
      deps({ isAlive: () => true, commandLineOf: () => 'node /x/snug-mcp.mjs', probeSocket: async () => undefined, kill }),
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
