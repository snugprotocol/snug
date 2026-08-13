// Desktop 'file' persistence backend (TASK-20260812 AC2): whole serialized files under
// one real directory (~/Snug on the desktop shell), written through an injected
// filesystem seam so the backend itself stays pure TS — the Tauri side implements the
// seam over its read_user_file/write_user_file commands.
import { looksComplete, type PersistenceBackend } from './persistence.js';

/**
 * The minimal filesystem the file backend needs, injected (plain-interface DI).
 *
 * - `readFile` resolves `undefined` for genuine absence (no such file) and REJECTS on
 *   any I/O failure — the two must never be conflated, or a transient read error
 *   silently opens a fresh database over real data (lesson 2026-08-03).
 * - `writeFileAtomic` owns atomicity: the implementation MUST write a temp file and
 *   rename it over the target (the Tauri `write_user_file` command does temp+rename),
 *   so a crash mid-write leaves the previous complete file in place. The backend
 *   deliberately does not re-implement safe-write on top — one atomicity contract,
 *   enforced where the bytes actually hit the disk.
 */
export interface FileBackendFs {
  readFile(path: string): Promise<Uint8Array | undefined>;
  writeFileAtomic(path: string, bytes: Uint8Array): Promise<void>;
}

/**
 * A PersistenceBackend storing each file as `${dir}/${file}`. Loads enforce the same
 * completeness rule as the OPFS backend (`looksComplete`: sqlite header OR the
 * SNUGSYNC1 sidecar envelope) — bytes that exist but carry neither magic are a torn or
 * corrupt write and THROW, so callers hit their corrupt/quarantine paths instead of
 * silently starting fresh. `undefined` means exactly one thing: the file does not exist.
 */
export function createFileBackend(fs: FileBackendFs, dir: string): PersistenceBackend {
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir;
  const pathOf = (file: string): string => `${base}/${file}`;

  return {
    kind: 'file',
    async load(file) {
      const path = pathOf(file);
      const bytes = await fs.readFile(path); // an I/O rejection propagates — it is not absence
      if (bytes === undefined) return undefined; // genuine absence: the only fresh-DB signal
      const length = bytes.length; // read before the guard: its negation narrows bytes to never
      if (!looksComplete(bytes)) {
        const shape = length === 0 ? 'empty' : `${length} magic-less bytes`;
        throw new Error(
          `stored file "${path}" is ${shape} — not a complete SQLite database or sync sidecar; ` +
            'refusing to treat corruption as a fresh start',
        );
      }
      return bytes;
    },
    async save(file, bytes) {
      await fs.writeFileAtomic(pathOf(file), bytes);
    },
  };
}
