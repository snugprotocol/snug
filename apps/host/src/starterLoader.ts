// starterLoader.ts — the on-demand StarterSource (TASK-20260905-host-kit AC14, A3). The
// kit build aliases the playground's `starter/starterSource.ts` (the ONE owner of the
// examples globs) to `starterSource.ts`, which builds this over the baked index.
//
// WHAT IS INLINE, WHAT LOADS. `appFolders()` and the small per-starter files — release
// meta, runtime contract, connection manifest (≈ 30 KB for all twelve) — are inline in
// the index, because the shelf paints from the catalogue at first render and
// `bundledStarterContracts()` walks EVERY folder (an on-demand contract would load all
// twelve wrappers on one install). The html and the authoring docs (≈ 1 MB) load on click
// from the content-pinned `@snugprotocol/starters` package on jsDelivr `/npm/` — the one
// CDN both artifact viewers allow (T1 S2).
//
// THE PROTOCOL. `load(folder)` appends exactly ONE classic `<script>` with `src`,
// `integrity="sha384-…"` (the hash baked from `index.json`) and `crossorigin="anonymous"`
// (SRI needs CORS). The wrapper calls `window.__snugStarterRegister(payload)`; the hook is
// installed once per page and dispatches by `payload.folder` to whoever asked. A script
// error, a wrapper that never registers (timeout), a payload of the wrong shape or the
// wrong package VERSION each reject with a NAMED `StarterLoadError` — never a hang, never
// a dead control — and remove the element so a retry appends a fresh one.
//
// `authoring()` is the bundles of every starter LOADED SO FAR. The playground seeds a
// starter's wiki at install, after its html was loaded for the run view, so the one being
// installed is always among them; a starter never clicked has no docs to seed.

import type { StarterAuthoringBundle, StarterSource } from '@playground/starter/starterSource';

export const STARTERS_INDEX_FORMAT = 'snug-starters-index/1';
export const STARTER_PAYLOAD_FORMAT = 'snug-starter/1';
export const STARTER_REGISTER_GLOBAL = '__snugStarterRegister';
export const STARTERS_CDN_PREFIX = 'https://cdn.jsdelivr.net/npm/';
export const DEFAULT_LOAD_TIMEOUT_MS = 20_000;

/** The named refusal the run view shows when a starter cannot be fetched (AC2). */
export const STARTER_LOAD_REFUSAL = 'starters load from the network — this page is offline or the starters package is unreachable';
export const STARTER_LOAD_TIMEOUT = 'starters load from the network — the starters package did not answer in time';

export interface StarterIndexEntry {
  file: string;
  /** base64 sha384 of the wrapper's bytes — becomes the script's `integrity`. */
  sha384: string;
  bytes: number;
  inline: { meta?: string; contract?: string; manifest?: string };
}

export interface StartersIndex {
  format: typeof STARTERS_INDEX_FORMAT;
  name: string;
  version: string;
  starters: Record<string, StarterIndexEntry>;
}

/** What a wrapper registers — html + docs + contract + meta as JSON (AC14). */
export interface StarterPayload {
  format: typeof STARTER_PAYLOAD_FORMAT;
  folder: string;
  version: string;
  html: string;
  meta?: string;
  contract?: string;
  manifest?: string;
  authoring: StarterAuthoringBundle;
}

export type StarterLoadReason = 'unknown_starter' | 'load_failed' | 'timeout' | 'bad_payload';

export class StarterLoadError extends Error {
  constructor(
    public readonly reason: StarterLoadReason,
    message: string,
  ) {
    super(message);
    this.name = 'StarterLoadError';
  }
}

export function starterScriptUrl(index: StartersIndex, folder: string): string {
  const entry = index.starters[folder];
  if (entry === undefined) throw new StarterLoadError('unknown_starter', `starter '${folder}' is not in the starters index`);
  return `${STARTERS_CDN_PREFIX}${index.name}@${index.version}/${entry.file}`;
}

/** The slice of a script element the loader touches — a fake in tests, `HTMLScriptElement` on the page. */
export interface ScriptElementLike {
  src: string;
  integrity: string;
  crossOrigin: string | null;
  async: boolean;
  onerror: ((event: Event | string) => void) | null;
}

/** Where script elements come from and go — the DOM on the page, a recorder in tests. */
export interface ScriptHost {
  createScript(): ScriptElementLike;
  attach(script: ScriptElementLike): void;
  detach(script: ScriptElementLike): void;
}

/** The page's `<head>` as a ScriptHost. An HTMLScriptElement satisfies ScriptElementLike structurally. */
export function domScriptHost(doc: Document): ScriptHost {
  return {
    createScript: () => doc.createElement('script'),
    attach: (script) => {
      doc.head.appendChild(script as HTMLScriptElement);
    },
    detach: (script) => {
      doc.head.removeChild(script as HTMLScriptElement);
    },
  };
}

export interface StarterLoaderDeps {
  scripts: ScriptHost;
  /** The object the wrapper reads the hook off — `window` on the page. */
  registry: Record<string, unknown>;
  timeoutMs?: number;
}

type Listener = (payload: unknown) => void;
type Hook = ((payload: unknown) => void) & { listeners: Set<Listener> };

/** One hook per page; every source on the page joins its listener set. */
function registerHook(registry: Record<string, unknown>): Hook {
  const existing = registry[STARTER_REGISTER_GLOBAL];
  if (typeof existing === 'function' && (existing as Hook).listeners instanceof Set) return existing as Hook;
  const listeners = new Set<Listener>();
  const hook = ((payload: unknown) => {
    for (const listener of listeners) listener(payload);
  }) as Hook;
  hook.listeners = listeners;
  registry[STARTER_REGISTER_GLOBAL] = hook;
  return hook;
}

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' && value !== null && Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string');

function parsePayload(value: unknown, version: string): StarterPayload | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const p = value as Record<string, unknown>;
  if (p.format !== STARTER_PAYLOAD_FORMAT) return undefined;
  if (typeof p.folder !== 'string' || typeof p.html !== 'string') return undefined;
  if (p.version !== version) return undefined;
  const authoring = p.authoring as { docs?: unknown; prompts?: unknown } | undefined;
  if (authoring === undefined || !isStringRecord(authoring.docs) || !isStringRecord(authoring.prompts)) return undefined;
  for (const key of ['meta', 'contract', 'manifest'] as const) {
    if (p[key] !== undefined && typeof p[key] !== 'string') return undefined;
  }
  return {
    format: STARTER_PAYLOAD_FORMAT,
    folder: p.folder,
    version,
    html: p.html,
    ...(typeof p.meta === 'string' ? { meta: p.meta } : {}),
    ...(typeof p.contract === 'string' ? { contract: p.contract } : {}),
    ...(typeof p.manifest === 'string' ? { manifest: p.manifest } : {}),
    authoring: { docs: { ...authoring.docs }, prompts: { ...authoring.prompts } },
  };
}

export interface OnDemandStarterSource extends StarterSource {
  /** The folders whose wrapper has registered — what `authoring()` covers. */
  loaded(): string[];
}

export function createStarterSource(index: StartersIndex, deps: StarterLoaderDeps): OnDemandStarterSource {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  const folders = Object.keys(index.starters).sort((a, b) => a.localeCompare(b));
  const loaded = new Map<string, StarterPayload>();
  const pending = new Map<
    string,
    { promise: Promise<StarterPayload>; settle: (outcome: { ok: StarterPayload } | { err: StarterLoadError }) => void }
  >();

  const hook = registerHook(deps.registry);
  hook.listeners.add((value) => {
    const folder = (value as { folder?: unknown } | null)?.folder;
    if (typeof folder !== 'string') return; // not even addressed — dropped
    const waiting = pending.get(folder);
    if (waiting === undefined) return; // unsolicited — dropped, never cached
    const payload = parsePayload(value, index.version);
    waiting.settle(
      payload === undefined
        ? { err: new StarterLoadError('bad_payload', `starter '${folder}': the registered bundle is not a ${STARTER_PAYLOAD_FORMAT} payload for ${index.name}@${index.version}`) }
        : { ok: payload },
    );
  });

  const load = (folder: string): Promise<StarterPayload> => {
    const hit = loaded.get(folder);
    if (hit !== undefined) return Promise.resolve(hit);
    const inFlight = pending.get(folder);
    if (inFlight !== undefined) return inFlight.promise;
    if (index.starters[folder] === undefined) {
      return Promise.reject(new StarterLoadError('unknown_starter', `starter '${folder}' is not in the starters index`));
    }

    const script = deps.scripts.createScript();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle!: (outcome: { ok: StarterPayload } | { err: StarterLoadError }) => void;
    const promise = new Promise<StarterPayload>((resolve, reject) => {
      settle = (outcome) => {
        if (!pending.has(folder)) return; // already settled
        pending.delete(folder);
        if (timer !== undefined) clearTimeout(timer);
        if ('ok' in outcome) {
          loaded.set(folder, outcome.ok);
          resolve(outcome.ok);
        } else {
          // Remove the element so a retry appends a fresh one (an offline click, then online).
          try {
            deps.scripts.detach(script);
          } catch {
            /* already gone */
          }
          reject(outcome.err);
        }
      };
    });
    pending.set(folder, { promise, settle });
    script.src = starterScriptUrl(index, folder);
    script.integrity = `sha384-${index.starters[folder]!.sha384}`;
    script.crossOrigin = 'anonymous';
    script.async = true;
    script.onerror = () => settle({ err: new StarterLoadError('load_failed', STARTER_LOAD_REFUSAL) });
    timer = setTimeout(() => settle({ err: new StarterLoadError('timeout', STARTER_LOAD_TIMEOUT) }), timeoutMs);
    deps.scripts.attach(script);
    return promise;
  };

  const inline = (folder: string, key: 'meta' | 'contract' | 'manifest'): Promise<string | undefined> =>
    Promise.resolve(index.starters[folder]?.inline[key]);

  return {
    appFolders: () => [...folders],
    html: (folder) => load(folder).then((p) => p.html),
    meta: (folder) => inline(folder, 'meta'),
    contract: (folder) => inline(folder, 'contract'),
    manifest: (folder) => inline(folder, 'manifest'),
    async authoring() {
      const out: Record<string, StarterAuthoringBundle> = {};
      for (const [folder, payload] of loaded) out[folder] = payload.authoring;
      return out;
    },
    loaded: () => [...loaded.keys()],
  };
}
