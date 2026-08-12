// Hydrated-subscription coercion (TASK-20260812 P3 item 2, the W2b concern): a user
// file carrying mode:'subscription' (imported or synced from web) must not dead-end
// on a shell whose platform declares no subscription capability. The ACTIVE mode is
// coerced to the best available (local when Ollama was detected, byok otherwise);
// the STORED setting is never rewritten — a re-export must carry the original — and
// a small dismissible note tells the user what happened, linking to Settings.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
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
