/**
 * TASK-20260815-provider-chat-lane AC12 (plan-review F3; Gate-5 MAJOR-2) — the
 * mutating-request confirm renders from the APP SHELL, not from RunView.
 *
 * The confirm gate's callers are no longer only RunView's app frame: a provider-lane
 * chat turn can park a confirm from ANY route the routed chat runs on. A mount the
 * current route doesn't render is a promise that never settles — the executor awaits a
 * dialog nobody shows. So the regression this file pins is: park a confirm while the
 * App is on a NON-Run route, and the dialog is on screen.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authConnectionCredentialSecretKey } from '@snugprotocol/db';

import { App } from '../App.js';
import { installTestUserDb } from './userdbTestHelper.js';
import { createNetHandlerFor, netConfirmStore, resolveNetConfirm, __resetNetStateForTests } from '../state/net.js';
import { getUserDb } from '../state/userdb.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP_ID = 'app-shell-confirm';
const HOST = 'api.shellconfirm.example';

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(async () => {
  __resetNetStateForTests();
  const db = await installTestUserDb();
  db.installApp({ appId: APP_ID, displayName: 'Shell Confirm App', html: '<p>x</p>' });
  db.setSecret(authConnectionCredentialSecretKey(APP_ID, 's', 'api_key'), 'k-shell');
  db.putDeclaredConnection(
    APP_ID,
    's',
    {
      slot: 's',
      kind: 'api_key' as const,
      provider: { name: 'Shell Service' },
      fields: [{ key: 'api_key', label: 'API key', type: 'secret' as const }],
      request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
      declaredApiHosts: [HOST],
    },
    'inference',
  );
  db.approveConnection(APP_ID, 's');
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  __resetNetStateForTests();
  vi.restoreAllMocks();
});

describe('AC12 — the confirm dialog is an app-shell mount', () => {
  it('a confirm parked while the shell shows /build renders the dialog (and resolves it)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={['/build']}>
          <App />
        </MemoryRouter>,
      );
    });

    // Sanity: we are NOT on the Run route — the builder surface is what rendered.
    expect(container.textContent).not.toContain('this app wants to make a change');

    // Park a confirm exactly the way any executor caller does (a POST through the gate).
    void getUserDb(); // keep the page db warm — the handler reads it per call
    const handler = createNetHandlerFor({ fetchImpl: async () => new Response('ok', { status: 200 }) });
    const write = handler.handle(APP_ID, {
      v: 1,
      type: 'snug:net-request',
      requestId: 'r-shell-1',
      instanceId: 'ins-1',
      url: `https://${HOST}/v1/change`,
      method: 'POST',
      body: '{}',
    });

    await act(async () => {
      await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    });
    // THE assertion: the dialog is on screen without RunView anywhere in the tree.
    expect(container.textContent).toContain('this app wants to make a change');
    expect(container.textContent).toContain(HOST);

    await act(async () => {
      resolveNetConfirm({ granted: false });
    });
    await expect(write).resolves.toMatchObject({ ok: false, code: 'NET_CONFIRM_DENIED' });
    expect(container.textContent).not.toContain('this app wants to make a change');
  });
});
