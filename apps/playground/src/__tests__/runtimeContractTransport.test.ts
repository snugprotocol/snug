/**
 * TASK-20260811-lean-runtime-data-chat, P1 — the app transport assembles runtime turns
 * from the CONTRACT, not from the builder assembly (ADR-0018, AC-F1-1/-F1-4).
 *
 * TESTED AT THE CALL SITE, deliberately (lessons 2026-08-05). The decision "which system
 * prompt does an app turn get" is made here, in `transport.ts`, so that is where it is
 * asserted — not at the adapter, which would pass just as happily with the wrong prompt.
 * The `onLlmEvent` round-trip feed carries `request.system` verbatim, which is the exact
 * bytes that went to the model.
 *
 * PER-SEND, NOT PER-CONSTRUCTION (fold F-M1). The plan originally assumed a `contentEpoch`
 * dependency would refresh the transport; recon proved no such refresh exists. Instead the
 * contract is read INSIDE `send()`, exactly as the brain/settings stores already are for
 * the reason recorded in the 2026-08-06 adversarial review — a value captured at creation
 * is frozen for the life of the memo, and RunView memoizes this transport.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { AgentRoundTrip, AgentTurnEvent } from '@snugprotocol/adapters';
import { runtimeContractSchema } from '@snugprotocol/protocol';

import { createDirectAppTransport } from '../agent/transport.js';
import { getUserDb } from '../state/userdb.js';
import { installTestUserDb } from './userdbTestHelper.js';

const CONTRACT = runtimeContractSchema.parse({
  overview: 'A chess app. You are the opponent; reply with one legal move.',
  responseGuidance: 'Reply {"move":"e2e4"}.',
});

const REVERTED_CONTRACT = runtimeContractSchema.parse({
  overview: 'The ORIGINAL chess contract from version one.',
});

/** Collect the round trips a send produces, so `request.system` can be asserted. */
function tripCollector(): { trips: AgentRoundTrip[]; onLlmEvent: (event: AgentTurnEvent) => void } {
  const trips: AgentRoundTrip[] = [];
  return {
    trips,
    onLlmEvent: (event) => {
      if (event.type === 'round_trip') {
        const { type: _type, ...trip } = event;
        trips.push(trip);
      }
    },
  };
}

const send = async (appId?: string): Promise<AgentRoundTrip[]> => {
  const { trips, onLlmEvent } = tripCollector();
  const transport = createDirectAppTransport({
    mode: 'byok',
    provider: 'mock',
    needsConfirm: () => false,
    ...(appId !== undefined ? { appId } : {}),
    onLlmEvent,
  });
  await transport.send(JSON.stringify({ type: 'chat', text: 'I play e4' }), {
    signal: new AbortController().signal,
  });
  return trips;
};

beforeEach(async () => {
  await installTestUserDb();
});

describe('AC-F1-1 — a runtime turn is assembled from the contract, never from the authoring layers', () => {
  it('sends the runtime layers and the contract, and NONE of the app-builder assembly', async () => {
    const db = await getUserDb();
    const app = db.installApp({ displayName: 'Chess', html: '<html>v1</html>' });
    db.putRuntimeContract(app.appId, app.currentVersion, CONTRACT);

    const trips = await send(app.appId);
    const system = trips[0]?.request.system ?? '';

    // The contract reached the system slot...
    expect(system).toContain('A chess app. You are the opponent; reply with one legal move.');
    expect(system).toContain('Reply {"move":"e2e4"}.');
    // ...the runtime doctrine layer is present...
    expect(system).toContain('You Are Running Inside an App');
    // ...and the authoring instructions a move cannot act on are GONE. This string is
    // from 30-app-builder-summary, the layer whose presence on every Chess move is the
    // defect this task exists to fix.
    expect(system).not.toContain('Snug App Builder');
  });

  it('carries the envelope as the ONLY message — no history, no authoring conversation', async () => {
    const db = await getUserDb();
    const app = db.installApp({ displayName: 'Chess', html: '<html>v1</html>' });
    db.putRuntimeContract(app.appId, app.currentVersion, CONTRACT);

    const trips = await send(app.appId);

    expect(trips[0]?.request.messages).toHaveLength(1);
    expect(trips[0]?.request.messages[0]?.role).toBe('user');
  });
});

describe('AC-F1-4 — a contract-less app is unchanged', () => {
  it('an app with no contract still gets the lean runtime layers (never the builder ones)', async () => {
    // D1 is independent of D2: dropping the builder assembly is right for EVERY app turn,
    // contract or not. What a contract-less app must not get is a fabricated contract.
    const db = await getUserDb();
    const app = db.installApp({ displayName: 'Plain', html: '<html>v1</html>' });

    const trips = await send(app.appId);
    const system = trips[0]?.request.system ?? '';

    expect(system).toContain('You Are Running Inside an App');
    expect(system).not.toContain('Snug App Builder');
    // NB: the 45-app-runtime layer itself MENTIONS `## About This App` (it tells the
    // model how to treat that section when present), so absence is asserted on the
    // rendered contract's own body, not on the heading string.
    expect(system).not.toContain(CONTRACT.overview);
  });

  it('a transport built with no appId at all still works (uninstalled starters)', async () => {
    // RunView runs uninstalled starters against an ephemeral DB; those have no app row,
    // so the transport must degrade rather than throw.
    const trips = await send(undefined);
    expect(trips).not.toHaveLength(0);
    expect(trips[0]?.request.system ?? '').not.toContain(CONTRACT.overview);
  });

  it('an unknown appId degrades to contract-less rather than throwing', async () => {
    const trips = await send('no-such-app');
    expect(trips).not.toHaveLength(0);
    expect(trips[0]?.request.system ?? '').not.toContain(CONTRACT.overview);
  });
});

describe('F-M1 — the contract is read PER SEND, not captured at construction', () => {
  it('turn → revert → turn: the second turn carries the REVERTED contract', async () => {
    const db = await getUserDb();
    const app = db.installApp({ displayName: 'Chess', html: '<html>v1</html>' });
    db.putRuntimeContract(app.appId, 1, REVERTED_CONTRACT);
    const v2 = db.saveAppVersion(app.appId, '<html>v2</html>');
    db.putRuntimeContract(app.appId, v2.version, CONTRACT);

    // ONE transport instance across both sends — this is what RunView's memo does.
    const { trips, onLlmEvent } = tripCollector();
    const transport = createDirectAppTransport({
      mode: 'byok',
      provider: 'mock',
      needsConfirm: () => false,
      appId: app.appId,
      onLlmEvent,
    });
    const wire = JSON.stringify({ type: 'chat', text: 'I play e4' });
    const signal = new AbortController().signal;

    await transport.send(wire, { signal });
    expect(trips[0]?.request.system).toContain('A chess app. You are the opponent');

    db.revertApp(app.appId, 1);

    await transport.send(wire, { signal });
    // A construction-time read would still be serving the v2 contract here.
    expect(trips[1]?.request.system).toContain('The ORIGINAL chess contract from version one.');
    expect(trips[1]?.request.system).not.toContain('You are the opponent');
  });
});
