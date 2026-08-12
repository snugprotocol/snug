// Desktop-only starter labeling (TASK-20260812 P3 item 5): the Hue starter reaches
// a device on the user's LAN, which a web page cannot. On web its tile is greyed and
// says so in plain words ("needs the desktop app — free download"); on the desktop
// platform the same tile is simply enabled, with no limitation badge at all.
// Labeling only — no Hue connector is built here.
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

interface Harness {
  HubView: typeof import('../views/HubView.js')['HubView'];
}

async function fresh(platform?: SnugPlatform): Promise<Harness> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  await helper.installTestUserDb();
  const hub = await import('../views/HubView.js');
  return { HubView: hub.HubView };
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

async function renderHub(harness: Harness): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={['/']}>
        <harness.HubView />
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

function hueTile(): HTMLElement | undefined {
  return [...(container?.querySelectorAll<HTMLElement>('[data-testid="starter-tile"]') ?? [])].find(
    (tile) => tile.getAttribute('data-starter-name') === 'hue lights party',
  );
}

describe('the Hue (desktopOnly) starter tile', () => {
  it('web: greyed out, not clickable, with the plain download copy', async () => {
    const harness = await fresh();
    await renderHub(harness);

    const tile = hueTile();
    expect(tile, 'the hue tile must be on the shelf').toBeDefined();
    const badge = tile!.querySelector('[data-testid="desktop-only-badge"]');
    expect(badge, 'the limitation badge renders on web').not.toBeNull();
    expect(badge!.textContent?.toLowerCase()).toContain('needs the desktop app — free download');
    const open = tile!.querySelector<HTMLButtonElement>('.tile-card-button');
    expect(open?.disabled, 'the web tile must not offer an open that cannot work').toBe(true);
  });

  it('desktop: enabled, no limitation badge', async () => {
    const harness = await fresh({
      kind: 'desktop',
      capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    });
    await renderHub(harness);

    const tile = hueTile();
    expect(tile).toBeDefined();
    expect(tile!.querySelector('[data-testid="desktop-only-badge"]')).toBeNull();
    const open = tile!.querySelector<HTMLButtonElement>('.tile-card-button');
    expect(open?.disabled).toBe(false);
  });

  it('an ordinary starter stays enabled on web (the labeling is hue-scoped)', async () => {
    const harness = await fresh();
    await renderHub(harness);

    const chess = [...(container?.querySelectorAll<HTMLElement>('[data-testid="starter-tile"]') ?? [])].find(
      (tile) => tile.getAttribute('data-starter-name') === 'chess',
    );
    expect(chess).toBeDefined();
    expect(chess!.querySelector<HTMLButtonElement>('.tile-card-button')?.disabled).toBe(false);
  });
});
