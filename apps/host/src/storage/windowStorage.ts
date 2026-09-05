// windowStorage.ts — the chat artifact's page storage as a `PersistenceBackend`
// (TASK-20260905-binding-a-artifacts AC4). claude.ai / Claude Desktop chat artifacts expose
// a flat `window.storage` (get / set / delete / list, T1 S10: persists across reloads, PER
// VIEW — the in-chat view and the published link hold separate stores; a documented 20 MB
// text cap, unmeasured). Values are strings, so the file rides as base64 in chunks.
//
// THE DISCIPLINE (lessons 2026-08-03 and 2026-08-22, the OPFS backend's A/B slots in
// another shape): every save writes a NEW generation's chunks first and flips the manifest
// LAST, so a write torn at any point leaves the previous generation complete and the
// manifest still pointing at it; the old generation is removed only after the flip. An
// empty read is "no file" ONLY when `list()` proves the manifest key absent — S10 measured
// `get` of a never-written key throwing a GENERIC message, so the message alone is never
// evidence of absence. A manifest that exists but cannot be read, names a chunk that is
// missing, or whose bytes fail their sha is CORRUPT: `load` throws, and `openUserDb`'s
// quarantine path does the rest — never a pristine file over the user's data.

import { base64ToBytes, bytesToBase64, type PersistenceBackend } from '@snugprotocol/db';

import { sha256Hex } from './sha256.js';

export const WINDOW_STORAGE_KEY_PREFIX = 'snug-user/';
export const WINDOW_STORAGE_FORMAT = 'snug-window-storage/1';
/** S4b measured 200,000-char writes at 325–551 ms each; the same chunk size here. */
export const DEFAULT_CHUNK_CHARS = 200_000;
/** The contract's documented text cap (unmeasured) — applied to the base64 as a whole. */
export const DEFAULT_MAX_TEXT_CHARS = 20_000_000;

/** The flat `window.storage` the chat viewer exposes (S10's observed shapes; values are strings). */
export interface WindowStorageLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list(prefix?: string): Promise<unknown>;
}

export class WindowStorageTooLarge extends Error {
  constructor(chars: number, cap: number) {
    super(`this file is ${chars.toLocaleString('en-US')} characters as text — this chat’s storage holds up to ${cap.toLocaleString('en-US')}; export the file to keep it`);
    this.name = 'WindowStorageTooLarge';
  }
}

export class WindowStorageCorrupt extends Error {
  constructor(detail: string) {
    super(`the file in this chat’s storage is corrupt: ${detail}`);
    this.name = 'WindowStorageCorrupt';
  }
}

interface Manifest {
  format: typeof WINDOW_STORAGE_FORMAT;
  gen: number;
  chunks: number;
  sha256: string;
  bytes: number;
}

/** A stored value comes back as `{ key, value }` (S10) or, on another shell, bare. */
function unwrapValue(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw !== null && typeof (raw as { value?: unknown }).value === 'string') return (raw as { value: string }).value;
  return undefined;
}

function unwrapKeys(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((k): k is string => typeof k === 'string');
  const keys = (raw as { keys?: unknown } | null)?.keys;
  return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
}

export function createWindowStorageBackend(
  storage: WindowStorageLike,
  options: { chunkChars?: number; maxTextChars?: number } = {},
): PersistenceBackend {
  const chunkChars = options.chunkChars ?? DEFAULT_CHUNK_CHARS;
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const manifestKey = (file: string): string => `${WINDOW_STORAGE_KEY_PREFIX}${file}`;
  const chunkKey = (file: string, gen: number, n: number): string => `${WINDOW_STORAGE_KEY_PREFIX}${file}/${gen}/${n}`;
  const genPrefix = (file: string, gen: number): string => `${WINDOW_STORAGE_KEY_PREFIX}${file}/${gen}/`;

  const listKeys = async (prefix: string): Promise<string[]> => {
    try {
      return unwrapKeys(await storage.list(prefix));
    } catch {
      return [];
    }
  };

  /** The manifest, `undefined` when PROVEN absent, a throw when present but unreadable. */
  const readManifest = async (file: string): Promise<Manifest | undefined> => {
    let raw: unknown;
    try {
      raw = await storage.get(manifestKey(file));
    } catch {
      const keys = await listKeys(manifestKey(file));
      if (!keys.includes(manifestKey(file))) return undefined;
      throw new WindowStorageCorrupt('its manifest exists but could not be read (unreadable, not absent)');
    }
    const text = unwrapValue(raw);
    if (text === undefined) throw new WindowStorageCorrupt('its manifest is not text');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new WindowStorageCorrupt('its manifest is not JSON');
    }
    const m = parsed as Partial<Manifest> | null;
    if (m === null || m.format !== WINDOW_STORAGE_FORMAT || typeof m.gen !== 'number' || typeof m.chunks !== 'number' || typeof m.sha256 !== 'string' || typeof m.bytes !== 'number') {
      throw new WindowStorageCorrupt(`its manifest is not ${WINDOW_STORAGE_FORMAT}`);
    }
    return m as Manifest;
  };

  return {
    kind: 'window-storage',
    async load(file) {
      const manifest = await readManifest(file);
      if (manifest === undefined) return undefined;
      let base64 = '';
      for (let n = 0; n < manifest.chunks; n++) {
        let raw: unknown;
        try {
          raw = await storage.get(chunkKey(file, manifest.gen, n));
        } catch {
          throw new WindowStorageCorrupt(`chunk ${n + 1} of ${manifest.chunks} is missing`);
        }
        const chunk = unwrapValue(raw);
        if (chunk === undefined) throw new WindowStorageCorrupt(`chunk ${n + 1} of ${manifest.chunks} is missing`);
        base64 += chunk;
      }
      const bytes = base64ToBytes(base64);
      if (bytes === undefined) throw new WindowStorageCorrupt('its chunks are not base64');
      if (bytes.length !== manifest.bytes || (await sha256Hex(bytes)) !== manifest.sha256) {
        throw new WindowStorageCorrupt('its bytes do not match the manifest sha256');
      }
      return bytes;
    },
    async save(file, bytes) {
      const base64 = bytesToBase64(bytes);
      if (base64.length > maxTextChars) throw new WindowStorageTooLarge(base64.length, maxTextChars);
      let previous: Manifest | undefined;
      try {
        previous = await readManifest(file);
      } catch {
        previous = undefined; // an unreadable manifest is replaced by the write below
      }
      const gen = (previous?.gen ?? 0) + 1;
      const chunks = Math.max(1, Math.ceil(base64.length / chunkChars));
      for (let n = 0; n < chunks; n++) {
        await storage.set(chunkKey(file, gen, n), base64.slice(n * chunkChars, (n + 1) * chunkChars));
      }
      const manifest: Manifest = { format: WINDOW_STORAGE_FORMAT, gen, chunks, sha256: await sha256Hex(bytes), bytes: bytes.length };
      // The commit point — only after every chunk landed.
      await storage.set(manifestKey(file), JSON.stringify(manifest));
      if (previous !== undefined && previous.gen !== gen) {
        // Best effort: an orphaned chunk is dead weight, never data loss.
        for (const key of await listKeys(genPrefix(file, previous.gen))) {
          try {
            await storage.delete(key);
          } catch {
            /* leave it */
          }
        }
      }
    },
  };
}
