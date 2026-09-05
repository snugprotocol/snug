// The boot probe (TASK-20260905-host-kit P6, AC2). `decideBinding` is pure and matrix-
// tested; `probeStorage` TRIES each rung with fakes that are PRESENT but throw at call
// time — the file:// trap (Chromium exposes `navigator.storage.getDirectory` there and
// rejects the call), which is exactly what a presence-based detector cannot see.
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { decideBinding, probeBrain, probeStorage, readBindingEnv, type BindingEnv } from '../probe.js';

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

describe('probeBrain — T2 pins the demo brain and records what it saw', () => {
  it('is the demo brain whatever the host offers; the legs are typed seats for T3/T4', () => {
    expect(probeBrain(env({}))).toEqual({
      brain: { kind: 'demo' },
      legs: { sample: 'absent', complete: 'absent', local: 'absent' },
    });
    expect(probeBrain(env({ claudeUse: true, claudeComplete: true }))).toEqual({
      brain: { kind: 'demo' },
      legs: { sample: 'detected', complete: 'detected', local: 'absent' },
    });
  });
});
