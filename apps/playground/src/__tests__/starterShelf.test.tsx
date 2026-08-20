// starterShelf.test.tsx — TASK-20260806-starters-pillars AC3, re-curated by
// TASK-20260815-starter-apps-rebuild.
//
// The curated starters reach the hub shelf through the ONE
// definition — the `import.meta.glob` over `examples/*/app.html` in starterApps.ts —
// with no second registry. This file pins (a) that the glob really carries them
// (a missing examples/ folder is invisible to typecheck and only fails here), and
// (b) that each gets its own kid-first look on the hub tile rather than the generic
// `⬡` fallback — an 11-year-old navigates the shelf by icon.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listStarterApps, STARTER_PREFIX } from '../starter/starterApps.js';
import { HubView } from '../views/HubView.js';
import { modeStore } from '../state/mode.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Folder names are the pinned contract literals (task file, "shared literals").
 *
 * RE-CURATED (TASK-20260815-starter-apps-rebuild): the shelf is now the five KEEPERS
 * plus the five gold-standard CONNECTED starters. The removed folders and their fates:
 * trip-planner, pocket-ledger, habit-tracker and connection-demo are gone with no
 * successor on the shelf; crypto-portfolio's Coinbase-shaped successor is trade-copilot;
 * spotify-party-dj → spotify, weather-planner → weather, my-repos → github,
 * hue-lights-party → hue. The membership + count assertions below are EXTENDED to the
 * new curation, exactly as P4 extended them, never relaxed.
 */
const KEEPER_FOLDERS = ['chess', 'flying-pig', 'adventure-quest', 'quiz-me', 'trivia-night'];
/**
 * The CONNECTED five (TASK-20260815-starter-apps-rebuild, ADR-0031): one per credential
 * shape — Coinbase (api_key + CDP signing, desktop-only), Spotify (oauth2_auth_code),
 * Hue (LAN-class lanHost, desktop-only), OpenWeather (api_key), GitHub (bearer_token).
 * They reach the shelf through the same `examples/*` glob as every other folder — which
 * is exactly why the count assertion below had to move with them rather than be relaxed.
 */
const CONNECTED_FOLDERS = ['trade-copilot', 'spotify', 'hue', 'weather', 'github', 'whatsapp', 'ledger', 'gmail'];
/** Every folder that must reach the shelf with its own look — the coverage loop's input. */
const LOOK_COVERED = [...KEEPER_FOLDERS, ...CONNECTED_FOLDERS];

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

async function renderHub(): Promise<HTMLDivElement> {
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
  await settle();
  return container;
}

beforeEach(async () => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  localStorage.clear();
  sessionStorage.clear();
  modeStore.set('subscription');
  await installTestUserDb();
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('the curated starters register through the ONE definition (AC3)', () => {
  it('listStarterApps() carries all ten starters straight from the examples/ glob', () => {
    const ids = listStarterApps().map((starter) => starter.id);
    for (const folder of [...KEEPER_FOLDERS, ...CONNECTED_FOLDERS]) {
      expect(ids, `examples/${folder}/app.html must be bundled on the shelf`).toContain(`${STARTER_PREFIX}${folder}`);
    }
    // The COUNT is pinned too (review fix 5a): the validate suite's APPS list and the
    // vite glob can drift silently — a folder that skips validation, or a listed app
    // whose folder vanished, both surface here as a length mismatch. The re-curation
    // EXTENDS the pinned membership rather than relaxing the check: each folder is
    // named above, so the count still fails on a folder nobody declared.
    expect(ids).toHaveLength(KEEPER_FOLDERS.length + CONNECTED_FOLDERS.length);
  });

  // The loop covers every curated folder (TASK-20260807-connection-reachability
  // §V2-6/MINOR 13). Extending it is the point: `STARTER_LOOKS` falls back via `??`, so a
  // new folder with no row renders a ⬡ tile with the generic blurb and NOTHING fails —
  // a silent UX regression. A folder is only "covered" if it is in this list.
  it('every keeper and connected starter tile has its own look, not the ⬡ fallback', async () => {
    const el = await renderHub();
    const emojis: string[] = [];
    for (const folder of LOOK_COVERED) {
      const name = folder.replace(/-/g, ' ');
      const tile = [...el.querySelectorAll<HTMLElement>('[data-testid="starter-tile"]')].find(
        (candidate) => candidate.getAttribute('data-starter-name') === name,
      );
      expect(tile, `a hub tile for "${name}"`).toBeDefined();
      const emoji = tile!.querySelector('.tile-emoji')?.textContent?.trim() ?? '';
      expect(emoji, `${name} needs a real look (STARTER_LOOKS row)`).not.toBe('⬡');
      expect(emoji).not.toBe('');
      const blurb = tile!.querySelector('.tile-sub')?.textContent ?? '';
      expect(blurb, `${name} needs its own blurb`).not.toContain('curated example — runs without a server');
      emojis.push(emoji);
    }
    // Kids find tiles by icon — identical icons would defeat the shelf.
    expect(new Set(emojis).size, 'each covered starter gets a distinct emoji').toBe(LOOK_COVERED.length);
  });
});
