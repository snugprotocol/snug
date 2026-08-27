/**
 * TASK-20260826-helper-bundle-update-sheet AC1–AC2 — the update sheet shows ONLY entries
 * newer than the installed version, and its card cannot be clipped by the window.
 *
 * Owner report (2026-08-26): on a v0.1.0 install offered v0.1.1, the sheet showed v0.1.0's
 * own "Good to know" ("macOS only through 1.0 — the Windows WebView…") beneath the new
 * entry — the bundled history rendered as if it were news — and the card's top was cut off
 * at the window's minimum height. Owner decision: only newer-than-installed entries.
 *
 * PLATFORM TEST TRAP: getPlatform locks on first read — reset modules, set the platform,
 * then import consumers.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../theme/app.css'), 'utf8');

function rule(selector: string): string {
  const match = css.match(new RegExp(`(^|\\n)${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`));
  if (match === null) throw new Error(`no ${selector} rule in app.css`);
  return match[2];
}

const WINDOWS_LINE = 'the Windows WebView cannot yet hold';
const NOTES = JSON.stringify({
  releases: [
    {
      version: '0.1.1',
      date: '2026-08-26',
      title: 'Newer',
      sections: [{ title: "What's new", items: ['a brain chip in the header'] }],
    },
    {
      version: '0.1.0',
      date: '2026-08-21',
      title: 'First release',
      sections: [{ title: 'Good to know', items: [`macOS only through 1.0 — ${WINDOWS_LINE} our promise.`] }],
    },
  ],
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(() => vi.resetModules());
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.restoreAllMocks();
});

async function mountSheet(opts: { current: string; offer: string; fetchOk: boolean }) {
  const platform = await import('../platform/platform.js');
  platform.setPlatform({
    kind: 'desktop',
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    appUpdates: {
      currentVersion: async () => opts.current,
      check: async () => undefined,
      downloadAndInstall: async () => undefined,
      relaunch: async () => undefined,
    } as never,
    fetchImpl: (async () =>
      opts.fetchOk
        ? new Response(NOTES, { status: 200 })
        : new Response('nope', { status: 404 })) as never,
  });
  const { appUpdateStore } = await import('../state/appUpdate.js');
  appUpdateStore.set({ phase: 'available', offer: { version: opts.offer, notes: 'manifest notes text' } });
  const { AppUpdateSheet } = await import('../desktop/AppUpdateControls.js');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AppUpdateSheet onClose={() => {}} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  // The sheet is PORTALED to <body>; `container` holds only the mount point. Readers query
  // the dialog itself (and the portal test below asserts the container does NOT hold it).
  return document.querySelector<HTMLElement>('[role="dialog"][aria-label="desktop update"]') ?? container;
}

describe('update sheet — only newer-than-installed entries (AC2)', () => {
  it('on v0.1.0 offered v0.1.1 with fetched notes: shows v0.1.1, never v0.1.0 history', async () => {
    const el = await mountSheet({ current: '0.1.0', offer: '0.1.1', fetchOk: true });
    expect(el.querySelector('[data-testid="app-release-new-v0.1.1"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="app-release-installed-v0.1.0"]')).toBeNull();
    expect(el.textContent).toContain('a brain chip');
    expect(el.textContent).not.toContain(WINDOWS_LINE);
    expect(el.textContent).not.toContain('First release');
  });

  it('when the fetch fails: falls back to BUNDLED entries newer than the installed version only', async () => {
    const el = await mountSheet({ current: '0.1.0', offer: '0.1.1', fetchOk: false });
    // The bundled file (this build's own copy) carries 0.1.0 history — it must stay hidden.
    expect(el.textContent).not.toContain(WINDOWS_LINE);
    expect(el.querySelector('[data-testid="app-release-installed-v0.1.0"]')).toBeNull();
    expect(el.querySelector('[data-testid="app-release-new-v0.1.1"]')).not.toBeNull();
  });

  it('with nothing newer known: shows the manifest notes as the honest fallback', async () => {
    // `current` must be >= the newest BUNDLED entry, or the bundled fallback legitimately
    // has something to show. Kept far ahead deliberately so landing a new release entry in
    // desktop-releases.json never silently re-points this case (it did, at v0.1.2).
    const el = await mountSheet({ current: '99.0.0', offer: '99.0.1', fetchOk: false });
    expect(el.textContent).toContain('manifest notes text');
    expect(el.textContent).not.toContain(WINDOWS_LINE);
  });
});

describe('update sheet — the card fits the window (AC1)', () => {
  it('is PORTALED out of the header: a backdrop-filter ancestor must never become its containing block', async () => {
    // The real bug: mounted inside `.shell-header` (backdrop-filter ⇒ containing block for
    // fixed descendants), the overlay's inset:0 meant the header's box and the card clipped.
    await mountSheet({ current: '0.1.0', offer: '0.1.1', fetchOk: true });
    const dialog = document.querySelector('[role="dialog"][aria-label="desktop update"]');
    expect(dialog).not.toBeNull();
    expect(container!.contains(dialog)).toBe(false);
    expect(dialog!.parentElement).toBe(document.body);
  });

  it('the card is border-box and capped below the viewport, and the overlay scrolls', () => {
    const card = rule('.release-notes-card');
    expect(card).toMatch(/box-sizing:\s*border-box/);
    expect(card).toMatch(/max-height:\s*calc\(100vh\s*-/);
    expect(card).not.toMatch(/max-height:\s*80vh/);
    expect(rule('.net-confirm-overlay')).toMatch(/overflow-y:\s*auto/);
    expect(rule('.net-confirm-actions')).toMatch(/flex-shrink:\s*0/);
  });
});
