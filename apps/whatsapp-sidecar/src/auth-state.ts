/**
 * THE SELF-HEALING AUTH STORE (TASK-20260822-wa-authstate-corruption).
 *
 * A drop-in for Baileys' `useMultiFileAuthState` — same folder, same file names, same
 * `BufferJSON` serialization, so an existing linked session resumes unchanged — with the
 * properties the original lacks and this sidecar already demands of its other disk state
 * (ADR-0037 §1, `thread-cache.ts`):
 *
 *  - **Crash-atomic writes.** The original `writeFile`s in place; a kill mid-write leaves
 *    a torn file. Torn is exactly what the owner's machine had (2026-08-20): an
 *    `app-state-sync-key` file ending in a stray `"}`. Writes here go to a UNIQUE temp
 *    name (a fixed name is a cross-process race — the documented rival-helper scenario),
 *    fsync (rename alone can commit before the data blocks on power loss — the desktop
 *    shell's Rust user-file write learned this first), then RENAME into place, at 0600 —
 *    these are session credentials. Write FAILURES are logged and swallowed: a full disk
 *    must not take down the link (thread-cache doctrine); the next update retries.
 *  - **Salvage-then-quarantine reads.** The original swallows the parse error and returns
 *    null, which upstream reports as "failed to find key" — corruption misdescribed as
 *    absence, parking app-state sync forever. Here a file whose head parses but whose tail
 *    is garbage is HEALED (the valid prefix rewritten atomically) and served; a file with
 *    no parseable head is quarantined aside (`.corrupt-<hash>`, hash-named so repeat
 *    corruption never clobbers earlier evidence, and NEVER deleted) and read as absent.
 *    Values of ANY JSON type survive — `lid-mapping` entries are bare strings (the live
 *    store holds 1,600+), and an object-only reader would have quarantined the whole
 *    LID↔phone directory on first read.
 *  - **Absence is ENOENT and nothing else.** A transient EACCES/EMFILE read as "no creds"
 *    would hand back fresh creds, and the next `creds.update` would atomically OVERWRITE
 *    the user's working session — so any other read error THROWS instead of impersonating
 *    a fresh start.
 *  - **`creds.json` quarantines by COPY, keys by rename.** The desktop autostart predicate
 *    and the wedge predicate both read `creds.json` by name; renaming it away would
 *    disable autostart forever while full signal material lingered in the aside copy with
 *    no UI path to forget it. The corrupt original stays put and the existing wedge-clear
 *    machinery (`shouldResetAuthStore`) stays in charge.
 *
 * Sync I/O by design: the original wraps async `writeFile` in per-path mutexes to stop
 * interleaved writes; synchronous ops make that in-process race unrepresentable, and these
 * files are tiny. Format fidelity is pinned both directions against the real
 * `useMultiFileAuthState` in `__tests__/auth-state.test.ts` — verified against the pinned
 * rc14 tarball, not remembered.
 */

import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { BufferJSON, initAuthCreds, proto } from 'baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from 'baileys';

/** Same spelling as the original — base64 ids carry `/` and `:`, and the file name is the contract. */
const fixFileName = (file: string): string => file.replace(/\//g, '__').replace(/:/g, '-');

/** Monotonic within the process; with the pid it makes every temp name unique. */
let tmpSeq = 0;

/** The throwing core. Callers decide whether a failure may propagate. */
const writeAtomically = (filePath: string, contents: string): void => {
  tmpSeq += 1;
  const tmp = `${filePath}.${process.pid}.${tmpSeq}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, filePath);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
};

/** The swallowing wrapper every persist path uses — a full disk must not take down the link. */
const persist = (filePath: string, contents: string, what: string): void => {
  try {
    writeAtomically(filePath, contents);
  } catch (error) {
    console.error(`[auth-state] failed to persist ${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/** Aside name derived from the CONTENT: repeat corruption never clobbers different evidence. */
const asideNameFor = (filePath: string, raw: string): string =>
  `${filePath}.corrupt-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;

/** Whether `raw[end - 1]` could end a JSON document — prunes the salvage scan's parse attempts. */
const canTerminateJson = (ch: string): boolean => /[\]}"0-9el]/.test(ch);

/**
 * The longest parseable prefix of `raw` (any JSON type), or undefined. The scan runs to the
 * start of the string: the one file where giving up early is catastrophic — `creds.json` —
 * is also the one whose legacy in-place rewrites could leave a tail longer than any fixed
 * bound. Cost is bounded by the terminator prune; it is paid only on already-corrupt files.
 */
const salvage = (raw: string): { value: unknown; healedPrefix?: string } | undefined => {
  for (let end = raw.length; end >= 1; end -= 1) {
    if (end !== raw.length && !canTerminateJson(raw[end - 1] as string)) continue;
    try {
      const prefix = raw.slice(0, end);
      const value: unknown = JSON.parse(prefix, BufferJSON.reviver);
      return end === raw.length ? { value } : { value, healedPrefix: prefix };
    } catch {
      // Not parseable at this length; shed another byte.
    }
  }
  return undefined;
};

/**
 * Salvage a raw JSON string without touching any file — the read-only half of `readValue`,
 * exported so sibling readers of the SAME files (the resume/wedge predicates in
 * `baileys-socket.ts`) parse with the store's leniency instead of contradicting it when a
 * heal-write could not land.
 */
export const salvageParse = (raw: string): unknown => salvage(raw)?.value;

/**
 * Read a JSON value, healing trailing garbage in place and quarantining what has no head.
 * Returns undefined for ENOENT and for quarantined corruption; THROWS on any other read
 * error — see module header. `preserveOnCorrupt` copies the aside instead of renaming.
 */
const readValue = (filePath: string, opts: { preserveOnCorrupt?: boolean } = {}): unknown => {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const salvaged = salvage(raw);
  if (salvaged === undefined) {
    const aside = asideNameFor(filePath, raw);
    try {
      if (opts.preserveOnCorrupt === true) {
        writeAtomically(aside, raw);
      } else {
        renameSync(filePath, aside);
      }
    } catch {
      // Quarantine is best-effort: the file stays put and this read answers absent.
      // NEVER fall back to deleting — the bytes are the only forensic evidence.
    }
    return undefined;
  }
  if (salvaged.healedPrefix !== undefined) {
    // The healed bytes are the file's own valid prefix, verbatim — byte-identical to what
    // a clean writer produced, so stock Baileys reads it too. Best-effort by `persist`.
    persist(filePath, salvaged.healedPrefix, `healed ${filePath}`);
  }
  return salvaged.value;
};

/**
 * Same call shape and on-disk format as `useMultiFileAuthState(folder)`; see module header
 * for what differs and why.
 */
export async function createFileAuthState(
  folder: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  try {
    mkdirSync(folder, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTDIR') {
      throw new Error(`found something that is not a directory at ${folder}, either delete it or specify a different location`);
    }
    throw error;
  }
  const pathOf = (file: string): string => join(folder, fixFileName(file));

  const creds =
    (readValue(pathOf('creds.json'), { preserveOnCorrupt: true }) as AuthenticationCreds | undefined) ??
    initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            let value = readValue(pathOf(`${type}-${id}.json`)) ?? null;
            if (type === 'app-state-sync-key' && value !== null && typeof value === 'object') {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value as SignalDataTypeMap[T];
          }
          return data;
        },
        set: async (data: SignalDataSet) => {
          for (const category in data) {
            const entries = data[category as keyof SignalDataTypeMap];
            for (const id in entries) {
              const value: unknown = entries[id];
              const filePath = pathOf(`${category}-${id}.json`);
              // Truthiness, like the original: Baileys hands `''` for an empty lidUser,
              // and the original REMOVED that file rather than writing scalar litter.
              if (value) {
                persist(filePath, JSON.stringify(value, BufferJSON.replacer), `${category}-${id}`);
              } else {
                try {
                  rmSync(filePath, { force: true });
                } catch {
                  // Removal is best-effort, like the original's swallowed unlink.
                }
              }
            }
          }
        },
      },
    },
    saveCreds: async () => {
      persist(pathOf('creds.json'), JSON.stringify(creds, BufferJSON.replacer), 'creds.json');
    },
  };
}
