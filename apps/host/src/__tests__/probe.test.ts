// The boot probe (TASK-20260905-host-kit P6, AC2). `decideBinding` is pure and matrix-
// tested; `probeStorage` TRIES each rung with fakes that are PRESENT but throw at call
// time — the file:// trap (Chromium exposes `navigator.storage.getDirectory` there and
// rejects the call), which is exactly what a presence-based detector cannot see.
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { fitHostTurn } from '@playground/agent/promptBudget';

import { DEFAULT_MAX_PROMPT_BYTES, measurePrompt } from '../brains/prompt.js';
import type { SampleFn } from '../brains/sample.js';
import { decideBinding, probeBrain, probeStorage, readBindingEnv, resolveHostNamespaces, runProbe, type BindingEnv } from '../probe.js';

const env = (over: Partial<BindingEnv>): BindingEnv => ({
  protocol: 'https:',
  hostname: 'example.test',
  claudeUse: false,
  ...over,
});

/**
 * The September chat runtime's whole surface (T1 S2/S10): a flat `window.claude.complete` and a
 * per-view `window.storage`, at an `about:srcdoc` origin. Measured GONE 2026-10-03 (a chat
 * artifact now runs in the hosted runtime, `window.claude = { use }`), so a page that still
 * meets it is just a page with no host brain. Every member records being touched: the kit
 * must never call `complete` and never read or write `storage`.
 */
function septemberChatWindow(): { win: { location: { protocol: string; hostname: string }; claude: unknown; storage: unknown; navigator: undefined; indexedDB: undefined }; touched: string[] } {
  const touched: string[] = [];
  const claude = {
    complete(this: unknown, prompt: string): Promise<string> {
      touched.push(`complete(${prompt.length})`);
      return Promise.resolve('{"move":{"from":"e7","to":"e5"}}');
    },
  };
  const storage = Object.fromEntries(
    ['get', 'set', 'delete', 'list'].map((name) => [name, async () => void touched.push(`storage.${name}`)]),
  );
  return { win: { location: { protocol: 'about:', hostname: '' }, claude, storage, navigator: undefined, indexedDB: undefined }, touched };
}

describe('decideBinding — the matrix', () => {
  it('a hosted artifact (claude.use present) is `artifact`, whatever the origin', () => {
    expect(decideBinding(env({ claudeUse: true }))).toBe('artifact');
    expect(decideBinding(env({ claudeUse: true, protocol: 'file:' }))).toBe('artifact');
  });
  it('C2: a page that meets ONLY window.claude.complete is decided like any page with no host brain — `file`', () => {
    // MIGRATED 2026-10-03 (TASK-20261003 R5 C2) from "a chat artifact (window.claude.complete,
    // no use) is the chat binding": that runtime was measured gone, its binding removed.
    for (const location of [
      { protocol: 'about:', hostname: '' },
      { protocol: 'https:', hostname: 'x.frame.claudeusercontent.com' },
      { protocol: 'file:', hostname: '' },
    ]) {
      const flat = decideBinding(readBindingEnv({ location, claude: { complete: async () => 'reply' } }));
      expect(flat, location.protocol).toBe(decideBinding(readBindingEnv({ location })));
      expect(flat, location.protocol).toBe('file');
    }
    // And with `use` beside it, `use` decides — `complete` adds nothing either way.
    expect(decideBinding(readBindingEnv({ location: { protocol: 'https:', hostname: 'h' }, claude: { use: async () => null, complete: async () => '' } }))).toBe('artifact');
  });
  it('file:// with no host globals is `file`', () => {
    expect(decideBinding(env({ protocol: 'file:', hostname: '' }))).toBe('file');
  });
  it('a loopback origin with NO runner is FILE-class — a static server, a dev server, a page somebody served', () => {
    // MIGRATED 2026-10-03 (TASK-20261003 K2, the migration the plan names) from
    // "http(s) on a loopback host with no host globals is `local-host`". That made
    // `local-host` mean two things — the runner, or anything served from loopback — and the
    // second got the runner's custody copy: "your file: on this Mac, in ~/Snug/user.snug"
    // on a page whose file lives in the browser. The binding is `local-host` only when a
    // runner ANSWERED (the boot asks, at the literal `http://127.0.0.1` alone).
    for (const hostname of ['localhost', '127.0.0.1', '[::1]', '127.0.0.5', 'snug.localhost', '0.0.0.0']) {
      expect(decideBinding(env({ protocol: 'http:', hostname })), hostname).toBe('file');
    }
    expect(decideBinding(env({ protocol: 'https:', hostname: 'localhost' }))).toBe('file');
    expect(decideBinding(env({ protocol: 'https:', hostname: '127.0.0.1' }))).toBe('file');
  });
  it('the RUNNER fact makes `local-host` — and outranks everything, because the runner’s page is the runner’s', () => {
    expect(decideBinding(env({ protocol: 'http:', hostname: '127.0.0.1', runner: true }))).toBe('local-host');
    // A runner that answered is the host, whatever globals an extension or a test put on the window.
    expect(decideBinding(env({ protocol: 'http:', hostname: '127.0.0.1', runner: true, claudeUse: true }))).toBe('local-host');
    expect(decideBinding(env({ protocol: 'http:', hostname: '127.0.0.1', runner: false }))).toBe('file');
  });
  it('any other origin with nothing wired reads as `file` — a plain page, no host', () => {
    expect(decideBinding(env({}))).toBe('file');
    expect(decideBinding(env({ protocol: 'http:', hostname: 'intranet.local' }))).toBe('file');
  });
});

describe('readBindingEnv', () => {
  it('reads protocol/hostname and detects `use` by function-ness, never by presence', () => {
    expect(readBindingEnv({ location: { protocol: 'https:', hostname: 'h' }, claude: { use: () => undefined } })).toEqual({ protocol: 'https:', hostname: 'h', claudeUse: true });
    expect(readBindingEnv({ location: { protocol: 'https:', hostname: 'h' }, claude: { use: 'not a function' } })).toEqual({ protocol: 'https:', hostname: 'h', claudeUse: false });
    expect(readBindingEnv({ location: { protocol: 'file:', hostname: '' } })).toEqual({ protocol: 'file:', hostname: '', claudeUse: false });
  });
  it('C2: `window.claude.complete` is not a fact the kit reads — the env is the same with it or without it', () => {
    const location = { protocol: 'https:', hostname: 'h' };
    expect(readBindingEnv({ location, claude: { complete: async () => 'x' } })).toEqual(readBindingEnv({ location }));
    expect(readBindingEnv({ location, claude: { use: () => undefined, complete: async () => 'x' } })).toEqual(readBindingEnv({ location, claude: { use: () => undefined } }));
  });
});

// ---- storage: present-but-throwing fakes ---------------------------------------------

type Bytes = Uint8Array;
/** An OPFS root whose round trip WORKS (an in-memory directory tree). */
function workingOpfs(): { getDirectory: () => Promise<unknown>; files: Map<string, Bytes> } {
  const files = new Map<string, Bytes>();
  const dir = (prefix: string): unknown => ({
    getDirectoryHandle: async (name: string) => dir(`${prefix}${name}/`),
    getFileHandle: async (name: string, opts?: { create?: boolean }) => {
      const key = `${prefix}${name}`;
      if (!files.has(key) && opts?.create !== true) throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
      if (!files.has(key)) files.set(key, new Uint8Array());
      return {
        createWritable: async () => ({
          write: async (data: Bytes) => {
            files.set(key, data.slice());
          },
          close: async () => undefined,
        }),
        getFile: async () => ({ arrayBuffer: async () => files.get(key)!.slice().buffer }),
      };
    },
    removeEntry: async (name: string) => {
      files.delete(`${prefix}${name}`);
    },
  });
  return { getDirectory: async () => dir(''), files };
}

describe('probeStorage — tries the ladder, never trusts presence', () => {
  it('OPFS whose round trip works wins, and the probe file is removed afterwards', async () => {
    const opfs = workingOpfs();
    const result = await probeStorage({ storage: { getDirectory: opfs.getDirectory }, indexedDB: new IDBFactory() });
    expect(result.kind).toBe('opfs');
    expect(result.backend.kind).toBe('opfs');
    expect([...opfs.files.keys()].some((k) => k.includes('probe'))).toBe(false);
  });

  it('calls getDirectory AS A METHOD of navigator.storage — an unbound call is "Illegal invocation" in Chromium', async () => {
    const opfs = workingOpfs();
    const storage = {
      getDirectory(this: unknown) {
        if (this !== storage) throw new TypeError('Illegal invocation');
        return opfs.getDirectory();
      },
    };
    const result = await probeStorage({ storage, indexedDB: new IDBFactory() });
    expect(result.kind).toBe('opfs');
  });

  it('OPFS present but REJECTING at call time (the file:// shape) falls through to IndexedDB', async () => {
    const getDirectory = async (): Promise<never> => {
      throw Object.assign(new Error('The request is not allowed'), { name: 'SecurityError' });
    };
    const result = await probeStorage({ storage: { getDirectory }, indexedDB: new IDBFactory() });
    expect(result.kind).toBe('idb');
    expect(result.backend.kind).toBe('idb');
  });

  it('OPFS that hands out a directory but cannot WRITE (no createWritable — Safari main thread) falls through', async () => {
    const getDirectory = async (): Promise<unknown> => ({
      getDirectoryHandle: async () => ({
        getFileHandle: async () => ({ getFile: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) }),
        removeEntry: async () => undefined,
      }),
    });
    const result = await probeStorage({ storage: { getDirectory }, indexedDB: new IDBFactory() });
    expect(result.kind).toBe('idb');
  });

  it('OPFS that writes but reads back DIFFERENT bytes is not storage', async () => {
    const getDirectory = async (): Promise<unknown> => ({
      getDirectoryHandle: async () => ({
        getFileHandle: async () => ({
          createWritable: async () => ({ write: async () => undefined, close: async () => undefined }),
          getFile: async () => ({ arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer }),
        }),
        removeEntry: async () => undefined,
      }),
    });
    const result = await probeStorage({ storage: { getDirectory }, indexedDB: new IDBFactory() });
    expect(result.kind).toBe('idb');
  });

  it('IndexedDB present but failing at open time falls through to memory', async () => {
    const indexedDB = {
      open: () => {
        throw new Error('idb refused');
      },
      deleteDatabase: () => undefined,
    };
    const result = await probeStorage({ storage: undefined, indexedDB: indexedDB as unknown as IDBFactory });
    expect(result.kind).toBe('memory');
    expect(result.backend.kind).toBe('memory');
  });

  it('IndexedDB whose open request ERRORS asynchronously (private-mode shapes) falls through to memory', async () => {
    const indexedDB = {
      open: () => {
        const req: { onerror: null | (() => void); onsuccess: null | (() => void); onupgradeneeded: null | (() => void); error: Error } = {
          onerror: null,
          onsuccess: null,
          onupgradeneeded: null,
          error: new Error('QuotaExceededError'),
        };
        setTimeout(() => req.onerror?.(), 0);
        return req;
      },
      deleteDatabase: () => undefined,
    };
    const result = await probeStorage({ storage: undefined, indexedDB: indexedDB as unknown as IDBFactory });
    expect(result.kind).toBe('memory');
  });

  it('nothing present at all → memory (never a throw: the kit must always boot)', async () => {
    const result = await probeStorage({ storage: undefined, indexedDB: undefined });
    expect(result.kind).toBe('memory');
  });

  it('a working IndexedDB is left without the probe database', async () => {
    const factory = new IDBFactory();
    const result = await probeStorage({ storage: undefined, indexedDB: factory });
    expect(result.kind).toBe('idb');
    const names = (await factory.databases()).map((d) => d.name);
    expect(names.some((n) => n?.includes('probe'))).toBe(false);
  });
});

describe('probeBrain — the demo brain when nothing answered; the legs record what was seen', () => {
  it('with no host namespaces it is the demo brain; a detected-but-unresolved leg stays `detected` (the T2 shape)', async () => {
    expect(await probeBrain(env({}))).toEqual({
      brain: { kind: 'demo' },
      legs: { sample: 'absent', local: 'absent' },
    });
    expect(await probeBrain(env({ claudeUse: true }))).toEqual({
      brain: { kind: 'demo' },
      legs: { sample: 'detected', local: 'absent' },
    });
  });
});

// ---- T4: the host namespaces (AC1/AC2/AC5) -------------------------------------------

type Fn = (...args: never[]) => unknown;
function fakeSample(limits: { maxPromptBytes: number } | 'reject'): SampleFn {
  const fn = (async () => ({ text: '', truncated: false, modelTierApplied: 'quick' as const })) as unknown as SampleFn;
  fn.limits = () => (limits === 'reject' ? Promise.reject(new Error('no')) : Promise.resolve(limits));
  fn.json = async () => ({});
  return fn;
}
const artifactNs = { publish: async () => ({ version: 'v1' }) };
const downloadsNs = { save: async () => ({}) };

/** A `window.claude.use` that answers per name — `undefined` entries resolve `null`, `'hang'` never resolves. */
function fakeUse(answers: Record<string, unknown | 'hang'>): (name: string) => Promise<unknown> {
  return (name) => (answers[name] === 'hang' ? new Promise(() => undefined) : Promise.resolve(answers[name] ?? null));
}

describe('resolveHostNamespaces — every capability asked together, behind one guard', () => {
  it('records resolved / null per capability and hands the namespaces back', async () => {
    const sample = fakeSample({ maxPromptBytes: 65536 });
    const host = await resolveHostNamespaces(fakeUse({ sample, artifact: artifactNs }), { guardMs: 50 });
    expect(host.legs).toEqual({ sample: 'resolved', artifact: 'resolved', downloads: 'null' });
    expect(host.sample).toBe(sample);
    expect(host.artifact).toBe(artifactNs);
    expect(host.downloads).toBeUndefined();
  });

  it('a `use` that never answers trips the guard: every leg `null`, the kit still boots (never a hang)', async () => {
    const host = await resolveHostNamespaces(fakeUse({ sample: 'hang', artifact: 'hang', downloads: 'hang' }), { guardMs: 20 });
    expect(host.legs).toEqual({ sample: 'null', artifact: 'null', downloads: 'null' });
    expect(host.guardTripped).toBe(true);
  });

  it('a `use` that throws is a null leg too', async () => {
    const host = await resolveHostNamespaces(() => Promise.reject(new Error('boom')), { guardMs: 20 });
    expect(host.legs).toEqual({ sample: 'null', artifact: 'null', downloads: 'null' });
  });
});

describe('decideBinding with the host’s answer (AC5 — artifact-static)', () => {
  it('claude.use present but sample AND artifact null → artifact-static (served top-level on the artifact host)', () => {
    expect(decideBinding(env({ claudeUse: true, hostAnswered: { sample: false, artifact: false } }))).toBe('artifact-static');
  });
  it('either namespace resolved → artifact; no answer recorded (guard tripped) → artifact (the T2 shape)', () => {
    expect(decideBinding(env({ claudeUse: true, hostAnswered: { sample: true, artifact: false } }))).toBe('artifact');
    expect(decideBinding(env({ claudeUse: true, hostAnswered: { sample: false, artifact: true } }))).toBe('artifact');
    expect(decideBinding(env({ claudeUse: true }))).toBe('artifact');
  });
});

describe('probeBrain with host namespaces — the pinned brains (AC1/AC2)', () => {
  it('sample resolved → the host brain: two adapters (quick app, default chat), the ruler, the cap from limits()', async () => {
    const sample = fakeSample({ maxPromptBytes: 65536 });
    const result = await probeBrain(env({ claudeUse: true }), { sample, legs: { sample: 'resolved', artifact: 'null', downloads: 'null' }, guardTripped: false, rejected: false });
    expect(result.legs).toEqual({ sample: 'resolved', local: 'absent' });
    const brain = result.brain;
    expect(brain.kind).toBe('host');
    if (brain.kind !== 'host') return;
    expect(brain.label).toBe('Claude · this artifact’s viewer');
    expect(brain.streaming).toBe(true);
    expect(brain.tools).toBe(false);
    expect(brain.promptBytes).toBe(measurePrompt);
    expect(brain.chatAdapter).toBeDefined();
    expect(brain.chatAdapter).not.toBe(brain.adapter);
    // The cap came from limits() BEFORE the adapters were built (one number, one time).
    expect(brain.maxPromptBytes).toBe(65536);
  });

  it('TASK-20260906 AC1/AC2: the sample brain carries the tier seat; both adapters read the store PER CALL (auto: quick app / default chat; an explicit tier overrides both); the seat is the store', async () => {
    const calls: (string | undefined)[] = [];
    const sample = (async (_input: unknown, options?: { modelTier?: string }) => {
      calls.push(options?.modelTier);
      return { text: 'ok', truncated: false, modelTierApplied: (options?.modelTier ?? 'default') as 'quick' | 'default' | 'complex' };
    }) as unknown as SampleFn;
    sample.limits = async () => ({ maxPromptBytes: 65536 });
    sample.json = async () => ({});
    const written: [string, string][] = [];
    const storage = { getItem: () => null, setItem: (k: string, v: string) => void written.push([k, v]) };
    const result = await probeBrain(env({ claudeUse: true }), { sample, legs: { sample: 'resolved', artifact: 'null', downloads: 'null' }, guardTripped: false, rejected: false }, storage);
    const brain = result.brain;
    if (brain.kind !== 'host') throw new Error('expected the sample brain');
    const seat = brain.tiers;
    if (seat === undefined) throw new Error('expected the tier seat');
    expect(seat.options).toEqual(['quick', 'default', 'complex']);
    expect(seat.viewerDefault).toBe('default');
    expect(seat.state.get().choice).toBe('auto');
    expect(calls).toEqual([]); // pinning made no call
    const turn = { system: 's', messages: [{ role: 'user' as const, content: 'x' }] };
    await brain.adapter.complete(turn);
    await brain.chatAdapter!.complete(turn);
    seat.set('complex');
    expect(calls).toEqual(['quick', 'default']); // the switch itself called nothing
    await brain.adapter.complete(turn);
    await brain.chatAdapter!.complete(turn);
    expect(calls).toEqual(['quick', 'default', 'complex', 'complex']);
    expect(written).toEqual([['snug-host:tier', 'complex']]);
  });

  it('TASK-20260906 AC3/AC4: the saved choice is read at boot; a substituted answer marks the tier and the selection falls back', async () => {
    const sample = (async (_input: unknown, options?: { modelTier?: string }) => ({ text: 'ok', truncated: false, modelTierApplied: (options?.modelTier === 'complex' ? 'default' : options?.modelTier ?? 'default') as 'quick' | 'default' | 'complex' })) as unknown as SampleFn;
    sample.limits = async () => ({ maxPromptBytes: 65536 });
    sample.json = async () => ({});
    const storage = { getItem: () => 'complex', setItem: () => {} };
    const result = await probeBrain(env({ claudeUse: true }), { sample, legs: { sample: 'resolved', artifact: 'null', downloads: 'null' }, guardTripped: false, rejected: false }, storage);
    const brain = result.brain;
    if (brain.kind !== 'host' || brain.tiers === undefined) throw new Error('expected the seat');
    expect(brain.tiers.state.get().choice).toBe('complex');
    await brain.adapter.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(brain.tiers.state.get()).toEqual({ choice: 'default', applied: { asked: 'complex', answered: 'default' }, unavailable: { complex: 'default' } });
    // The NEXT call carries the fallback on the wire (review testing gap 4), and the note survives it (review C1).
    const asked: (string | undefined)[] = [];
    const wire = (async (_input: unknown, options?: { modelTier?: string }) => (asked.push(options?.modelTier), { text: 'ok', truncated: false, modelTierApplied: 'default' as const })) as unknown as SampleFn;
    wire.limits = async () => ({ maxPromptBytes: 65536 });
    wire.json = async () => ({});
    const again = await probeBrain(env({ claudeUse: true }), { sample: wire, legs: { sample: 'resolved', artifact: 'null', downloads: 'null' }, guardTripped: false, rejected: false }, storage);
    if (again.brain.kind !== 'host' || again.brain.tiers === undefined) throw new Error('expected the seat');
    await again.brain.adapter.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] }); // complex → substituted
    await again.brain.chatAdapter!.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] }); // the fallback, honoured
    expect(asked).toEqual(['complex', 'default']);
    expect(again.brain.tiers.state.get().applied).toEqual({ asked: 'complex', answered: 'default' });
  });

  it('TASK-20260906 AC1 (twin): the demo brain carries NO tier seat', async () => {
    const demo = await probeBrain(env({}));
    expect(demo.brain).toEqual({ kind: 'demo' });
  });

  it('C4: the cap IS limits().maxPromptBytes — the 262,144 contract 0.2.67 reports (measured 2026-10-03), and the builder budgets on it to the byte', async () => {
    const result = await probeBrain(env({ claudeUse: true }), { sample: fakeSample({ maxPromptBytes: 262_144 }), legs: { sample: 'resolved', artifact: 'null', downloads: 'null' }, guardTripped: false, rejected: false });
    const brain = result.brain;
    if (brain.kind !== 'host' || brain.promptBytes === undefined || brain.maxPromptBytes === undefined) throw new Error('expected the sample brain with a ruler and a cap');
    expect(brain.maxPromptBytes).toBe(262_144);
    // ADR-0066: the builder's budget-or-refuse reads THIS seat — the probe's cap and the
    // adapters' own ruler — so a turn of exactly the cap goes out and one byte more is refused.
    const system = 'S';
    const fill = (bytes: number): string => 'x'.repeat(bytes - measurePrompt(system, [{ role: 'user', content: '' }]));
    const seat = { maxPromptBytes: brain.maxPromptBytes, promptBytes: brain.promptBytes };
    expect(fitHostTurn({ system, history: [], message: fill(262_144) }, seat)).toMatchObject({ ok: true, bytes: 262_144 });
    expect(fitHostTurn({ system, history: [], message: fill(262_145) }, seat)).toEqual({ ok: false, bytes: 262_145, maxPromptBytes: 262_144 });
  });

  it.each([
    ['rejects', 'reject'],
    ['answers a string', { maxPromptBytes: '262144' }],
    ['answers no member', {}],
    ['answers null', null],
    ['answers NaN', { maxPromptBytes: Number.NaN }],
    ['answers zero', { maxPromptBytes: 0 }],
    ['answers a negative number', { maxPromptBytes: -1 }],
    ['answers a fraction', { maxPromptBytes: 1024.5 }],
    ['answers Infinity', { maxPromptBytes: Number.POSITIVE_INFINITY }],
  ] as const)('C4: limits() that %s → the 65,536 fallback, never a cap that is not a byte count', async (_label, limits) => {
    const result = await probeBrain(env({ claudeUse: true }), { sample: fakeSample(limits as never), legs: { sample: 'resolved', artifact: 'null', downloads: 'null' }, guardTripped: false, rejected: false });
    expect(DEFAULT_MAX_PROMPT_BYTES).toBe(65_536);
    expect(result.brain.kind === 'host' && result.brain.maxPromptBytes).toBe(65_536);
  });

  // The probe promises nothing here throws (header): a runtime whose `sample` has no `limits`,
  // throws from it at once, or never answers it still boots, on the fallback (R5 verifier).
  it.each([
    [
      'has no limits member',
      (fn: SampleFn): void => {
        Reflect.deleteProperty(fn, 'limits');
      },
    ],
    [
      'throws synchronously from limits()',
      (fn: SampleFn): void => {
        fn.limits = () => {
          throw new Error('no limits here');
        };
      },
    ],
    [
      'never settles limits()',
      (fn: SampleFn): void => {
        fn.limits = () => new Promise<never>(() => undefined);
      },
    ],
  ] as const)('C4: a sample that %s → the host brain on the 65,536 fallback, the boot never stopped', async (_label, breakIt) => {
    const sample = fakeSample({ maxPromptBytes: 262_144 });
    breakIt(sample);
    const result = await probeBrain(env({ claudeUse: true }), { sample, legs: { sample: 'resolved', artifact: 'null', downloads: 'null' }, guardTripped: false, rejected: false }, undefined, { guardMs: 20 });
    expect(result.brain.kind).toBe('host');
    expect(result.brain.kind === 'host' && result.brain.maxPromptBytes).toBe(DEFAULT_MAX_PROMPT_BYTES);
  });

  it('sample null (artifact resolved or not) → the demo brain, leg `null`', async () => {
    const result = await probeBrain(env({ claudeUse: true }), { artifact: artifactNs, legs: { sample: 'null', artifact: 'resolved', downloads: 'null' }, guardTripped: false, rejected: false });
    expect(result.brain).toEqual({ kind: 'demo' });
    expect(result.legs.sample).toBe('null');
  });

  it('C2: window.claude.complete alone → the demo brain, exactly as a page with no claude at all', async () => {
    // MIGRATED 2026-10-03 (TASK-20261003 R5 C2) from "window.claude.complete alone → the chat
    // brain: one adapter, no streaming, no cap": the September runtime it pinned is gone.
    const { win, touched } = septemberChatWindow();
    const flat = await runProbe(win);
    const plain = await runProbe({ ...win, claude: undefined });
    expect(flat.brain).toEqual({ brain: { kind: 'demo' }, legs: { sample: 'absent', local: 'absent' } });
    expect(flat.brain).toEqual(plain.brain);
    expect(touched).toEqual([]);
  });

  it('neither brain makes a call when pinned (never on load)', async () => {
    let calls = 0;
    const sample = (async () => {
      calls += 1;
      return { text: '', truncated: false, modelTierApplied: 'quick' as const };
    }) as unknown as SampleFn;
    sample.limits = async () => ({ maxPromptBytes: 1 });
    sample.json = async () => ({});
    await probeBrain(env({ claudeUse: true }), { sample, legs: { sample: 'resolved', artifact: 'null', downloads: 'null' }, guardTripped: false, rejected: false });
    expect(calls).toBe(0);
  });
});

describe('runProbe — the whole boot, from a window', () => {
  const baseWindow = () => ({ location: { protocol: 'https:', hostname: 'x.frame.claudeusercontent.com' }, navigator: undefined, indexedDB: undefined });

  it('a hosted viewer: binding artifact, the host brain, the namespaces carried for the record and the export seat', async () => {
    const sample = fakeSample({ maxPromptBytes: 65536 });
    const win = { ...baseWindow(), claude: { use: fakeUse({ sample, artifact: artifactNs, downloads: downloadsNs }) } };
    const result = await runProbe(win, { guardMs: 50 });
    expect(result.binding).toBe('artifact');
    expect(result.brain.brain.kind).toBe('host');
    expect(result.host?.artifact).toBe(artifactNs);
    expect(result.host?.downloads).toBe(downloadsNs);
    expect(result.brain.brain.kind === 'host' && result.brain.brain.maxPromptBytes).toBe(65536);
  });

  it('the artifact host serving the page top-level (every use() null): artifact-static, demo brain, no namespaces', async () => {
    const win = { ...baseWindow(), claude: { use: fakeUse({}) } };
    const result = await runProbe(win, { guardMs: 50 });
    expect(result.binding).toBe('artifact-static');
    expect(result.brain.brain).toEqual({ kind: 'demo' });
    expect(result.host?.artifact).toBeUndefined();
  });

  it('a host whose use() never answers: the guard trips, the binding stays `artifact` (never static — nothing was ANSWERED), the demo brain boots', async () => {
    const win = { ...baseWindow(), claude: { use: fakeUse({ sample: 'hang', artifact: 'hang', downloads: 'hang' }) } };
    const result = await runProbe(win, { guardMs: 20 });
    expect(result.binding).toBe('artifact');
    expect(result.brain.brain).toEqual({ kind: 'demo' });
    expect(result.brain.legs.sample).toBe('null');
    expect(result.host?.guardTripped).toBe(true);
  });

  it('C2: a page that meets only the September chat runtime (flat window.claude.complete + window.storage): the binding a plain page gets, the demo brain, nothing asked, nothing touched', async () => {
    // MIGRATED 2026-10-03 (TASK-20261003 R5 C2) from "a chat viewer (flat window.claude): the
    // chat binding with the chat brain".
    const { win, touched } = septemberChatWindow();
    const result = await runProbe({ ...win, location: baseWindow().location });
    expect(result.binding).toBe('file');
    expect(result.brain.brain).toEqual({ kind: 'demo' });
    expect(result.host).toBeUndefined();
    expect(touched).toEqual([]);
  });

  it('a plain file: nothing asked, nothing waited for', async () => {
    const result = await runProbe({ location: { protocol: 'file:', hostname: '' } });
    expect(result.binding).toBe('file');
    expect(result.brain.brain).toEqual({ kind: 'demo' });
    expect(result.host).toBeUndefined();
  });
});

describe('the runtime is invoked as a METHOD; a rejecting use is never a static page (correctness review 6)', () => {
  const baseWindow = () => ({ location: { protocol: 'https:', hostname: 'x.frame.claudeusercontent.com' }, navigator: undefined, indexedDB: undefined });

  it('a this-dependent `use` still works — the kit calls it on window.claude', async () => {
    const sample = fakeSample({ maxPromptBytes: 4096 });
    const claude = {
      use(this: unknown, name: string): Promise<unknown> {
        if (this !== claude) throw new TypeError('Illegal invocation');
        return Promise.resolve(name === 'sample' ? sample : null);
      },
    };
    const hosted = await runProbe({ ...baseWindow(), claude }, { guardMs: 50 });
    expect(hosted.binding).toBe('artifact');
    expect(hosted.brain.brain.kind === 'host' && hosted.brain.brain.maxPromptBytes).toBe(4096);
  });

  it('a `use` that REJECTS leaves the binding at artifact with the demo brain — only an answer of null makes a static page', async () => {
    const win = { ...baseWindow(), claude: { use: () => Promise.reject(new TypeError('Illegal invocation')) } };
    const result = await runProbe(win, { guardMs: 50 });
    expect(result.binding).toBe('artifact');
    expect(result.brain.brain).toEqual({ kind: 'demo' });
    expect(result.host?.rejected).toBe(true);
  });

  it('the cap limits() reports is the cap the adapters NAME in a refusal (maintainability review 3)', async () => {
    const sample = Object.assign(
      async () => {
        throw Object.assign(new Error('too big'), { code: 'prompt_too_large' });
      },
      { limits: async () => ({ maxPromptBytes: 1000 }), json: async () => ({}) },
    ) as unknown as SampleFn;
    const result = await probeBrain(env({ claudeUse: true }), { sample, legs: { sample: 'resolved', artifact: 'null', downloads: 'null' }, guardTripped: false, rejected: false });
    if (result.brain.kind !== 'host') throw new Error('expected the host brain');
    const refusal = await result.brain.chatAdapter!.complete({ system: 'S', messages: [{ role: 'user', content: 'x' }] });
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.message).toContain('1,000');
    expect(result.brain.maxPromptBytes).toBe(1000);
  });
});

// ---- the storage globals are read through the ONE guarded accessor (K4) ----------------

describe('runProbe at an opaque origin — every storage getter THROWS', () => {
  it('still answers: memory, the demo brain, `file` — the page boots and says so', async () => {
    // An `about:srcdoc` document at origin `null` (where T1 measured September's chat
    // artifacts): `localStorage`, `indexedDB` and `navigator.storage` are getters that throw a
    // SecurityError there. `runProbe` read two of the three bare.
    const deny = (name: string) => ({
      get(): never {
        throw new DOMException(`The document is sandboxed and lacks the 'allow-same-origin' flag (${name}).`, 'SecurityError');
      },
    });
    const navigator = {};
    Object.defineProperty(navigator, 'storage', deny('storage'));
    const win = { location: { protocol: 'about:', hostname: '' }, navigator };
    Object.defineProperty(win, 'indexedDB', deny('indexedDB'));
    Object.defineProperty(win, 'localStorage', deny('localStorage'));
    const result = await runProbe(win as Parameters<typeof runProbe>[0]);
    expect(result.storage.kind).toBe('memory');
    expect(result.brain.brain).toEqual({ kind: 'demo' });
    expect(result.binding).toBe('file');
  });
});
