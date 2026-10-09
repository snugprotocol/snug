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
const KEEPER_FOLDERS = ['chess', 'flying-pig', 'adventure-quest', 'quiz-me'];
/**
 * The CONNECTED five (TASK-20260815-starter-apps-rebuild, ADR-0031): one per credential
 * shape — Coinbase (api_key + CDP signing; no browser CORS), Spotify (oauth2_auth_code),
 * Hue (LAN-class lanHost), OpenWeather (api_key), GitHub (bearer_token). Which hosts run
 * each is derived from those declarations (`availability.test.ts` holds the matrix).
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

  // TASK-20261003 S2 (ADR-0072 §4): the shelf entry CARRIES what the starter declares, and
  // `listStarterApps()` is synchronous — so whether this host can run a starter is decided
  // in the same pass that paints its tile, never a render later. (What the hub does with it
  // is `hubAvailability.test.tsx`; the needs × hosts matrix is `availability.test.ts`.)
  it('every connected starter carries its declared requirement at first paint; the keepers carry none', () => {
    const byId = new Map(listStarterApps().map((starter) => [starter.id, starter]));
    for (const folder of CONNECTED_FOLDERS) {
      const declared = byId.get(`${STARTER_PREFIX}${folder}`)?.requirement;
      expect(declared, `examples/${folder}/connection.json must reach the shelf entry`).toBeDefined();
      expect(declared!.provider.name).not.toBe('');
    }
    for (const folder of KEEPER_FOLDERS) {
      expect(byId.get(`${STARTER_PREFIX}${folder}`)?.requirement, `${folder} declares no connection`).toBeUndefined();
    }
    // The three shapes the availability derivation branches on, read off the real manifests.
    expect(byId.get(`${STARTER_PREFIX}hue`)?.requirement?.lanHost).toBeDefined();
    expect(byId.get(`${STARTER_PREFIX}whatsapp`)?.requirement?.kind).toBe('linked_device');
    expect(byId.get(`${STARTER_PREFIX}gmail`)?.requirement?.kind).toBe('oauth2_auth_code');
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
