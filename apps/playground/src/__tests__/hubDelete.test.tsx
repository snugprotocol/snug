// hubDelete.test.tsx — per-app delete from the hub (TASK-20260803-hub-ops AC22).
//
// The delete itself is irreversible (no trash, no undo — out of scope), so the UI
// contract carries the weight:
//   * an INLINE two-step confirm — `window.confirm` is forbidden by the design contract
//   * the action must NOT be nested inside the tile's navigation <Link>, or clicking
//     "delete" navigates into the app instead
//   * a double-click must not fire two deletes (the latch idiom already used for installs)

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { HubView } from '../views/HubView.js';
import { userLibrary } from '../state/library.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HTML = '<!DOCTYPE html><html><head><title>Chess Coach</title></head><body></body></html>';

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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

// Scoped to INSTALLED apps: starter tiles reuse the .app-tile class, and only
// installed apps get a delete action.
const tiles = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('[data-testid="installed-tile"]')];
const deleteButton = (el: HTMLElement): HTMLButtonElement | null =>
  el.querySelector<HTMLButtonElement>('[data-testid="app-delete"]');
const confirmButton = (el: HTMLElement): HTMLButtonElement | null =>
  el.querySelector<HTMLButtonElement>('[data-testid="app-delete-confirm"]');

function click(node: Element | null): void {
  expect(node, 'expected the element to exist before clicking it').not.toBeNull();
  act(() => {
    node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  db = await installTestUserDb();
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('hub app delete (AC22)', () => {
  it('offers a per-app delete action on each installed tile', async () => {
    await userLibrary().save(HTML, 'Chess Coach');
    const el = await renderHub();
    expect(tiles(el)).toHaveLength(1);
    expect(deleteButton(el)).not.toBeNull();
  });

  it('never calls window.confirm — the confirm is inline', async () => {
    await userLibrary().save(HTML, 'Chess Coach');
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const el = await renderHub();

    click(deleteButton(el));
    await settle();
    click(confirmButton(el));
    await settle();

    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('requires TWO steps: the first click only arms the confirm', async () => {
    const entry = await userLibrary().save(HTML, 'Chess Coach');
    const el = await renderHub();

    expect(confirmButton(el)).toBeNull(); // not armed yet
    click(deleteButton(el));
    await settle();

    // Armed, but nothing deleted until the confirm is pressed.
    expect(confirmButton(el)).not.toBeNull();
    expect((await userLibrary().list()).map((e) => e.id)).toContain(entry.id);
  });

  it('deletes the app on confirm and removes its tile', async () => {
    const keep = await userLibrary().save(HTML, 'Keeper');
    const drop = await userLibrary().save(HTML, 'Goner');
    const el = await renderHub();
    expect(tiles(el)).toHaveLength(2);

    // Find the tile BY NAME: listApps orders by `updated_at DESC, app_id`, and two saves
    // in the same millisecond tie-break on a random uuid — so tile order is not stable
    // and indexing into it makes the test pass or fail by luck.
    const target = tiles(el).find((tile) => tile.textContent?.includes('Goner'));
    expect(target, 'expected a tile for the app being deleted').toBeDefined();
    click(target!.querySelector('[data-testid="app-delete"]'));
    await settle();
    click(target!.querySelector('[data-testid="app-delete-confirm"]'));
    await settle();

    const remaining = await userLibrary().list();
    expect(remaining.map((e) => e.id)).toEqual([keep.id]);
    expect(remaining.map((e) => e.id)).not.toContain(drop.id);
    expect(tiles(el)).toHaveLength(1);
  });

  it('can be cancelled, leaving the app installed', async () => {
    const entry = await userLibrary().save(HTML, 'Chess Coach');
    const el = await renderHub();

    click(deleteButton(el));
    await settle();
    click(el.querySelector('[data-testid="app-delete-cancel"]'));
    await settle();

    expect(confirmButton(el)).toBeNull(); // disarmed
    expect((await userLibrary().list()).map((e) => e.id)).toContain(entry.id);
    expect(tiles(el)).toHaveLength(1);
  });

  it('latches a double-click so one confirm cannot delete twice', async () => {
    const entry = await userLibrary().save(HTML, 'Chess Coach');
    const spy = vi.spyOn(db, 'deleteApp');
    const el = await renderHub();

    click(deleteButton(el));
    await settle();
    // Two clicks in the SAME tick — the latch must swallow the second.
    const confirm = confirmButton(el);
    act(() => {
      confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(entry.id);
  });

  it('keeps the delete action OUT of the navigation link (AC22)', async () => {
    await userLibrary().save(HTML, 'Chess Coach');
    const el = await renderHub();
    const button = deleteButton(el);
    expect(button).not.toBeNull();
    // A delete button inside the <Link> would navigate to the app on click.
    expect(button!.closest('a')).toBeNull();
    // …and the tile must still be navigable.
    expect(tiles(el)[0]!.querySelector('a') ?? tiles(el)[0]!.closest('a')).not.toBeNull();
  });

  it('surfaces a failure without removing the tile', async () => {
    await userLibrary().save(HTML, 'Chess Coach');
    vi.spyOn(db, 'deleteApp').mockRejectedValue(new Error('disk on fire'));
    const el = await renderHub();

    click(deleteButton(el));
    await settle();
    click(confirmButton(el));
    await settle();

    expect(el.querySelector('[role="alert"]')?.textContent ?? '').toMatch(/delete failed/i);
    expect(tiles(el)).toHaveLength(1);
  });
});
