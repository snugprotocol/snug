// probe.ts — what the kit finds out about the host it woke up in, BEFORE React boots
// (TASK-20260905-host-kit P6; TASK-20260905-binding-a-artifacts AC1/AC2/AC5). Four
// questions, each pure-or-tried:
//
//   host     — `resolveHostNamespaces(use)` asks the artifact runtime for `sample`,
//              `artifact` and `downloads` TOGETHER, behind one named guard (claude.d.ts:
//              `use()` resolves `null` after 10 s where nothing answers; the guard covers a
//              `use` that never settles at all). Asked only when `window.claude.use` is a
//              function; nothing is prompted and nothing is spent (`use()` and `limits()`
//              ask the viewer nothing — sample.d.ts).
//   binding  — `decideBinding(env)` is pure over five facts (protocol, hostname, the two
//              claude globals, what the host answered) and matrix-tested. Disclosure and
//              the per-binding recipes read it; nothing routes on it (the surface flags do).
//              `'artifact-static'`: `use` exists but sample AND artifact are `null` — the
//              page served top-level on the artifact's own host (claude.d.ts:17-20), where
//              nothing can save and no brain exists; the chip says so and no save act renders.
//   storage  — `probeStorage()` TRIES each rung of the ladder (OPFS → IndexedDB → memory)
//              with a real write/read round trip and hands back the first that WORKS.
//              Never presence-based (review #1/#15/#30 of T2).
//   brain    — `probeBrain(env, host, complete)` PINS the host brain from what resolved:
//              `sample` → two adapters (envelopes on `quick`, the builder on `default`),
//              the shaper as the ruler, the cap from `limits()`; `window.claude.complete`
//              → the chat adapter, no streaming, no cap; nothing → the demo brain, with
//              every leg recorded so the chip's provenance is truthful (ADR-0059).
//
// Nothing here asks the user anything, and nothing here throws: a kit that cannot probe
// still boots on memory with the demo brain and says so.

import { createIdbBackend, createMemoryBackend, createOpfsBackend, type PersistenceBackend } from '@snugprotocol/db';
import { USERDB_OPFS_DIR } from '@snugprotocol/protocol';

import type { PlatformBrain, SnugPlatform } from '@playground/platform/platform';
import { isLocalEndpointHost } from '@playground/security/privateHost';

import { createCompleteAdapter, type CompleteFn } from './brains/complete.js';
import { measurePrompt } from './brains/prompt.js';
import { createSampleAdapter, type SampleFn } from './brains/sample.js';

// ---------------------------------------------------------------------------- binding

/** ONE home: the platform seat's union (apps/playground/src/platform/platform.ts). */
export type Binding = NonNullable<SnugPlatform['binding']>;

/** The facts the binding is decided on — read once from `window` by `readBindingEnv`, plus what the host answered. */
export interface BindingEnv {
  protocol: string;
  hostname: string;
  /** `window.claude.use` is a function — the HOSTED artifact runtime (`sample`, `artifact`). */
  claudeUse: boolean;
  /** `window.claude.complete` is a function — the CHAT artifact runtime. */
  claudeComplete: boolean;
  /** What `use()` answered, once asked: absent when it was never asked or never answered (guard). */
  hostAnswered?: { sample: boolean; artifact: boolean };
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

/**
 * The host globals outrank the origin: an artifact viewer is always https, and a page
 * served from anywhere ELSE with nothing wired is, for every purpose the kit has, a plain
 * file — `'file'` names "no host", not the scheme. A loopback http(s) origin with no host
 * globals is the local host (T3) or a developer's static server, which is the same thing
 * to the kit. `use` present with NOTHING resolving is the artifact host serving the page
 * top-level: `'artifact-static'` (nothing saves, no brain). No answer at all (the guard
 * tripped, or the sync path) keeps `'artifact'` — the T2 shape.
 */
export function decideBinding(env: BindingEnv): Binding {
  if (env.claudeUse) {
    if (env.hostAnswered !== undefined && !env.hostAnswered.sample && !env.hostAnswered.artifact) return 'artifact-static';
    return 'artifact';
  }
  if (env.claudeComplete) return 'artifact-chat';
  if (env.protocol === 'file:') return 'file';
  // The repo's ONE host classifier (security/privateHost.ts) — not a second loopback regex.
  if ((env.protocol === 'http:' || env.protocol === 'https:') && isLocalEndpointHost(env.hostname)) return 'local-host';
  return 'file';
}

// ---------------------------------------------------------------------- host namespaces

/** The `artifact` namespace slice the record uses (artifact.d.ts 0.2.41: the html form). */
export interface ArtifactNamespace {
  publish(html: string): Promise<{ version: string }>;
}

/** The `downloads` namespace slice the export seat uses (downloads.d.ts 0.2.41). */
export interface DownloadsNamespace {
  save(request: { filename: string; data: Uint8Array | string | Blob }): Promise<unknown>;
}

export type CapabilityLeg = 'resolved' | 'null';

export interface HostNamespaces {
  sample?: SampleFn;
  artifact?: ArtifactNamespace;
  downloads?: DownloadsNamespace;
  legs: { sample: CapabilityLeg; artifact: CapabilityLeg; downloads: CapabilityLeg };
  /** True when at least one `use()` never settled inside the guard (a broken host, not a `null` answer). */
  guardTripped: boolean;
  /** True when at least one `use()` REJECTED (threw) — a broken host, never reported as a static page. */
  rejected: boolean;
}

/**
 * The guard for a `use()` that never settles. The contract itself resolves `null` after
 * 10 s where no viewer answers; a real viewer answers in milliseconds (the hosted walk
 * journals the measured number). Sized ABOVE the contract's own timer so a slow-but-honest
 * `null` is never mistaken for a hang.
 */
export const HOST_ANSWER_GUARD_MS = 15_000;

const NAMESPACES = ['sample', 'artifact', 'downloads'] as const;

export async function resolveHostNamespaces(
  use: (name: string) => Promise<unknown>,
  /** `guardMs` is a test seam; production takes HOST_ANSWER_GUARD_MS. */
  options: { guardMs?: number } = {},
): Promise<HostNamespaces> {
  const guardMs = options.guardMs ?? HOST_ANSWER_GUARD_MS;
  let guardTripped = false;
  let rejected = false;
  const ask = async (name: (typeof NAMESPACES)[number]): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        guardTripped = true;
        resolve(null);
      }, guardMs);
    });
    try {
      return await Promise.race([
        use(name).catch(() => {
          rejected = true;
          return null;
        }),
        guard,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const [sample, artifact, downloads] = await Promise.all(NAMESPACES.map(ask));
  const isSample = typeof sample === 'function';
  const isArtifact = typeof (artifact as { publish?: unknown } | null)?.publish === 'function';
  const isDownloads = typeof (downloads as { save?: unknown } | null)?.save === 'function';
  return {
    ...(isSample ? { sample: sample as SampleFn } : {}),
    ...(isArtifact ? { artifact: artifact as ArtifactNamespace } : {}),
    ...(isDownloads ? { downloads: downloads as DownloadsNamespace } : {}),
    legs: { sample: isSample ? 'resolved' : 'null', artifact: isArtifact ? 'resolved' : 'null', downloads: isDownloads ? 'resolved' : 'null' },
    guardTripped,
    rejected,
  };
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
export async function opfsRoundTrip(storage: { getDirectory?: unknown } | undefined): Promise<boolean> {
  const getDirectory = storage?.getDirectory;
  if (typeof getDirectory !== 'function') return false;
  // Invoked AS A METHOD of `navigator.storage`: an unbound `getDirectory()` throws
  // "Illegal invocation" in Chromium, which the try-the-ladder wrapper would read as
  // "OPFS does not work here" — found on the real page (2026-09-05), invisible to a
  // closure fake.
  const root = (await (getDirectory as () => Promise<unknown>).call(storage)) as {
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
  if (await tried(() => opfsRoundTrip(env.storage))) return { backend: factories.opfs(), kind: 'opfs' };
  if (await tried(() => idbRoundTrip(env.indexedDB))) return { backend: factories.idb(), kind: 'idb' };
  return { backend: factories.memory(), kind: 'memory' };
}

// ------------------------------------------------------------------------------ brain

/** `detected`: the global was a function but nothing resolved (or nothing was asked); `resolved`/`null`: the host's answer. */
export type BrainLeg = 'absent' | 'detected' | 'resolved' | 'null';

export interface BrainProbeResult {
  brain: PlatformBrain;
  /** The typed seats: `sample` (hosted), `complete` (chat), `local` (T3's boot config). */
  legs: { sample: BrainLeg; complete: BrainLeg; local: 'absent' };
}

export const HOSTED_BRAIN_LABEL = 'Claude · this artifact’s viewer';
export const CHAT_BRAIN_LABEL = 'Claude · this chat';
/** The documented cap when `limits()` cannot be read (T4 S11 measured exactly this value). */
export const DEFAULT_MAX_PROMPT_BYTES = 65_536;

/**
 * The brain, pinned from what resolved. Async only because `sample.limits()` is: the cap is
 * read FIRST (it prompts and spends nothing — sample.d.ts) so both adapters and the seat are
 * built with the same number, once (maintainability review 3 — a seat copied by value into
 * the adapters and mutated later named 65,536 in its refusal while the builder budgeted on
 * the real cap).
 */
export async function probeBrain(env: BindingEnv, host?: HostNamespaces, complete?: CompleteFn): Promise<BrainProbeResult> {
  const sampleLeg: BrainLeg = env.claudeUse ? (host === undefined ? 'detected' : host.legs.sample) : 'absent';
  if (host?.sample !== undefined) {
    const sample = host.sample;
    const maxPromptBytes = await sample
      .limits()
      .then((limits) => (typeof limits?.maxPromptBytes === 'number' && limits.maxPromptBytes > 0 ? limits.maxPromptBytes : DEFAULT_MAX_PROMPT_BYTES))
      .catch(() => DEFAULT_MAX_PROMPT_BYTES);
    const brain: PlatformBrain = {
      kind: 'host',
      label: HOSTED_BRAIN_LABEL,
      adapter: createSampleAdapter(sample, { modelTier: 'quick', maxPromptBytes }),
      chatAdapter: createSampleAdapter(sample, { modelTier: 'default', maxPromptBytes }),
      streaming: true,
      tools: false,
      maxPromptBytes,
      promptBytes: measurePrompt,
    };
    return { brain, legs: { sample: 'resolved', complete: env.claudeComplete ? 'detected' : 'absent', local: 'absent' } };
  }
  if (!env.claudeUse && env.claudeComplete && complete !== undefined) {
    const brain: PlatformBrain = {
      kind: 'host',
      label: CHAT_BRAIN_LABEL,
      adapter: createCompleteAdapter(complete),
      streaming: false,
      tools: false,
      promptBytes: measurePrompt,
    };
    return { brain, legs: { sample: 'absent', complete: 'resolved', local: 'absent' } };
  }
  return {
    brain: { kind: 'demo' },
    legs: { sample: sampleLeg, complete: env.claudeComplete ? 'detected' : 'absent', local: 'absent' },
  };
}

// --------------------------------------------------------------------------- together

export interface ProbeResult {
  binding: Binding;
  storage: StorageProbeResult;
  brain: BrainProbeResult;
  /** The resolved host namespaces (hosted artifact only) — the record and the export seat read them. */
  host?: HostNamespaces;
}

export interface ProbeWindowLike extends BindingWindowLike {
  navigator?: { storage?: { getDirectory?: unknown } | undefined } | undefined;
  indexedDB?: IDBFactory | undefined;
}

/**
 * The whole probe, from `window`, in the order the kit boots: host, binding, storage, brain.
 * `use` and `complete` are invoked AS METHODS of `window.claude` — an unbound call is
 * "Illegal invocation" on a this-dependent runtime, the `getDirectory` class of defect the
 * T2 walk found (correctness review 6). A `use` that rejects, like one that never answers,
 * leaves the binding at `artifact`: only an ANSWER of `null` makes a static page.
 */
export async function runProbe(win: ProbeWindowLike, options: { guardMs?: number } = {}): Promise<ProbeResult> {
  const env = readBindingEnv(win);
  const claude = (win.claude ?? undefined) as { use?: (name: string) => Promise<unknown>; complete?: CompleteFn } | undefined;
  let host: HostNamespaces | undefined;
  if (env.claudeUse && claude?.use !== undefined) {
    host = await resolveHostNamespaces((name) => claude.use!(name), options);
    if (!host.guardTripped && !host.rejected) env.hostAnswered = { sample: host.sample !== undefined, artifact: host.artifact !== undefined };
  }
  const complete = !env.claudeUse && env.claudeComplete && claude?.complete !== undefined ? (prompt: string) => claude.complete!(prompt) : undefined;
  const storage = await probeStorage({ storage: win.navigator?.storage, indexedDB: win.indexedDB });
  const brain = await probeBrain(env, host, complete);
  return { binding: decideBinding(env), storage, brain, ...(host !== undefined ? { host } : {}) };
}
