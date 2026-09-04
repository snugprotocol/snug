// sharedSurfaces.test.tsx — TASK-20260904-app-sharing AC12/AC13/AC15/AC16/AC17 rendered.
//
//   • the hub's "shared with you" section renders ONLY when the shelf is non-empty, sits
//     between "your apps" and "starter apps", and its cards are text nodes even for a
//     hostile bundle (every string is `<img onerror>`);
//   • the shared preview route shows install + "run with AI" (off, aria-pressed=false),
//     the disclosure, the docs tab with the contract as text, and NO chat tab; the frame
//     it mounts is keyed to the un-armed preview until the toggle flips;
//   • install from the preview lands the app and navigates to it;
//   • the Settings "add shared app" picker and the whole-file importer sniff and point at
//     each other on a mismatch;
//   • the platform open dispatch routes a bundle to the shelf and never to importUserFile.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_BUNDLE_FORMAT } from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';

import RunView from '../run/RunView.js';
import { HubView } from '../views/HubView.js';
import { SettingsView } from '../views/SettingsView.js';
import { modeStore } from '../state/mode.js';
import { __resetSharedInboxForTests, listSharedEntries, receiveSharedBundle, sharedOpenRequestStore, sharedRouteIdFor } from '../share/sharedInbox.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const LINEAGE = '0b6e5a1c-8d5e-4f13-9a2b-7c1d2e3f4a5b';
const HOSTILE = '<img src=x onerror="document.body.dataset.pwned=1">';

function bundleText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: APP_BUNDLE_FORMAT,
    lineage: LINEAGE,
    sharedAt: '2026-09-04T01:00:00.000Z',
    app: { displayName: 'Weather Wall', description: 'A wall of weather.', iconEmoji: '🌦', usesDb: false },
    html: '<!doctype html><html><body>hi</body></html>',
    contract: { overview: 'You summarize the forecast in one sentence.' },
    docs: [{ slug: 'vision', title: 'Vision', content: '# Vision\n\nA wall.' }],
    connections: [
      {
        slot: 'weather',
        provider: { name: 'Unaffiliated Weather Co' },
        kind: 'api_key',
        fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
        declaredApiHosts: ['api.weather.example'],
      },
    ],
    ...overrides,
  });
}

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

function PathProbe({ onPath }: { onPath: (path: string) => void }): ReactElement {
  const location = useLocation();
  onPath(location.pathname);
  return <span />;
}

function mount(element: Parameters<Root['render']>[0]): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

function unmountCurrent(): void {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
}

async function renderHub(): Promise<HTMLDivElement> {
  const el = mount(
    <MemoryRouter initialEntries={['/']}>
      <HubView />
    </MemoryRouter>,
  );
  await settle();
  return el;
}

async function renderRun(id: string): Promise<{ el: HTMLDivElement; path: () => string }> {
  let current = `/run/${id}`;
  const el = mount(
    <MemoryRouter initialEntries={[`/run/${id}`]}>
      <PathProbe onPath={(p) => (current = p)} />
      <Routes>
        <Route path="/run/:id" element={<RunView />} />
      </Routes>
    </MemoryRouter>,
  );
  await settle();
  return { el, path: () => current };
}

const q = (el: ParentNode, testId: string): HTMLElement | null => el.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

beforeEach(async () => {
  modeStore.set('byok');
  db = await installTestUserDb();
  __resetSharedInboxForTests();
  delete document.body.dataset['pwned'];
});

afterEach(() => {
  unmountCurrent();
  sharedOpenRequestStore.set(null);
});

describe('the hub shelf (AC12)', () => {
  it('renders no "shared with you" section while the shelf is empty', async () => {
    const el = await renderHub();
    const titles = [...el.querySelectorAll('.section-title')].map((h) => h.textContent);
    expect(titles).toEqual(['your apps', 'starter apps']);
  });

  it('renders the section between "your apps" and "starter apps" with a shared card, and dismiss removes it', async () => {
    await receiveSharedBundle(bundleText(), { source: 'file', persist: true });
    const el = await renderHub();
    const titles = [...el.querySelectorAll('.section-title')].map((h) => h.textContent);
    expect(titles).toEqual(['your apps', 'shared with you', 'starter apps']);
    const tile = q(el, 'shared-tile');
    expect(tile).not.toBeNull();
    expect(tile!.getAttribute('data-shared-name')).toBe('Weather Wall');
    expect(q(el, 'shared-badge')?.textContent).toBe('shared');
    expect(q(el, 'shared-open-card')?.getAttribute('aria-label')).toBe('open Weather Wall');
    await act(async () => {
      q(el, 'shared-dismiss')!.click();
    });
    await settleUntil(() => q(el, 'shared-tile') === null, 'the tile to be dismissed');
    expect(listSharedEntries()).toEqual([]);
  });

  it('(N, AC16) a hostile bundle renders as TEXT — no markup from it reaches the DOM', async () => {
    await receiveSharedBundle(
      bundleText({
        app: { displayName: HOSTILE, description: HOSTILE, iconEmoji: '<b>', usesDb: false },
        docs: [{ slug: 'vision', title: HOSTILE, content: HOSTILE }],
      }),
      { source: 'file', persist: true },
    );
    const el = await renderHub();
    const tile = q(el, 'shared-tile')!;
    expect(tile.querySelector('img')).toBeNull();
    expect(tile.querySelector('b')).toBeNull();
    expect(tile.textContent).toContain('<img src=x onerror=');
    expect(document.body.dataset['pwned']).toBeUndefined();
  });
});

describe('the shared preview route (AC13)', () => {
  async function shelfId(): Promise<string> {
    const received = await receiveSharedBundle(bundleText(), { source: 'file', persist: true });
    if (!received.ok) throw new Error('receive failed');
    return received.entry.bundleId;
  }

  it('offers install and an un-armed "run with AI", states the disclosure, and has no chat tab', async () => {
    const bundleId = await shelfId();
    const { el } = await renderRun(sharedRouteIdFor(bundleId));
    await settleUntil(() => q(el, 'shared-install') !== null, 'the install button');
    expect(q(el, 'shared-install')?.textContent).toBe('install');
    const toggle = q(el, 'shared-run-with-ai');
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute('aria-pressed')).toBe('false');
    expect(q(el, 'shared-preview-disclosure')?.textContent).toContain('nothing is saved until you install');
    expect(q(el, 'shared-preview-disclosure')?.textContent).toContain('Unaffiliated Weather Co');
    // No chat tab: the rail tab strip names inspector + docs only.
    const tabs = [...el.querySelectorAll('[role="group"][aria-label="rail tabs"] button')].map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(tabs.join(' ')).not.toMatch(/chat/i);
    expect(tabs.join(' ')).toMatch(/docs/i);
    // Nothing owned: no share control, no model select, no connections door.
    expect(q(el, 'share-app')).toBeNull();
    expect(q(el, 'app-model-select')).toBeNull();
    expect(q(el, 'manage-connections')).toBeNull();
  });

  it('the docs tab shows the bundle docs and the contract as text', async () => {
    const bundleId = await shelfId();
    const { el } = await renderRun(sharedRouteIdFor(bundleId));
    await settleUntil(() => q(el, 'shared-docs') !== null || q(el, 'shared-install') !== null, 'the preview');
    // The preview opens on docs.
    await settleUntil(() => q(el, 'shared-docs') !== null, 'the docs panel');
    expect(q(el, 'shared-contract')?.textContent).toContain('You summarize the forecast');
    expect(q(el, 'shared-doc-vision')?.textContent).toContain('A wall.');
    expect(el.querySelector('[data-testid="shared-docs"] img')).toBeNull();
  });

  it('the frame is keyed to the un-armed preview until "run with AI" flips it (the consent gate)', async () => {
    const bundleId = await shelfId();
    const { el } = await renderRun(sharedRouteIdFor(bundleId));
    await settleUntil(() => q(el, 'shared-run-with-ai') !== null, 'the toggle');
    const before = el.querySelector('iframe');
    await act(async () => {
      q(el, 'shared-run-with-ai')!.click();
    });
    await settle();
    expect(q(el, 'shared-run-with-ai')!.getAttribute('aria-pressed')).toBe('true');
    const after = el.querySelector('iframe');
    // A remount: the host captures its transport at mount, so arming must produce a new frame.
    expect(after).not.toBe(before);
  });

  it('install lands the app under share:<lineage>, declares the connection as shared, and navigates to the copy', async () => {
    const bundleId = await shelfId();
    const { el, path } = await renderRun(sharedRouteIdFor(bundleId));
    await settleUntil(() => q(el, 'shared-install') !== null, 'the install button');
    await act(async () => {
      q(el, 'shared-install')!.click();
    });
    await settleUntil(() => db.getAppByInstallSource(`share:${LINEAGE}`) !== undefined, 'the install to land');
    const app = db.getAppByInstallSource(`share:${LINEAGE}`)!;
    await settleUntil(() => path() === `/run/${app.appId}`, 'navigation to the installed copy');
    expect(db.getAppHtml(app.appId)).toContain('hi');
    const rows = db.listConnections(app.appId);
    expect(rows.map((r) => [r.slot, r.status, r.provenance])).toEqual([['weather', 'declared', 'shared']]);
    expect(db.getAppDoc(app.appId, 'vision')?.content).toContain('A wall.');
    expect(listSharedEntries()).toEqual([]);
  });

  it('a route for a bundle that is not on the shelf says so instead of rendering a blank', async () => {
    const { el } = await renderRun(sharedRouteIdFor('a'.repeat(64)));
    await settleUntil(() => q(el, 'shared-preview-disclosure') !== null, 'the disclosure');
    expect(q(el, 'shared-preview-disclosure')?.textContent).toContain('no longer on your shelf');
    expect(q(el, 'shared-install')).toBeNull();
  });
});

describe('Settings — add shared app + the mutual sniff (AC15)', () => {
  function pickFile(el: HTMLElement, label: RegExp, file: File): void {
    const labelEl = [...el.querySelectorAll('label.file-btn')].find((l) => label.test(l.textContent ?? ''));
    if (labelEl === undefined) throw new Error(`no picker labelled ${String(label)}`);
    const input = labelEl.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  async function renderSettings(): Promise<HTMLDivElement> {
    const el = mount(
      <MemoryRouter initialEntries={['/settings']}>
        <SettingsView />
      </MemoryRouter>,
    );
    await settle();
    return el;
  }

  it('a bundle handed to "add shared app" lands on the shelf and asks to open the preview', async () => {
    const el = await renderSettings();
    pickFile(el, /add shared app/, new File([bundleText()], 'weather.snug', { type: 'application/json' }));
    await settleUntil(() => listSharedEntries().length === 1, 'the shelf entry');
    expect(listSharedEntries()[0]?.kept).toBe(true);
    expect(sharedOpenRequestStore.get()).toBe(listSharedEntries()[0]?.bundleId);
  });

  it('a USER FILE handed to "add shared app" is refused with a pointer to the other button, and never touches the shelf', async () => {
    const el = await renderSettings();
    const sqlite = new Uint8Array(200);
    sqlite.set(new TextEncoder().encode('SQLite format 3\0'));
    pickFile(el, /add shared app/, new File([sqlite], 'snug-user.snug'));
    await settleUntil(() => (el.querySelector('.error-note')?.textContent ?? '').includes('whole snug file'), 'the refusal');
    expect(listSharedEntries()).toEqual([]);
  });

  it('(N) a BUNDLE handed to "import snug file" goes to the shelf, never to importUserFile', async () => {
    const before = db.listApps().length;
    const el = await renderSettings();
    pickFile(el, /^import snug file/, new File([bundleText()], 'weather.snug'));
    await settleUntil(() => listSharedEntries().length === 1, 'the shelf entry');
    await settleUntil(() => (el.querySelector('.error-note')?.textContent ?? '').includes('shared app'), 'the note');
    expect(db.listApps().length).toBe(before);
  });
});

describe('the platform open dispatch (AC17)', () => {
  it('routes a bundle to the shelf and never calls the user-file confirm', async () => {
    const openFile = await import('../platform/openFile.js');
    const confirm = vi.fn(async () => true);
    await openFile.dispatchOpenedSnugFile(new TextEncoder().encode(bundleText()), '/Users/x/weather.snug', confirm);
    expect(confirm).not.toHaveBeenCalled();
    expect(listSharedEntries()).toHaveLength(1);
    expect(listSharedEntries()[0]?.kept).toBe(true);
    expect(sharedOpenRequestStore.get()).toBe(listSharedEntries()[0]?.bundleId);
    expect(db.listApps()).toEqual([]);
  });

  it('routes SQLite bytes to the user-file confirm and never to the shelf', async () => {
    const openFile = await import('../platform/openFile.js');
    const confirm = vi.fn(async () => false);
    const sqlite = new Uint8Array(200);
    sqlite.set(new TextEncoder().encode('SQLite format 3\0'));
    await openFile.dispatchOpenedSnugFile(sqlite, '/Users/x/user.snug', confirm);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(listSharedEntries()).toEqual([]);
  });

  it('a refused bundle reaches the banner store rather than vanishing', async () => {
    const openFile = await import('../platform/openFile.js');
    await openFile.dispatchOpenedSnugFile(new TextEncoder().encode('{"hello":1}'), '/Users/x/thing.snug', async () => true);
    expect(openFile.openUserFileErrorStore.get()).toMatch(/not a Snug user file or a shared app/);
  });
});
