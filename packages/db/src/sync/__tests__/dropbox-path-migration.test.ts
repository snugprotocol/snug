// TASK-20260820 — moving the Dropbox path across the rename (AC23, plan review B3).
//
// THE FAILURE THIS PREVENTS. `createDropboxProvider` captures ONE path at construction
// and uses it for pull, push and metadata. Point it at `/snug/user.snug` and an
// existing user's remote copy at `/snug/user.sqlite` is simply not there: `pull`
// returns undefined, the loop reads that as "freshly provisioned origin", and pushes
// local up as a NEW file. Best case they now have two files and their old backup is
// orphaned. Worse case — the naive fix of "pull legacy, push canonical" — the push
// carries a base revision belonging to a DIFFERENT file, Dropbox 409s forever, and
// sync is permanently wedged with no path out.
//
// So the migration is explicit: read the legacy path only when the canonical one is
// absent, and tell the caller, so the first push provisions the new path with
// `mode: 'add'` instead of a conditional update against a foreign revision.
import { describe, expect, it } from 'vitest';

import { DROPBOX_DEFAULT_PATH, DROPBOX_LEGACY_PATH, createDropboxProvider } from '../dropbox.js';

const BYTES = new Uint8Array([1, 2, 3, 4]);

/** A Dropbox stub holding whatever paths the test seeds. */
function dropbox(files: Record<string, { bytes: Uint8Array; rev: string }>) {
  const calls: { url: string; arg: Record<string, unknown> }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const arg = JSON.parse(headers['dropbox-api-arg'] ?? (init?.body as string) ?? '{}') as Record<string, unknown>;
    calls.push({ url: String(url), arg });
    const path = String(arg.path ?? '');
    if (String(url).includes('download')) {
      const hit = files[path];
      if (hit === undefined) {
        return new Response(JSON.stringify({ error_summary: 'path/not_found/' }), { status: 409 });
      }
      return new Response(hit.bytes.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: { 'dropbox-api-result': JSON.stringify({ rev: hit.rev }) },
      });
    }
    if (String(url).includes('upload')) {
      files[path] = { bytes: BYTES, rev: 'rev-new' };
      return new Response(JSON.stringify({ rev: 'rev-new' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  return { fetchImpl, calls, files };
}

describe('Dropbox path migration (AC23)', () => {
  it('pulls the LEGACY path when the canonical one is absent', async () => {
    const stub = dropbox({ [DROPBOX_LEGACY_PATH]: { bytes: BYTES, rev: 'rev-legacy' } });
    const provider = createDropboxProvider({ getToken: () => Promise.resolve('t'), fetch: stub.fetchImpl });

    const pulled = await provider.pull();
    expect(pulled).toBeDefined();
    expect(Array.from(pulled!.bytes)).toEqual(Array.from(BYTES));
    // Canonical is asked for FIRST — a legacy-first order would keep reading a stale
    // copy forever once the canonical file exists.
    expect(stub.calls[0]!.arg.path).toBe(DROPBOX_DEFAULT_PATH);
    expect(stub.calls[1]!.arg.path).toBe(DROPBOX_LEGACY_PATH);
  });

  it('prefers the CANONICAL path once it exists, ignoring the legacy copy', async () => {
    const canonical = new Uint8Array([9, 9, 9]);
    const stub = dropbox({
      [DROPBOX_DEFAULT_PATH]: { bytes: canonical, rev: 'rev-new' },
      [DROPBOX_LEGACY_PATH]: { bytes: BYTES, rev: 'rev-legacy' },
    });
    const provider = createDropboxProvider({ getToken: () => Promise.resolve('t'), fetch: stub.fetchImpl });

    const pulled = await provider.pull();
    expect(Array.from(pulled!.bytes)).toEqual(Array.from(canonical));
    // The legacy path must not even be consulted — reading it here would be how a
    // user gets silently rolled back to an older copy.
    expect(stub.calls.some((c) => c.arg.path === DROPBOX_LEGACY_PATH)).toBe(false);
  });

  it('reports the legacy read so the first push PROVISIONS rather than updates', async () => {
    const stub = dropbox({ [DROPBOX_LEGACY_PATH]: { bytes: BYTES, rev: 'rev-legacy' } });
    const provider = createDropboxProvider({ getToken: () => Promise.resolve('t'), fetch: stub.fetchImpl });

    const pulled = await provider.pull();
    // A revision from the LEGACY file must never be handed back as though it belonged
    // to the canonical one: `mode: {update: rev-legacy}` against a path that does not
    // exist yet is a permanent 409.
    expect(pulled!.migratedFromLegacy).toBe(true);
  });

  it('writes to the CANONICAL path, never back to the legacy one', async () => {
    const stub = dropbox({ [DROPBOX_LEGACY_PATH]: { bytes: BYTES, rev: 'rev-legacy' } });
    const provider = createDropboxProvider({ getToken: () => Promise.resolve('t'), fetch: stub.fetchImpl });

    await provider.push(BYTES, undefined);
    const upload = stub.calls.find((c) => c.url.includes('upload'));
    expect(upload!.arg.path).toBe(DROPBOX_DEFAULT_PATH);
    expect(stub.files[DROPBOX_LEGACY_PATH]).toBeDefined(); // legacy copy left intact
  });

  it('a genuinely empty origin still reports undefined (F1: never clobber local)', async () => {
    const stub = dropbox({});
    const provider = createDropboxProvider({ getToken: () => Promise.resolve('t'), fetch: stub.fetchImpl });
    expect(await provider.pull()).toBeUndefined();
  });
});
