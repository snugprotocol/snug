// artifactHtml.test.ts — TASK-20260905-binding-a-artifacts AC5: the hosted artifact's
// durable record OVER the probed browser bucket. The bucket stays the working copy (every
// debounced save lands there); the page's own `snug-db` block is the durable copy, written
// by ONE explicit act — never on load, never on a timer. The page source for that act is
// FETCHED and verified, never serialized from the live DOM (the contract forbids it: the
// viewer injects its runtime). Every refusal is named; nothing here overwrites a copy.

import { createMemoryBackend, sha256Hex } from '@snugprotocol/db';
import { USERDB_FILE } from '@snugprotocol/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { VIEWER_WRAPPER_HEAD, VIEWER_WRAPPER_TAIL, wrapAsViewerPage } from '../../../../scripts/fixtures/viewer-wrapper.mjs';
import { DB_BLOCK_FORMAT, readDbBlock, unwrapViewerPage, writeDbBlock } from '../../../../scripts/lib/page-blocks.mjs';
import { ARTIFACT_MAX_PAGE_BYTES, BEFORE_LOAD_FILE, CUSTODY_NOTE_STASH_KEY, CUSTODY_SIDECAR_FILE, createArtifactRecord } from '../storage/artifactHtml.js';
import { createCustodyStore } from '../storage/custodyStore.js';

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

  it('(N) a block whose bytes do not match its sha is CORRUPT: an EMPTY bucket starts a fresh, dirty file and the note says so (never a boot that throws forever — correctness review 15); the block is not seeded', async () => {
    const page = (await pageWithBlock(bytesOf(16), 1)).replace(/"sha256":"[0-9a-f]{64}"/, `"sha256":"${'0'.repeat(64)}"`);
    const bucket = createMemoryBackend();
    const store = createCustodyStore();
    const record = createArtifactRecord({ bucket, pageBlock: readDbBlock(page), canonicalSource: async () => page, expectedStamp: STAMP, publish: recorder().publish, store });
    expect(await record.backend.load(USERDB_FILE)).toBeUndefined();
    expect(await bucket.load(USERDB_FILE)).toBeUndefined();
    expect(store.get().dirty).toBe(true);
    expect(store.get().note).toMatch(/corrupt.*new file/);
  });

  it('(N) a block the page-blocks reader called corrupt beside a bucket that HAS a file: the bucket copy is used, the note names the unreadable page copy', async () => {
    const page = KIT_PAGE.replace('</body>', '<script type="text/plain" id="snug-db">not json\nAAAA</script>\n</body>');
    const bucket = createMemoryBackend();
    await bucket.save(USERDB_FILE, bytesOf(12));
    const store = createCustodyStore();
    const record = createArtifactRecord({ bucket, pageBlock: readDbBlock(page), canonicalSource: async () => page, expectedStamp: STAMP, publish: recorder().publish, store });
    expect(await record.backend.load(USERDB_FILE)).toEqual(bytesOf(12));
    expect(store.get().note).toMatch(/corrupt.*in use/);
  });

  it('a sha match RE-SYNCS a stale sidecar (correctness review 4): the next divergence reads the right direction', async () => {
    const payload = bytesOf(30);
    const page = await pageWithBlock(payload, 2);
    const bucket = createMemoryBackend();
    await bucket.save(USERDB_FILE, payload);
    // The sidecar still says #1 (a publish whose reload outran the sidecar write).
    const stale = createArtifactRecord({ bucket, pageBlock: readDbBlock(page), canonicalSource: async () => page, expectedStamp: STAMP, publish: recorder().publish, store: createCustodyStore(), custodyStart: { saved: 1 } });
    await stale.backend.load(USERDB_FILE);
    // A fresh record over the same bucket reads the sidecar: it must say #2 now, so a later edit is "newer".
    await bucket.save(USERDB_FILE, bytesOf(30, 7));
    const store = createCustodyStore();
    const next = createArtifactRecord({ bucket, pageBlock: readDbBlock(page), canonicalSource: async () => page, expectedStamp: STAMP, publish: recorder().publish, store });
    await next.backend.load(USERDB_FILE);
    expect(store.get().divergence).toBe('newer');
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

  it('the fetched source is the VIEWER-WRAPPED page (AC13, measured 2026-09-06): the save unwraps it, verifies the kit document, and publishes the BARE kit page with the block — never the wrapper', async () => {
    const bucket = createMemoryBackend();
    const store = createCustodyStore();
    const pub = recorder();
    // The wrapped fetch is what `fetch(location.href)` returns on the real artifact; a saved
    // page comes back wrapped too, its block inside the kit body.
    const record = createArtifactRecord({ bucket, pageBlock: undefined, canonicalSource: async () => wrapAsViewerPage(KIT_PAGE), expectedStamp: STAMP, publish: pub.publish, store });
    await record.backend.save(USERDB_FILE, bytesOf(8));
    expect(await record.publish()).toMatchObject({ ok: true, saved: 1 });
    expect(pub.calls).toHaveLength(1);
    const published = pub.calls[0]!;
    expect(published.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(published).not.toContain('frame-runtime');
    expect(unwrapViewerPage(published)).toEqual({ html: published, wrapped: false });
    expect(readDbBlock(published)?.manifest?.saved).toBe(1);
    // The block landed inside the kit body: stripping it gives the kit page back exactly.
    const block = readDbBlock(published)!;
    if (block.corrupt !== undefined) throw new Error(block.corrupt);
    expect(`${published.slice(0, block.index)}${published.slice(block.end + 1)}`).toBe(KIT_PAGE);

    // Save #2 fetches the wrapped SAVED page: the live block is read through the unwrap too.
    const again = createArtifactRecord({ bucket, pageBlock: readDbBlock(published), canonicalSource: async () => wrapAsViewerPage(published), expectedStamp: STAMP, publish: pub.publish, store, custodyStart: { saved: 1 } });
    expect(await again.publish()).toMatchObject({ ok: true, saved: 2 });
    expect(readDbBlock(pub.calls[1]!)?.manifest?.saved).toBe(2);
    expect((pub.calls[1]!.match(/id="snug-db"/g) ?? []).length).toBe(1);
  });

  it('(N) a wrapper that is not the measured shape — content after the kit document, a wrapper inside a wrapper — is refused by name with nothing published', async () => {
    const bucket = createMemoryBackend();
    const pub = recorder();
    for (const [label, source] of [
      ['trailing script', `${VIEWER_WRAPPER_HEAD}${KIT_PAGE}<script>injected()</script>${VIEWER_WRAPPER_TAIL}`],
      ['double wrap', wrapAsViewerPage(wrapAsViewerPage(KIT_PAGE))],
    ] as const) {
      const store = createCustodyStore();
      const record = createArtifactRecord({ bucket, pageBlock: undefined, canonicalSource: async () => source, expectedStamp: STAMP, publish: pub.publish, store });
      await record.backend.save(USERDB_FILE, bytesOf(8));
      expect(await record.publish(), label).toMatchObject({ ok: false, reason: 'not-the-kit-page' });
      expect(store.get().note, label).toMatch(/wrapper/);
    }
    expect(pub.calls).toHaveLength(0);
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

  it('a fetched page whose block is NEWER than the boot-time one is a conflict — another view saved meanwhile (security review 6)', async () => {
    const bootPage = await pageWithBlock(bytesOf(4), 6);
    const livePage = await pageWithBlock(bytesOf(4, 3), 8);
    const bucket = createMemoryBackend();
    const store = createCustodyStore();
    const pub = recorder();
    const record = createArtifactRecord({ bucket, pageBlock: readDbBlock(bootPage), canonicalSource: async () => livePage, expectedStamp: STAMP, publish: pub.publish, store });
    await record.backend.load(USERDB_FILE);
    await record.backend.save(USERDB_FILE, bytesOf(12));
    const outcome = await record.publish();
    expect(outcome).toMatchObject({ ok: false, reason: 'conflict' });
    expect(pub.calls).toHaveLength(0);
    expect(store.get().divergence).toBe('older');
    expect(store.get().saved?.saved).toBe(8);
  });

  it('the sidecar takes the projected counter BEFORE the publish and is restored on a rejection; the stash survives only a conflict (correctness reviews 3 + 4)', async () => {
    const bucket = createMemoryBackend();
    const store = createCustodyStore();
    let sidecarDuringPublish: string | undefined;
    const pub = recorder();
    const publishSpy = async (html: string): Promise<{ version: string }> => {
      const raw = await bucket.load(CUSTODY_SIDECAR_FILE);
      sidecarDuringPublish = raw === undefined ? undefined : new TextDecoder().decode(raw);
      return pub.publish(html);
    };
    const record = createArtifactRecord({ bucket, pageBlock: undefined, canonicalSource: async () => KIT_PAGE, expectedStamp: STAMP, publish: publishSpy, store });
    await record.backend.save(USERDB_FILE, bytesOf(8));
    expect(await record.publish()).toMatchObject({ ok: true, saved: 1 });
    expect(sidecarDuringPublish).toContain('"saved":1');
    pub.setOutcome({ reject: { code: 'too_large' } });
    expect(await record.publish()).toMatchObject({ ok: false, reason: 'too-large' });
    expect(new TextDecoder().decode((await bucket.load(CUSTODY_SIDECAR_FILE))!)).toContain('"saved":1'); // restored, not 2
    expect(sessionStorage.getItem(CUSTODY_NOTE_STASH_KEY)).toBeNull(); // no "saved" lie for the next boot
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
    expect(sessionStorage.getItem(CUSTODY_NOTE_STASH_KEY)).toBeNull(); // a read-only refusal reloads nothing — no stale stash
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
    let reloads = 0;
    const terminal = createArtifactRecord({ bucket, pageBlock: readDbBlock(page), canonicalSource: async () => page, expectedStamp: STAMP, publish: recorder().publish, store, custodyStart: { saved: 3 }, onReload: () => (reloads += 1) });
    await terminal.loadPageCopy();
    expect(reloads).toBe(1); // terminal: the open db would flush the browser copy back (correctness review 1)
    expect(sessionStorage.getItem(CUSTODY_NOTE_STASH_KEY)).toContain('loaded the page’s saved copy');
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
