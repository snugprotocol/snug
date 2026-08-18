/**
 * THE DURABLE THREAD CACHE (ADR-0037 §1, TASK-20260818-telepath-linking-sync).
 *
 * Everything the sidecar syncs used to live in in-process Maps, so the shell's (correct)
 * reap-on-exit made every desktop restart a full, invisible re-sync. This file is the disk
 * half of the fix: a versioned JSON snapshot beside the session keys.
 *
 * The write rules come from hard-won lessons (lessons.md 2026-08-03):
 *  - Writes go to a TEMP NAME and RENAME into place. A crash mid-write can truncate the file
 *    being written, and rename is atomic on the same filesystem — so the good copy is never
 *    the one at risk.
 *  - A corrupt, empty, or unparsable file is QUARANTINED (moved aside) and read as absent.
 *    Zero bytes are corruption, never "a fresh start": treating them as fresh silently
 *    discards everything the user synced.
 *  - A foreign magic or version is refused WITHOUT quarantine — a downgrade must not destroy
 *    a newer format's data; it just starts cold.
 *  - 0600, like the token beside it: message text is the user's private life.
 *
 * v1 is a whole-snapshot JSON write on a debounce (the adapter owns the cadence); SQLite is
 * the named successor if size or write amplification hurts (ADR-0037), behind this same
 * two-method seam.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MAGIC = 'snug-wa-thread-cache';
const VERSION = 1;

export interface ThreadCache {
  /** The stored snapshot, or undefined on a first run / after quarantining bad bytes. */
  load(): unknown | undefined;
  /** Persist a snapshot. NEVER throws — a full disk must not take down syncing. */
  save(snapshot: unknown): void;
}

export function createThreadCache(file: string): ThreadCache {
  const quarantine = (): void => {
    try {
      renameSync(file, `${file}.corrupt`);
    } catch {
      try {
        rmSync(file, { force: true });
      } catch {
        // Even removal failed; load() keeps answering undefined, which is survivable.
      }
    }
  };

  return {
    load() {
      try {
        if (!existsSync(file)) return undefined;
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        const envelope = parsed as { magic?: unknown; v?: unknown; snapshot?: unknown } | null;
        if (envelope?.magic !== MAGIC || envelope.v !== VERSION) return undefined;
        return envelope.snapshot;
      } catch {
        quarantine();
        return undefined;
      }
    },

    save(snapshot) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify({ magic: MAGIC, v: VERSION, snapshot }), { mode: 0o600 });
        renameSync(tmp, file);
      } catch {
        // Leave the previous good copy in place; the next debounced save tries again.
      }
    },
  };
}
