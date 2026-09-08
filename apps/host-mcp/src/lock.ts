// One process, one file (ADR-0068 §3).
//
// Two Claude Code windows must be one Snug: a second process holding the same
// `~/Snug/user.snug` is two writers, which is the wedge the WhatsApp helper's orphan bug
// taught (lessons 2026-08-18/19). So the second session ATTACHES to the first rather than
// spawning a rival.
//
// Three races decide the shape:
//
//  * SIMULTANEOUS SPAWN. Two ephemeral binds never collide, so "bind, then write the lock"
//    lets both processes win and leaves one an unreapable orphan. `O_EXCL` on the lock file
//    decides the winner BEFORE anything binds.
//  * PID RECYCLING. A recycled pid is a live process that does not answer our socket, so
//    "dead or unresponsive ⇒ stale" would classify a stranger stale — and take-over signals
//    what it replaces. The desktop's reaper states the rule: a number alone is never
//    enough, the command line must name the thing we would have spawned. Killing a stranger
//    is worse than the conflict it repairs.
//  * A LIVE PRIMARY'S SOCKET. The sidecar unlinks its socket path before binding because it
//    is that path's only writer. Here every peer is symmetric, so an unconditional unlink
//    would cut a live primary's socket out from under it and freeze its client count.

import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';

export interface LockRecord {
  port: number;
  pid: number;
  /** SHA-256 of the bearer. The bearer itself never touches disk (D-B8). */
  tokenHash: string;
  startedAt: number;
  socket: string;
}

export interface LockDeps {
  pid: number;
  isAlive(pid: number): boolean;
  /** The process's command line, for identity — never trust a pid alone. */
  commandLineOf(pid: number): string | undefined;
  /** Ask the recorded socket who it is. `undefined` when nothing answers. */
  probeSocket(socket: string): Promise<{ tokenHash: string; port: number } | undefined>;
  now(): number;
  kill?(pid: number): void;
}

export type AcquireResult =
  | { role: 'primary' }
  | { role: 'attached'; port: number; socket: string }
  | { role: 'refused'; reason: string };

const lockPathOf = (dir: string): string => path.join(dir, 'lock.json');

/** The lock as it stands, or `undefined` when absent or unreadable (a corrupt lock is stale). */
export function readLock(dir: string): LockRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPathOf(dir), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Partial<LockRecord>;
    if (typeof record.port !== 'number' || typeof record.pid !== 'number' || typeof record.tokenHash !== 'string') return undefined;
    return record as LockRecord;
  } catch {
    return undefined;
  }
}

/** Whether the recorded owner is one of ours, by command identity rather than by pid. */
function ownerIsOurs(record: LockRecord, deps: LockDeps): boolean {
  const commandLine = deps.commandLineOf(record.pid);
  return commandLine !== undefined && /snug-mcp/.test(commandLine);
}

function writeLockExclusive(dir: string, record: LockRecord): boolean {
  try {
    // 'wx' — create, and fail if it exists. This is the whole of the simultaneous-spawn fix.
    const fd = openSync(lockPathOf(dir), 'wx');
    try {
      writeSync(fd, JSON.stringify(record));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(
  dir: string,
  claim: { port: number; tokenHash: string; socket: string },
  deps: LockDeps,
): Promise<AcquireResult> {
  const record: LockRecord = { port: claim.port, pid: deps.pid, tokenHash: claim.tokenHash, startedAt: deps.now(), socket: claim.socket };

  if (writeLockExclusive(dir, record)) return { role: 'primary' };

  // Somebody holds it. Decide what they are before touching anything of theirs.
  const held = readLock(dir);
  if (held === undefined) {
    // Corrupt or vanished between the create and the read: take it.
    rmSync(lockPathOf(dir), { force: true });
    return writeLockExclusive(dir, record) ? { role: 'primary' } : { role: 'refused', reason: 'the lock is being contended' };
  }

  const alive = deps.isAlive(held.pid);
  if (alive && !ownerIsOurs(held, deps)) {
    // A live stranger owns this pid — a recycled number. Never signal it, never take over.
    return { role: 'refused', reason: `another process (pid ${held.pid}) holds this lock` };
  }

  if (alive) {
    const answer = await deps.probeSocket(held.socket);
    if (answer !== undefined && answer.tokenHash === held.tokenHash) {
      // A healthy primary: attach to it. This is the two-windows-one-Snug path.
      return { role: 'attached', port: answer.port, socket: held.socket };
    }
    // Ours by command line, but its socket is gone: a wedged primary still holding the
    // user file. Signal it, then take over.
    deps.kill?.(held.pid);
  }

  rmSync(lockPathOf(dir), { force: true });
  // Only a proven-dead owner's socket may be removed — never a live one's.
  rmSync(held.socket, { force: true });
  return writeLockExclusive(dir, record) ? { role: 'primary' } : { role: 'refused', reason: 'the lock is being contended' };
}

/**
 * Release only if it is still OURS. Another process may have taken over while we were
 * shutting down, and clearing its record would let a third win a port two others use.
 */
export async function releaseLock(dir: string, tokenHash: string): Promise<void> {
  const held = readLock(dir);
  if (held === undefined || held.tokenHash !== tokenHash) return;
  rmSync(lockPathOf(dir), { force: true });
}
