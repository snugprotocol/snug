// TASK-20260817-telepath: the shelf tile shows the APP's name, not its folder name.
//
// WHY THIS EXISTS. `listStarterApps()` derives a tile's name from the folder
// (`folder.replace(/-/g, ' ')`), so the shelf read "whatsapp", "spotify", "hue",
// "github" while the apps those folders ship are called Telepath, Rewind, Moodboard
// and Standup. The owner hit exactly the failure that causes: after a full rebuild of
// the WhatsApp starter into Telepath, the shelf still said "whatsapp" — indistinguishable
// from "my rebuild did not land", and the display name only appears once the app is
// running and has announced itself.
//
// The fix keeps the FOLDER as the identity (install_source, STARTER_LOOKS keys and the
// desktopOnly gate all key on it) and adds an optional display name to the look row. This
// suite pins the two halves that matter: the rendered label, and the identity attribute
// staying folder-shaped so nothing downstream re-keys on a human string.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

async function renderHub(): Promise<void> {
  vi.resetModules();
  const helper = await import('./userdbTestHelper.js');
  await helper.installTestUserDb();
  const { HubView } = await import('../views/HubView.js');

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={['/']}>
        <HubView />
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

function tileFor(folder: string): HTMLElement | undefined {
  return [...(container?.querySelectorAll<HTMLElement>('[data-testid="starter-tile"]') ?? [])].find(
    (tile) => tile.getAttribute('data-starter-name') === folder,
  );
}

describe('starter tiles carry the app name, keyed by folder', () => {
  it('shows Telepath on the whatsapp folder’s tile', async () => {
    await renderHub();
    const tile = tileFor('whatsapp');
    expect(tile, 'the whatsapp starter tile exists').toBeDefined();
    expect(tile!.textContent).toContain('Telepath');
    // The bare folder name must not be what the user reads.
    expect(tile!.querySelector('.tile-name')?.textContent).toBe('Telepath');
  });

  it('names the other renamed starters too — one rule, not a whatsapp special case', async () => {
    await renderHub();
    for (const [folder, displayName] of [
      ['spotify', 'Rewind'],
      ['hue', 'Moodboard'],
      ['github', 'Standup'],
      ['weather', 'Should I?'],
    ] as const) {
      const tile = tileFor(folder);
      expect(tile, `${folder} tile exists`).toBeDefined();
      expect(tile!.querySelector('.tile-name')?.textContent, folder).toBe(displayName);
    }
  });

  it('falls back to the folder name for a starter with no declared display name', async () => {
    await renderHub();
    // `chess` ships as "ember chess" in-app but declares no tile name; the folder is the
    // honest fallback rather than a guess.
    const tile = tileFor('chess');
    expect(tile).toBeDefined();
    expect(tile!.querySelector('.tile-name')?.textContent).toBe('chess');
  });

  it('keeps the IDENTITY attribute folder-shaped — install_source keys on it', async () => {
    await renderHub();
    // If this ever became the display name, the install_source identity rule and the
    // desktopOnly gate would silently re-key on a human string.
    expect(tileFor('whatsapp')?.getAttribute('data-starter-name')).toBe('whatsapp');
    expect(tileFor('hue')?.getAttribute('data-starter-name')).toBe('hue');
  });
});
