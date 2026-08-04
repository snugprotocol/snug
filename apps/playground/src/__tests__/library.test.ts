// The library after the portable-hub evolution: apps live in the USER DB in every
// mode (child-2 AC6); the server artifact fetch survives only as the subscription-mode
// pull path (client-authoritative, F4).

import { describe, expect, it, vi } from 'vitest';

import { createServerArtifactFetch, createUserDbLibrary, deriveDisplayName } from '../state/library.js';
import { installTestUserDb } from './userdbTestHelper.js';

const HTML = '<!DOCTYPE html><html><head><title>Chess Coach</title></head><body></body></html>';

describe('createUserDbLibrary', () => {
  it('saves into the user DB, lists, and returns html by id', async () => {
    const db = await installTestUserDb();
    const library = createUserDbLibrary(() => Promise.resolve(db));
    const entry = await library.save(HTML);
    expect(entry.displayName).toBe('Chess Coach'); // derived from <title>
    const listed = await library.list();
    expect(listed.map((e) => e.id)).toEqual([entry.id]);
    expect(await library.getHtml(entry.id)).toBe(HTML);
    // and it is REALLY an app row with a version, not a blob on the side
    expect(db.getApp(entry.id)?.currentVersion).toBe(1);
  });

  it('misses return undefined; entries list newest-updated first', async () => {
    const db = await installTestUserDb();
    const library = createUserDbLibrary(() => Promise.resolve(db));
    expect(await library.getHtml('nope')).toBeUndefined();
    await library.save(HTML, 'first');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await library.save(HTML, 'second');
    const listed = await library.list();
    expect(listed.map((e) => e.displayName)).toEqual(['second', 'first']);
  });
});

describe('install-source dedup (living-apps AC8)', () => {
  it('save with the same installSource returns the existing app; findByInstallSource resolves it', async () => {
    const db = await installTestUserDb();
    const store = createUserDbLibrary(() => Promise.resolve(db));
    const first = await store.save('<html><head><title>Chess</title></head></html>', 'chess', 'starter:chess');
    const second = await store.save('<html><head><title>Chess</title></head></html>', 'chess', 'starter:chess');
    expect(second.id).toBe(first.id);
    expect(await store.list()).toHaveLength(1);
    expect((await store.findByInstallSource('starter:chess'))?.id).toBe(first.id);
    expect(await store.findByInstallSource('starter:none')).toBeUndefined();
  });
});

describe('createServerArtifactFetch (subscription pull path)', () => {
  it('fetches html by id and maps 404 to undefined', async () => {
    const fetchSpy = vi.fn(async (input: string) =>
      input.includes('art-1') ? new Response(HTML, { status: 200 }) : new Response('', { status: 404 }),
    );
    const store = createServerArtifactFetch(fetchSpy);
    expect(await store.getHtml('art-1')).toBe(HTML);
    expect(await store.getHtml('gone')).toBeUndefined();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/artifacts/art-1');
  });
});

describe('deriveDisplayName', () => {
  it('prefers the explicit name, then <title>, then the fallback', () => {
    expect(deriveDisplayName(HTML, 'My App')).toBe('My App');
    expect(deriveDisplayName(HTML)).toBe('Chess Coach');
    expect(deriveDisplayName('<html></html>')).toBe('untitled app');
  });
});
