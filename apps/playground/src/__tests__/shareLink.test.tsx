// shareLink.test.tsx — TASK-20260904 AC19/AC20/AC22 (the link path, ADR-0064).
//
//   AC19  encrypt/decrypt round-trips; a flipped byte or a wrong key fails CLOSED; and
//         the KEY appears in no request URL, header or body (fetch spied at the platform seam).
//   AC20  the receiver act: a good link lands the bundle on the shelf IN MEMORY (no
//         settings row) and navigates; gone / unreachable / bad-key are named; the view
//         strips the fragment from the address bar.
//   AC22  link records split by sensitivity: the public record in settings, the token +
//         key in secrets; a default export carries neither the token nor the key.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_BUNDLE_FORMAT } from '@snugprotocol/protocol';
import { SHARED_APP_SETTING_PREFIX, shareLinkSettingKey } from '@snugprotocol/db';
import type { UserDb } from '@snugprotocol/db';

import { decryptBundle, encryptBundle, fromBase64Url, toBase64Url } from '../share/bundleCrypto.js';
import { desktopLinkFor, parseShareLink, shareLinkFor } from '../share/relayClient.js';
import { __resetSharedInboxForTests, listSharedEntries } from '../share/sharedInbox.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The relay origin is a BUILD-TIME constant; mock the config so the link path is live here.
vi.mock('../config/site.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/site.js')>();
  return { ...actual, SHARE_RELAY_ORIGIN: 'https://share.test' };
});

const LINEAGE = '0b6e5a1c-8d5e-4f13-9a2b-7c1d2e3f4a5b';
const bundleText = JSON.stringify({
  format: APP_BUNDLE_FORMAT,
  lineage: LINEAGE,
  sharedAt: '2026-09-04T01:00:00.000Z',
  app: { displayName: 'Weather Wall', usesDb: false },
  html: '<!doctype html><html><body>hi</body></html>',
  connections: [],
});

let db: UserDb;

beforeEach(async () => {
  db = await installTestUserDb();
  __resetSharedInboxForTests();
});

describe('bundleCrypto (AC19)', () => {
  it('round-trips, and the key is 43 url-safe chars', async () => {
    const plain = new TextEncoder().encode(bundleText);
    const sealed = await encryptBundle(plain);
    expect(sealed.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sealed.ciphertext.length).toBe(12 + plain.length + 16);
    const opened = await decryptBundle(sealed.ciphertext, sealed.key);
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(new TextDecoder().decode(opened.plaintext)).toBe(bundleText);
  });

  it('(N) fails closed on a flipped byte, a wrong key, a malformed key, and a short blob', async () => {
    const sealed = await encryptBundle(new TextEncoder().encode(bundleText));
    const flipped = sealed.ciphertext.slice();
    flipped[20] = (flipped[20]! ^ 0x01) & 0xff;
    expect((await decryptBundle(flipped, sealed.key)).ok).toBe(false);
    const other = await encryptBundle(new TextEncoder().encode('x'));
    expect((await decryptBundle(sealed.ciphertext, other.key)).ok).toBe(false);
    expect((await decryptBundle(sealed.ciphertext, 'not-a-key')).ok).toBe(false);
    expect((await decryptBundle(new Uint8Array(20), sealed.key)).ok).toBe(false);
  });

  it('base64url helpers are exact inverses and refuse foreign alphabets', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(fromBase64Url('abc+/=')).toBeUndefined();
  });
});

describe('relayClient — the key is never sent (AC19 N)', () => {
  it('upload carries only ciphertext; download and revoke carry only the id / token', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'A'.repeat(22), expiresAt: '2026-10-04T00:00:00.000Z', revokeToken: 'T'.repeat(43) }), { status: 201 });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const { downloadCiphertext, revokeShare, uploadCiphertext } = await import('../share/relayClient.js');
      const sealed = await encryptBundle(new TextEncoder().encode(bundleText));
      const uploaded = await uploadCiphertext(sealed.ciphertext);
      expect(uploaded.id).toBe('A'.repeat(22));
      await downloadCiphertext(uploaded.id);
      await revokeShare(uploaded.id, uploaded.revokeToken);
      expect(seen).toHaveLength(3);
      for (const request of seen) {
        expect(request.url).not.toContain(sealed.key);
        expect(JSON.stringify(request.init?.headers ?? {})).not.toContain(sealed.key);
        const body = request.init?.body;
        if (body instanceof Uint8Array) expect(new TextDecoder().decode(body)).not.toContain(sealed.key);
        else if (typeof body === 'string') expect(body).not.toContain(sealed.key);
        // and the plaintext never travels either
        if (body instanceof Uint8Array) expect(new TextDecoder().decode(body)).not.toContain('Weather Wall');
      }
      expect(seen[0]?.url).toBe('https://share.test/v1/bundles');
      expect(seen[2]?.init?.headers).toEqual({ Authorization: `Bearer ${'T'.repeat(43)}` });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('link grammar: builds and parses both shapes strictly', () => {
    const id = 'B'.repeat(22);
    const key = 'k'.repeat(43);
    expect(shareLinkFor(id, key)).toBe(`https://playground.snugprotocol.org/s/${id}#${key}`);
    expect(desktopLinkFor(id, key)).toBe(`snug://s/${id}#${key}`);
    expect(parseShareLink(shareLinkFor(id, key))).toEqual({ id, key });
    expect(parseShareLink(desktopLinkFor(id, key))).toEqual({ id, key });
    expect(parseShareLink(`snug://s/${id}`)).toBeUndefined();
    expect(parseShareLink(`snug://evil/${id}#${key}`)).toBeUndefined();
    expect(parseShareLink(`http://playground.snugprotocol.org/s/${id}#${key}`)).toBeUndefined();
  });
});

describe('receiveShareLink + SharedLinkView (AC20)', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    if (root !== undefined) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
  });

  function PathProbe({ onPath }: { onPath: (path: string) => void }): ReactElement {
    const location = useLocation();
    onPath(location.pathname);
    return <span />;
  }

  async function renderLink(entry: string): Promise<{ el: HTMLDivElement; path: () => string }> {
    const { SharedLinkView } = await import('../views/SharedLinkView.js');
    let current = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={[entry]}>
          <PathProbe onPath={(p) => (current = p)} />
          <Routes>
            <Route path="/s/:id" element={<SharedLinkView />} />
            <Route path="/run/:id" element={<span data-testid="preview-route" />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    return { el: container, path: () => current };
  }

  it('a good link lands the bundle on the shelf IN MEMORY, strips the fragment, and navigates to the preview', async () => {
    const sealed = await encryptBundle(new TextEncoder().encode(bundleText));
    const id = 'C'.repeat(22);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sealed.ciphertext as unknown as BodyInit, { status: 200 })));
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const { path } = await renderLink(`/s/${id}#${sealed.key}`);
    expect(path()).toMatch(/^\/run\/shared--[0-9a-f]{64}$/);
    expect(listSharedEntries()).toHaveLength(1);
    expect(listSharedEntries()[0]?.kept).toBe(false);
    expect(listSharedEntries()[0]?.link).toEqual({ id, key: sealed.key });
    expect(db.listSettingKeys().filter((k) => k.startsWith(SHARED_APP_SETTING_PREFIX))).toEqual([]);
    expect(replaceState).toHaveBeenCalled();
    const lastCall = replaceState.mock.calls.at(-1);
    expect(String(lastCall?.[2] ?? '')).not.toContain(sealed.key);
  });

  it('names gone / unreachable / bad-key / bad-link failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    let view = await renderLink(`/s/${'D'.repeat(22)}#${'k'.repeat(43)}`);
    expect(view.el.querySelector('[data-testid="shared-link-failure"]')?.getAttribute('data-reason')).toBe('gone');
    if (root !== undefined) act(() => root?.unmount());
    container?.remove();

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    view = await renderLink(`/s/${'D'.repeat(22)}#${'k'.repeat(43)}`);
    expect(view.el.querySelector('[data-testid="shared-link-failure"]')?.getAttribute('data-reason')).toBe('unreachable');
    if (root !== undefined) act(() => root?.unmount());
    container?.remove();

    const sealed = await encryptBundle(new TextEncoder().encode(bundleText));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sealed.ciphertext as unknown as BodyInit, { status: 200 })));
    view = await renderLink(`/s/${'D'.repeat(22)}#${'x'.repeat(43)}`);
    expect(view.el.querySelector('[data-testid="shared-link-failure"]')?.getAttribute('data-reason')).toBe('bad-key');
    if (root !== undefined) act(() => root?.unmount());
    container?.remove();

    view = await renderLink(`/s/${'D'.repeat(22)}`);
    expect(view.el.querySelector('[data-testid="shared-link-failure"]')?.getAttribute('data-reason')).toBe('bad-link');
    expect(listSharedEntries()).toEqual([]);
  });
});

describe('shareLinks — records split by sensitivity (AC22)', () => {
  it('the public record lives in settings, the token and key in secrets; a default export carries neither', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 'E'.repeat(22), expiresAt: '2099-10-04T00:00:00.000Z', revokeToken: 'T'.repeat(43) }), { status: 201 })),
    );
    try {
      const { mintShareLink, listShareLinks, linkForRecord, revokeShareLink } = await import('../share/shareLinks.js');
      const { prepareShare } = await import('../share/exportShare.js');
      const app = db.installApp({ displayName: 'Weather Wall', html: '<html>hi</html>' });
      const prepared = await prepareShare(app.appId, []);
      const { link, record } = await mintShareLink(app.appId, prepared);
      const key = link.split('#')[1]!;
      expect(db.getSetting(shareLinkSettingKey(app.appId, record.id))).toMatchObject({ id: record.id, expiresAt: record.expiresAt });
      expect(JSON.stringify(db.getSetting(shareLinkSettingKey(app.appId, record.id)))).not.toContain('T'.repeat(43));
      expect(db.getSecret(`share:${record.id}`)).toContain('T'.repeat(43));
      expect(db.getSecret(`share:${record.id}`)).toContain(key);
      // A DEFAULT export (secrets stripped) carries neither the token nor the key.
      const exported = await db.exportUserDb({ includeSecrets: false });
      const text = new TextDecoder('latin1').decode(exported);
      expect(text).not.toContain('T'.repeat(43));
      expect(text).not.toContain(key);
      expect(text).toContain(record.id); // the public record is fine to carry
      expect(listShareLinks(db, app.appId).map((r) => r.id)).toEqual([record.id]);
      expect(linkForRecord(db, record)).toBe(link);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
      expect(await revokeShareLink(app.appId, record.id)).toBe(true);
      expect(listShareLinks(db, app.appId)).toEqual([]);
      expect(db.getSecret(`share:${record.id}`)).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
