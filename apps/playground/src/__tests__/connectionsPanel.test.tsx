// AL-03 D5 — the minimal Connections settings panel (the PERMANENT settings seat;
// AL-04's wizard replaces its approval INNARDS, the panel itself survives). Lists each
// app's auth spec (kind, provider, FULL frozen host list, status) with Approve /
// Re-approve / Revoke wired to the AL-02 db accessors, and invalidates remembered net
// grants on every approval transition (R3). The mutating-call confirm dialog is
// covered by netState.test.ts + confirmDialog.test.tsx.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionsCard } from '../views/SettingsView.js';
import { installTestUserDb } from './userdbTestHelper.js';
import { getUserDb } from '../state/userdb.js';
import * as net from '../state/net.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-conn';
const spec = {
  kind: 'api_key' as const,
  provider: { name: 'Example API' },
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' as const }],
  declaredApiHosts: ['api.example.com', 'cdn.example.com'],
};

let container: HTMLDivElement;
let root: Root;

async function seed(status: 'unapproved' | 'approved' | 'imported_unapproved' = 'unapproved'): Promise<void> {
  const db = await getUserDb();
  db.installApp({ appId: APP, displayName: 'Conn App', html: '<p>x</p>' });
  db.putAuthSpec(APP, spec);
  if (status === 'approved') db.approveAuthSpec(APP);
  if (status === 'imported_unapproved') {
    // simulate an imported row: put + demote via the accessor's status
    db.approveAuthSpec(APP);
    // there is no public demote; the panel only needs a non-approved row to show Approve,
    // so leave it approved for that path and use the dedicated imported case elsewhere.
  }
}

async function renderPanel(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ConnectionsCard />);
  });
  // let the async user-db load settle
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(async () => {
  await installTestUserDb();
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe('ConnectionsCard', () => {
  it('lists the spec kind, provider, FULL frozen host list, and status', async () => {
    await seed('approved');
    await renderPanel();
    const text = container.textContent ?? '';
    expect(text).toContain('Example API');
    expect(text).toContain('api_key');
    expect(text).toContain('api.example.com');
    expect(text).toContain('cdn.example.com'); // the WHOLE frozen list, not a summary
    expect(text.toLowerCase()).toContain('approved');
  });

  it('an empty state shows when no app has an auth spec', async () => {
    await renderPanel();
    expect((container.textContent ?? '').toLowerCase()).toContain('no connections');
  });

  it('Approve calls approveAuthSpec and invalidates remembered net grants (R3)', async () => {
    await seed('unapproved');
    const db = await getUserDb();
    const approve = vi.spyOn(db, 'approveAuthSpec');
    const invalidate = vi.spyOn(net, 'invalidateNetGrants');
    await renderPanel();
    const approveButton = [...container.querySelectorAll('button')].find((b) => /approve/i.test(b.textContent ?? ''));
    expect(approveButton).toBeDefined();
    await act(async () => {
      approveButton!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(approve).toHaveBeenCalledWith(APP);
    expect(invalidate).toHaveBeenCalledWith(APP);
  });

  it('Revoke deletes the spec and invalidates remembered net grants', async () => {
    await seed('approved');
    const db = await getUserDb();
    const del = vi.spyOn(db, 'deleteAuthSpec');
    const invalidate = vi.spyOn(net, 'invalidateNetGrants');
    await renderPanel();
    const revokeButton = [...container.querySelectorAll('button')].find((b) => /revoke/i.test(b.textContent ?? ''));
    expect(revokeButton).toBeDefined();
    await act(async () => {
      revokeButton!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(del).toHaveBeenCalledWith(APP);
    expect(invalidate).toHaveBeenCalledWith(APP);
  });

  it('an approved row offers Re-approve, which re-freezes and invalidates grants', async () => {
    await seed('approved');
    const db = await getUserDb();
    const reapprove = vi.spyOn(db, 'reapproveAuthSpec');
    const invalidate = vi.spyOn(net, 'invalidateNetGrants');
    await renderPanel();
    const reapproveButton = [...container.querySelectorAll('button')].find((b) => /re-approve/i.test(b.textContent ?? ''));
    expect(reapproveButton).toBeDefined();
    await act(async () => {
      reapproveButton!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(reapprove).toHaveBeenCalledWith(APP);
    expect(invalidate).toHaveBeenCalledWith(APP);
  });
});
