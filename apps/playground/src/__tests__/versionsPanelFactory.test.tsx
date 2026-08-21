// versionsPanelFactory.test.tsx — TASK-20260820-starter-updates (ADR-0045), AC8b.
//
// With plural factory pins (install v1 + one pin per starter update), the panel's
// banner and reset target must follow the NEWEST pin — the same version
// `resetToFactory` restores since the MIN→MAX change — while every pinned row keeps its
// `factory` tag (each IS a factory snapshot). This pins the `find`-on-DESC selection
// that previously happened to be correct only because exactly one pin could exist.

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

async function render(appId: string, onReverted: (v: number) => void = () => {}): Promise<void> {
  await act(async () => {
    root.render(<VersionsPanel appId={appId} refreshToken={0} onReverted={onReverted} />);
  });
  await settle();
}

describe('plural factory pins (ADR-0045)', () => {
  it('the banner names the NEWEST pin and reset restores it; every pin keeps the factory tag', async () => {
    const app = db.installApp({ displayName: 'A', html: '<html>FACTORY-v1</html>' });
    db.saveAppVersion(app.appId, '<html>FACTORY-v2</html>', 'starter update to v2', undefined, { pinned: true });
    db.saveAppVersion(app.appId, '<html>user edit</html>');
    const reverted: number[] = [];
    await render(app.appId, (v) => reverted.push(v));

    const banner = container.querySelector('.factory-reset');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('v2 is pinned forever');

    expect(container.querySelectorAll('.version-tag-factory')).toHaveLength(2);

    const resetButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'reset to factory');
    act(() => resetButton!.click());
    await settle();
    expect(db.getAppHtml(app.appId)).toBe('<html>FACTORY-v2</html>');
    expect(reverted).toHaveLength(1);
  });

  it('single-pin apps read exactly as before', async () => {
    const app = db.installApp({ displayName: 'A', html: '<html>FACTORY</html>' });
    db.saveAppVersion(app.appId, '<html>edit</html>');
    await render(app.appId);
    expect(container.querySelector('.factory-reset')!.textContent).toContain('v1 is pinned forever');
    expect(container.querySelectorAll('.version-tag-factory')).toHaveLength(1);
  });
});
