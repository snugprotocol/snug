// The boot probe (TASK-20260905-host-kit P6, AC2). `decideBinding` is pure and matrix-
// tested; `probeStorage` TRIES each rung with fakes that are PRESENT but throw at call
// time — the file:// trap (Chromium exposes `navigator.storage.getDirectory` there and
// rejects the call), which is exactly what a presence-based detector cannot see.
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { measurePrompt } from '../brains/prompt.js';
import type { SampleFn } from '../brains/sample.js';
import { decideBinding, probeBrain, probeStorage, readBindingEnv, resolveHostNamespaces, runProbe, type BindingEnv } from '../probe.js';

const env = (over: Partial<BindingEnv>): BindingEnv => ({
  protocol: 'https:',
  hostname: 'example.test',
  claudeUse: false,
  claudeComplete: false,
  ...over,
});

describe('decideBinding — the matrix', () => {
  it('a hosted artifact (claude.use present) is `artifact`, whatever the origin', () => {
    expect(decideBinding(env({ claudeUse: true }))).toBe('artifact');
    expect(decideBinding(env({ claudeUse: true, claudeComplete: true }))).toBe('artifact');
    expect(decideBinding(env({ claudeUse: true, protocol: 'file:' }))).toBe('artifact');
  });
  it('a chat artifact (window.claude.complete, no use) is `artifact-chat`', () => {
    expect(decideBinding(env({ claudeComplete: true }))).toBe('artifact-chat');
  });
  it('file:// with no host globals is `file`', () => {
    expect(decideBinding(env({ protocol: 'file:', hostname: '' }))).toBe('file');
  });
  it('http(s) on a loopback host with no host globals is `local-host`', () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]', '127.0.0.5']) {
      expect(decideBinding(env({ protocol: 'http:', hostname }))).toBe('local-host');
    }
    expect(decideBinding(env({ protocol: 'https:', hostname: 'localhost' }))).toBe('local-host');
  });
  it('any other origin with nothing wired reads as `file` — a plain page, no host', () => {
    expect(decideBinding(env({}))).toBe('file');
    expect(decideBinding(env({ protocol: 'http:', hostname: 'intranet.local' }))).toBe('file');
  });
});

describe('readBindingEnv', () => {
  it('reads protocol/hostname and detects the claude globals by function-ness, never by presence', () => {
    const read = readBindingEnv({
      location: { protocol: 'https:', hostname: 'h' },
      claude: { use: () => undefined, complete: 'not a function' },
    });
    expect(read).toEqual({ protocol: 'https:', hostname: 'h', claudeUse: true, claudeComplete: false });
    expect(readBindingEnv({ location: { protocol: 'file:', hostname: '' } })).toEqual({
      protocol: 'file:',
      hostname: '',
      claudeUse: false,
      claudeComplete: false,
    });
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
    expect(await probeBrain(env({}))).toMatchObject({
      brain: { kind: 'demo' },
      legs: { sample: 'absent', complete: 'absent', local: 'absent' },
    });
    expect(await probeBrain(env({ claudeUse: true, claudeComplete: true }))).toMatchObject({
      brain: { kind: 'demo' },
      legs: { sample: 'detected', complete: 'detected', local: 'absent' },
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
    expect(result.legs).toEqual({ sample: 'resolved', complete: 'absent', local: 'absent' });
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

  it('limits() rejecting → the documented 65,536 fallback', async () => {
    const result = await probeBrain(env({ claudeUse: true }), { sample: fakeSample('reject'), legs: { sample: 'resolved', artifact: 'null', downloads: 'null' }, guardTripped: false, rejected: false });
    expect(result.brain.kind === 'host' && result.brain.maxPromptBytes).toBe(65536);
  });

  it('sample null (artifact resolved or not) → the demo brain, leg `null`', async () => {
    const result = await probeBrain(env({ claudeUse: true }), { artifact: artifactNs, legs: { sample: 'null', artifact: 'resolved', downloads: 'null' }, guardTripped: false, rejected: false });
    expect(result.brain).toEqual({ kind: 'demo' });
    expect(result.legs.sample).toBe('null');
  });

  it('window.claude.complete alone → the chat brain: one adapter, no streaming, no cap (unmeasured), the ruler still pinned', async () => {
    const complete = async (): Promise<unknown> => 'reply';
    const result = await probeBrain(env({ claudeComplete: true }), undefined, complete);
    expect(result.legs).toEqual({ sample: 'absent', complete: 'resolved', local: 'absent' });
    const brain = result.brain;
    if (brain.kind !== 'host') throw new Error('expected the chat brain');
    expect(brain.label).toBe('Claude · this chat');
    expect(brain.streaming).toBe(false);
    expect(brain.tools).toBe(false);
    expect(brain.maxPromptBytes).toBeUndefined();
    expect(brain.chatAdapter).toBeUndefined();
    expect(brain.promptBytes).toBe(measurePrompt);
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

  it('a chat viewer (flat window.claude): artifact-chat with the chat brain', async () => {
    const win = { ...baseWindow(), claude: { complete: async () => 'ok' } };
    const result = await runProbe(win);
    expect(result.binding).toBe('artifact-chat');
    expect(result.brain.brain.kind === 'host' && result.brain.brain.label).toBe('Claude · this chat');
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

  it('a this-dependent `use` / `complete` still works — the kit calls them on window.claude', async () => {
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
    const chat = {
      complete(this: unknown, prompt: string): Promise<unknown> {
        if (this !== chat) throw new TypeError('Illegal invocation');
        return Promise.resolve(`echo ${prompt.length}`);
      },
    };
    const chatProbe = await runProbe({ ...baseWindow(), claude: chat });
    expect(chatProbe.brain.brain.kind).toBe('host');
    if (chatProbe.brain.brain.kind !== 'host') return;
    const result = await chatProbe.brain.brain.adapter.complete({ system: 'S', messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toMatchObject({ ok: true, text: 'echo 5' }); // 'S' + PROMPT_SEPARATOR + 'hi'
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
