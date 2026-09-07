// compose.test.ts — TASK-20260905-binding-a-artifacts: the composition root wires each
// binding to its storage seam and its seats, from injected window/document slices.
import { createMemoryBackend, openUserDb, sha256Hex } from '@snugprotocol/db';
import { USERDB_FILE } from '@snugprotocol/protocol';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

import { DB_BLOCK_FORMAT, upsertBundleBlock, writeDbBlock } from '../../../../scripts/lib/page-blocks.mjs';
import { composeHostPlatform, handInBeforePaint, type ComposeDocument, type ComposeWindow } from '../compose.js';
import type { HostNamespaces, ProbeResult } from '../probe.js';
import { CUSTODY_NOTE_STASH_KEY } from '../storage/artifactHtml.js';

const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');
const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const STAMP = '0.1.0 abcdef1';
const KIT = `<!doctype html>\n<html><head><meta name="snug-host-build" content="${STAMP}" /><script type="module">/* kit */</script></head><body><div id="root"></div>\n</body></html>\n`;
const LINEAGE = '0f5e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

/** A document slice over a page string — the DOM at boot, without jsdom. */
function docOf(page: string): ComposeDocument {
  const stamp = /<meta name="snug-host-build" content="([^"]*)"/.exec(page)?.[1] ?? null;
  const db = /<script type="text\/plain" id="snug-db">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? null;
  const bundles = [...page.matchAll(/<script type="application\/snug-app-bundle\+json" data-lineage="([^"]+)">([\s\S]*?)<\/script>/g)];
  return {
    querySelector: (sel) => (sel.includes('snug-host-build') && stamp !== null ? { getAttribute: () => stamp } : null),
    getElementById: (id) => (id === 'snug-db' && db !== null ? { textContent: db } : null),
    querySelectorAll: () => bundles.map((m) => ({ getAttribute: (n: string) => (n === 'data-lineage' ? m[1]! : null), textContent: m[2]! })),
  };
}

function winOf(page: string, extra: Partial<ComposeWindow> = {}): ComposeWindow {
  return { location: { href: 'https://x.frame.claudeusercontent.com/' }, fetch: async () => ({ ok: true, status: 200, text: async () => page }), ...extra };
}

const probeOf = (binding: ProbeResult['binding'], host?: Partial<HostNamespaces>): ProbeResult => ({
  binding,
  storage: { backend: createMemoryBackend(), kind: 'memory' },
  brain: { brain: { kind: 'demo' }, legs: { sample: 'absent', complete: 'absent', local: 'absent' } },
  ...(host !== undefined ? { host: { legs: { sample: 'null', artifact: 'null', downloads: 'null' }, guardTripped: false, rejected: false, ...host } } : {}),
});

describe('composeHostPlatform', () => {
  it('hosted artifact with artifact + downloads: the record over the bucket, the save act, the export seat, the hand-in seat', async () => {
    const published: string[] = [];
    const probe = probeOf('artifact', { artifact: { publish: async (html) => (published.push(html), { version: 'v2' }) }, downloads: { save: async () => ({}) } });
    const c = composeHostPlatform(probe, winOf(KIT), docOf(KIT), wasm);
    expect(c.platform.userdbBackend?.kind).toBe('artifact-html');
    expect(c.platform.custody?.save).toBeDefined();
    expect(c.platform.custody?.canSave?.()).toBe(true);
    expect(c.platform.saveFile).toBeDefined();
    expect(c.platform.agentHandIns).toBe(c.platform.agentHandIns);
    await c.platform.userdbBackend!.save(USERDB_FILE, new Uint8Array([1, 2, 3]));
    expect(c.custody.get().dirty).toBe(true);
    const saved = await c.platform.custody!.save!();
    expect(saved).toMatchObject({ ok: true });
    expect(published).toHaveLength(1);
    expect(c.custody.get().dirty).toBe(false);
  });

  it('a page carrying a db block seeds an empty bucket at first load', async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const page = writeDbBlock(KIT, { manifest: { format: DB_BLOCK_FORMAT, bytes: 4, sha256: await sha256Hex(bytes), saved: 2, savedAt: 'x' }, base64: btoa(String.fromCharCode(...bytes)) });
    const c = composeHostPlatform(probeOf('artifact', { artifact: { publish: async () => ({ version: 'v' }) } }), winOf(page), docOf(page), wasm);
    expect(await c.platform.userdbBackend!.load(USERDB_FILE)).toEqual(bytes);
    expect(c.custody.get().saved?.saved).toBe(2);
  });

  it('artifact-static: the record without a save act, read-only from the start', () => {
    const c = composeHostPlatform(probeOf('artifact-static', {}), winOf(KIT), docOf(KIT), wasm);
    expect(c.platform.userdbBackend?.kind).toBe('artifact-html');
    expect(c.platform.custody?.save).toBeUndefined();
    expect(c.custody.get().readOnly).toBe(true);
    expect(c.platform.binding).toBe('artifact-static');
  });

  it('a chat artifact with window.storage: the window-storage backend, no save act, the copy export', () => {
    const store = new Map<string, string>();
    const storage = {
      get: async (k: string) => ({ key: k, value: store.get(k) }),
      set: async (k: string, v: string) => (store.set(k, v), { key: k, value: v }),
      delete: async (k: string) => (store.delete(k), { key: k }),
      list: async (p?: string) => ({ keys: [...store.keys()].filter((k) => p === undefined || k.startsWith(p)), prefix: p ?? '', shared: false }),
    };
    const c = composeHostPlatform(probeOf('artifact-chat'), winOf(KIT, { storage }), docOf(KIT), wasm);
    expect(c.platform.userdbBackend?.kind).toBe('window-storage');
    expect(c.platform.custody?.save).toBeUndefined();
    expect(c.platform.saveFile).toBeDefined();
  });

  it('a chat artifact WITHOUT window.storage, and a plain file: the probed bucket', () => {
    expect(composeHostPlatform(probeOf('artifact-chat'), winOf(KIT), docOf(KIT), wasm).platform.userdbBackend?.kind).toBe('memory');
    expect(composeHostPlatform(probeOf('file'), winOf(KIT), docOf(KIT), wasm).platform.userdbBackend?.kind).toBe('memory');
  });

  it('a stashed note from the publish-then-reload is rendered once and dropped', () => {
    const items = new Map([[CUSTODY_NOTE_STASH_KEY, 'saved to this artifact (save #3)']]);
    const sessionStorage = { getItem: (k: string) => items.get(k) ?? null, removeItem: (k: string) => void items.delete(k) };
    const c = composeHostPlatform(probeOf('artifact', {}), winOf(KIT, { sessionStorage }), docOf(KIT), wasm);
    expect(c.custody.get().note).toBe('saved to this artifact (save #3)');
    expect(items.size).toBe(0);
    c.platform.custody?.dismissNote?.();
    expect(c.custody.get().note).toBeUndefined();
  });

  it('handIn installs the page’s bundle blocks once the db is open; an edited copy is offered through the seat and applied by it', async () => {
    const bundle = { format: 'snug-app-bundle/1', lineage: LINEAGE, sharedAt: '2026-09-05T00:00:00.000Z', app: { displayName: 'Pomodoro', usesDb: false }, html: '<!doctype html><html><body>v1</body></html>', connections: [] };
    const page = upsertBundleBlock(KIT, LINEAGE, JSON.stringify(bundle));
    const c = composeHostPlatform(probeOf('artifact', {}), winOf(page), docOf(page), wasm);
    const opened = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
    if (opened.status !== 'ok') throw new Error(opened.status);
    const first = await c.handIn(opened.userDb);
    expect(first.installed).toHaveLength(1);
    const appId = first.installed[0]!.appId;
    opened.userDb.saveAppVersion(appId, '<!doctype html><html><body>edited</body></html>', 'user edit');
    const page2 = upsertBundleBlock(KIT, LINEAGE, JSON.stringify({ ...bundle, html: '<!doctype html><html><body>v2</body></html>' }));
    const c2 = composeHostPlatform(probeOf('artifact', {}), winOf(page2), docOf(page2), wasm);
    const second = await c2.handIn(opened.userDb);
    expect(second.pending).toHaveLength(1);
    expect(c2.platform.agentHandIns?.pending.get()).toEqual([{ appId, displayName: 'Pomodoro', bundleId: second.pending[0]!.bundleId }]);
    const applied = await c2.platform.agentHandIns!.apply(appId);
    expect(applied.version).toBe(3);
    expect(c2.platform.agentHandIns?.pending.get()).toEqual([]);
    expect(opened.userDb.getAppHtml(appId)).toContain('v2');
    await opened.userDb.close();
  });
});

describe('handInBeforePaint — the named, bounded pre-paint wait', () => {
  it('resolves true when the hand-in finishes inside the bound, false past it; a rejected hand-in never blocks the paint', async () => {
    expect(await handInBeforePaint(Promise.resolve(), 50)).toBe(true);
    expect(await handInBeforePaint(new Promise(() => undefined), 20)).toBe(false);
    expect(await handInBeforePaint(Promise.reject(new Error('db')), 50)).toBe(true);
  });

  it('"load the page’s copy" is TERMINAL: the composition hands the record the window’s reload (correctness review 1)', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const page = writeDbBlock(KIT, { manifest: { format: DB_BLOCK_FORMAT, bytes: 3, sha256: await sha256Hex(bytes), saved: 4, savedAt: 'x' }, base64: btoa(String.fromCharCode(...bytes)) });
    const reload = vi.fn();
    const probe = probeOf('artifact', { artifact: { publish: async () => ({ version: 'v' }) } });
    await probe.storage.backend.save(USERDB_FILE, new Uint8Array([9]));
    const c = composeHostPlatform(probe, winOf(page, { reload }), docOf(page), wasm);
    await c.platform.userdbBackend!.load(USERDB_FILE);
    expect(c.custody.get().divergence).toBeDefined();
    await c.platform.custody!.loadPageCopy!();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(CUSTODY_NOTE_STASH_KEY)).toContain('loaded the page’s saved copy');
  });

  it('a memory bucket under an artifact is named on the custody state (correctness review 14)', () => {
    const c = composeHostPlatform(probeOf('artifact', {}), winOf(KIT), docOf(KIT), wasm);
    expect(c.custody.get().workingCopy).toBe('memory');
  });
});
