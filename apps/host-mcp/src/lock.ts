// One process, one file (ADR-0068 §3).
//
// Two Claude Code windows must be one Snug: a second process holding the same
// `~/Snug/user.snug` is two writers, which is the wedge the WhatsApp helper's orphan bug
// taught (lessons 2026-08-18/19). So the second session ATTACHES to the first rather than
// spawning a rival.
//
// Four races decide the shape:
//
//  * SIMULTANEOUS SPAWN. Two ephemeral binds never collide, so "bind, then write the lock"
//    lets both processes win and leaves one an unreapable orphan. Creating the lock file
//    EXCLUSIVELY decides the winner BEFORE anything binds.
//  * PID RECYCLING. A recycled pid is a live process that does not answer our socket, so
//    "dead or unresponsive ⇒ stale" would classify a stranger stale — and take-over signals
//    what it replaces. The desktop's reaper states the rule: a number alone is never
//    enough, the command line must name the thing we would have spawned. Killing a stranger
//    is worse than the conflict it repairs.
//  * A LIVE PRIMARY'S SOCKET. The sidecar unlinks its socket path before binding because it
//    is that path's only writer. Here every peer is symmetric, so an unconditional unlink
//    would cut a live primary's socket out from under it and freeze its client count.
//  * TWO NEWCOMERS, ONE DEAD LOCK. What a crash, a SIGKILL or a reboot leaves is a record
//    whose owner is gone, and "is it still the record I judged? then remove it, then create
//    mine" is three steps. Two processes started at once both passed the first; the second
//    then removed the FIRST'S NEW LOCK and wrote its own, and both led (measured 2026-10-03
//    on the built bundle: 3 rounds in 80 ended with a primary that had no lock.json and
//    every later window refused for ever; 77 in 80 the loser was refused with the DEAD
//    pid's number). So replacing a record is one step under a mutex, a lock is linked into
//    place whole (never visible empty — an empty lock reads as corrupt, and a corrupt lock
//    is taken), and whoever loses asks the WINNER what it asked the dead record — are you
//    there yet? — and attaches to it.
//
// THE ORDER OF QUESTIONS (L1, L8 — rewritten 2026-10-03). It used to be: read the command
// line, then probe the socket. The shipped build could not read a command line at all, so
// every live holder was a stranger and a second window was ALWAYS refused — "two windows,
// one Snug" had only ever worked in tests. Now:
//
//   1. The SOCKET, first. A runner that answers with the hash the lock records is the lock's
//      owner, whatever its pid or command line: attach. No process table is consulted.
//      (A record written moments ago is a primary still between its lock and its socket:
//      it is asked again, shortly, before anything below is concluded.)
//      (An answer with ANOTHER hash is another lock generation's runner. While the record's
//      own pid lives, that pid holds this home. Once it is dead the record is litter beside
//      a live runner: it is replaced with the socket left alone, and whoever takes the lock
//      meets that socket and joins it — `runner.ts`, "the socket is the last word".)
//   2. Silent, and the pid is dead: take over.
//   3. Silent, and the pid is ALIVE: the one place identity is read. A stranger is refused
//      and never signalled. One of ours is a wedged primary — and is signalled only after
//      three probes over five seconds have failed AND its recorded port is silent too, then
//      WAITED for. A lock taken beside a runner that is still shutting down is two writers.
//
// Each of those is asked of the record that is there NOW. When it changes hands while it is
// being judged, the judging starts again with whoever holds it — a bounded number of times.
//
// SILENT IS NOT ABSENT (Gate 5, security/F3). Every take-over used to unlink the canonical
// socket once its record's owner was judged gone — on ONE missed 1.5 s probe when the pid was
// dead. But the socket need not be that pid's: a live runner whose lock went missing listens
// there too, and its event loop can sit in a synchronous `/bin/ps` (`holder.ts`, up to 2 s, on
// every `/status`) right through a probe. The reviewer proved it on this function: a live
// listener that never answers, a dead pid's record → `primary`, the live socket gone from
// disk, and the newcomer then bound its own and led — two primaries on one user file. So no
// take-over unlinks a path anything still LISTENS on (a connect, where unsure is live), nor
// one beside a port that still answers: it keeps the socket, and the newcomer meets it in
// `listenControl` — joins it, or refuses `socket-in-use`.

import { closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isSnugCommandLine } from './identity.js';

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
  /** Whether anything still answers on the recorded port — a wedged control socket is not a dead runner. */
  probePort(port: number): Promise<boolean>;
  /**
   * Whether anything LISTENS on a socket path — a connect, not a conversation, and an unsure
   * answer is `true`. Asked of the canonical path before a take-over may unlink it: a busy
   * runner misses a probe and still accepts a connection.
   */
  socketListens(socket: string): Promise<boolean>;
  /** Injected so the tests of a five-second rule take no five seconds. */
  sleep(ms: number): Promise<void>;
  /** Ask one of OURS to shut down (SIGTERM). Never called for a stranger. */
  kill(pid: number): void;
  now(): number;
}

export type AcquireResult =
  | { role: 'primary' }
  | { role: 'attached'; port: number; socket: string; pid: number }
  | {
      role: 'refused';
      /** The refusal table's row (`refusals.ts`). */
      code: 'lock-held-by-stranger' | 'lock-contended';
      /** The process the lock names, when it named one. */
      pid?: number;
      reason: string;
    };

/**
 * How long after a record was written its owner may still be STARTING. `O_EXCL` picks the
 * winner of a simultaneous spawn before anything binds, so for a moment the winner holds
 * the lock and has no socket yet; measured, a start takes well under a second. A loser that
 * arrives in that moment waits for the socket instead of judging a silence that means
 * nothing yet.
 */
export const STARTING_WINDOW_MS = 3_000;
const STARTING_POLL_MS = 100;

/** How many times a silent runner of ours is asked before it is called wedged (L8). */
export const TAKEOVER_PROBES = 3;
/** The time those probes are spread over: one missed answer is a busy event loop, not a wedge. */
export const TAKEOVER_PROBE_SPREAD_MS = 5_000;
/** How long a signalled runner is given to exit before the take-over is abandoned. */
export const TAKEOVER_EXIT_WAIT_MS = 5_000;
const EXIT_POLL_MS = 100;

/**
 * How many records one acquire will judge. A round ends in an answer or in "it changed
 * hands": lost the take-over to another newcomer (ask the winner), a busy mutex, a starting
 * runner that gave the lock back (take it). Each of those is somebody else making progress,
 * so a handful is generous; past it the answer is contention, and the next tool call asks
 * again.
 */
const ACQUIRE_ROUNDS = 6;

/**
 * How old a take-over mutex must be before it is a dead process's litter. What it guards is
 * a few synchronous file operations — microseconds — so a holder this old did not get slow;
 * it was killed inside.
 */
export const TAKEOVER_MUTEX_STALE_MS = 10_000;

const lockPathOf = (dir: string): string => path.join(dir, 'lock.json');
const tempPathOf = (dir: string, pid: number): string => `${lockPathOf(dir)}.${pid}.tmp`;

/** The mutex a take-over holds while it replaces a record (exported for the tests that hold it). */
export const takeoverMutexPath = (dir: string): string => path.join(dir, 'lock.takeover');

/**
 * THE control socket of a host directory. Take-over unlinks this path and no other: the
 * `socket` a lock record names is something another process wrote, and removing a path read
 * out of a file is an arbitrary-unlink primitive for anyone who can write that file.
 */
export const controlSocketPath = (dir: string): string => path.join(dir, 'ctl.sock');

/**
 * What is at the lock's path. NO FILE and A FILE NOBODY CAN READ are different facts and get
 * different treatment: an absent lock is created (exclusively — that cannot hurt anyone), an
 * unreadable one has to be removed first, and removing is only safe for a file that is there
 * to be judged.
 */
function inspectLock(dir: string): LockRecord | 'absent' | 'unreadable' {
  let raw: string;
  try {
    raw = readFileSync(lockPathOf(dir), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return 'unreadable';
    const record = parsed as Partial<LockRecord>;
    if (typeof record.port !== 'number' || typeof record.pid !== 'number' || typeof record.tokenHash !== 'string' || typeof record.socket !== 'string') {
      return 'unreadable';
    }
    return record as LockRecord;
  } catch {
    return 'unreadable';
  }
}

/** The lock as it stands, or `undefined` when absent or unreadable (a corrupt lock is stale). */
export function readLock(dir: string): LockRecord | undefined {
  const found = inspectLock(dir);
  return typeof found === 'string' ? undefined : found;
}

/**
 * Create the lock, exclusively and WHOLE. The record is written to a file of its own and
 * then LINKED into place: `link` fails when the name exists — the exclusivity `O_EXCL` gave,
 * which is the whole of the simultaneous-spawn fix — and the name never exists without its
 * content. (It used to be opened `wx` and written a moment later. In between it was empty,
 * and to a second process an empty lock is a corrupt one: removed, and led beside.)
 */
function createLock(dir: string, record: LockRecord): boolean {
  const temp = tempPathOf(dir, record.pid);
  try {
    writeFileSync(temp, JSON.stringify(record));
    linkSync(temp, lockPathOf(dir));
    return true;
  } catch (error) {
    // HELD is EEXIST and nothing else. Any other failure is the directory's (a read-only
    // home, a missing parent) and is thrown for the runner to name as such — reporting it
    // as contention would send the user to stop a runner that does not exist.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Whether THIS process now holds the take-over mutex. A mutex a dead process left is broken, once. */
function enterTakeover(dir: string): boolean {
  const mutex = takeoverMutexPath(dir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      closeSync(openSync(mutex, 'wx'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let age: number;
    try {
      // The file system's clock against the file system's own stamp — not the injected
      // `now`, which is the clock records are dated by and may be a test's.
      age = Date.now() - statSync(mutex).mtimeMs;
    } catch {
      // Gone between the create and the look: its holder has just finished.
      return false;
    }
    if (age <= TAKEOVER_MUTEX_STALE_MS) return false;
    rmSync(mutex, { force: true });
  }
  return false;
}

/**
 * Put `record` where `judged` is — the ONE step of a take-over. Under the mutex the record
 * is read again; only if it is still the one that was judged is anything touched. `moved`
 * means it is not (or somebody else is inside this very step): the caller judges whatever
 * is there now.
 *
 * `judged` is `undefined` for a lock that could not be read at all.
 *
 * `keepSocket` is for a record whose owner is gone while the control socket is NOT litter:
 * another runner answers on it, or something still listens there (Gate 5, security/F3).
 * Unlinking there would cut a live runner's socket out from under it — every later attach
 * would fail, its session count would freeze, and the newcomer would lead beside it.
 *
 * The listening question is asked BEFORE the mutex, not under it: the mutex guards a few
 * synchronous file operations, and a connect may take its whole bound. Nothing can begin
 * listening on the canonical path in between — binding it takes the lock, and a lock that
 * changed hands is `moved` below.
 */
function replaceRecord(
  dir: string,
  judged: LockRecord | undefined,
  record: LockRecord,
  { keepSocket = false }: { keepSocket?: boolean } = {},
): { role: 'primary' } | 'moved' {
  if (!enterTakeover(dir)) return 'moved';
  try {
    const now = inspectLock(dir);
    if (judged === undefined) {
      if (typeof now !== 'string') return 'moved';
      // Removed only when it is THERE and unreadable — nothing outside this mutex can turn
      // such a file into a record. An absent one is simply created: removing "it" could
      // remove the lock a process starting right now has just linked into place.
      if (now === 'unreadable') rmSync(lockPathOf(dir), { force: true });
      return createLock(dir, record) ? { role: 'primary' } : 'moved';
    }
    if (typeof now === 'string' || now.tokenHash !== judged.tokenHash) return 'moved';
    // The canonical path, never `judged.socket`; and only once nothing listens on it
    // (`takeOver` asked, at connect level, before this mutex was entered).
    if (!keepSocket) rmSync(controlSocketPath(dir), { force: true });
    // RENAMED over the old record, not removed-then-created: the lock is never absent in
    // between, so no process starting at this instant can create one of its own.
    const temp = tempPathOf(dir, record.pid);
    writeFileSync(temp, JSON.stringify(record));
    renameSync(temp, lockPathOf(dir));
    return { role: 'primary' };
  } finally {
    rmSync(takeoverMutexPath(dir), { force: true });
  }
}

/**
 * The refusal for a home somebody else holds. A `pid` is passed only by a caller that has
 * JUST seen that process alive, with nothing awaited in between: the sentence built from it
 * tells a person which runner to stop, and must never name one that is gone.
 */
const contended = (pid?: number): AcquireResult => ({
  role: 'refused',
  code: 'lock-contended',
  ...(pid !== undefined ? { pid } : {}),
  reason: 'the lock is being contended',
});

export async function acquireLock(
  dir: string,
  claim: { port: number; tokenHash: string; socket: string },
  deps: LockDeps,
): Promise<AcquireResult> {
  /** Dated when it is WRITTEN: a newcomer reads the date as "this runner may still be starting". */
  const mine = (): LockRecord => ({ port: claim.port, pid: deps.pid, tokenHash: claim.tokenHash, startedAt: deps.now(), socket: claim.socket });
  /** Whether the lock still holds the record being judged. */
  const stillHolds = (held: LockRecord): boolean => readLock(dir)?.tokenHash === held.tokenHash;

  /**
   * Take over from a record whose owner is judged gone — and keep the canonical socket if
   * anything still listens on it, or if the record's port still answers (`serving`): either is
   * a live runner that missed its probes, not litter. Kept, the newcomer meets it at
   * `listenControl` and joins it or refuses; only a socket nothing listens on is removed.
   */
  const takeOver = async (held: LockRecord, serving = false): Promise<{ role: 'primary' } | 'moved'> => {
    const keepSocket = serving || (await deps.socketListens(controlSocketPath(dir)));
    return replaceRecord(dir, held, mine(), { keepSocket });
  };

  /**
   * The questions, asked of ONE record. `patient` is the first record this acquire judges:
   * only that one may be given the wedged-runner procedure and its signal.
   */
  const judge = async (held: LockRecord, patient: boolean): Promise<AcquireResult | 'moved'> => {
    /** One probe's verdict: join it, or — when it answers as somebody else — back off. */
    const joinIfAnswering = async (): Promise<AcquireResult | 'moved' | undefined> => {
      const answer = await deps.probeSocket(held.socket);
      if (answer === undefined) return undefined;
      // A healthy primary: attach to it. This is the two-windows-one-Snug path.
      if (answer.tokenHash === held.tokenHash) return { role: 'attached', port: answer.port, socket: held.socket, pid: held.pid };
      // THE HASH IS THE IDENTITY. An answer with another hash is another lock generation's
      // runner — its port and its bearer are not the ones this record promises. If the lock
      // has meanwhile become that generation's, it is simply the new holder answering.
      if (!stillHolds(held)) return 'moved';
      // Still the record that was judged, and somebody ELSE answers. While the record's own
      // process lives, it is the one that holds this home, and it is named. Once it is DEAD
      // the record is litter beside a live runner (that runner's lock went missing, and the
      // newcomer that won the empty lock died holding it). Refusing here named the dead pid,
      // on every retry, until somebody stopped the healthy runner (measured 2026-10-03). So
      // the record is replaced and the socket is left ALONE: it is that runner's, and the
      // process that now takes the lock meets it and joins (`runner.ts`: "the socket is the
      // last word").
      return deps.isAlive(held.pid) ? contended(held.pid) : replaceRecord(dir, held, mine(), { keepSocket: true });
    };

    // 1. The socket, first.
    const joined = await joinIfAnswering();
    if (joined !== undefined) return joined;

    // Silent, but its record is moments old: a primary between its lock and its socket. Ask
    // again, shortly, for as long as the window lasts — or until it answers, dies, or gives
    // the lock back (a runner that could not lead releases it and lives on, degraded).
    for (let age = deps.now() - held.startedAt; age >= 0 && age < STARTING_WINDOW_MS && deps.isAlive(held.pid); age = deps.now() - held.startedAt) {
      await deps.sleep(STARTING_POLL_MS);
      if (!stillHolds(held)) return 'moved';
      const started = await joinIfAnswering();
      if (started !== undefined) return started;
    }

    // 2. Silent and dead.
    if (!deps.isAlive(held.pid)) return takeOver(held);

    // 3. Silent and ALIVE — the only place identity is read. A live stranger owns this pid (a
    //    recycled number): never signal it, never take over from it.
    if (!isSnugCommandLine(deps.commandLineOf(held.pid))) {
      return { role: 'refused', code: 'lock-held-by-stranger', pid: held.pid, reason: `another process (pid ${held.pid}) holds this lock` };
    }
    // "Alive, and its command line is ours" is true of THIS process too. A record naming our
    // own pid was left by a runner that is gone — a dead one whose number came to us, or
    // this very process in a start that failed half-way. Its next step below is a signal,
    // and that signal would be to ourselves.
    if (held.pid === deps.pid) return takeOver(held);
    // The runner that beat this acquire to a take-over and has not come up. Its start is its
    // own to finish: the next tool call asks again, with every question below to ask.
    if (!patient) return contended(held.pid);

    // Ours, and it missed one probe. That is a busy event loop until proven otherwise.
    for (let asked = 1; asked < TAKEOVER_PROBES; asked += 1) {
      await deps.sleep(TAKEOVER_PROBE_SPREAD_MS / (TAKEOVER_PROBES - 1));
      const late = await joinIfAnswering();
      if (late !== undefined) return late;
    }
    const serving = await deps.probePort(held.port);
    // Gone while it was being asked — and asked AFTER the port, so nothing is awaited between
    // this look and the refusal below. A dead runner protects no page, and a refusal built
    // from this record would name a process that no longer exists: take over. But whatever
    // answers on its port number now is alive — perhaps the runner that owns the socket — so
    // that answer is not discarded: the socket is kept for `listenControl` to judge.
    if (!deps.isAlive(held.pid)) return takeOver(held, serving);
    // Its control socket is gone, but a runner still answering on its port has pages open
    // and a user file in hand. That one is the user's to stop (`snug stop`), not ours to kill.
    if (serving) return contended(held.pid);
    // Five seconds have passed: another newcomer may have finished this same take-over, and
    // the pid in OUR copy of the record would then be history.
    if (!stillHolds(held)) return 'moved';

    // A wedged primary still holding the user file. Signal it — then WAIT: its shutdown
    // flushes and releases, and a lock taken before that finishes is two writers on one file.
    deps.kill(held.pid);
    for (let waited = 0; deps.isAlive(held.pid); waited += EXIT_POLL_MS) {
      if (waited >= TAKEOVER_EXIT_WAIT_MS) return contended(held.pid);
      await deps.sleep(EXIT_POLL_MS);
    }
    return takeOver(held);
  };

  let patient = true;
  for (let round = 0; round < ACQUIRE_ROUNDS; round += 1) {
    if (createLock(dir, mine())) return { role: 'primary' };

    // Somebody holds it. Decide what they are before touching anything of theirs.
    const held = inspectLock(dir);
    // Released between the create and the read: there is nothing to judge, only to create.
    if (held === 'absent') continue;
    if (held === 'unreadable') {
      const repaired = replaceRecord(dir, undefined, mine());
      if (repaired !== 'moved') return repaired;
      continue;
    }
    const verdict = await judge(held, patient);
    if (verdict !== 'moved') return verdict;
    patient = false;
  }
  // Never the number of a process that is gone: the sentence built from this tells a person
  // which runner to stop.
  const now = readLock(dir);
  return contended(now !== undefined && deps.isAlive(now.pid) ? now.pid : undefined);
}

/**
 * Correct the record to the port actually bound. The claim is written BEFORE anything
 * listens (that ordering is the simultaneous-spawn fix), and the fixed port may be busy —
 * so without this the record names a port that may be somebody else's listener, and
 * take-over's "does its port still answer" would be asking the wrong process.
 */
export function recordBoundPort(dir: string, tokenHash: string, port: number): void {
  const held = readLock(dir);
  if (held === undefined || held.tokenHash !== tokenHash || held.port === port) return;
  // Temp + rename: a reader never sees half a record, and a half record reads as stale.
  const temp = tempPathOf(dir, held.pid);
  writeFileSync(temp, JSON.stringify({ ...held, port }));
  renameSync(temp, lockPathOf(dir));
}

/**
 * Put the record back when the file is GONE. The runner that owns the control socket is the
 * runner, whatever became of its lock (removed by hand, or by a newcomer from a build
 * without the take-over mutex) — and a runner with no lock.json is one every later process
 * out-races to the lock and then trips over at the socket. Only an ABSENT lock: a record
 * that is there is somebody's, and that somebody will meet the socket and give it back.
 */
export function reassertLock(dir: string, record: LockRecord): void {
  if (inspectLock(dir) === 'absent') createLock(dir, record);
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
