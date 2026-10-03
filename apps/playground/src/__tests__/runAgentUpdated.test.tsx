// runAgentUpdated.test.tsx — TASK-20261003 K6 (ADR-0072 §3): a running app whose version
// changed underneath it offers "your agent updated this app — reload".
//
// On the local runner the agent hands a new version in while the user is INSIDE the app. The
// hand-in lands in the user's file at once (an unedited copy takes it — ADR-0045 §7), but the
// frame on screen was built from the old html and nothing told it. The run view now re-reads
// the app's code on a `libraryRevision` bump and, when it differs from what is mounted, says
// so and offers the reload. It never swaps the frame underneath the user: whatever they were
// doing in the app is theirs until they say so — and a reload asked for mid-think waits for
// the think, because a frame remounted then drops the reply it was promised.
import { act, useEffect } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { FRAME_TYPES, type Frame } from '@snugprotocol/protocol';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Each case cold-imports the real run view after `vi.resetModules()` (the runAvailability budget).
vi.setConfig({ testTimeout: 20_000 });

const V1 = '<!doctype html><html><head><title>Pomodoro</title></head><body>timer v1</body></html>';
const V2 = '<!doctype html><html><head><title>Pomodoro</title></head><body>timer v2</body></html>';

/** The app frame, stood in for: what it was mounted with, how often, and its `onFrame` seam. */
const frame: { html?: string; mounts: number; onFrame?: (direction: 'inbound' | 'outbound', frame: Frame) => void } = { mounts: 0 };

function FakeAppFrame(props: { html: string; onFrame?: (direction: 'inbound' | 'outbound', frame: Frame) => void }): ReactElement {
  useEffect(() => {
    frame.mounts += 1;
  }, []);
  frame.html = props.html;
  if (props.onFrame !== undefined) frame.onFrame = props.onFrame;
  return <div data-testid="fake-app-frame" />;
}

interface Harness {
  RunView: typeof import('../run/RunView.js')['default'];
  signals: typeof import('../platform/signals.js');
  db: UserDb;
  turn: number;
}

/** See hubAvailability.test.tsx: a timed-out test must not touch the next one's DOM or act queue. */
let turn = 0;
function stillMyTurn(mine: number): void {
  if (mine !== turn) throw new Error('this test was abandoned (it timed out) — it must not touch the next test’s modules or DOM');
}

async function fresh(): Promise<Harness> {
  const mine = turn;
  vi.resetModules();
  vi.doMock('@snugprotocol/runner', async (importOriginal) => ({ ...(await importOriginal<typeof import('@snugprotocol/runner')>()), SnugAppFrame: FakeAppFrame }));
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }),
  });
  localStorage.clear();
  sessionStorage.clear();
  frame.html = undefined;
  frame.mounts = 0;
  frame.onFrame = undefined;
  const helper = await import('./userdbTestHelper.js');
  stillMyTurn(mine);
  const db = await helper.installTestUserDb();
  stillMyTurn(mine);
  const signals = await import('../platform/signals.js');
  const run = await import('../run/RunView.js');
  stillMyTurn(mine);
  return { RunView: run.default, signals, db, turn: mine };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  turn++;
  if (root !== undefined) {
    const current = root;
    await act(async () => current.unmount());
  }
  container?.remove();
  container = undefined;
  root = undefined;
  vi.doUnmock('@snugprotocol/runner');
  vi.restoreAllMocks();
});

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function openApp(harness: Harness, id: string): Promise<void> {
  stillMyTurn(harness.turn);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[`/run/${id}`]}>
        <Routes>
          <Route path="/run/:id" element={<harness.RunView />} />
          <Route path="/" element={<div data-testid="hub-route" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settle();
}

const offer = (): HTMLElement | null => container?.querySelector<HTMLElement>('[data-testid="agent-updated"]') ?? null;
const reloadButton = (): HTMLButtonElement => {
  const button = container?.querySelector<HTMLButtonElement>('[data-testid="agent-updated-reload"]');
  if (button == null) throw new Error('no reload offer');
  return button;
};

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

/** What the runner's hand-in does to an unedited copy: a new version in the file, then the signal. */
async function handInV2(harness: Harness, appId: string): Promise<void> {
  harness.db.saveAppVersion(appId, V2, 'updated by your agent');
  await act(async () => harness.signals.bumpLibraryRevision());
  await settle();
}

describe('a running app whose version changed underneath it (K6)', () => {
  it('offers "your agent updated this app" — and does NOT swap the frame under the user', async () => {
    const harness = await fresh();
    const app = harness.db.installApp({ displayName: 'Pomodoro', html: V1 });
    await openApp(harness, app.appId);
    expect(frame.html).toBe(V1);
    expect(offer()).toBeNull();
    const mounts = frame.mounts;

    await handInV2(harness, app.appId);

    expect(offer()?.textContent).toContain('your agent updated this app');
    expect(reloadButton().textContent).toBe('reload');
    expect(frame.html, 'the running copy is still the one the user was in').toBe(V1);
    expect(frame.mounts, 'nothing remounted the frame').toBe(mounts);
  });

  it('the offer is a STRIP INSIDE the stage, above the frame — never a sibling of the stage in the layout’s row', async () => {
    // The run layout is a flex ROW (stage | divider | rail). The offer was first rendered as
    // a child of that row, where it became a full-height column: measured on the built page
    // 2026-10-03, it took 583 px from the app at 1280 and pushed the frame off-screen at 375
    // — the opposite of "what the user was doing in the app is theirs". The pixels are the
    // browser leg's (local-handin.spec.ts); the structure that produces them is pinned here.
    const harness = await fresh();
    const app = harness.db.installApp({ displayName: 'Pomodoro', html: V1 });
    await openApp(harness, app.appId);
    await handInV2(harness, app.appId);

    const note = offer();
    const stage = container?.querySelector('.run-stage');
    const header = container?.querySelector('.run-header');
    const frameWrap = container?.querySelector('[data-testid="frame-wrap"]');
    expect(note).not.toBeNull();
    expect(stage, 'the stage column').not.toBeNull();
    // Class names, not elements: a red here should print one word, not the whole run view.
    expect(note!.parentElement?.className, 'the offer’s parent is the stage column, not the layout row').toBe('run-stage');
    expect(note!.parentElement === stage).toBe(true);
    // Under the header (whose controls stay reachable) and above the frame it speaks about.
    expect(header!.compareDocumentPosition(note!) & Node.DOCUMENT_POSITION_FOLLOWING, 'after the run header').toBeTruthy();
    expect(note!.compareDocumentPosition(frameWrap!) & Node.DOCUMENT_POSITION_FOLLOWING, 'before the frame').toBeTruthy();
    expect(frameWrap!.parentElement === stage, 'the frame is its sibling in the same column').toBe(true);
  });

  it('reload takes the new version: the frame remounts on it and the offer goes', async () => {
    const harness = await fresh();
    const app = harness.db.installApp({ displayName: 'Pomodoro', html: V1 });
    await openApp(harness, app.appId);
    const mounts = frame.mounts;
    await handInV2(harness, app.appId);

    await click(reloadButton());
    await settle();

    expect(frame.html).toBe(V2);
    expect(frame.mounts).toBeGreaterThan(mounts);
    expect(offer()).toBeNull();
  });

  it('a library change that did not touch THIS app offers nothing', async () => {
    const harness = await fresh();
    const app = harness.db.installApp({ displayName: 'Pomodoro', html: V1 });
    await openApp(harness, app.appId);
    harness.db.installApp({ displayName: 'Chess', html: V2 });
    await act(async () => harness.signals.bumpLibraryRevision());
    await settle();
    expect(offer()).toBeNull();
    expect(frame.html).toBe(V1);
  });

  it('a new version with NO signal offers nothing — the view reads on the bump, it does not poll', async () => {
    const harness = await fresh();
    const app = harness.db.installApp({ displayName: 'Pomodoro', html: V1 });
    await openApp(harness, app.appId);
    harness.db.saveAppVersion(app.appId, V2, 'updated by your agent');
    await settle();
    expect(offer()).toBeNull();
  });

  it('a reload asked for MID-THINK waits for the think — then lands', async () => {
    const harness = await fresh();
    const app = harness.db.installApp({ displayName: 'Pomodoro', html: V1 });
    await openApp(harness, app.appId);
    expect(frame.onFrame).toBeDefined();
    // The app asked its brain something and the reply has not come back.
    const message = { v: 1, type: FRAME_TYPES.appMessage, requestId: 'req-1', instanceId: 'i', appId: 'a', action: 'move', payload: {}, state: {} } as unknown as Frame;
    await act(async () => frame.onFrame!('inbound', message));
    await handInV2(harness, app.appId);
    const mounts = frame.mounts;

    await click(reloadButton());
    await settle();
    expect(frame.html, 'a frame remounted mid-think would drop the reply').toBe(V1);
    expect(frame.mounts).toBe(mounts);
    expect(reloadButton().disabled).toBe(true);
    expect(reloadButton().textContent).toMatch(/finishes thinking/);

    // The reply lands; the reload the user asked for happens now.
    const reply = { v: 1, type: FRAME_TYPES.appResponse, requestId: 'req-1', instanceId: 'i', ok: true, streaming: false, data: {} } as unknown as Frame;
    await act(async () => frame.onFrame!('outbound', reply));
    await settle();
    expect(frame.html).toBe(V2);
    expect(offer()).toBeNull();
  });
});
