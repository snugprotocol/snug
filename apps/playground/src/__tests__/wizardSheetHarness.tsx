// wizardSheetHarness.tsx — the SHARED wizard-sheet component-test harness
// (TASK-20260822-gmail-dual-mode, Gate-5 review: webSurfaceWizard was about to become
// the FOURTH near-verbatim copy of this scaffolding — desktopWizardSheet:47-149,
// lanWizardFlow and linkedDeviceSheet carry the older copies, each already drifting on
// tuned details. New wizard-sheet suites should import from here; the older copies can
// migrate opportunistically.)
//
// Platform is set-once, so every case takes a fresh module registry and imports the
// sheet + stores dynamically from that generation (`fresh`). Module-level container
// state is per test FILE (vitest isolates workers per file) — call `cleanupSheet()`
// from the suite's own afterEach.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** A desktop platform whose OAuth capability records calls without opening anything. */
export function fakeDesktopPlatform(redirectUri = 'http://127.0.0.1:41420/callback'): {
  platform: SnugPlatform;
  opened: string[];
  redirectUriFor: ReturnType<typeof vi.fn>;
} {
  const opened: string[] = [];
  const redirectUriFor = vi.fn(async () => redirectUri);
  const platform: SnugPlatform = {
    kind: 'desktop',
    oauth: {
      redirectUriFor,
      openExternal: async (url) => {
        opened.push(url);
      },
      channelFor: () => ({ onmessage: null, close: () => undefined }),
      cancel: async () => undefined,
    },
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  };
  return { platform, opened, redirectUriFor };
}

export interface WizardSheetHarness {
  db: UserDb;
  wizard: typeof import('../state/connectionWizard.js');
  Sheet: typeof import('../connections/ConnectionWizardSheet.js')['ConnectionWizardSheet'];
}

/** Fresh module generation: platform (optional — absent means WEB), user db, wizard, sheet. */
export async function freshWizardSheet(platform?: SnugPlatform): Promise<WizardSheetHarness> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  const db = await helper.installTestUserDb();
  const wizard = await import('../state/connectionWizard.js');
  wizard.__resetConnectionWizardForTests();
  const sheet = await import('../connections/ConnectionWizardSheet.js');
  return { db, wizard, Sheet: sheet.ConnectionWizardSheet };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

export function sheetContainer(): HTMLDivElement | undefined {
  return container;
}

/**
 * ONE microtask tick is not enough: the connect handler awaits a chain
 * (save credentials → mint the authorize URL → openExternal), and a single flush lands
 * mid-chain on a loaded machine. That is precisely how the desktopWizardSheet suite
 * went red on a CI runner while passing locally every time. Drain generously instead
 * of guessing a tick count. (Tuning history lives with the original suite; change it
 * HERE so every importer moves together.)
 */
export async function settleSheet(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Await a CONDITION rather than a tick count — for assertions after real async work. */
export async function settleSheetUntil(done: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !done(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

export async function renderSheet(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  await settleSheet();
}

export function sheetButton(name: RegExp): HTMLButtonElement | undefined {
  return [...(container?.querySelectorAll('button') ?? [])].find((b) => name.test(b.textContent ?? '')) as
    | HTMLButtonElement
    | undefined;
}

export async function clickSheetButton(name: RegExp): Promise<void> {
  const target = sheetButton(name);
  if (target === undefined) {
    throw new Error(`no button matching ${String(name)} — rendered: ${container?.textContent?.slice(0, 400) ?? ''}`);
  }
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settleSheet();
}

export async function typeSheetField(fieldKey: string, value: string): Promise<void> {
  const input = container?.querySelector<HTMLInputElement>(`input[data-field-key="${fieldKey}"]`);
  if (input === null || input === undefined) throw new Error(`no input for declared field ${fieldKey}`);
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settleSheet();
}

/** Install a throwaway app and persist (optionally approving) its declared connection row. */
export function declareSheetConnection(
  db: UserDb,
  appId: string,
  requirement: { slot: string },
  approve = true,
): void {
  db.installApp({ appId, displayName: 'Wizard Harness App', html: '<p>x</p>' });
  db.putDeclaredConnection(appId, requirement.slot, requirement, 'registry');
  if (approve) db.approveConnection(appId, requirement.slot);
}

/** Call from the suite's afterEach — unmounts and clears the shared container. */
export async function cleanupSheet(): Promise<void> {
  if (root !== undefined) {
    const current = root;
    await act(async () => {
      current.unmount();
    });
  }
  container?.remove();
  container = undefined;
  root = undefined;
  vi.restoreAllMocks();
}
