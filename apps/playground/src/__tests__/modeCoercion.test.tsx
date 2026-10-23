// Hydrated-subscription coercion (TASK-20260812 P3 item 2, the W2b concern): a user
// file carrying mode:'subscription' (imported or synced from web) must not dead-end
// on a shell whose platform declares no subscription capability. The ACTIVE mode is
// coerced to the best available (local when Ollama was detected, byok otherwise);
// the STORED setting is never rewritten — a re-export must carry the original — and
// a small dismissible note tells the user what happened, linking to Settings.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openUserDb, type UserDb } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Harness {
  db: UserDb;
  mode: typeof import('../state/mode.js');
  ollama: typeof import('../state/ollama.js');
  helper: typeof import('./userdbTestHelper.js');
  note: typeof import('../desktop/ModeCoercionNote.js');
}

async function fresh(platform?: SnugPlatform): Promise<Harness> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  const db = await helper.installTestUserDb();
  const mode = await import('../state/mode.js');
  const ollama = await import('../state/ollama.js');
  const note = await import('../desktop/ModeCoercionNote.js');
  return { db, mode, ollama, helper, note };
}

function desktopPlatform(overrides: Partial<SnugPlatform> = {}): SnugPlatform {
  return {
    kind: 'desktop',
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    ...overrides,
  };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

describe('hydrateSettings — subscription coercion on capability-less platforms', () => {
  it('coerces the ACTIVE mode to byok when no Ollama was detected, and flags the note', async () => {
    const harness = await fresh(desktopPlatform());
    harness.db.setSetting('mode', 'subscription');

    harness.mode.hydrateSettings(harness.db);

    expect(harness.mode.modeStore.get()).toBe('byok');
    expect(harness.mode.modeCoercedStore.get()).toBe(true);
  });

  it('coerces to local when the Ollama probe found a running install', async () => {
    const harness = await fresh(
      desktopPlatform({ probeOllama: () => Promise.resolve({ running: true, models: ['llama3.2'] }) }),
    );
    harness.db.setSetting('mode', 'subscription');
    await harness.ollama.refreshOllama();

    harness.mode.hydrateSettings(harness.db);

    expect(harness.mode.modeStore.get()).toBe('local');
    expect(harness.mode.modeCoercedStore.get()).toBe(true);
  });

  it('NEVER rewrites the stored setting: the file still says subscription and a re-export carries it', async () => {
    const harness = await fresh(desktopPlatform());
    harness.db.setSetting('mode', 'subscription');

    harness.mode.hydrateSettings(harness.db);
    await new Promise((resolve) => setTimeout(resolve, 10)); // any illegal write-through would have landed

    expect(harness.db.getSetting('mode'), 'the stored value must survive untouched').toBe('subscription');

    // The re-export proof: open the exported bytes as their own database.
    const bytes = await harness.db.exportUserDb({ includeSecrets: false });
    const reopened = await openUserDb({
      backend: { kind: 'memory', load: () => Promise.resolve(bytes), save: () => Promise.resolve() },
      locateWasm: harness.helper.locateWasm,
    });
    if (reopened.status !== 'ok') throw new Error(`re-open failed: ${reopened.status}`);
    expect(reopened.userDb.getSetting('mode'), 'a re-export must carry the original mode').toBe('subscription');
  });

  it('web (subscription capability present): hydration keeps subscription, no note (AC10)', async () => {
    const harness = await fresh();
    harness.db.setSetting('mode', 'subscription');

    harness.mode.hydrateSettings(harness.db);

    expect(harness.mode.modeStore.get()).toBe('subscription');
    expect(harness.mode.modeCoercedStore.get()).toBe(false);
  });

  it('a stored byok/local mode on desktop hydrates without any coercion note', async () => {
    const harness = await fresh(desktopPlatform());
    harness.db.setSetting('mode', 'local');

    harness.mode.hydrateSettings(harness.db);

    expect(harness.mode.modeStore.get()).toBe('local');
    expect(harness.mode.modeCoercedStore.get()).toBe(false);
  });
});

// TASK-20261023-siwc-chatgpt-plan Gate 3, L4 (AC1; plan §11 L4-10; ADR-0078 §1): a roaming file
// whose stored mode is `chatgpt` opened where the platform carries NO custody seat (web, the host
// kit, a desktop build without it) is coerced exactly like subscription — the best available mode,
// the note raised, the stored row untouched. Where the seat IS present the mode is simply chatgpt.
// Before the fix a stored 'chatgpt' fails `isMode` and is silently IGNORED (modeStore stays byok,
// no note) — the first three rows are red on the note; the seat row is red on the mode.
describe('hydrateSettings — a stored chatgpt mode (TASK-20261023-siwc-chatgpt-plan, L4-10)', () => {
  /** The ChatGPT-plan custody seat, inert — presence is all `availableModes()` / the coercion read. */
  const seat = (): NonNullable<SnugPlatform['chatgptPlan']> => ({
    sessionStore: { read: () => Promise.resolve(undefined), write: () => Promise.resolve(), clear: () => Promise.resolve() },
    loopback: { begin: (path) => Promise.resolve({ redirectUri: `http://127.0.0.1:1455${path}` }), onCallback: () => () => undefined, cancel: () => Promise.resolve() },
    openExternal: () => Promise.resolve(),
  });

  it('a desktop WITHOUT the seat: coerced to byok (no Ollama), the note raised, the stored row untouched', async () => {
    const harness = await fresh(desktopPlatform());
    harness.db.setSetting('mode', 'chatgpt');

    harness.mode.hydrateSettings(harness.db);
    await new Promise((resolve) => setTimeout(resolve, 10)); // any illegal write-through would have landed

    expect(harness.mode.modeStore.get()).toBe('byok');
    expect(harness.mode.modeCoercedStore.get()).toBe(true);
    expect(harness.db.getSetting('mode'), 'the stored value must survive untouched').toBe('chatgpt');
  });

  it('coerces to local when the Ollama probe found a running install', async () => {
    const harness = await fresh(desktopPlatform({ probeOllama: () => Promise.resolve({ running: true, models: ['llama3.2'] }) }));
    harness.db.setSetting('mode', 'chatgpt');
    await harness.ollama.refreshOllama();

    harness.mode.hydrateSettings(harness.db);

    expect(harness.mode.modeStore.get()).toBe('local');
    expect(harness.mode.modeCoercedStore.get()).toBe(true);
    expect(harness.db.getSetting('mode')).toBe('chatgpt');
  });

  it('the web build (subscription offered, no seat) coerces too — never "subscription", never chatgpt', async () => {
    const harness = await fresh();
    harness.db.setSetting('mode', 'chatgpt');

    harness.mode.hydrateSettings(harness.db);

    expect(harness.mode.modeStore.get()).toBe('byok');
    expect(harness.mode.modeCoercedStore.get()).toBe(true);
    expect(harness.db.getSetting('mode')).toBe('chatgpt');
  });

  it('a desktop WITH the seat: the mode is chatgpt and there is nothing to note', async () => {
    const harness = await fresh(desktopPlatform({ chatgptPlan: seat() }));
    harness.db.setSetting('mode', 'chatgpt');

    harness.mode.hydrateSettings(harness.db);

    expect(harness.mode.modeStore.get()).toBe('chatgpt');
    expect(harness.mode.modeCoercedStore.get()).toBe(false);
  });
});

describe('ModeCoercionNote — the small dismissible surface', () => {
  async function mount(harness: Harness): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <harness.note.ModeCoercionNote />
        </MemoryRouter>,
      );
    });
  }

  it('renders nothing while no coercion happened', async () => {
    const harness = await fresh(desktopPlatform());
    await mount(harness);
    expect(container?.textContent).toBe('');
  });

  it('after a coercion: says the computer uses its own AI settings, links to Settings, dismisses', async () => {
    const harness = await fresh(desktopPlatform());
    harness.db.setSetting('mode', 'subscription');
    harness.mode.hydrateSettings(harness.db);
    await mount(harness);

    expect(container?.textContent).toContain('This computer uses its own AI settings');
    const link = container?.querySelector<HTMLAnchorElement>('a[href*="settings"]');
    expect(link, 'the note must link to Settings').toBeTruthy();

    const dismiss = [...(container?.querySelectorAll('button') ?? [])].find((b) =>
      /got it|dismiss/i.test(b.textContent ?? ''),
    );
    expect(dismiss, 'the note must be dismissible').toBeDefined();
    await act(async () => {
      dismiss!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container?.querySelector('[data-testid="mode-coercion-note"]')).toBeNull();
    // Dismissal is session-local — the stored file is not touched by it either.
    expect(harness.db.getSetting('mode')).toBe('subscription');
  });
});

// ---------------------------------------------------------------------------------------------
// TASK-20261023-siwc-chatgpt-plan Gate 3, L5 — the note says WHICH mode the file asked for (plan
// §12 L5-2). `modeCoercedStore` stays a boolean; `coercedFromModeStore` (L4) names the stored mode
// that was coerced, and the note branches its copy on it. A file that asked for the ChatGPT plan
// must not be told it asked for a hub subscription (the mutation: one hard-coded sentence).
// RED until `coercedFromModeStore` exists and the note branches.
// ---------------------------------------------------------------------------------------------

describe('ModeCoercionNote — the copy names the mode the file asked for (L5-2)', () => {
  const CHATGPT_NOTE =
    "This computer uses its own AI settings — your file asked for your ChatGPT plan, which this app can't sign in to here. Pick how apps think in settings.";
  const SUBSCRIPTION_NOTE =
    "This computer uses its own AI settings — your file asked for a hub subscription, which isn't part of the desktop app. Pick how apps think in settings.";
  const collapse = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

  async function mountNote(harness: Harness): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <harness.note.ModeCoercionNote />
        </MemoryRouter>,
      );
    });
  }

  it('a stored chatgpt mode on a seatless desktop: coercedFromModeStore is "chatgpt" and the note reads the ChatGPT sentence VERBATIM — never the hub one', async () => {
    const harness = await fresh(desktopPlatform());
    harness.db.setSetting('mode', 'chatgpt');
    harness.mode.hydrateSettings(harness.db);
    expect(harness.mode.coercedFromModeStore.get()).toBe('chatgpt');

    await mountNote(harness);
    const text = collapse(container?.querySelector('[data-testid="mode-coercion-note"]')?.textContent);
    expect(text).toContain(CHATGPT_NOTE);
    expect(text).not.toContain('hub subscription');
    expect(container?.querySelector('a[href*="settings"]'), 'the note still links to Settings').toBeTruthy();
  });

  it('a stored subscription mode: coercedFromModeStore is "subscription" and today’s sentence is unchanged', async () => {
    const harness = await fresh(desktopPlatform());
    harness.db.setSetting('mode', 'subscription');
    harness.mode.hydrateSettings(harness.db);
    expect(harness.mode.coercedFromModeStore.get()).toBe('subscription');

    await mountNote(harness);
    const text = collapse(container?.querySelector('[data-testid="mode-coercion-note"]')?.textContent);
    expect(text).toContain(SUBSCRIPTION_NOTE);
    expect(text).not.toContain('ChatGPT');
  });

  it('no coercion → coercedFromModeStore is undefined', async () => {
    const harness = await fresh(desktopPlatform());
    harness.db.setSetting('mode', 'byok');
    harness.mode.hydrateSettings(harness.db);
    expect(harness.mode.coercedFromModeStore.get()).toBeUndefined();
  });

  it('"got it" clears BOTH stores — the boolean and the named mode — and the stored row is untouched', async () => {
    const harness = await fresh(desktopPlatform());
    harness.db.setSetting('mode', 'chatgpt');
    harness.mode.hydrateSettings(harness.db);
    await mountNote(harness);

    const dismiss = [...(container?.querySelectorAll('button') ?? [])].find((b) => /got it/i.test(b.textContent ?? ''));
    expect(dismiss).toBeDefined();
    await act(async () => {
      dismiss!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container?.querySelector('[data-testid="mode-coercion-note"]')).toBeNull();
    expect(harness.mode.modeCoercedStore.get()).toBe(false);
    expect(harness.mode.coercedFromModeStore.get()).toBeUndefined();
    expect(harness.db.getSetting('mode')).toBe('chatgpt');
  });
});
