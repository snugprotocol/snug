// hubUpdateBadge.test.tsx — TASK-20260820-starter-updates (ADR-0045), AC2/AC3.
//
// The hub tile REPORTS an available starter update — "update · vN" in place of
// "installed" — and nothing more: clicking still only opens the copy (the hub-never-
// writes doctrine). The badge uses its OWN class because `dedup.spec.ts` proves
// single-install with a strict `.tile-installed-badge` selector.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { starterVersionSettingKey } from '@snugprotocol/db';

import { HubView } from '../views/HubView.js';
import { __resetStarterMetaFixturesForTests, __setStarterMetaFixturesForTests } from '../starter/starterMeta.js';
import {
  __resetStarterUpdateFixturesForTests,
  __setStarterUpdateFixturesForTests,
} from '../starter/starterUpdate.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const FOLDER = 'chess';
const SOURCE = `starter:${FOLDER}`;
const HTML_V1 = '<html><body>chess v1</body></html>';
const HTML_V2 = '<html><body>chess v2</body></html>';

const meta = (version: number): string =>
  JSON.stringify({
    version,
    appHash: 'unused',
    changelog: [
      { version, date: '2026-08-21', sections: [{ title: "What's new", items: ['Something.'] }] },
    ],
  });

let container: HTMLDivElement;
let root: Root;
let db: UserDb;

beforeEach(async () => {
  db = await installTestUserDb();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetStarterMetaFixturesForTests();
  __resetStarterUpdateFixturesForTests();
});

async function renderHub(): Promise<void> {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/']}>
        <HubView />
      </MemoryRouter>,
    );
  });
  // The badge resolves ASYNC (bundle read per installed tile); settle a few beats.
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    if (container.querySelector('[data-testid="starter-update-badge"]') !== null) return;
  }
}

const chessTile = (): Element | null => container.querySelector(`[data-starter-name="${FOLDER}"]`);

describe('the hub update badge (AC2, AC3)', () => {
  it('replaces "installed" with "update · vN" when the bundle is ahead', async () => {
    __setStarterMetaFixturesForTests({ [FOLDER]: meta(2) });
    __setStarterUpdateFixturesForTests({ [FOLDER]: HTML_V2 });
    const app = db.installApp({ displayName: 'Chess', html: HTML_V1, installSource: SOURCE });
    db.setSetting(starterVersionSettingKey(app.appId), 1);

    await renderHub();
    const tile = chessTile()!;
    const badge = tile.querySelector('[data-testid="starter-update-badge"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('update · v2');
    expect(tile.querySelector('.tile-installed-badge')).toBeNull();
  });

  it('an up-to-date install keeps the plain "installed" badge', async () => {
    __setStarterMetaFixturesForTests({ [FOLDER]: meta(1) });
    __setStarterUpdateFixturesForTests({ [FOLDER]: HTML_V1 });
    const app = db.installApp({ displayName: 'Chess', html: HTML_V1, installSource: SOURCE });
    db.setSetting(starterVersionSettingKey(app.appId), 1);

    await renderHub();
    const tile = chessTile()!;
    expect(tile.querySelector('[data-testid="starter-update-badge"]')).toBeNull();
    expect(tile.querySelector('.tile-installed-badge')).not.toBeNull();
  });

  it('an uninstalled starter shows neither badge', async () => {
    __setStarterMetaFixturesForTests({ [FOLDER]: meta(2) });
    __setStarterUpdateFixturesForTests({ [FOLDER]: HTML_V2 });
    await renderHub();
    const tile = chessTile()!;
    expect(tile.querySelector('[data-testid="starter-update-badge"]')).toBeNull();
    expect(tile.querySelector('.tile-installed-badge')).toBeNull();
  });
});
