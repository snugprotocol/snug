// probe.ts — what the kit finds out about the host it woke up in, BEFORE React boots
// (TASK-20260905-host-kit P6). Three questions, three pure-or-tried answers:
//
//   binding  — `decideBinding(env)` is pure over four facts (protocol, hostname, the two
//              claude globals) and matrix-tested. Disclosure and the per-binding recipes
//              read it; nothing routes on it (the surface flags do — P2).
//   storage  — `probeStorage()` TRIES each rung of the ladder (OPFS → IndexedDB → memory)
//              with a real write/read round trip and hands back the first that WORKS.
//              Never presence-based: Chromium reports `navigator.storage.getDirectory` as
//              a function at file:// and rejects the call with SecurityError; Safari's main
//              thread hands out a directory whose file handles cannot `createWritable`.
//              `detectPersistenceBackend` would pick either and the user would read "your
//              Snug file couldn't be read" (review #1/#15/#30).
//   brain    — `probeBrain()` pins the DEMO brain in T2 (ADR-0065 §4 / D15: the kit never
//              asks). The `legs` record is the typed seat T3/T4 fill: what was DETECTED is
//              recorded now so the chip's provenance is truthful the day a leg is wired.
//
// Nothing here asks the user anything, and nothing here throws: a kit that cannot probe
// still boots on memory with the demo brain and says so.

import { createIdbBackend, createMemoryBackend, createOpfsBackend, type PersistenceBackend } from '@snugprotocol/db';
import { USERDB_OPFS_DIR } from '@snugprotocol/protocol';

import type { PlatformBrain } from '@playground/platform/platform';

// ---------------------------------------------------------------------------- binding

export type Binding = 'artifact' | 'artifact-chat' | 'local-host' | 'file';

/** The four facts the binding is decided on — read once from `window` by `readBindingEnv`. */
export interface BindingEnv {
  protocol: string;
  hostname: string;
  /** `window.claude.use` is a function — the HOSTED artifact runtime (`sample`, `artifact`). */
  claudeUse: boolean;
  /** `window.claude.complete` is a function — the CHAT artifact runtime. */
  claudeComplete: boolean;
}

export interface BindingWindowLike {
  location: { protocol: string; hostname: string };
  claude?: unknown;
}

const isFunction = (value: unknown): boolean => typeof value === 'function';

export function readBindingEnv(win: BindingWindowLike): BindingEnv {
  const claude = (win.claude ?? undefined) as { use?: unknown; complete?: unknown } | undefined;
  return {
    protocol: win.location.protocol,
    hostname: win.location.hostname,
    claudeUse: isFunction(claude?.use),
    claudeComplete: isFunction(claude?.complete),
  };
}

/** `localhost`, `*.localhost`, the whole 127/8 block, and IPv6 loopback (bracketed or bare). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '[::1]' || h === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * The host globals outrank the origin: an artifact viewer is always https, and a page
 * served from anywhere ELSE with nothing wired is, for every purpose the kit has, a plain
 * file — `'file'` names "no host", not the scheme. A loopback http(s) origin with no host
 * globals is the local host (T3) or a developer's static server, which is the same thing
 * to the kit.
 */
export function decideBinding(env: BindingEnv): Binding {
  if (env.claudeUse) return 'artifact';
  if (env.claudeComplete) return 'artifact-chat';
  if (env.protocol === 'file:') return 'file';
  if ((env.protocol === 'http:' || env.protocol === 'https:') && isLoopbackHost(env.hostname)) return 'local-host';
  return 'file';
}

// ---------------------------------------------------------------------------- storage

export type StorageKind = 'opfs' | 'idb' | 'memory';

export interface StorageProbeResult {
  backend: PersistenceBackend;
  /** The rung that WORKED — the disclosure names it (AC2). */
  kind: StorageKind;
}

/** What the probe reads off `window` — every seat optional, every seat only TRIED. */
export interface StorageEnv {
  storage?: { getDirectory?: unknown } | undefined;
  indexedDB?: IDBFactory | undefined;
}

/** The factories the winner is built with; injectable so the ladder can be tested with fakes. */
export interface StorageFactories {
  opfs: () => PersistenceBackend;
  idb: () => PersistenceBackend;
  memory: () => PersistenceBackend;
}

const DEFAULT_FACTORIES: StorageFactories = {
  // The SAME directory names the web playground uses, so a user who later serves the
  // ordinary playground from this origin finds the same file.
  opfs: () => createOpfsBackend(USERDB_OPFS_DIR),
  idb: () => createIdbBackend(USERDB_OPFS_DIR),
  memory: () => createMemoryBackend(),
};

const PROBE_FILE = 'snug-host.probe';
const PROBE_DB = 'snug-host-probe';
const PROBE_BYTES = new TextEncoder().encode('snug-host-probe/1');

// Realm-agnostic on purpose: a value that crossed IndexedDB's structured clone (or a test
// environment's window boundary) is a typed array whose constructor is not THIS realm's
// `Uint8Array`, so `instanceof` lies while `ArrayBuffer.isView` and the tag do not.
const toBytes = (back: unknown): Uint8Array | undefined => {
  if (ArrayBuffer.isView(back)) return new Uint8Array(back.buffer, back.byteOffset, back.byteLength);
  if (Object.prototype.toString.call(back) === '[object ArrayBuffer]') return new Uint8Array(back as ArrayBuffer);
  return undefined;
};

const sameBytes = (back: unknown): boolean => {
  const bytes = toBytes(back);
  if (bytes === undefined || bytes.length !== PROBE_BYTES.length) return false;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== PROBE_BYTES[i]) return false;
  return true;
};

/**
 * The OPFS round trip mirrors exactly what `createOpfsBackend` needs: a directory handle
 * under the root, a file handle with `create`, a writable stream, a readable File. Any
 * step missing or rejecting means the backend would fail the same way at first save.
 */
export async function opfsRoundTrip(getDirectory: unknown): Promise<boolean> {
  if (typeof getDirectory !== 'function') return false;
  const root = (await (getDirectory as () => Promise<unknown>)()) as {
    getDirectoryHandle?: (name: string, opts?: { create?: boolean }) => Promise<unknown>;
  };
  if (typeof root?.getDirectoryHandle !== 'function') return false;
  const dir = (await root.getDirectoryHandle(USERDB_OPFS_DIR, { create: true })) as {
    getFileHandle?: (name: string, opts?: { create?: boolean }) => Promise<unknown>;
    removeEntry?: (name: string) => Promise<void>;
  };
  if (typeof dir?.getFileHandle !== 'function') return false;
  const handle = (await dir.getFileHandle(PROBE_FILE, { create: true })) as {
    createWritable?: () => Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>;
    getFile?: () => Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
  };
  try {
    if (typeof handle?.createWritable !== 'function' || typeof handle.getFile !== 'function') return false;
    const writable = await handle.createWritable();
    await writable.write(PROBE_BYTES.slice());
    await writable.close();
    return sameBytes(await (await handle.getFile()).arrayBuffer());
  } finally {
    // Best effort: a probe file left behind is harmless (the backend reads fixed names).
    try {
      await dir.removeEntry?.(PROBE_FILE);
    } catch {
      /* ignore */
    }
  }
}

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
  });

export async function idbRoundTrip(factory: IDBFactory | undefined): Promise<boolean> {
  if (typeof factory?.open !== 'function') return false;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(PROBE_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
  try {
    await request(db.transaction('files', 'readwrite').objectStore('files').put(PROBE_BYTES.slice(), 'probe'));
    return sameBytes(await request(db.transaction('files', 'readonly').objectStore('files').get('probe')));
  } finally {
    db.close();
    // Best effort, awaited so a listing right after the probe does not still show it.
    await new Promise<void>((resolve) => {
      try {
        const del = factory.deleteDatabase(PROBE_DB);
        del.onsuccess = () => resolve();
        del.onerror = () => resolve();
        del.onblocked = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}

const tried = async (attempt: () => Promise<boolean>): Promise<boolean> => {
  try {
    return await attempt();
  } catch {
    return false;
  }
};

export async function probeStorage(env: StorageEnv, factories: StorageFactories = DEFAULT_FACTORIES): Promise<StorageProbeResult> {
  if (await tried(() => opfsRoundTrip(env.storage?.getDirectory))) return { backend: factories.opfs(), kind: 'opfs' };
  if (await tried(() => idbRoundTrip(env.indexedDB))) return { backend: factories.idb(), kind: 'idb' };
  return { backend: factories.memory(), kind: 'memory' };
}

// ------------------------------------------------------------------------------ brain

export type BrainLeg = 'absent' | 'detected';

export interface BrainProbeResult {
  brain: PlatformBrain;
  /**
   * The typed seats T3/T4 fill: `sample` (hosted artifact, `claude.use`), `complete` (chat
   * artifact, `window.claude.complete`), `local` (the local host's boot config). In T2 a
   * detected leg is recorded and NOT wired — the brain is the demo brain and the chip says
   * "no host brain wired yet".
   */
  legs: { sample: BrainLeg; complete: BrainLeg; local: 'absent' };
}

export function probeBrain(env: BindingEnv): BrainProbeResult {
  return {
    brain: { kind: 'demo' },
    legs: {
      sample: env.claudeUse ? 'detected' : 'absent',
      complete: env.claudeComplete ? 'detected' : 'absent',
      local: 'absent',
    },
  };
}

// --------------------------------------------------------------------------- together

export interface ProbeResult {
  binding: Binding;
  storage: StorageProbeResult;
  brain: BrainProbeResult;
}

export interface ProbeWindowLike extends BindingWindowLike {
  navigator?: { storage?: { getDirectory?: unknown } | undefined } | undefined;
  indexedDB?: IDBFactory | undefined;
}

/** The whole probe, from `window`, in the order the kit boots: binding, storage, brain. */
export async function runProbe(win: ProbeWindowLike): Promise<ProbeResult> {
  const env = readBindingEnv(win);
  const storage = await probeStorage({ storage: win.navigator?.storage, indexedDB: win.indexedDB });
  return { binding: decideBinding(env), storage, brain: probeBrain(env) };
}
