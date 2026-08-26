/**
 * TASK-20260826 AC8–AC10 (ADR-0060 §§3,6,9) — the on-demand helper download's host state
 * and its consent card, against a SPY platform seat.
 *
 * The load-bearing claims: (1) nothing downloads without a click; (2) the click names the
 * size before it happens and joins an in-flight install rather than starting a rival;
 * (3) a missing helper reaches the pairing screen as the CARD, never as the Rust prose;
 * (4) web (no seat) renders nothing at all.
 *
 * PLATFORM TEST TRAP: getPlatform locks on first read — reset modules, set, then import.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HelperStatusSeat, SnugPlatform } from '../platform/platform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ABSENT: HelperStatusSeat = {
  name: 'whatsapp-sidecar',
  installed: false,
  kind: 'absent',
  requiredVersion: '0.1.0',
  mismatch: false,
  arch: 'aarch64',
  downloadBytes: 42_781_469,
  unpackedBytes: 142_348_572,
  linkedSessionOnDisk: false,
};
const INSTALLED: HelperStatusSeat = { ...ABSENT, installed: true, kind: 'downloaded', installedVersion: '0.1.0' };

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

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function desktop(overrides: Partial<SnugPlatform>): SnugPlatform {
  return {
    kind: 'desktop',
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    sidecarCtl: async () => ({ running: true, nonce: 'n' }),
    sidecarFetch: async () => ({ status: 200, body: '{}' }),
    sidecarWizardFetch: async () => ({ status: 200, body: JSON.stringify({ state: 'waiting', qr: 'QR' }) }),
    ...overrides,
  };
}

async function mountCard(platform: SnugPlatform, onInstalled?: () => void) {
  (await import('../platform/platform.js')).setPlatform(platform);
  const { HelperInstallCard } = await import('../connections/HelperInstallCard.js');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<HelperInstallCard name="whatsapp-sidecar" appName="Telepath" onInstalled={onInstalled} />);
  });
  await settle();
  return container;
}

describe('HelperInstallCard — consent before download (AC9)', () => {
  it('names the size and source, and downloads NOTHING until the click', async () => {
    const helperInstall = vi.fn(async () => INSTALLED);
    const el = await mountCard(desktop({ helperStatus: async () => ABSENT, helperInstall }));
    const card = el.querySelector('[data-testid="helper-install-card"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('Telepath needs the WhatsApp helper');
    expect(card!.textContent).toContain('41 MB download from GitHub');
    expect(card!.textContent).toContain('136 MB on disk');
    expect(helperInstall).not.toHaveBeenCalled();
  });

  it('the click installs, shows progress, then clears the card and reports installed', async () => {
    let progressCb: ((p: { name: string; phase: 'downloading'; received: number; total: number }) => void) | undefined;
    let finish!: (s: HelperStatusSeat) => void;
    const helperInstall = vi.fn(
      (_name: string, onProgress?: (p: never) => void) =>
        new Promise<HelperStatusSeat>((resolve) => {
          progressCb = onProgress as never;
          finish = resolve;
        }),
    );
    const onInstalled = vi.fn();
    const el = await mountCard(desktop({ helperStatus: async () => ABSENT, helperInstall }), onInstalled);
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="helper-install-button"]')!.click();
    });
    await settle();
    expect(helperInstall).toHaveBeenCalledTimes(1);
    await act(async () => {
      progressCb?.({ name: 'whatsapp-sidecar', phase: 'downloading', received: 21_000_000, total: 42_000_000 });
    });
    expect(el.querySelector('[data-testid="helper-install-progress"]')!.textContent).toContain('downloading 50%');
    // a second click while in flight JOINS the first — no rival download
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="helper-install-button"]')?.click();
    });
    expect(helperInstall).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(INSTALLED);
    });
    await settle();
    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(el.querySelector('[data-testid="helper-install-card"]')).toBeNull();
  });

  it('a refused install is shown by name and the button returns', async () => {
    const helperInstall = vi.fn(async () => {
      throw new Error('helper archive is not the pinned build (sha256 …) — refused');
    });
    const el = await mountCard(desktop({ helperStatus: async () => ABSENT, helperInstall }));
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="helper-install-button"]')!.click();
    });
    await settle();
    expect(el.querySelector('[data-testid="helper-install-error"]')!.textContent).toContain('not the pinned build');
    expect(el.querySelector<HTMLButtonElement>('[data-testid="helper-install-button"]')!.disabled).toBe(false);
  });

  it('an installed, matching helper renders no card; a mismatched downloaded one offers an update', async () => {
    const el = await mountCard(desktop({ helperStatus: async () => INSTALLED, helperInstall: async () => INSTALLED }));
    expect(el.querySelector('[data-testid="helper-install-card"]')).toBeNull();
    vi.resetModules();
    act(() => root?.unmount());
    container?.remove();
    const el2 = await mountCard(
      desktop({ helperStatus: async () => ({ ...INSTALLED, installedVersion: '0.0.9', mismatch: true }), helperInstall: async () => INSTALLED }),
    );
    expect(el2.textContent).toContain('needs an update');
    expect(el2.textContent).toContain('you have v0.0.9');
  });

  it('a DEV install never gets the card, even when it mismatches the pin (ADR-0060 §4)', async () => {
    const el = await mountCard(desktop({ helperStatus: async () => ({ ...INSTALLED, kind: 'dev', installedVersion: undefined, mismatch: true }), helperInstall: async () => INSTALLED }));
    expect(el.querySelector('[data-testid="helper-install-card"]')).toBeNull();
  });

  it('web (no seat) renders nothing', async () => {
    const el = await mountCard({ kind: 'web', capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: false } });
    expect(el.querySelector('[data-testid="helper-install-card"]')).toBeNull();
  });
});

describe('beginDeviceLink — a missing helper is a typed refusal, never Rust prose (AC8/AC10)', () => {
  it('returns helper-missing before any spawn when the seat says absent', async () => {
    const sidecarCtl = vi.fn(async () => ({ running: true, nonce: 'n' }));
    (await import('../platform/platform.js')).setPlatform(desktop({ helperStatus: async () => ABSENT, sidecarCtl }));
    const { beginDeviceLink } = await import('../state/connectionWizard.js');
    const started = await beginDeviceLink();
    expect(started.ok).toBe(false);
    expect(started).toMatchObject({ reason: 'helper-missing' });
    expect(sidecarCtl).not.toHaveBeenCalled();
  });

  it('a mismatched DOWNLOADED helper still starts (pin = wanted, never a refusal — §3)', async () => {
    const sidecarCtl = vi.fn(async () => ({ running: true, nonce: 'n' }));
    (await import('../platform/platform.js')).setPlatform(
      desktop({ helperStatus: async () => ({ ...INSTALLED, installedVersion: '0.0.9', mismatch: true }), sidecarCtl }),
    );
    const { beginDeviceLink } = await import('../state/connectionWizard.js');
    const started = await beginDeviceLink();
    expect(sidecarCtl).toHaveBeenCalledWith('start');
    expect(started.ok).toBe(true);
  });
});

describe('HelperSurface — the autostart moment is not silent (AC15)', () => {
  async function mountSurface(status: HelperStatusSeat) {
    (await import('../platform/platform.js')).setPlatform(desktop({ helperStatus: async () => status, helperInstall: async () => INSTALLED }));
    const { HelperSurface } = await import('../desktop/HelperSurface.js');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<HelperSurface />);
    });
    await settle();
    return container;
  }
  it('shows the chip only when a linked session is on disk AND the helper is wanted', async () => {
    const el = await mountSurface({ ...ABSENT, linkedSessionOnDisk: true });
    expect(el.querySelector('[data-testid="helper-chip"]')).not.toBeNull();
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="helper-chip"]')!.click();
    });
    await settle();
    expect(el.querySelector('[data-testid="helper-install-card"]')).not.toBeNull();
  });
  it('no chip without a linked session, and none when the helper is fine', async () => {
    const el = await mountSurface(ABSENT);
    expect(el.querySelector('[data-testid="helper-chip"]')).toBeNull();
    vi.resetModules();
    act(() => root?.unmount());
    container?.remove();
    const el2 = await mountSurface({ ...INSTALLED, linkedSessionOnDisk: true });
    expect(el2.querySelector('[data-testid="helper-chip"]')).toBeNull();
  });
});
