// connectErrorSurfacing.test.tsx — TASK-20260812-registry-authoritative-auth, P2
// (AC7: the specific thrown message reaches the DOM per throw path; AC8: the
// ConnectScreen retry's rejection is HANDLED, never `void`-discarded).
//
// F1 — THE SWALLOW SITE. The ConnectScreen's sign-in button called
// `void startConnectionOAuthFlow({}, preOpened)`: every throw on that path — including
// paths that throw BEFORE any flow status is written — was discarded as an unhandled
// rejection, so the button did nothing visible. The sheet already renders
// `connectionFlowStatusStore`'s error state with a retry (`connect-error`), so the fix
// routes the catch there; these tests assert the LITERAL thrown copy in the DOM, per
// review MAJOR 6 ("an error region appears" passed before any fix — unfalsifiable).
//
// THE THREE PRE-STATUS THROW PATHS, each with its message text:
//  1. `approve this connection before signing in` — the B1 wall, row not approved;
//  2. `this connection does not sign you in` — a non-OAuth kind reached the connect
//     step (the split-brain D6 makes this reachable for a stored wrong-kind row);
//  3. `Missing required client credential: client_id` — the mint rethrow: the retry
//     passes `{}` as client creds, so any provider whose flow needs a client_id threw
//     on EVERY retry click and the void discarded it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { ConnectionWizardSheet } from '../connections/ConnectionWizardSheet.js';
import {
  __resetConnectionWizardForTests,
  connectionFlowStatusStore,
  connectionWizardStepStore,
  openConnectionWizard,
} from '../state/connectionWizard.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-p2-connect-errors';

// Fictional brands so the production admission gate (installed by the test helper)
// never trips a registry borrow — the pattern connectionWizard.test.tsx pins.
const oauthRequirement = {
  slot: 'tunecast',
  provider: { name: 'Tunecast' },
  kind: 'oauth2_auth_code',
  endpoints: {
    authorizeUrl: 'https://accounts.tunecast.example/authorize',
    tokenUrl: 'https://accounts.tunecast.example/api/token',
  },
  pkce: true,
  fields: [{ key: 'client_id', label: 'Client ID', type: 'text', required: true }],
  declaredApiHosts: ['api.tunecast.example'],
} as const satisfies Record<string, unknown>;

const apiKeyRequirement = {
  slot: 'meridian',
  provider: { name: 'Meridian Exchange' },
  kind: 'api_key',
  fields: [{ key: 'api_key', label: 'API key', type: 'secret', required: true }],
  declaredApiHosts: ['api.meridian-exchange.example'],
} as const satisfies Record<string, unknown>;

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

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderSheetAtConnect(requirement: Record<string, unknown>, opts: { approve?: boolean } = {}): Promise<void> {
  db.putDeclaredConnection(APP, requirement['slot'] as string, requirement, 'user' as never);
  if (opts.approve === true) db.approveConnection(APP, requirement['slot'] as string);
  openConnectionWizard({ appId: APP, slot: requirement['slot'] as string, source: 'directive' });
  connectionWizardStepStore.set('connect');

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ConnectionWizardSheet />);
  });
  await settle();
}

const text = (): string => container?.textContent ?? '';

function signInButton(): HTMLButtonElement {
  const button = [...(container?.querySelectorAll('button') ?? [])].find((candidate) =>
    /sign(ing)? in to/i.test(candidate.textContent ?? ''),
  );
  expect(button, 'the ConnectScreen must offer its sign-in button').toBeDefined();
  return button as HTMLButtonElement;
}

async function clickSignIn(): Promise<void> {
  await act(async () => {
    signInButton().click();
  });
  await settle();
}

describe('AC7 — each pre-status throw path renders its SPECIFIC message', () => {
  it("path 1: an unapproved row → 'approve this connection before signing in' reaches the DOM", async () => {
    await renderSheetAtConnect(oauthRequirement, { approve: false });
    await clickSignIn();

    const error = container?.querySelector('[data-testid="connect-error"]');
    expect(error, 'the throw must surface in the connect error region').not.toBeNull();
    expect(error?.textContent).toContain('approve this connection before signing in');
  });

  it("path 2: a non-OAuth kind at the connect step → 'this connection does not sign you in'", async () => {
    // Reachable in production for a stored wrong-kind row (the D6 split-brain made the
    // wizard route an api_key provider here before P1's fix; stored rows keep that
    // shape forward-only, so the copy must reach the user).
    await renderSheetAtConnect(apiKeyRequirement, { approve: true });
    await clickSignIn();

    const error = container?.querySelector('[data-testid="connect-error"]');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain('this connection does not sign you in');
  });

  it('path 3: the mint rethrow — the retry sends {} creds, and the missing client_id is SAID', async () => {
    await renderSheetAtConnect(oauthRequirement, { approve: true });
    await clickSignIn();

    const error = container?.querySelector('[data-testid="connect-error"]');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain('Missing required client credential: client_id');
  });
});

describe('AC8 — the retry rejection is HANDLED (regression pin on the void form)', () => {
  it('the click writes the flow status store instead of an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const recorder = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', recorder);
    try {
      await renderSheetAtConnect(oauthRequirement, { approve: true });
      await clickSignIn();
      // Give the microtask queue a beat so a discarded rejection would have reported.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(connectionFlowStatusStore.get().state, 'the throw must land in the status store').toBe('error');
      expect(unhandled, 'a future refactor back to `void f()` must fail HERE').toEqual([]);
      // And the user is offered a retry beside the message, not a dead end.
      expect(text()).toMatch(/try signing in to Tunecast again/i);
    } finally {
      process.off('unhandledRejection', recorder);
    }
  });
});
