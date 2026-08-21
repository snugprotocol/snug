// TASK-20260820 — the offer actually APPEARS in the hub (owner-found gap).
//
// WHY A RENDER TEST AND NOT ANOTHER SOURCE ASSERTION. The owner ran the desktop client,
// a new database was created, and nothing ever asked for a passphrase. Every unit test
// was green: `ProtectSetupFlow` worked when mounted directly, `protectOffer` worked when
// called directly — and no code path did either. That is the same defect class as the
// sync sealer (D-2), found the same way: by using the product.
//
// So this mounts the REAL route component and asserts a person sees the screen. Grepping
// the source proves the wiring exists; only rendering proves it fires.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';

const desktopFirstRun = { value: false };
const protectOffer = { value: false };

vi.mock('../desktop/firstRun.js', () => ({
  useDesktopFirstRun: () => desktopFirstRun.value,
  initDesktopFirstRun: () => Promise.resolve(),
  completeDesktopFirstRun: () => undefined,
}));
vi.mock('../vault/protectOffer.js', () => ({
  useProtectOffer: () => protectOffer.value,
  deferProtectOffer: vi.fn(),
  declineProtectOfferPermanently: vi.fn(),
  markProtectionEnabled: vi.fn(),
}));
vi.mock('../vault/enableProtection.js', () => ({
  enableProtection: vi.fn(() => Promise.resolve({ recoveryKey: 'AAAAA-BBBBB' })),
  disableProtection: vi.fn(() => Promise.resolve()),
}));
vi.mock('../state/appMeta.js', () => ({
  useAppMetaMap: () => new Map(),
  refreshAppMeta: () => Promise.resolve(),
}));
vi.mock('../starter/starters.js', () => ({ listStarterApps: () => [] }));

const { HubView } = await import('../views/HubView.js');

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <HubView />
      </MemoryRouter>,
    );
  });
}

afterEach(async () => {
  if (root !== undefined) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  desktopFirstRun.value = false;
  protectOffer.value = false;
});

describe('the protection offer reaches the screen', () => {
  it('shows the setup flow when the offer is live', async () => {
    protectOffer.value = true;
    await render();
    // The words a person would actually see on a brand-new file.
    expect(container?.textContent ?? '').toMatch(/protect this file/i);
    expect(container?.textContent ?? '').toMatch(/passphrase/i);
  });

  it('does NOT show it once the file is protected or the offer was declined', async () => {
    protectOffer.value = false;
    await render();
    expect(container?.textContent ?? '').not.toMatch(/protect this file/i);
  });

  it('the desktop welcome still comes FIRST — one idea per screen', async () => {
    // Stacking both gates would break the rule both were written to follow, and would
    // ask about protecting a file before the user has any reason to care about it.
    desktopFirstRun.value = true;
    protectOffer.value = true;
    await render();
    expect(container?.textContent ?? '').not.toMatch(/protect this file/i);
  });
});
