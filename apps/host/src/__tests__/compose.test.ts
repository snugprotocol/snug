// compose.test.ts — TASK-20260905-binding-a-artifacts: the composition root wires each
// binding to its storage seam and its seats, from injected window/document slices.
import { createMemoryBackend, openUserDb, sha256Hex } from '@snugprotocol/db';
import { USERDB_FILE } from '@snugprotocol/protocol';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

import { custodyDisclosure, hostPassport } from '@playground/platform/copy';
import { hostHonesty } from '@playground/schedule/copy';
import { honestyInputFor } from '@playground/schedule/honesty';

import { DB_BLOCK_FORMAT, upsertBundleBlock, writeDbBlock } from '../../../../scripts/lib/page-blocks.mjs';
import { composeHostPlatform, handInBeforePaint, type ComposeDocument, type ComposeWindow } from '../compose.js';
import { runProbe, type HostNamespaces, type ProbeResult } from '../probe.js';
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
  brain: { brain: { kind: 'demo' }, legs: { sample: 'absent', local: 'absent' } },
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

  it('a plain file: the probed bucket, no save act, the copy export', () => {
    // MIGRATED 2026-10-03 (TASK-20261003 R5 C2): this and the C2 case below replace the two
    // chat-binding cases ("window.storage is the file's home"; "the chat binding without it:
    // the bucket") — the September chat runtime they composed was measured gone.
    const c = composeHostPlatform(probeOf('file'), winOf(KIT), docOf(KIT), wasm);
    expect(c.platform.userdbBackend?.kind).toBe('memory');
    expect(c.platform.custody?.save).toBeUndefined();
    expect(c.platform.saveFile).toBeDefined();
    expect(c.record).toBeUndefined();
  });

  it('C2: a page that meets only the September chat runtime composes EXACTLY as a plain page — the bucket (its window.storage never read or written), the demo brain, and the same true sentences, none of them about a chat', async () => {
    const touched: string[] = [];
    const flatStorage = Object.fromEntries(['get', 'set', 'delete', 'list'].map((name) => [name, async () => void touched.push(`storage.${name}`)]));
    const complete = async (): Promise<string> => (touched.push('complete'), '{}');
    const location = { protocol: 'https:', hostname: 'x.frame.claudeusercontent.com' };
    const compose = async (claude: unknown, extra: Record<string, unknown>) => {
      const probe = await runProbe({ location, claude, navigator: undefined, indexedDB: undefined });
      // The boot hands compose the window it has; a September page's window carries `storage`.
      const win = { ...winOf(KIT), ...extra } as ComposeWindow;
      return composeHostPlatform(probe, win, docOf(KIT), wasm);
    };
    const flat = await compose({ complete }, { storage: flatStorage });
    const plain = await compose(undefined, {});
    expect(flat.platform.binding).toBe('file');
    expect(flat.platform.brain).toEqual({ kind: 'demo' });
    expect(flat.platform.userdbBackend?.kind).toBe(plain.platform.userdbBackend?.kind);
    await flat.platform.userdbBackend!.save(USERDB_FILE, new Uint8Array([1]));
    await flat.platform.userdbBackend!.load(USERDB_FILE);
    expect(touched).toEqual([]);
    // What the page SAYS: the passport and the "your file" chip are the plain page's, word for
    // word. (The brain chip's demo sentence does not read the binding at all — the e2e reads it.)
    const custody = flat.custody.get();
    expect(hostPassport(flat.platform, custody)).toEqual(hostPassport(plain.platform, plain.custody.get()));
    expect(custodyDisclosure(flat.platform.binding, flat.platform.userdbBackend?.kind, custody)).toEqual(custodyDisclosure(plain.platform.binding, plain.platform.userdbBackend?.kind, plain.custody.get()));
    const said = hostPassport(flat.platform, custody);
    expect(said.where).toBe('a page in your browser');
    const thinks = said.rows.find((row) => row.key === 'thinks')!;
    expect(thinks).toEqual({ key: 'thinks', name: 'thinks', can: false, sentence: 'no brain is wired into this host yet — the demo brain answers, from a script.' });
    for (const sentence of [said.where, ...said.rows.map((row) => row.sentence)]) {
      expect(sentence, sentence).not.toMatch(/\bchat\b/i);
    }
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

describe('the scheduler seat per binding (TASK-20261009 H3; ADR-0074 §7)', () => {
  it('a hosted artifact: "this artifact", page-bound, no notify — the page cannot raise one', () => {
    const probe = probeOf('artifact', { artifact: { publish: async () => ({ version: 'v2' }) }, downloads: { save: async () => ({}) } });
    const { platform } = composeHostPlatform(probe, winOf(KIT), docOf(KIT), wasm);
    expect(platform.scheduler).toEqual({ wakeMode: 'page', hostLabel: 'this artifact' });
    expect(platform.scheduler?.notify).toBeUndefined();
  });

  it('a static artifact: the same subject — a reader cannot tell the two artifact arms apart, and should not', () => {
    const { platform } = composeHostPlatform(probeOf('artifact-static', {}), winOf(KIT), docOf(KIT), wasm);
    expect(platform.scheduler).toEqual({ wakeMode: 'page', hostLabel: 'this artifact' });
  });

  it('a plain file: "this page" — the subject a tab opened from disk or a static server can honestly claim', () => {
    const { platform } = composeHostPlatform(probeOf('file'), winOf(KIT), docOf(KIT), wasm);
    expect(platform.scheduler).toEqual({ wakeMode: 'page', hostLabel: 'this page' });
    expect(platform.scheduler?.notify).toBeUndefined();
  });

  it('the honesty line reads the seat AND the storage rung off the composed platform: a memory bucket says the page keeps nothing; a durable one does not', () => {
    const memory = composeHostPlatform(probeOf('artifact', {}), winOf(KIT), docOf(KIT), wasm).platform;
    expect(honestyInputFor(memory)).toEqual({ kind: 'host', hostLabel: 'this artifact', wakeMode: 'page', storageRung: 'memory' });
    expect(hostHonesty(honestyInputFor(memory))).toBe('runs while this artifact is open — this page keeps nothing after it closes');

    const durable = composeHostPlatform({ ...probeOf('file'), storage: { backend: createMemoryBackend(), kind: 'opfs' } }, winOf(KIT), docOf(KIT), wasm).platform;
    expect(honestyInputFor(durable)).toEqual({ kind: 'host', hostLabel: 'this page', wakeMode: 'page', storageRung: 'durable' });
    expect(hostHonesty(honestyInputFor(durable))).toBe('runs while this page is open');
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
