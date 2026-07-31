// Library stores: server mode reads the artifact routes; BYOK mode round-trips
// records through IndexedDB (fake-indexeddb here).

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { createByokLibrary, createServerLibrary, deriveDisplayName } from '../state/library.js';

const HTML = '<!DOCTYPE html><html><head><title>Chess Coach</title></head><body></body></html>';

describe('createByokLibrary', () => {
  it('saves, lists, and returns html by id', async () => {
    const library = createByokLibrary(new IDBFactory());
    const saved = await library.save(HTML);
    expect(saved.displayName).toBe('Chess Coach');
    expect(saved.bytes).toBe(new TextEncoder().encode(HTML).byteLength);

    const listed = await library.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(saved.id);
    expect(await library.getHtml(saved.id)).toBe(HTML);
  });

  it('lists newest first and misses return undefined', async () => {
    const library = createByokLibrary(new IDBFactory());
    const first = await library.save(HTML, 'older');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await library.save(HTML, 'newer');
    const listed = await library.list();
    expect(listed.map((entry) => entry.id)).toEqual([second.id, first.id]);
    expect(await library.getHtml('nope')).toBeUndefined();
  });
});

describe('createServerLibrary', () => {
  it('lists from GET /artifacts and fetches html from GET /artifacts/:id', async () => {
    const fetchSpy = vi.fn(async (input: string) => {
      if (input === '/artifacts') {
        return new Response(JSON.stringify({ artifacts: [{ id: 'a1', displayName: 'x', bytes: 10, createdAt: 'now' }] }));
      }
      if (input === '/artifacts/a1') return new Response(HTML);
      return new Response('nope', { status: 404 });
    });
    const library = createServerLibrary(fetchSpy);
    const listed = await library.list();
    expect(listed).toEqual([{ id: 'a1', displayName: 'x', bytes: 10, createdAt: 'now' }]);
    expect(await library.getHtml('a1')).toBe(HTML);
    expect(await library.getHtml('missing')).toBeUndefined();
  });
});

describe('deriveDisplayName', () => {
  it('prefers the explicit name, then <title>, then the fallback', () => {
    expect(deriveDisplayName(HTML, 'My App')).toBe('My App');
    expect(deriveDisplayName(HTML)).toBe('Chess Coach');
    expect(deriveDisplayName('<html></html>')).toBe('untitled app');
  });
});
