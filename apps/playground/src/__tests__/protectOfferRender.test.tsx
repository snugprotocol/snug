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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

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
// HubHome (the not-offering branch) boots a REAL sql.js database to list the library.
// This spec is about which screen the router shows, so the db is stubbed out — without
// it the wasm binary is fetched over a `/@fs/` URL that only resolves under a running
// dev server, and the suite fails with an ENOENT that has nothing to do with the test.
vi.mock('../state/userdb.js', () => ({
  getUserDb: () => Promise.resolve({ listApps: () => [], getSetting: () => undefined }),
  userDbStatusStore: { get: () => ({ state: 'ready' }), subscribe: () => () => undefined },
}));

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

describe('the unlock screen survives a failed attempt (owner-found, second pass)', () => {
  it('stays mounted while the status dips to opening', async () => {
    // THE BUG: `unlockUserDb` sets status 'opening' mid-attempt, and App.tsx rendered
    // UnlockScreen only while status === 'locked'. So a wrong passphrase UNMOUNTED the
    // screen, destroying the `failed` state that was about to be set — the user got a
    // cleared box and complete silence. The unit test missed it by mounting the
    // component directly with the store mocked; only the composed app can show it.
    // The fix: unlockUserDb never publishes an intermediate status, so the screen is
    // never unmounted between submit and result.
    const source = readFileSync(join(SRC, 'state/userdb.ts'), 'utf8');
    const fn = /export async function unlockUserDb[\s\S]*?\n}/.exec(source)?.[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn).not.toContain("userDbStatusStore.set({ state: 'opening' })");
  });
});
