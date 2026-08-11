// connectionRecovery.test.tsx — P3-AC10, REBUILT AS A BEHAVIORAL GATE (fold).
//
// WHAT THIS FILE REPLACES, and why the replacement was necessary. AC10 exists to close a
// carry-forward from P2: `createConnectionRequirementInferrer` shipped with NO production
// caller, so P2's AC7 ("inference never sees a credential") held only by test
// construction. The test written to close it walked the source tree for the string
// 'createConnectionRequirementInferrer' and asserted a non-empty hit list — which the
// adapter module satisfies by merely IMPORTING the identifier. Mutation proved the gap:
// renaming the single production wire (`recoverRequirement`, passed to
// `finalizeConnectionDeclaration` from `useBuilderChat`'s post-turn seam) restored the
// exact defect AC10 was written to close, and the whole playground suite stayed green.
//
// SO THIS FILE DRIVES THE SHIPPED PATH. It renders the REAL `useBuilderChat`, runs a REAL
// turn on the demo brain whose scripted reply writes a CONNECTED app and declares NOTHING,
// and asserts a row was recovered and persisted. Nothing here constructs a pipeline call
// by hand: every seam between the turn ending and the row landing is production code, so
// severing any one of them fails this test.
//
// WHY THE RECOVERY RUNS WITH NO MODEL. `guessConnectedHost` reads `api.spotify.com` out of
// the app's own code and `slotFromHost` derives the slot host-side; the inferrer's FIRST
// rung is the pinned registry, which resolves Spotify without touching the completion seam
// at all. That makes this test deterministic and offline while still exercising the
// production inferrer — the registry rung is production behavior, not a stub.
//
// C1 — the recovery runs at BUILD, strictly before any credential for the connection
// exists. This file writes no credential value anywhere, and the assertion that the
// persisted row carries only field KEYS and hosts is part of what it pins.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { useBuilderChat, type BuilderChat } from '../agent/useBuilderChat.js';
import { modeStore, providerStore } from '../state/mode.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;

interface Rendered {
  chat: () => BuilderChat;
  unmount: () => void;
}

function renderChat(): Rendered {
  const holder: { current: BuilderChat | null } = { current: null };
  function Harness(): ReactElement {
    holder.current = useBuilderChat('thr-recovery');
    return <span />;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness />);
  });
  return {
    chat: () => {
      if (holder.current === null) throw new Error('hook not rendered');
      return holder.current;
    },
    unmount: () => {
      act(() => root?.unmount());
      container?.remove();
      root = undefined;
      container = undefined;
    },
  };
}

/**
 * Drain until the post-turn seam has settled. The declaration finalizer is an AWAIT
 * INSIDE the turn's tail, so a single microtask flush lands mid-flight and would read a
 * DB that has not been written yet — the flakiest possible shape for exactly the
 * assertion this file makes. Polling for the row (with a bounded, honest give-up) keeps
 * the test deterministic without pretending the write is synchronous.
 */
async function settleUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    if (predicate()) return;
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * The `?demoreq=undeclared` variant is a URL flag read per call by `demoRequirementVariant`
 * — set it the way the browser would rather than reaching into the module.
 */
function setDemoVariant(variant: string | null): void {
  const url = new URL(window.location.href);
  if (variant === null) url.searchParams.delete('demoreq');
  else url.searchParams.set('demoreq', variant);
  window.history.replaceState({}, '', url);
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  // byok + the mock provider IS the demo brain: `createTurnAdapter` hands back the mock
  // adapter, which runs the scripted `?demoreq=` turn. This is the production selection
  // path, not a test override.
  modeStore.set('byok');
  providerStore.set('mock');
  db = await installTestUserDb();
  setDemoVariant('undeclared');
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  setDemoVariant(null);
  vi.restoreAllMocks();
});

describe('P3-AC10 — the v4 requirement inferrer runs on the SHIPPED post-turn path', () => {
  it('a connected build that declares NOTHING recovers a persisted requirement row', async () => {
    const r = renderChat();
    act(() => {
      r.chat().send('build me a spotify playlist browser');
    });

    // The app itself is the precondition: the turn must actually have written a connected
    // app, or a green result below would mean nothing.
    await settleUntil(() => db.listApps().length > 0, 'the app version to be written');
    const app = db.listApps()[0]!;
    expect(db.getAppHtml(app.appId) ?? '').toContain('useConnectedFetch');

    // THE ASSERTION THAT CLOSES THE CARRY-FORWARD: a row exists, and it exists because the
    // production seam reached the v4 inferrer. Nothing in this test constructed it.
    await settleUntil(
      () => db.listConnections(app.appId).length > 0,
      'the recovered connection row (the production recoverRequirement wire must fire)',
    );

    const rows = db.listConnections(app.appId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // The slot is HOST-derived (`api.spotify.com` → 'spotify'), never model-chosen: it is
    // half the primary key, so the model has no business picking it.
    expect(row.slot).toBe('spotify');
    expect(row.requirement.provider.name).toMatch(/spotify/i);
    // It lands `declared` — a recovered requirement is a REVIEWABLE STARTING POINT, never
    // an approval. The full strong review still stands between it and a credential.
    expect(row.status).toBe('declared');
    // Provenance is host-computed from the RUNG that answered. Spotify is pinned, so this
    // is 'registry' — and that must never read as a model guess, because it is not one.
    expect(row.provenance).toBe('registry');
  });

  it('the recovered row carries field KEYS and hosts only — no credential seat (C1, at build time)', async () => {
    const r = renderChat();
    act(() => {
      r.chat().send('build me a spotify playlist browser');
    });
    await settleUntil(() => db.listApps().length > 0, 'the app version to be written');
    const app = db.listApps()[0]!;
    await settleUntil(() => db.listConnections(app.appId).length > 0, 'the recovered connection row');

    const row = db.listConnections(app.appId)[0]!;
    // The ordering fact, asserted rather than asserted-about: at the moment recovery ran,
    // no credential for this connection could exist, because nothing has asked for one.
    expect(row.status).toBe('declared');
    for (const field of row.requirement.fields ?? []) {
      expect(Object.keys(field)).not.toContain('value');
    }
    // And the row's serialized form carries nothing that looks like a stored secret.
    expect(JSON.stringify(row.requirement)).not.toMatch(/"value"\s*:/);
  });

  it('a build that DECLARES its requirement never invokes recovery — the wire is the fallback, not the path', async () => {
    // The negative control. If recovery fired on every connected build, the first test
    // would pass while the declared path was quietly being overwritten by a guess.
    setDemoVariant('bearer');
    const r = renderChat();
    act(() => {
      r.chat().send('build me a weather app');
    });
    await settleUntil(() => db.listApps().length > 0, 'the app version to be written');
    const app = db.listApps()[0]!;
    await settleUntil(() => db.listConnections(app.appId).length > 0, 'the declared connection row');

    const rows = db.listConnections(app.appId);
    expect(rows).toHaveLength(1);
    // Declared by the model's own directive: the slot and provenance come from the
    // DECLARATION channel, not from the registry rung a recovery would have taken.
    expect(rows[0]!.slot).toBe('openweather');
    expect(rows[0]!.provenance).not.toBe('registry');
  });
});
