// accessReannounce.test.tsx — AC11's re-announce clause at the altitude that owns it
// (TASK-20261010-cross-app-access W6 fix lane, finding 11). The handler never sees announces (its
// row "a reader that RE-ANNOUNCES" pins that the pending SURVIVES a fresh instanceId at that
// altitude), so the dismiss lives in RunView's `onAnnounce`: a (re-)announce is a fresh app
// instance in this frame, and an APP ask the previous instance left on the strip has nobody to
// answer it — dismissed (`ACCESS_DECLINED` retryable at the engine), nothing recorded; an ask the
// USER started is theirs and survives. Mutation: drop the `dismissPendingAccess` call in
// RunView's `onAnnounce` → the first row reds.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';

import { parkAccessRequest, pendingAccessStore, type ConsentOutcome } from '../access/consent.js';
import { __setAccessDepsForTests, readerGeneration, resetAccessSession } from '../access/grants.js';
import { rankSources } from '../access/relevance.js';
import RunView from '../run/RunView.js';
import { modeStore } from '../state/mode.js';
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

async function mountRun(id: string): Promise<HTMLIFrameElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[`/run/${id}`]}>
        <Routes>
          <Route path="/run/:id" element={<RunView />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 20 && container.querySelector('iframe') === null; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  const iframe = container.querySelector<HTMLIFrameElement>('iframe');
  if (iframe === null) throw new Error('the app frame did not mount');
  return iframe;
}

/** A frame from the app, as the runner meets it: `source` is the app's own window. */
async function announce(iframe: HTMLIFrameElement): Promise<void> {
  const data = { v: PROTOCOL_VERSION, type: FRAME_TYPES.announce, appId: 'budget', displayName: 'Budget' };
  let event: MessageEvent;
  try {
    event = new MessageEvent('message', { data, source: iframe.contentWindow });
  } catch {
    event = new MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: iframe.contentWindow });
  }
  await act(async () => {
    window.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

/** Park one ask for Budget on the strip, as the engine would; answers what the held ask was settled with. */
function park(provenance: 'app' | 'user'): { outcomes: ConsentOutcome[] } {
  const outcomes: ConsentOutcome[] = [];
  const reader = db.getApp(budget)!;
  act(() => {
    parkAccessRequest({
      db,
      reader,
      generation: readerGeneration(budget) ?? -1,
      purpose: 'to show spending by category',
      provenance,
      candidates: rankSources({ readerAppId: budget, apps: [] }),
      settle: (outcome) => outcomes.push(outcome),
    });
  });
  return { outcomes };
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  modeStore.set('subscription');
  resetAccessSession();
  db = await installTestUserDb();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db) });
  budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title><p>budget</p>' }).appId;
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  resetAccessSession();
  __setAccessDepsForTests();
});

describe('AC11 — a re-announce dismisses the APP ask the previous instance left (W6 finding 11)', () => {
  it('a second announce in the same frame dismisses the app ask: nothing recorded, the strip empty', async () => {
    const iframe = await mountRun(budget);
    await announce(iframe);
    const { outcomes } = park('app');
    expect(pendingAccessStore.get()[budget]?.provenance).toBe('app');
    await announce(iframe); // a fresh app instance in the same frame generation
    expect(pendingAccessStore.get()[budget]).toBeUndefined();
    expect(outcomes).toEqual([{ kind: 'dismissed' }]);
    expect(db.listAccessDeclines(budget)).toEqual([]);
    expect(db.isAccessMuted(budget)).toBe(false);
  });

  it('the twin: an ask the USER started survives the same announce', async () => {
    const iframe = await mountRun(budget);
    await announce(iframe);
    const { outcomes } = park('user');
    await announce(iframe);
    expect(pendingAccessStore.get()[budget]?.provenance).toBe('user');
    expect(outcomes).toEqual([]);
  });
});
