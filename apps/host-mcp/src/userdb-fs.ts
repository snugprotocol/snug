// The user's file on disk — the seam Snug Desktop fills with `read_user_file` /
// `write_user_file`, in Node (ADR-0068 §1).
//
// `createFileBackend` delegates atomicity entirely to its fs implementation ("one
// atomicity contract, enforced where the bytes actually hit the disk"), so these are the
// desktop's `userfile.rs` rules rather than a lighter version of them: a bare filename
// inside one directory, temp + fsync + rename + directory fsync, and a read that never
// fabricates emptiness.
//
// THE RULE THAT MATTERS MOST (lesson 2026-08-03, quoted in `file-backend.ts`'s own header):
// absence means ENOENT and nothing else. A reader that maps any failure to "not found"
// opens a pristine empty database over the user's real file, and the next save destroys
// it. Over HTTP that becomes: 404 is absence, and every other status rejects.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

/**
 * The desktop's `valid_name`, copied verbatim in behaviour: ASCII alphanumerics plus
 * `. _ -`, at most 128 characters, never leading with a dot.
 *
 * It must stay this wide. The db writes more than the two userdb names — a quarantine save
 * is `${file}.corrupt-<base36>.bak` and the sync sidecar has its own name — so a
 * hand-narrowed allowlist would throw INSIDE the corruption handler and turn a recoverable
 * quarantine into an unrecoverable crash.
 */
export function validUserFileName(name: string): boolean {
  if (name.length === 0 || name.length > 128) return false;
  if (name.startsWith('.')) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/** Temp files older than this are another run's litter and may be swept. */
const TMP_STALE_AFTER_MS = 600_000;

export interface UserFileStore {
  read(name: string): Promise<Uint8Array | undefined>;
  write(name: string, bytes: Uint8Array, options?: { failBeforeRename?: boolean }): Promise<void>;
}

function fsyncDir(dir: string): void {
  // The rename must itself become durable. Windows has no directory-handle fsync; this
  // process is macOS-only for now, and a failure here is not worth losing the write over.
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* best effort, as on the desktop */
  }
}

function sweepStaleTemps(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.includes('.tmp-')) continue;
    const full = path.join(dir, entry);
    try {
      // Only OUR litter, and only when it is old enough that no concurrent write owns it.
      if (now - statSync(full).mtimeMs > TMP_STALE_AFTER_MS) rmSync(full, { force: true });
    } catch {
      /* raced with another sweeper */
    }
  }
}

export function createUserFileStore(dir: string): UserFileStore {
  const pathOf = (name: string): string => {
    if (!validUserFileName(name)) throw new Error(`refusing an unsafe file name: ${name}`);
    return path.join(dir, name);
  };

  return {
    async read(name: string): Promise<Uint8Array | undefined> {
      const file = pathOf(name);
      try {
        return new Uint8Array(readFileSync(file));
      } catch (error) {
        // ENOENT — and ONLY ENOENT — is absence. An EACCES or EISDIR that resolved
        // `undefined` would mint a fresh database over a real file.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },

    async write(name: string, bytes: Uint8Array, options: { failBeforeRename?: boolean } = {}): Promise<void> {
      const file = pathOf(name);
      mkdirSync(dir, { recursive: true });
      sweepStaleTemps(dir);
      const tmp = `${file}.tmp-${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')}`;
      const fd = openSync(tmp, 'wx');
      try {
        writeSync(fd, bytes);
        // The temp's CONTENTS are durable before anything points at it.
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        // The testable crash seam: everything up to here is discardable, and the target
        // is untouched.
        if (options.failBeforeRename === true) throw new Error('interrupted before rename');
        renameSync(tmp, file);
      } catch (error) {
        rmSync(tmp, { force: true });
        throw error;
      }
      fsyncDir(dir);
    },
  };
}

export type LoadResult = { kind: 'absent' } | { kind: 'bytes' } | { kind: 'error' };

/**
 * How the page's `FileBackendFs` reads a status. The 404 arm is the whole of absence; a
 * 423 (the file is held by Snug Desktop), a 500, or anything else must REJECT so the db
 * takes its error path rather than its fresh-start path.
 */
export function statusToLoadResult(status: number): LoadResult {
  if (status === 404) return { kind: 'absent' };
  if (status === 200) return { kind: 'bytes' };
  return { kind: 'error' };
}
