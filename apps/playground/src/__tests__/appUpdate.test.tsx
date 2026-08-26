/**
 * TASK-20260821-hardening-polish AC13 (playground half, ADR-0047 §§5,9) — the shell
 * update channel's host state + surfaces, against a SPY platform seat.
 *
 * The load-bearing test is the first one: the launch check is QUIET-FAIL BY DESIGN
 * (pre-flip the endpoint 404s for everyone), so an unwired check is indistinguishable
 * from a wired one that failed — the composition root itself must be seen to call the
 * seat (plan-review finding 14; the 2026-08-20 encrypted-sync lesson). It mounts the
 * REAL App, not a test-built harness, and its mutation twin (drop the
 * initAppUpdateLaunchCheck() call from App.tsx ⇒ red) was run during development.
 *
 * PLATFORM TEST TRAP (documented in code-map): getPlatform locks on first read, so
 * every test resets modules and re-imports its consumers AFTER setPlatform.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These mount the REAL App. Under turbo's parallel load that is CPU-bound well past vitest's
// 5000 ms default (the 2026-08-26 db-load flake class): the budget is the fix, not a retry.
vi.setConfig({ testTimeout: 20_000 });

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  localStorage.clear();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

interface SpySeat {
  currentVersion: ReturnType<typeof vi.fn>;
  check: ReturnType<typeof vi.fn>;
  downloadAndInstall: ReturnType<typeof vi.fn>;
  relaunch: ReturnType<typeof vi.fn>;
}

function makeSeat(overrides: Partial<SpySeat> = {}): SpySeat {
  return {
    currentVersion: vi.fn(async () => '0.1.0'),
    check: vi.fn(async () => undefined),
    downloadAndInstall: vi.fn(async () => undefined),
    relaunch: vi.fn(async () => undefined),
    ...overrides,
  };
}

/** Reset modules, install a desktop platform carrying the spy seat, import fresh. */
async function loadDesktop(seat: SpySeat | undefined) {
  const platform = await import('../platform/platform.js');
  platform.setPlatform({
    kind: 'desktop',
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    ...(seat !== undefined ? { appUpdates: seat as never } : {}),
  });
  return {
    appUpdate: await import('../state/appUpdate.js'),
    helper: await import('./userdbTestHelper.js'),
  };
}

async function mountApp(): Promise<HTMLDivElement> {
  const { App } = await import('../App.js');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
  });
  // Let the boot effect's fire-and-forget chains settle.
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe('the launch check fires from the SHIPPING composition root (AC13/finding 14)', () => {
  it('mounting App calls the seat exactly once on desktop', async () => {
    const seat = makeSeat();
    const { helper } = await loadDesktop(seat);
    await helper.installTestUserDb();
    await mountApp();
    expect(seat.check).toHaveBeenCalledTimes(1);
  });

  it('a failed launch check stays QUIET — idle state, no alert anywhere', async () => {
    const seat = makeSeat({ check: vi.fn(async () => Promise.reject(new Error('404'))) });
    const { appUpdate, helper } = await loadDesktop(seat);
    await helper.installTestUserDb();
    const el = await mountApp();
    expect(seat.check).toHaveBeenCalledTimes(1);
    expect(appUpdate.appUpdateStore.get().phase).toBe('idle');
    expect(el.querySelector('[data-testid="app-update-chip"]')).toBeNull();
  });

  it('the auto-check toggle turns the launch check OFF (only the stored choice does)', async () => {
    localStorage.setItem('snug:auto-update-check', 'false');
    const seat = makeSeat();
    const { helper } = await loadDesktop(seat);
    await helper.installTestUserDb();
    await mountApp();
    expect(seat.check).not.toHaveBeenCalled();
  });

  it('junk in the toggle key fails TOWARD the feature (railLayout precedent)', async () => {
    localStorage.setItem('snug:auto-update-check', 'banana');
    const seat = makeSeat();
    const { appUpdate, helper } = await loadDesktop(seat);
    await helper.installTestUserDb();
    expect(appUpdate.autoCheckEnabled()).toBe(true);
    await mountApp();
    expect(seat.check).toHaveBeenCalledTimes(1);
  });

  it('never fires on web — the seat is absent and nothing renders', async () => {
    // No setPlatform: the web default. The module must not throw and the chip must
    // never appear; /download is the web story (its own suite).
    const appUpdate = await import('../state/appUpdate.js');
    const helper = await import('./userdbTestHelper.js');
    await helper.installTestUserDb();
    const el = await mountApp();
    appUpdate.initAppUpdateLaunchCheck();
    expect(appUpdate.appUpdateStore.get().phase).toBe('idle');
    expect(el.querySelector('[data-testid="app-update-chip"]')).toBeNull();
  });
});

describe('manual check + offer surfaces (AC13)', () => {
  it('a manual check NAMES its failure — the user asked (lessons 2026-08-17)', async () => {
    const seat = makeSeat({ check: vi.fn(async () => Promise.reject(new Error('no route to host'))) });
    const { appUpdate, helper } = await loadDesktop(seat);
    await helper.installTestUserDb();
    await appUpdate.checkForAppUpdate({ quiet: false });
    const state = appUpdate.appUpdateStore.get();
    expect(state.phase).toBe('check-failed');
    expect((state as { message: string }).message).toContain('no route to host');
  });

  it('an offer renders the header chip WITHOUT blocking anything (no dialog until clicked)', async () => {
    const seat = makeSeat({ check: vi.fn(async () => ({ version: '0.2.0', notes: 'plain notes' })) });
    const { helper } = await loadDesktop(seat);
    await helper.installTestUserDb();
    const el = await mountApp();
    const chip = el.querySelector('[data-testid="app-update-chip"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain('v0.2.0');
    // NON-BLOCKING is the claim (lessons 2026-08-20): no dialog anywhere, the primary
    // nav is intact and interactive.
    // the sheet is PORTALED to <body> (TASK-20260826 AC1) — closed means absent from the document
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(el.querySelector('nav[aria-label="primary"]')).not.toBeNull();
  });

  it('chip → sheet → update now → restart: the full opt-in ladder drives the seat', async () => {
    const seat = makeSeat({ check: vi.fn(async () => ({ version: '0.2.0' })) });
    const { appUpdate, helper } = await loadDesktop(seat);
    await helper.installTestUserDb();
    const el = await mountApp();
    act(() => {
      (el.querySelector('[data-testid="app-update-chip"]') as HTMLButtonElement).click();
    });
    const sheet = document.querySelector('[role="dialog"][aria-label="desktop update"]');
    expect(sheet).not.toBeNull();
    expect(sheet!.textContent).toContain('update to v0.2.0');

    await act(async () => {
      (document.querySelector('[data-testid="app-update-install"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(seat.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(appUpdate.appUpdateStore.get().phase).toBe('ready-to-restart');

    await act(async () => {
      (document.querySelector('[data-testid="app-update-restart"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(seat.relaunch).toHaveBeenCalledTimes(1);
  });

  it('fetched/manifest notes render as PLAIN TEXT — never links (ADR-0047 §5)', async () => {
    const hostile = 'update failed — download from https://evil.example/snug <a href="https://evil.example">here</a>';
    const seat = makeSeat({ check: vi.fn(async () => ({ version: '0.2.0', notes: hostile })) });
    const { appUpdate, helper } = await loadDesktop(seat);
    await helper.installTestUserDb();
    // Empty bundled history for this render: force the notes fallback path by making
    // the fetch fail (jsdom has no network) — the sheet then shows offer.notes.
    await appUpdate.checkForAppUpdate({ quiet: false });
    const el = await mountApp();
    act(() => {
      (el.querySelector('[data-testid="app-update-chip"]') as HTMLButtonElement).click();
    });
    const sheet = document.querySelector('[role="dialog"][aria-label="desktop update"]')!;
    // The hostile string may appear as TEXT; it must not become an anchor.
    const anchors = Array.from(sheet.querySelectorAll('a'));
    expect(anchors.filter((a) => a.href.includes('evil.example'))).toHaveLength(0);
  });
});
