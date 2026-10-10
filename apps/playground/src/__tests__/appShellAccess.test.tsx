/**
 * TASK-20261010-cross-app-access AC20 — the consent sheet is an APP-SHELL mount, beside
 * `NetConfirmDialog` (the appShellNetConfirm.test.tsx precedent).
 *
 * The sheet is opened from more than the run view: Settings' *let Budget read another app…*
 * and the reader's access sheet park an ask and open the review while the user is on some other
 * route. A sheet mounted only by RunView would be a review nobody can see. So: park an ask and
 * open its review while the App is on a NON-Run route, and the sheet is on screen.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';

import { App } from '../App.js';
import { pendingAccessStore, reviewStore } from '../access/consent.js';
import { CONSENT_SHEET } from '../access/copy.js';
import { __setAccessDepsForTests, resetAccessSession } from '../access/grants.js';
import { startUserAsk } from '../access/userAsk.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;
let budget: string;
let ledger: string;

beforeEach(async () => {
  resetAccessSession();
  db = await installTestUserDb();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db) });
  budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
  ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
  await db.applyAppDdl(ledger, ['CREATE TABLE transactions (amount INTEGER)']);
  await db.driver.handle(ledger, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: 'seed-1', instanceId: 'seed', op: 'exec', sql: 'INSERT INTO transactions VALUES (1)' });
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  resetAccessSession();
  __setAccessDepsForTests();
  vi.restoreAllMocks();
});

describe('AC20 — the consent sheet renders from the App shell', () => {
  it('an ask opened for review while the shell shows /build puts the sheet on screen (and not now closes it)', async () => {
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

    // The user's own act is headlined as theirs — never "Budget wants …" (W6 finding 35).
    const title = CONSENT_SHEET.userTitle('Budget');
    expect(document.body.textContent).not.toContain(title);

    // The host-chrome creation act: parks the ask and opens its review — no RunView anywhere.
    await act(async () => {
      await startUserAsk(budget);
    });
    expect(reviewStore.get()).toBe(budget);

    await act(async () => {
      await vi.waitFor(() => expect(document.querySelector('[data-testid="access-consent-sheet"]')).not.toBeNull());
    });
    expect(document.body.textContent).toContain(title);
    // The one app with data is offered (and, alone, chosen).
    expect(document.querySelector<HTMLInputElement>(`[data-testid="access-source-${ledger}"]`)?.checked).toBe(true);

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="access-not-now"]')!.click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(document.querySelector('[data-testid="access-consent-sheet"]')).toBeNull());
    });
    expect(pendingAccessStore.get()[budget]).toBeUndefined();
  });
});
