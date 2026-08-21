// versionsPanelDelete.test.tsx — TASK-20260821-ui-polish AC3/AC4, the UI half.
//
// The positive and its negatives live in ONE suite deliberately (plan review finding
// 15a): before this feature NO row had a delete control, so "pinned/current rows render
// none" was vacuously true — it only means something asserted beside "an eligible row
// renders one".

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { VersionsPanel } from '../run/VersionsPanel.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let db: UserDb;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

beforeEach(async () => {
  db = await installTestUserDb();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(appId: string): Promise<void> {
  await act(async () => {
    root.render(<VersionsPanel appId={appId} refreshToken={0} onReverted={() => {}} />);
  });
  await settle();
}

/** v1 pinned (install), v2 + v3 edits; current = 3. Only v2 is deletable. */
function seed(): string {
  const app = db.installApp({ displayName: 'A', html: '<html>v1</html>' });
  db.saveAppVersion(app.appId, '<html>v2</html>', 'edit 2', undefined);
  db.saveAppVersion(app.appId, '<html>v3</html>', 'edit 3', undefined);
  return app.appId;
}

const rowOf = (version: number): HTMLElement | undefined =>
  [...container.querySelectorAll<HTMLElement>('.version-row')].find((row) =>
    row.querySelector('.version-row-title')?.textContent?.startsWith(`v${version}`),
  );

function click(node: Element | null | undefined): void {
  expect(node, 'expected the element to exist before clicking it').not.toBeNull();
  expect(node).toBeDefined();
  act(() => {
    node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('per-version delete (AC3/AC4)', () => {
  it('offers delete on the eligible row and on NO pinned or current row — one claim, both halves', async () => {
    const appId = seed();
    await render(appId);

    expect(rowOf(2)?.querySelector('[data-testid="version-delete"]'), 'v2 is deletable').not.toBeNull();
    expect(rowOf(1)?.querySelector('[data-testid="version-delete"]'), 'v1 is pinned factory').toBeFalsy();
    expect(rowOf(3)?.querySelector('[data-testid="version-delete"]'), 'v3 is running').toBeFalsy();
  });

  it('delete → inline confirm → the row disappears and the DB row is gone', async () => {
    const appId = seed();
    await render(appId);

    click(rowOf(2)?.querySelector('[data-testid="version-delete"]'));
    // Two-step, inline — the design contract forbids window.confirm.
    click(container.querySelector('[data-testid="version-delete-confirm"]'));
    await settle();

    expect(rowOf(2)).toBeUndefined();
    expect(db.listAppVersions(appId).map((v) => v.version)).toEqual([3, 1]);
    // The running version is untouched.
    expect(db.getApp(appId)?.currentVersion).toBe(3);
  });

  it('the confirm can be dismissed without deleting', async () => {
    const appId = seed();
    await render(appId);

    click(rowOf(2)?.querySelector('[data-testid="version-delete"]'));
    click(container.querySelector('[data-testid="version-delete-cancel"]'));
    await settle();

    expect(db.listAppVersions(appId).map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it('a delete failure surfaces in the panel’s error note', async () => {
    const appId = seed();
    await render(appId);
    // Make the DB refuse (delete the row first behind the panel's back).
    db.deleteAppVersion(appId, 2);

    click(rowOf(2)?.querySelector('[data-testid="version-delete"]'));
    click(container.querySelector('[data-testid="version-delete-confirm"]'));
    await settle();

    expect(container.querySelector('.error-note')?.textContent).toMatch(/version/i);
  });
});
