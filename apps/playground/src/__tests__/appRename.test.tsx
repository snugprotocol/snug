// appRename.test.tsx — TASK-20260821-ui-polish AC1/AC2: renaming an installed app.
//
// The rename is a LIBRARY act (`userLibrary().rename`): uniqueness is enforced there —
// trimmed, case-insensitive, self-rename allowed — because the DB deliberately has no
// name constraint (a schema bump for a UI refusal is not warranted). The subtle half is
// the ANNOUNCE path: every run writes the app's self-described name back into
// `display_name` (`recordAppMeta`), so a rename also writes the `appRenamed:<appId>`
// marker and BOTH altitudes of the merge respect it — the synchronous store merge and
// the async DB write (which re-checks the marker against the DB, because an announce can
// race hydration).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { HubView } from '../views/HubView.js';
import { recordAppMeta, refreshAppMeta, renamedAppsStore, appMetaStore } from '../state/appMeta.js';
import { resetLibraryForTests, userLibrary } from '../state/library.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const html = (title: string): string => `<!DOCTYPE html><html><head><title>${title}</title></head><body></body></html>`;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let db: UserDb;
let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  appMetaStore.set({});
  renamedAppsStore.set(new Set());
  resetLibraryForTests();
  db = await installTestUserDb();
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('userLibrary().rename (AC1/AC2)', () => {
  it('renames the app row and writes the renamed marker', async () => {
    const app = await userLibrary().save(html('Chess Coach'), 'Chess Coach');
    await userLibrary().rename(app.id, '  My Chess Trainer  ');

    expect(db.getApp(app.id)?.displayName).toBe('My Chess Trainer');
    expect(db.listRenamedApps()).toEqual([app.id]);
  });

  it('refuses a name another app already holds — case-insensitive, trimmed — and writes nothing', async () => {
    const a = await userLibrary().save(html('Chess Coach'), 'Chess Coach');
    await userLibrary().save(html('Ledger'), 'Ledger');

    await expect(userLibrary().rename(a.id, ' LEDGER ')).rejects.toThrow(/already/i);
    expect(db.getApp(a.id)?.displayName).toBe('Chess Coach');
    expect(db.listRenamedApps()).toEqual([]);
  });

  it('allows renaming an app to a variant of its OWN name', async () => {
    const a = await userLibrary().save(html('Chess Coach'), 'Chess Coach');
    await expect(userLibrary().rename(a.id, 'CHESS coach')).resolves.toBeUndefined();
    expect(db.getApp(a.id)?.displayName).toBe('CHESS coach');
  });

  it('refuses an empty name', async () => {
    const a = await userLibrary().save(html('Chess Coach'), 'Chess Coach');
    await expect(userLibrary().rename(a.id, '   ')).rejects.toThrow(/name/i);
    expect(db.getApp(a.id)?.displayName).toBe('Chess Coach');
  });
});

describe('the announce path respects a rename (the clobber guard)', () => {
  it('an un-renamed app still takes its announced name — the pre-existing behavior', async () => {
    const app = await userLibrary().save(html('Chess Coach'), 'Chess Coach');
    await refreshAppMeta();

    recordAppMeta(app.id, { displayName: 'Chess Coach Deluxe' });
    await flush();

    expect(db.getApp(app.id)?.displayName).toBe('Chess Coach Deluxe');
  });

  it('a RENAMED app keeps the user’s name through an announce — store AND db', async () => {
    const app = await userLibrary().save(html('Chess Coach'), 'Chess Coach');
    await userLibrary().rename(app.id, 'My Chess Trainer');
    await refreshAppMeta();

    // The next run announces the app's own (old) title.
    recordAppMeta(app.id, { displayName: 'Chess Coach', iconEmoji: '♞' });
    await flush();

    expect(db.getApp(app.id)?.displayName).toBe('My Chess Trainer');
    expect(appMetaStore.get()[app.id]?.displayName).toBe('My Chess Trainer');
    // The rest of the announce metadata still lands — only the NAME is the user's.
    expect(appMetaStore.get()[app.id]?.iconEmoji).toBe('♞');
  });

  it('holds even when the announce RACES hydration (empty in-memory store)', async () => {
    const app = await userLibrary().save(html('Chess Coach'), 'Chess Coach');
    await userLibrary().rename(app.id, 'My Chess Trainer');
    // Simulate a fresh boot where the announce arrives before refreshAppMeta ran.
    appMetaStore.set({});
    renamedAppsStore.set(new Set());

    recordAppMeta(app.id, { displayName: 'Chess Coach' });
    await flush();

    // The async DB write re-checks the marker against the DB — the authoritative guard.
    expect(db.getApp(app.id)?.displayName).toBe('My Chess Trainer');
  });
});

describe('the hub tile rename flow (AC1 UI half)', () => {
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
        <MemoryRouter>
          <HubView />
        </MemoryRouter>,
      );
    });
    await settle();
    return container;
  }

  function click(node: Element | null): void {
    expect(node, 'expected the element to exist before clicking it').not.toBeNull();
    act(() => {
      node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  it('rename → type → Enter commits, and the tile shows the new name without a reload', async () => {
    await userLibrary().save(html('Chess Coach'), 'Chess Coach');
    const el = await renderHub();

    click(el.querySelector('[data-testid="app-rename"]'));
    const input = el.querySelector<HTMLInputElement>('[data-testid="app-rename-input"]');
    expect(input).not.toBeNull();
    await act(async () => {
      input!.value = 'My Chess Trainer';
      input!.dispatchEvent(new Event('input', { bubbles: true }));
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();

    expect(el.querySelector('.tile-name')?.textContent).toBe('My Chess Trainer');
    expect(db.listApps()[0]?.displayName).toBe('My Chess Trainer');
  });

  it('a duplicate name shows the refusal inline and changes nothing', async () => {
    await userLibrary().save(html('Chess Coach'), 'Chess Coach');
    await userLibrary().save(html('Ledger'), 'Ledger');
    const el = await renderHub();

    const chessTile = [...el.querySelectorAll<HTMLElement>('[data-testid="installed-tile"]')].find((tile) =>
      tile.textContent?.includes('Chess Coach'),
    );
    expect(chessTile).toBeDefined();
    click(chessTile!.querySelector('[data-testid="app-rename"]'));
    const input = chessTile!.querySelector<HTMLInputElement>('[data-testid="app-rename-input"]');
    await act(async () => {
      input!.value = 'ledger';
      input!.dispatchEvent(new Event('input', { bubbles: true }));
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();

    expect(el.textContent).toMatch(/already/i);
    expect(db.listApps().map((a) => a.displayName).sort()).toEqual(['Chess Coach', 'Ledger']);
  });

  it('Escape cancels without writing', async () => {
    await userLibrary().save(html('Chess Coach'), 'Chess Coach');
    const el = await renderHub();

    click(el.querySelector('[data-testid="app-rename"]'));
    const input = el.querySelector<HTMLInputElement>('[data-testid="app-rename-input"]');
    await act(async () => {
      input!.value = 'Something Else';
      input!.dispatchEvent(new Event('input', { bubbles: true }));
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();

    expect(el.querySelector('[data-testid="app-rename-input"]')).toBeNull();
    expect(db.listApps()[0]?.displayName).toBe('Chess Coach');
  });
});
