// netErrorCtaVisibility.test.tsx — TASK-20260812-registry-authoritative-auth, P2
// (AC11: the net-error CTA never silently no-ops; AC12's run-time half).
//
// F4 — THE OWNER'S ACTUAL BUG. Opening an app whose connection row never persisted
// shows the NET_NOT_APPROVED banner; clicking "connect this app" called
// `openConnectionWizardForApp`, which returned `false` at the zero-rows guard — and
// `false` produced NOTHING: no wizard, no note, no state change. A CTA whose only
// failure mode is silence is F1's bug class one layer up, and it is what the owner hit.
//
// THE FIX HAS TWO HALVES, both asserted here at the decision altitude:
//  1. the zero-row refusal WRITES an explanation (why there is nothing to connect, and
//     a route forward) into `connectionWizardNoteStore`;
//  2. that store finally has a RENDERER (`ConnectionWizardNote`, mounted beside the
//     sheet) — it had none at all, so even the pre-existing "wizard already open"
//     refusal was silent in the UI. One renderer fixes the silence CLASS, not just F4.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NET_ERROR_CODES } from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';

import { ConnectionWizardNote } from '../connections/ConnectionWizardNote.js';
import {
  __resetConnectionWizardForTests,
  connectionWizardNoteStore,
  openConnectionWizard,
  openConnectionWizardForApp,
  openConnectionWizardForNetError,
} from '../state/connectionWizard.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;

beforeEach(async () => {
  db = await installTestUserDb();
  __resetConnectionWizardForTests();
});

afterEach(async () => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  __resetConnectionWizardForTests();
  await db.close();
});

async function renderNote(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ConnectionWizardNote />);
  });
}

const text = (): string => container?.textContent ?? '';

describe('AC11 — the zero-row net-error CTA produces a VISIBLE outcome, never silence', () => {
  it('openConnectionWizardForNetError on an app with ZERO rows refuses WITH an explanation', async () => {
    // The zero-row fixture: the app exists conceptually but no connection row was ever
    // persisted — the exact state the owner's Coinbase app was in.
    expect(db.listConnections('app-rowless')).toEqual([]);

    const opened = await openConnectionWizardForNetError('app-rowless', NET_ERROR_CODES.NET_NOT_APPROVED);

    expect(opened, 'the contract stays boolean — no wizard opened').toBe(false);
    const note = connectionWizardNoteStore.get();
    expect(note, 'a refusal must leave the user an explanation, never silence').not.toBeNull();
    // The explanation must say WHY (nothing to connect) and name a ROUTE FORWARD (ask
    // the app's agent to declare the connection) — not merely apologize.
    expect(note).toMatch(/no connection/i);
    expect(note).toMatch(/ask|agent|chat/i);
  });

  it('the explanation RENDERS — the note store has an actual DOM surface', async () => {
    await renderNote();
    expect(text()).toBe('');

    await act(async () => {
      await openConnectionWizardForNetError('app-rowless', NET_ERROR_CODES.NET_NOT_APPROVED);
    });

    const alert = container?.querySelector('[data-testid="connection-wizard-note"]');
    expect(alert, 'the note must render as a visible alert').not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(text()).toMatch(/no connection/i);
  });

  it('the note is dismissible, and dismissing clears the store', async () => {
    await renderNote();
    await act(async () => {
      await openConnectionWizardForNetError('app-rowless', NET_ERROR_CODES.NET_NOT_APPROVED);
    });
    const dismiss = [...(container?.querySelectorAll('button') ?? [])].find((candidate) =>
      /dismiss|ok/i.test(candidate.textContent ?? ''),
    );
    expect(dismiss, 'the note must offer a way out').toBeDefined();
    await act(async () => {
      dismiss!.click();
    });
    expect(connectionWizardNoteStore.get()).toBeNull();
    expect(text()).toBe('');
  });

  it('a successful open CLEARS any stale note (the note never lies next to a live wizard)', async () => {
    connectionWizardNoteStore.set('stale note from an earlier refusal');
    openConnectionWizard({ appId: 'app-a', slot: 'coinbase', source: 'error_cta' });
    expect(connectionWizardNoteStore.get()).toBeNull();
  });

  it("the pre-existing 'wizard already open' refusal renders through the SAME surface", async () => {
    // The silence class, not just F4: this refusal wrote the note before this task, but
    // no surface showed it. One renderer covers every refusal reason.
    await renderNote();
    openConnectionWizard({ appId: 'app-a', slot: 'coinbase', source: 'directive' });
    await act(async () => {
      openConnectionWizard({ appId: 'app-b', slot: 'spotify', source: 'directive' });
    });
    expect(text()).toMatch(/already open/i);
  });
});

describe('AC12 (run-time half) — connected-but-rowless is never a dead end', () => {
  it('openConnectionWizardForApp itself explains the zero-row refusal on every source', async () => {
    // The CTA is one caller; the chat card and settings are others. The explanation is
    // written where the DECISION is made (the zero-row guard), so no caller can strand
    // the user by forgetting to translate `false`.
    const opened = await openConnectionWizardForApp('app-rowless', 'directive');
    expect(opened).toBe(false);
    expect(connectionWizardNoteStore.get()).toMatch(/no connection/i);
  });
});
