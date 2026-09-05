// artifactHtml.test.ts — TASK-20260905-binding-a-artifacts AC5: the hosted artifact's
// durable record OVER the probed browser bucket. The bucket stays the working copy (every
// debounced save lands there); the page's own `snug-db` block is the durable copy, written
// by ONE explicit act — never on load, never on a timer. The page source for that act is
// FETCHED and verified, never serialized from the live DOM (the contract forbids it: the
// viewer injects its runtime). Every refusal is named; nothing here overwrites a copy.

import { createMemoryBackend } from '@snugprotocol/db';
import { USERDB_FILE } from '@snugprotocol/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { DB_BLOCK_FORMAT, readDbBlock, writeDbBlock } from '../../../../scripts/lib/page-blocks.mjs';
import { ARTIFACT_MAX_PAGE_BYTES, BEFORE_LOAD_FILE, CUSTODY_NOTE_STASH_KEY, CUSTODY_SIDECAR_FILE, createArtifactRecord } from '../storage/artifactHtml.js';
import { createCustodyStore } from '../storage/custodyStore.js';
import { sha256Hex } from '../storage/sha256.js';

const STAMP = '0.1.0 abcdef1';
const KIT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="snug-host-build" content="${STAMP}" /><title>Snug</title>
<script type="module">/* kit */</script></head>
<body><div id="root"></div>
</body></html>
`;
const bytesOf = (n: number, seed = 1): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * seed + 3) % 251);
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

async function pageWithBlock(bytes: Uint8Array, saved: number, page = KIT_PAGE): Promise<string> {
  return writeDbBlock(page, {
    manifest: { format: DB_BLOCK_FORMAT, bytes: bytes.length, sha256: await sha256Hex(bytes), saved, savedAt: '2026-09-05T00:00:00Z' },
    base64: b64(bytes),
  });
}

function recorder() {
  const calls: string[] = [];
  let outcome: { version: string } | { reject: { code: string } } = { version: 'v-next' };
  return {
    calls,
    setOutcome: (o: typeof outcome) => {
      outcome = o;
    },
    publish: async (html: string): Promise<{ version: string }> => {
      calls.push(html);
      if ('reject' in outcome) throw Object.assign(new Error(outcome.reject.code), outcome.reject);
      return outcome;
    },
  };
}

beforeEach(() => {
  sessionStorage.clear();
});

describe('load — bucket first, the page block as the seed, never an overwrite', () => {
  it('an empty bucket is seeded from the page block with ONE counted save; the custody counter takes the block’s', async () => {
    const payload = bytesOf(64);
    const page = await pageWithBlock(payload, 5);
    const bucket = createMemoryBackend();
    const saves: string[] = [];
    const counted = { ...bucket, save: async (file: string, bytes: Uint8Array) => (saves.push(file), bucket.save(file, bytes)) };
    const store = createCustodyStore();
    const record = createArtifactRecord({ bucket: counted, pageBlock: readDbBlock(page), canonicalSource: async () => page, expectedStamp: STAMP, publish: recorder().publish, store });
    expect(record.backend.kind).toBe('artifact-html');
    expect(await record.backend.load(USERDB_FILE)).toEqual(payload);
    // Exactly two writes, both named: the seed, and the counter sidecar that records which page save it came from.
    expect(saves).toEqual([USERDB_FILE, CUSTODY_SIDECAR_FILE]);
    expect(await bucket.load(USERDB_FILE)).toEqual(payload);
    expect(store.get()).toMatchObject({ dirty: false, saved: { saved: 5 } });
    expect(store.get().divergence).toBeUndefined();
  });

  it('a bucket file with NO page block is simply dirty (unsaved) — never divergence', async () => {
    const bucket = createMemoryBackend();
    await bucket.save(USERDB_FILE, bytesOf(10));
    const store = createCustodyStore();
    const record = createArtifactRecord({ bucket, pageBlock: undefined, canonicalSource: async () => KIT_PAGE, expectedStamp: STAMP, publish: recorder().publish, store });
    expect(await record.backend.load(USERDB_FILE)).toEqual(bytesOf(10));
    expect(store.get().dirty).toBe(true);
    expect(store.get().divergence).toBeUndefined();
  });

  it('a bucket file that differs from the block is a divergence with a DIRECTION; nothing is overwritten', async () => {
    const page = await pageWithBlock(bytesOf(20, 2), 9);
    const bucket = createMemoryBackend();
    await bucket.save(USERDB_FILE, bytesOf(20, 5));
    // The bucket last saw page save #9 (it published it): its copy is NEWER than the page.
    const store = createCustodyStore();
    const record = createArtifactRecord({ bucket, pageBlock: readDbBlock(page), canonicalSource: async () => page, expectedStamp: STAMP, publish: recorder().publish, store, custodyStart: { saved: 9 } });
    expect(await record.backend.load(USERDB_FILE)).toEqual(bytesOf(20, 5));
    expect(store.get().divergence).toBe('newer');
    // A bucket that only saw save #3 is OLDER than the page's #9.
    const store2 = createCustodyStore();
    const record2 = createArtifactRecord({ bucket, pageBlock: readDbBlock(page), canonicalSource: async () => page, expectedStamp: STAMP, publish: recorder().publish, store: store2, custodyStart: { saved: 3 } });
    await record2.backend.load(USERDB_FILE);
    expect(store2.get().divergence).toBe('older');
    expect(await bucket.load(USERDB_FILE)).toEqual(bytesOf(20, 5));
  });

  it('identical bytes in the bucket and the block: clean, no divergence', async () => {
    const payload = bytesOf(30);
    const page = await pageWithBlock(payload, 2);
    const bucket = createMemoryBackend();
    await bucket.save(USERDB_FILE, payload);
    const store = createCustodyStore();
    const record = createArtifactRecord({ bucket, pageBlock: readDbBlock(page), canonicalSource: async () => page, expectedStamp: STAMP, publish: recorder().publish, store });
    await record.backend.load(USERDB_FILE);
    expect(store.get().dirty).toBe(false);
    expect(store.get().divergence).toBeUndefined();
  });

  it('(N) a block whose bytes do not match its sha is CORRUPT — load throws, the bucket is untouched', async () => {
    const page = (await pageWithBlock(bytesOf(16), 1)).replace(/"sha256":"[0-9a-f]{64}"/, `"sha256":"${'0'.repeat(64)}"`);
    const bucket = createMemoryBackend();
    const store = createCustodyStore();
    const record = createArtifactRecord({ bucket, pageBlock: readDbBlock(page), canonicalSource: async () => page, expectedStamp: STAMP, publish: recorder().publish, store });
    await expect(record.backend.load(USERDB_FILE)).rejects.toThrow(/corrupt|sha/i);
    expect(await bucket.load(USERDB_FILE)).toBeUndefined();
  });

  it('(N) a block the page-blocks reader called corrupt is CORRUPT too, never "no file"', async () => {
    const page = KIT_PAGE.replace('</body>', '<script type="text/plain" id="snug-db">not json\nAAAA</script>\n</body>');
    const record = createArtifactRecord({ bucket: createMemoryBackend(), pageBlock: readDbBlock(page), canonicalSource: async () => page, expectedStamp: STAMP, publish: recorder().publish, store: createCustodyStore() });
    await expect(record.backend.load(USERDB_FILE)).rejects.toThrow(/corrupt/i);
  });

  it('every other file name passes straight through to the bucket', async () => {
    const bucket = createMemoryBackend();
    const record = createArtifactRecord({ bucket, pageBlock: undefined, canonicalSource: async () => KIT_PAGE, expectedStamp: STAMP, publish: recorder().publish, store: createCustodyStore() });
    await record.backend.save('user.snug.sync', bytesOf(4));
    expect(await record.backend.load('user.snug.sync')).toEqual(bytesOf(4));
    expect(await bucket.load('user.snug.sync')).toEqual(bytesOf(4));
  });
});

describe('save — the bucket, plus the dirty flag', () => {
  it('writes the bucket and marks the record dirty; never touches the page', async () => {
    const bucket = createMemoryBackend();
    const store = createCustodyStore();
    const pub = recorder();
    const record = createArtifactRecord({ bucket, pageBlock: undefined, canonicalSource: async () => KIT_PAGE, expectedStamp: STAMP, publish: pub.publish, store });
    await record.backend.save(USERDB_FILE, bytesOf(8));
    expect(await bucket.load(USERDB_FILE)).toEqual(bytesOf(8));
    expect(store.get().dirty).toBe(true);
    expect(pub.calls).toHaveLength(0);
  });
});

describe('publish — the one explicit act', () => {
  it('fetches the canonical source, verifies it, splices the bucket bytes into the block (inserting when absent), bumps the counter, publishes once, clears dirty', async () => {
    const bucket = createMemoryBackend();
    const store = createCustodyStore();
    const pub = recorder();
    let fetches = 0;
    const record = createArtifactRecord({ bucket, pageBlock: undefined, canonicalSource: async () => ((fetches += 1), KIT_PAGE), expectedStamp: STAMP, publish: pub.publish, store });
    await record.backend.load(USERDB_FILE);
    await record.backend.save(USERDB_FILE, bytesOf(40));
    expect(fetches).toBe(0); // nothing fetched, nothing published on load or save
    const outcome = await record.publish();
    expect(outcome).toMatchObject({ ok: true, version: 'v-next', saved: 1 });
    expect(fetches).toBe(1);
    expect(pub.calls).toHaveLength(1);
    const block = readDbBlock(pub.calls[0]!);
    expect(block?.manifest).toMatchObject({ format: DB_BLOCK_FORMAT, bytes: 40, saved: 1, sha256: await sha256Hex(bytesOf(40)) });
    expect(block?.base64).toBe(b64(bytesOf(40)));
    expect(pub.calls[0]!.startsWith('<!doctype html>')).toBe(true);
    expect(store.get()).toMatchObject({ dirty: false, saved: { saved: 1 } });
    expect(sessionStorage.getItem(CUSTODY_NOTE_STASH_KEY)).toContain('saved');
  });

  it('a second publish replaces the block and continues the counter from the page’s', async () => {
    const page = await pageWithBlock(bytesOf(4), 6);
    const bucket = createMemoryBackend();
    const store = createCustodyStore();
    const pub = recorder();
    const record = createArtifactRecord({ bucket, pageBlock: readDbBlock(page), canonicalSource: async () => page, expectedStamp: STAMP, publish: pub.publish, store });
    await record.backend.load(USERDB_FILE);
    await record.backend.save(USERDB_FILE, bytesOf(12));
    const outcome = await record.publish();
    expect(outcome).toMatchObject({ ok: true, saved: 7 });
    expect((pub.calls[0]!.match(/id="snug-db"/g) ?? []).length).toBe(1);
    expect(readDbBlock(pub.calls[0]!)?.manifest?.saved).toBe(7);
  });

  it('(N) refuses when the fetched page is not the kit page — an injected script, a wrong stamp — and publishes nothing', async () => {
    const bucket = createMemoryBackend();
    const store = createCustodyStore();
    const pub = recorder();
    const injected = KIT_PAGE.replace('</head>', '<script>window.__runtime__=1</script></head>');
    const record = createArtifactRecord({ bucket, pageBlock: undefined, canonicalSource: async () => injected, expectedStamp: STAMP, publish: pub.publish, store });
    await record.backend.save(USERDB_FILE, bytesOf(8));
    const outcome = await record.publish();
    expect(outcome).toMatchObject({ ok: false, reason: 'not-the-kit-page' });
    expect(pub.calls).toHaveLength(0);
    expect(store.get().dirty).toBe(true);
    expect(store.get().note).toMatch(/script/);
    const stale = createArtifactRecord({ bucket, pageBlock: undefined, canonicalSource: async () => KIT_PAGE, expectedStamp: '9.9.9 0000000', publish: pub.publish, store });
    expect(await stale.publish()).toMatchObject({ ok: false, reason: 'not-the-kit-page' });
  });

  it('(N) refuses when the PROJECTED page would exceed the cap — named with the three parts, export offered, nothing published', async () => {
    const bucket = createMemoryBackend();
    const store = createCustodyStore();
    const pub = recorder();
    const record = createArtifactRecord({ bucket, pageBlock: undefined, canonicalSource: async () => KIT_PAGE, expectedStamp: STAMP, publish: pub.publish, store, maxPageBytes: 2_000 });
    await record.backend.save(USERDB_FILE, bytesOf(1_500)); // 2,000 base64 chars alone bust a 2,000-byte cap
    const outcome = await record.publish();
    expect(outcome).toMatchObject({ ok: false, reason: 'too-large' });
    expect(pub.calls).toHaveLength(0);
    expect(store.get().note).toMatch(/export/i);
    expect(store.get().note).toMatch(/page/i);
    expect(ARTIFACT_MAX_PAGE_BYTES).toBe(16 * 1024 * 1024 - 512 * 1024);
  });

  it('(N) nothing in the bucket → nothing to publish (named), no call', async () => {
    const pub = recorder();
    const record = createArtifactRecord({ bucket: createMemoryBackend(), pageBlock: undefined, canonicalSource: async () => KIT_PAGE, expectedStamp: STAMP, publish: pub.publish, store: createCustodyStore() });
    expect(await record.publish()).toMatchObject({ ok: false, reason: 'nothing-to-save' });
    expect(pub.calls).toHaveLength(0);
  });

  it('maps the runtime’s codes: conflict keeps the copy safe (dirty stays), not_writer / not_granted flip read-only, too_large is the size refusal', async () => {
    const bucket = createMemoryBackend();
    const store = createCustodyStore();
    const pub = recorder();
    const record = createArtifactRecord({ bucket, pageBlock: undefined, canonicalSource: async () => KIT_PAGE, expectedStamp: STAMP, publish: pub.publish, store });
    await record.backend.save(USERDB_FILE, bytesOf(8));
    pub.setOutcome({ reject: { code: 'conflict' } });
    expect(await record.publish()).toMatchObject({ ok: false, reason: 'conflict' });
    expect(store.get().dirty).toBe(true);
    expect(sessionStorage.getItem(CUSTODY_NOTE_STASH_KEY)).toMatch(/published .*first/);
    pub.setOutcome({ reject: { code: 'not_writer' } });
    expect(await record.publish()).toMatchObject({ ok: false, reason: 'read-only' });
    expect(store.get().readOnly).toBe(true);
    expect(record.canSave()).toBe(false);
    pub.setOutcome({ reject: { code: 'too_large' } });
    const store2 = createCustodyStore();
    const record2 = createArtifactRecord({ bucket, pageBlock: undefined, canonicalSource: async () => KIT_PAGE, expectedStamp: STAMP, publish: pub.publish, store: store2 });
    expect(await record2.publish()).toMatchObject({ ok: false, reason: 'too-large' });
    pub.setOutcome({ reject: { code: 'rate_limited' } });
    expect(await record2.publish()).toMatchObject({ ok: false, reason: 'busy' });
  });

  it('a record with no artifact namespace is read-only from the start: no publish path, the store says so', () => {
    const store = createCustodyStore();
    const record = createArtifactRecord({ bucket: createMemoryBackend(), pageBlock: undefined, canonicalSource: async () => KIT_PAGE, expectedStamp: STAMP, publish: undefined, store });
    expect(record.canSave()).toBe(false);
    expect(store.get().readOnly).toBe(true);
  });
});

describe('the divergence acts', () => {
  it('loadPageCopy keeps the browser copy under a before-load name, seeds the page’s copy, adopts its counter', async () => {
    const page = await pageWithBlock(bytesOf(20, 2), 9);
    const bucket = createMemoryBackend();
    await bucket.save(USERDB_FILE, bytesOf(20, 5));
    const store = createCustodyStore();
    const record = createArtifactRecord({ bucket, pageBlock: readDbBlock(page), canonicalSource: async () => page, expectedStamp: STAMP, publish: recorder().publish, store, custodyStart: { saved: 3 } });
    await record.backend.load(USERDB_FILE);
    expect(store.get().divergence).toBe('older');
    await record.loadPageCopy();
    expect(await bucket.load(BEFORE_LOAD_FILE)).toEqual(bytesOf(20, 5));
    expect(await bucket.load(USERDB_FILE)).toEqual(bytesOf(20, 2));
    expect(store.get()).toMatchObject({ dirty: false, saved: { saved: 9 } });
    expect(store.get().divergence).toBeUndefined();
  });

  it('keepBrowserCopy clears the divergence and marks the copy dirty (it is unsaved relative to the page)', async () => {
    const page = await pageWithBlock(bytesOf(20, 2), 9);
    const bucket = createMemoryBackend();
    await bucket.save(USERDB_FILE, bytesOf(20, 5));
    const store = createCustodyStore();
    const record = createArtifactRecord({ bucket, pageBlock: readDbBlock(page), canonicalSource: async () => page, expectedStamp: STAMP, publish: recorder().publish, store, custodyStart: { saved: 9 } });
    await record.backend.load(USERDB_FILE);
    record.keepBrowserCopy();
    expect(store.get().dirty).toBe(true);
    expect(store.get().divergence).toBeUndefined();
    expect(await bucket.load(USERDB_FILE)).toEqual(bytesOf(20, 5));
  });
});
