/**
 * TASK-20260821-hardening-polish AC12 + the Settings halves of AC13 (ADR-0047).
 *
 * The /download page and the Settings "app" card, platform-gated BOTH WAYS: web gets
 * the download story (button → the single-homed DMG URL, the honest Gatekeeper
 * paragraph while builds are unsigned, the bundled release notes); desktop gets the
 * version + update controls and NO download button. Same platform test trap as
 * appUpdate.test.tsx: reset modules, setPlatform, then import consumers.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
});

async function renderEl(element: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<MemoryRouter>{element}</MemoryRouter>);
  });
  return container;
}

async function setDesktop(appUpdates?: object): Promise<void> {
  const platform = await import('../platform/platform.js');
  platform.setPlatform({
    kind: 'desktop',
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    ...(appUpdates !== undefined ? { appUpdates: appUpdates as never } : {}),
  });
}

describe('the /download page (AC12)', () => {
  it('web: the DMG button carries the single-homed URL, beside the Gatekeeper truth and the bundled notes', async () => {
    const { DownloadView } = await import('../views/DownloadView.js');
    const { DESKTOP_DOWNLOAD_URL } = await import('../desktop/releaseChannel.js');
    const { newestBundledRelease } = await import('../desktop/desktopReleases.js');
    const el = await renderEl(<DownloadView />);

    const button = el.querySelector<HTMLAnchorElement>('[data-testid="download-dmg"]');
    expect(button).not.toBeNull();
    expect(button!.getAttribute('href')).toBe(DESKTOP_DOWNLOAD_URL);
    // Every github.com link opens in a new tab (owner call, 2026-08-23): pre-flip
    // these 404 anonymously, and a same-tab 404 would navigate the playground away.
    expect(button!.getAttribute('target')).toBe('_blank');
    expect(button!.getAttribute('rel')).toContain('noreferrer');
    const releasesLink = Array.from(el.querySelectorAll('a')).find((a) =>
      (a.getAttribute('href') ?? '').includes('/releases'),
    );
    expect(releasesLink).toBeDefined();
    expect(releasesLink!.getAttribute('target')).toBe('_blank');
    expect(releasesLink!.getAttribute('rel')).toContain('noreferrer');

    // The version on the button is the BUNDLED newest release — this build's own
    // trusted copy, no fetch (ADR-0047 §5).
    const release = newestBundledRelease();
    expect(release).toBeDefined();
    expect(button!.textContent).toContain(`v${release!.version}`);

    // Builds are signed + notarized since v0.1.0 (TASK-20260824, ADR-0047 §7
    // amendment), so the right-click → Open disclosure is GONE — and its absence is
    // now the contract. Asserting absence rather than deleting the assertion keeps
    // the page honest in the other direction too: if anyone reinstates the paragraph
    // while builds are notarized, the page would be telling users to practise the
    // exact habit that makes them vulnerable to unsigned software.
    expect(el.querySelector('[data-testid="gatekeeper-note"]')).toBeNull();

    // macOS-only is stated, not implied (ADR-0021 D8).
    expect(el.textContent!.toLowerCase()).toContain('macos only');

    // The Tesla-style notes render from the bundled history.
    const notes = el.querySelector('[data-testid="download-release-notes"]');
    expect(notes).not.toBeNull();
    expect(notes!.textContent).toContain(release!.sections[0]!.items[0]!);
  });

  it('desktop: no download button — the page says updates arrive in-app', async () => {
    await setDesktop({ currentVersion: async () => '0.1.0', check: async () => undefined });
    const { DownloadView } = await import('../views/DownloadView.js');
    const el = await renderEl(<DownloadView />);
    expect(el.querySelector('[data-testid="download-page-desktop"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="download-dmg"]')).toBeNull();
  });
});

describe('the Settings app card (AC13/AC16 surfaces)', () => {
  it('web: a pointer to /download, no update controls', async () => {
    const helper = await import('./userdbTestHelper.js');
    await helper.installTestUserDb();
    const { SettingsView } = await import('../views/SettingsView.js');
    const el = await renderEl(<SettingsView />);
    const link = el.querySelector<HTMLAnchorElement>('[data-testid="settings-get-desktop"]');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/download');
    expect(el.querySelector('[data-testid="settings-check-updates"]')).toBeNull();
  });

  it('desktop: version renders, a manual check NAMES its failure, and the auto-check toggle persists', async () => {
    const check = vi.fn(async () => Promise.reject(new Error('could not reach github.com')));
    await setDesktop({ currentVersion: async () => '0.1.0', check });
    const appUpdate = await import('../state/appUpdate.js');
    appUpdate.__resetAppUpdateForTests();
    const helper = await import('./userdbTestHelper.js');
    await helper.installTestUserDb();
    const { SettingsView } = await import('../views/SettingsView.js');
    const el = await renderEl(<SettingsView />);

    // Version line (async currentVersion → settle a beat).
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.textContent).toContain('v0.1.0');

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="settings-check-updates"]')!.click();
      await Promise.resolve();
    });
    expect(check).toHaveBeenCalledTimes(1);
    const failure = el.querySelector('[data-testid="settings-check-failed"]');
    expect(failure, 'the manual check must name its failure (lessons 2026-08-17)').not.toBeNull();
    expect(failure!.textContent).toContain('could not reach github.com');

    const toggle = el.querySelector<HTMLInputElement>('[data-testid="settings-auto-update-check"]')!;
    expect(toggle.checked).toBe(true);
    act(() => {
      toggle.click();
    });
    expect(localStorage.getItem('snug:auto-update-check')).toBe('false');
    expect(appUpdate.autoCheckEnabled()).toBe(false);
  });
});
