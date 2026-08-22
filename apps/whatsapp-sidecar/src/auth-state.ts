/**
 * THE SELF-HEALING AUTH STORE (TASK-20260822-wa-authstate-corruption).
 *
 * A drop-in for Baileys' `useMultiFileAuthState` — same folder, same file names, same
 * `BufferJSON` serialization, so an existing linked session resumes unchanged — with the
 * two properties the original lacks and this sidecar already demands of its other disk
 * state (ADR-0037 §1, `thread-cache.ts`):
 *
 *  - **Crash-atomic writes.** The original `writeFile`s in place; a kill mid-write leaves
 *    a torn file. Torn is exactly what the owner's machine had (2026-08-20): an
 *    `app-state-sync-key` file ending in a stray `"}`. Writes here go to a temp name and
 *    RENAME into place, at 0600 — these are session credentials.
 *  - **Salvage-then-quarantine reads.** The original swallows the parse error and returns
 *    null, which upstream reports as "failed to find key" — corruption misdescribed as
 *    absence, parking app-state sync forever. Here a file whose head parses but whose tail
 *    is garbage is HEALED (the valid prefix rewritten atomically) and served; a file with
 *    no parseable head is QUARANTINED aside (`.corrupt`, never deleted) and read as
 *    absent, so sync parks that one collection while everything else keeps flowing.
 *
 * Sync I/O by design: the original wraps async `writeFile` in per-path mutexes to stop
 * interleaved writes; synchronous ops make that race unrepresentable, and these files are
 * tiny. Format fidelity is pinned both directions against the real `useMultiFileAuthState`
 * in `__tests__/auth-state.test.ts` — verified against the pinned rc14 tarball, not
 * remembered.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BufferJSON, initAuthCreds, proto } from 'baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from 'baileys';

/** How far back from the tail the salvager searches for a parseable prefix. */
const MAX_TRAILING_GARBAGE = 1024;

/** Same spelling as the original — base64 ids carry `/` and `:`, and the file name is the contract. */
const fixFileName = (file: string): string => file.replace(/\//g, '__').replace(/:/g, '-');

const writeAtomically = (filePath: string, contents: string): void => {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, filePath);
};

const quarantine = (filePath: string): void => {
  try {
    renameSync(filePath, `${filePath}.corrupt`);
  } catch {
    try {
      rmSync(filePath, { force: true });
    } catch {
      // Even removal failed; the caller keeps answering "absent", which is survivable.
    }
  }
};

/**
 * The longest parseable prefix of `raw`, or undefined. `end === raw.length` on the first
 * try is the clean case; anything shorter means trailing garbage was shed.
 */
const salvage = (raw: string): { value: unknown; healedPrefix?: string } | undefined => {
  const floor = Math.max(1, raw.length - MAX_TRAILING_GARBAGE);
  for (let end = raw.length; end >= floor; end -= 1) {
    try {
      const prefix = raw.slice(0, end);
      const value: unknown = JSON.parse(prefix, BufferJSON.reviver);
      if (typeof value !== 'object' || value === null) return undefined;
      return end === raw.length ? { value } : { value, healedPrefix: prefix };
    } catch {
      // Not parseable at this length; shed one more byte.
    }
  }
  return undefined;
};

/** Read a JSON value, healing trailing garbage in place and quarantining what has no head. */
const readValue = (filePath: string): unknown => {
  if (!existsSync(filePath)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  const salvaged = salvage(raw);
  if (salvaged === undefined) {
    quarantine(filePath);
    return undefined;
  }
  if (salvaged.healedPrefix !== undefined) {
    try {
      // The healed bytes are the file's own valid prefix, verbatim — byte-identical to
      // what a clean writer produced, so stock Baileys reads it too.
      writeAtomically(filePath, salvaged.healedPrefix);
    } catch {
      // Healing is best-effort; the value is already in hand either way.
    }
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
  mkdirSync(folder, { recursive: true });
  const pathOf = (file: string): string => join(folder, fixFileName(file));

  const creds = (readValue(pathOf('creds.json')) as AuthenticationCreds | undefined) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            let value = readValue(pathOf(`${type}-${id}.json`)) ?? null;
            if (type === 'app-state-sync-key' && value !== null) {
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
              if (value === null || value === undefined) {
                rmSync(filePath, { force: true });
              } else {
                writeAtomically(filePath, JSON.stringify(value, BufferJSON.replacer));
              }
            }
          }
        },
      },
    },
    saveCreds: async () => {
      writeAtomically(pathOf('creds.json'), JSON.stringify(creds, BufferJSON.replacer));
    },
  };
}
