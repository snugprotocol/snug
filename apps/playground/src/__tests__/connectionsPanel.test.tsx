// AL-03 D5 — the minimal Connections settings panel (the PERMANENT settings seat;
// AL-04's wizard replaces its approval INNARDS, the panel itself survives). Lists each
// app's auth spec (kind, provider, FULL frozen host list, status) with Approve /
// Re-approve / Revoke wired to the AL-02 db accessors, and invalidates remembered net
// grants on every approval transition (R3). The mutating-call confirm dialog is
// covered by netState.test.ts + confirmDialog.test.tsx.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UserDbCredentialStore } from '@snugprotocol/auth';

import { ConnectionsCard } from '../views/SettingsView.js';
import { installTestUserDb } from './userdbTestHelper.js';
import { getUserDb } from '../state/userdb.js';
import * as net from '../state/net.js';
import * as wizard from '../state/wizard.js';

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
  wizard.__resetWizardStateForTests();
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

  it('AL-04 AC9: Approve OPENS THE WIZARD (connect) — the transition happens inside it', async () => {
    await seed('unapproved');
    const db = await getUserDb();
    const approve = vi.spyOn(db, 'approveAuthSpec');
    await renderPanel();
    const approveButton = [...container.querySelectorAll('button')].find((b) => /approve/i.test(b.textContent ?? ''));
    expect(approveButton).toBeDefined();
    await act(async () => {
      approveButton!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    // The panel button no longer approves directly — the wizard owns the innards
    // (and its approval action is what calls invalidateNetGrants, tested in
    // authWizard.test.tsx — AL-03's R3/M23 guard stays red-capable there).
    expect(approve).not.toHaveBeenCalled();
    expect(wizard.wizardStore.get()).toMatchObject({ appId: APP, mode: 'connect', source: 'settings' });
  });

  it('AL-04 AC12/B1 companion: approveWizardSpec on the seeded row still drops grants (the R3 wall, in its new seat)', async () => {
    await seed('unapproved');
    const db = await getUserDb();
    const approve = vi.spyOn(db, 'approveAuthSpec');
    const invalidate = vi.spyOn(net, 'invalidateNetGrants');
    wizard.openWizard({ source: 'settings', appId: APP, mode: 'connect' });
    const result = await wizard.approveWizardSpec();
    expect(result.ok).toBe(true);
    expect(approve).toHaveBeenCalledWith(APP);
    expect(invalidate).toHaveBeenCalledWith(APP);
  });

  it('AL-04 D5: editing an APPROVED row routes through reapproveAuthSpec — the HostFreezeViolation split never fires as a surprise', async () => {
    await seed('approved');
    const db = await getUserDb();
    const reapprove = vi.spyOn(db, 'reapproveAuthSpec');
    wizard.openWizard({ source: 'settings', appId: APP, mode: 'connect' });
    // A changed union on an approved row: putAuthSpec would throw HostFreezeViolation;
    // the wizard's approve action must take the reapprove path instead.
    const result = await wizard.approveWizardSpec({ ...spec, declaredApiHosts: ['api.example.com', 'api.widened.example'] });
    expect(result.ok).toBe(true);
    expect(reapprove).toHaveBeenCalledTimes(1);
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

  it("AL-04 (AL-03 sweep follow-up): Revoke ALSO wipes the app's credential slice — no zombie value survives to a re-approval", async () => {
    await seed('approved');
    const db = await getUserDb();
    const store = new UserDbCredentialStore(db);
    await store.setCredential(APP, 'api_key', 'zombie-credential-000');
    await renderPanel();
    const revokeButton = [...container.querySelectorAll('button')].find((b) => /revoke/i.test(b.textContent ?? ''));
    await act(async () => {
      revokeButton!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    // Before this child, deleteAuthSpec left auth:<appId>:* intact — a re-declared +
    // re-approved spec for the same appId would resume injecting the OLD credential
    // without re-entry (probe-confirmed by AL-03's live sweep). Fail closed: gone.
    expect(await store.getCredential(APP, 'api_key')).toBeUndefined();
  });

  it('an approved row offers Re-approve, which opens the wizard in reapprove mode (AC9)', async () => {
    await seed('approved');
    await renderPanel();
    const reapproveButton = [...container.querySelectorAll('button')].find((b) => /re-approve/i.test(b.textContent ?? ''));
    expect(reapproveButton).toBeDefined();
    await act(async () => {
      reapproveButton!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(wizard.wizardStore.get()).toMatchObject({ appId: APP, mode: 'reapprove', source: 'settings' });
  });
});
