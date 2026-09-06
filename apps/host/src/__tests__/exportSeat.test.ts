// exportSeat.test.ts — TASK-20260905-binding-a-artifacts AC6: the kit's saveFile seat —
// wrapper vs bundle by sniff, `downloads.save` with every code owned, the chat copy path.
import { createMemoryBackend, openUserDb, unwrapUserFile } from '@snugprotocol/db';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { artifactBundleName, createExportSeat } from '../exportSeat.js';
import { createCustodyStore } from '../storage/custodyStore.js';

const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

async function userFile(): Promise<Uint8Array> {
  const opened = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
  if (opened.status !== 'ok') throw new Error(opened.status);
  opened.userDb.installApp({ displayName: 'x', html: '<!doctype html><html><body>x</body></html>' });
  const bytes = await opened.userDb.exportUserDb({ includeSecrets: false });
  await opened.userDb.close();
  return bytes;
}

function fakeDownloads(outcome: 'ok' | { reject: string } = 'ok', settleAfterMs = 0) {
  const calls: { filename: string; data: string }[] = [];
  return {
    calls,
    ns: {
      save: async (request: { filename: string; data: Uint8Array | string | Blob }) => {
        calls.push({ filename: request.filename, data: String(request.data) });
        if (settleAfterMs > 0) await new Promise((r) => setTimeout(r, settleAfterMs));
        if (outcome !== 'ok') throw Object.assign(new Error(outcome.reject), { code: outcome.reject });
        return {};
      },
    },
  };
}

describe('createExportSeat', () => {
  it('a user file leaves as the wrapper under snug-user.snug.json, and the wrapper round-trips through the db reader', async () => {
    const bytes = await userFile();
    const dl = fakeDownloads();
    const store = createCustodyStore();
    await createExportSeat({ downloads: dl.ns, store })(bytes, 'snug-user.snug');
    expect(dl.calls).toHaveLength(1);
    expect(dl.calls[0]!.filename).toBe('snug-user.snug.json');
    const back = await unwrapUserFile(dl.calls[0]!.data);
    expect(back.ok && back.bytes).toEqual(bytes);
    expect(store.get().note).toMatch(/saved snug-user\.snug\.json/);
  });

  it('a bundle leaves as <stem>.snug.json with its text unchanged', async () => {
    const text = '{"format":"snug-app-bundle/1","lineage":"x"}';
    const dl = fakeDownloads();
    await createExportSeat({ downloads: dl.ns, store: createCustodyStore() })(new TextEncoder().encode(text), 'Weather Wall.snug');
    expect(dl.calls[0]).toEqual({ filename: 'Weather Wall.snug.json', data: text });
    expect(artifactBundleName('a.snug')).toBe('a.snug.json');
    expect(artifactBundleName('a.json')).toBe('a.json');
  });

  it('(N) something that is not a Snug file is refused with a note and never sent', async () => {
    const dl = fakeDownloads();
    const store = createCustodyStore();
    await createExportSeat({ downloads: dl.ns, store })(new TextEncoder().encode('hello'), 'x.txt');
    expect(dl.calls).toHaveLength(0);
    expect(store.get().note).toMatch(/not a Snug file/);
  });

  it('declined is silent; rate_limited, rejected_extension and an unknown code are named', async () => {
    const bytes = await userFile();
    for (const [code, expected] of [
      ['declined', undefined],
      ['rate_limited', /already open/],
      ['rejected_extension', /does not allow/],
      ['upstream_error', /save failed \(upstream_error\)/],
    ] as const) {
      const store = createCustodyStore();
      await createExportSeat({ downloads: fakeDownloads({ reject: code }).ns, store })(bytes, 'snug-user.snug');
      if (expected === undefined) expect(store.get().note).toBeUndefined();
      else expect(store.get().note).toMatch(expected);
    }
  });

  it('a second export while a prompt is open is refused by name — one prompt at a time, and the FIRST click owns the prompt (the guard is taken before the hash)', async () => {
    const bytes = await userFile();
    const dl = fakeDownloads('ok', 20);
    const store = createCustodyStore();
    const seat = createExportSeat({ downloads: dl.ns, store });
    const first = seat(bytes, 'snug-user.snug');
    await seat(bytes, 'snug-user.snug'); // resolves at once: refused before any await
    expect(store.get().note).toMatch(/already open/);
    expect(dl.calls).toHaveLength(0); // the first is still hashing — nothing has reached downloads yet
    await first;
    expect(dl.calls).toHaveLength(1);
    expect(store.get().note).toMatch(/^saved snug-user\.snug\.json/);
    // A refused prepare releases the guard: the next export is not stuck behind it.
    await seat(new Uint8Array([1, 2, 3]), 'junk');
    expect(store.get().note).toMatch(/not a Snug file/);
    await seat(bytes, 'snug-user.snug');
    expect(dl.calls).toHaveLength(2);
  });

  it('without downloads (a chat artifact) the wrapper text is COPIED and the note names the size and the file name', async () => {
    const bytes = await userFile();
    const copied: string[] = [];
    const store = createCustodyStore();
    await createExportSeat({ downloads: undefined, store, copyText: (t) => (copied.push(t), true) })(bytes, 'snug-user.snug');
    expect(copied).toHaveLength(1);
    expect((await unwrapUserFile(copied[0]!)).ok).toBe(true);
    expect(store.get().note).toMatch(/copied \d+ KB .* snug-user\.snug\.json/);
    const failing = createCustodyStore();
    await createExportSeat({ downloads: undefined, store: failing, copyText: () => false })(bytes, 'snug-user.snug');
    expect(failing.get().note).toMatch(/copy failed/);
  });
});
