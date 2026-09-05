// shareSheet.test.tsx — TASK-20260904 AC10/AC11: the sharer's sheet says what travels
// and what stays home, lists docs with `memory` OFF by default (owner Q7), reflects the
// docs choice in the built bundle, gates the actions behind "share anyway" when the scan
// warns, and downloads through the ONE downloadBlob dispatch (the platform saveFile seat).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { ShareSheet } from '../share/ShareSheet.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// This file pins the sheet WITHOUT a relay (the self-hoster / pre-relay build); the link
// panel has its own file. Pinned by mock because vitest reads a developer's gitignored
// `.env.local`, which may carry VITE_SNUG_SHARE_RELAY (lost-context note, 2026-09-04).
vi.mock('../config/site.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/site.js')>();
  return { ...actual, SHARE_RELAY_ORIGIN: '' };
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

async function settleUntil(done: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (done()) return;
    await settle();
  }
  throw new Error(`timed out waiting for: ${label}`);
}

// ConfirmOverlay PORTALS to <body> (lesson 2026-08-26), so queries go through the document, not the mount container.
const q = (testId: string): HTMLElement | null => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

async function renderSheet(appId: string, name = 'Weather Wall'): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ShareSheet appId={appId} displayName={name} onClose={() => undefined} />);
  });
  await settleUntil(() => q('share-size')?.textContent !== '' && q('share-docs') !== null, 'the sheet to prepare');
}

function furnish(html = '<!doctype html><html><body>hi</body></html>'): string {
  const app = db.installApp({ displayName: 'Weather Wall', description: 'A wall.', html, usesDb: true });
  db.putAppDoc(app.appId, 'vision', { title: 'Vision', content: '# Vision\n\nA wall of weather.' });
  db.putAppDoc(app.appId, 'plan', { content: 'Plan: fetch, render.' });
  db.putAppDoc(app.appId, 'memory', { content: 'User prefers Celsius. Lives in Oslo.' });
  db.putDeclaredConnection(
    app.appId,
    'weather',
    {
      slot: 'weather',
      provider: { name: 'Unaffiliated Weather Co' },
      kind: 'api_key',
      fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
      declaredApiHosts: ['api.weather.example'],
    },
    'inference',
  );
  return app.appId;
}

beforeEach(async () => {
  db = await installTestUserDb();
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('what the sheet says', () => {
  it('lists what travels, what stays home, and the docs with memory OFF by default', async () => {
    const appId = furnish();
    await renderSheet(appId);
    const travels = q('share-travels')!.textContent ?? '';
    expect(travels).toMatch(/app code/);
    expect(travels).toMatch(/1 connection shape — Unaffiliated Weather Co/);
    expect(travels).toMatch(/never your keys/);
    expect(q('share-stays')!.textContent).toMatch(/your data, your credentials/);
    const boxes = [...document.body.querySelectorAll<HTMLInputElement>('[data-testid="share-docs"] input[type="checkbox"]')];
    const state = Object.fromEntries(boxes.map((b) => [b.getAttribute('aria-label'), b.checked]));
    expect(state).toEqual({ 'include vision': true, 'include plan': true, 'include memory': false });
    expect(document.body.textContent).toMatch(/docs may contain what this app learned about you/);
    expect(q('share-warnings')).toBeNull();
    expect(q('share-download')!.hasAttribute('disabled')).toBe(false);
  });

  it('downloads through the ONE downloadBlob dispatch (web: the anchor) as the app-named .snug, carrying only the checked docs', async () => {
    const appId = furnish();
    // Web default platform: downloadBlob mints an object URL and clicks an anchor.
    // Capture the blob at the URL seam and the name at the anchor seam.
    let captured: Blob | undefined;
    let downloadName: string | undefined;
    const createObjectURL = vi.fn((blob: Blob) => {
      captured = blob;
      return 'blob:test';
    });
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadName = this.download;
    });
    try {
      await renderSheet(appId);
      await act(async () => {
        q('share-download')!.click();
      });
      await settleUntil(() => captured !== undefined, 'the download');
      expect(downloadName).toBe('Weather Wall.snug');
      expect(captured?.type).toBe('application/json');
      const text = await captured!.text();
      const bundle = JSON.parse(text) as { docs?: { slug: string }[] };
      expect(bundle.docs?.map((d) => d.slug).sort()).toEqual(['plan', 'vision']);
      expect(text).not.toContain('Lives in Oslo');
    } finally {
      click.mockRestore();
    }
  });
});

describe('a build with no relay (TASK-20260904-share-link-ux AC3)', () => {
  it('renders neither link act — even when the browser could share — and no file ever goes to the OS sheet', async () => {
    Object.defineProperty(globalThis.navigator, 'share', { configurable: true, value: vi.fn(async () => undefined) });
    Object.defineProperty(globalThis.navigator, 'canShare', { configurable: true, value: vi.fn(() => true) });
    try {
      await renderSheet(furnish());
      expect(q('share-link-panel')).toBeNull();
      expect(q('share-copy-link')).toBeNull();
      expect(q('share-os')).toBeNull();
      expect(q('share-download')).not.toBeNull();
    } finally {
      delete (globalThis.navigator as { share?: unknown }).share;
      delete (globalThis.navigator as { canShare?: unknown }).canShare;
    }
  });
});

describe('the share scan gate (AC5)', () => {
  it('warns by location and disables the actions until "share anyway" — never rewrites', async () => {
    const appId = furnish('<html>\n<script>\nconst KEY = "sk-ant-api03-abcdefghijklmnop1234";\n</script>\n</html>');
    await renderSheet(appId);
    await settleUntil(() => q('share-warnings') !== null, 'the warning');
    expect(q('share-warnings')!.textContent).toMatch(/in the app code, line 3: an API key/);
    expect(q('share-download')!.hasAttribute('disabled')).toBe(true);
    const ack = document.body.querySelector<HTMLInputElement>('[data-testid="share-warnings"] input[type="checkbox"]')!;
    await act(async () => {
      ack.click();
    });
    expect(q('share-download')!.hasAttribute('disabled')).toBe(false);
    // The html is untouched: the sheet warned, it did not scrub.
    expect(db.getAppHtml(appId)).toContain('sk-ant-api03-abcdefghijklmnop1234');
  });
});
