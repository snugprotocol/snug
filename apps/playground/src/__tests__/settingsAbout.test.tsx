// settingsAbout.test.tsx — TASK-20260823-legal-terms-privacy-eula AC5 (ADR-0055 §1).
//
// Settings → about is the "app" section grown up: on desktop it keeps the version,
// the manual update check and the auto-check toggle (ADR-0047 §9 — the existing
// test-ids are the contract downloadSurfaces/desktopSettingsView pin) and adds the
// legal links plus the EULA text rendered OFFLINE from legal/eula.ts (the playground
// never imports from apps/desktop, and a GitHub URL needs the network — review F2);
// on web it keeps the download pointer and carries the same links minus the EULA.
//
// Platform is set-once, so each case takes a fresh module registry (the
// desktopSettingsView.test.tsx harness).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SnugPlatform } from '../platform/platform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

async function fresh(platform?: SnugPlatform): Promise<void> {
  vi.resetModules();
  localStorage.clear();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  await helper.installTestUserDb();
  const view = await import('../views/SettingsView.js');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <view.SettingsView />
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const q = (sel: string): HTMLElement | null => container?.querySelector<HTMLElement>(sel) ?? null;

function desktop(): SnugPlatform {
  return {
    kind: 'desktop',
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    appUpdates: {
      currentVersion: async () => '0.1.0',
      check: async () => ({ available: false }),
      downloadAndInstall: async () => {},
      relaunch: async () => {},
    } as unknown as NonNullable<SnugPlatform['appUpdates']>,
  };
}

describe('Settings → about', () => {
  it('is the "about" section (renamed from "app" — the one deliberate label edit)', async () => {
    await fresh();
    expect(q('[data-testid="settings-section-about"]')).not.toBeNull();
    expect(q('[data-testid="settings-section-app"]')).toBeNull();
  });

  it('web: download pointer + terms, privacy, threat model, license; no EULA', async () => {
    await fresh();
    const about = q('[data-testid="settings-section-about"]')!;
    expect(about.querySelector('[data-testid="settings-get-desktop"]')).not.toBeNull();
    expect(about.querySelector('[data-testid="about-terms"]')?.getAttribute('href')).toContain('/terms');
    expect(about.querySelector('[data-testid="about-privacy"]')?.getAttribute('href')).toContain('/privacy');
    expect(about.querySelector<HTMLAnchorElement>('[data-testid="about-threat-model"]')?.href).toMatch(/threat-model\.md$/);
    expect(about.querySelector<HTMLAnchorElement>('[data-testid="about-license"]')?.href).toMatch(/LICENSE$/);
    expect(about.querySelector('[data-testid="about-eula"]')).toBeNull();
  });

  it('desktop: version, update controls (existing ids), the links, AND the EULA text offline', async () => {
    await fresh(desktop());
    const about = q('[data-testid="settings-section-about"]')!;
    expect(about.textContent).toContain('v0.1.0');
    expect(about.querySelector('[data-testid="settings-check-updates"]')).not.toBeNull();
    expect(about.querySelector('[data-testid="settings-auto-update-check"]')).not.toBeNull();
    expect(about.querySelector('[data-testid="about-terms"]')).not.toBeNull();
    expect(about.querySelector('[data-testid="about-privacy"]')).not.toBeNull();
    const eula = about.querySelector<HTMLDetailsElement>('[data-testid="about-eula"]');
    expect(eula, 'the EULA is on the page, not behind a URL').not.toBeNull();
    // Rendered from the constant — the exact words the installer showed.
    const { EULA_TEXT } = await import('../legal/eula.js');
    expect(eula?.textContent).toContain('Clicking Agree means you accept these terms.');
    expect(eula?.querySelector('pre')?.textContent).toBe(EULA_TEXT);
    expect(about.querySelector('[data-testid="settings-get-desktop"]')).toBeNull();
  });
});
