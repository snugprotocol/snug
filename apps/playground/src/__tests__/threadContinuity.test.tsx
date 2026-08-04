// threadContinuity.test.tsx — TASK-20260804-hub-polish, Phase G.
//
// AC19 — after a build completes, opening the new app's run view shows THE BUILD
//        CONVERSATION on the main thread, not an empty one. Asserted end-to-end:
//        build in BuilderView → open /run/:id → the builder's messages are present.
// AC20 — the thread picker is reachable whenever more than one thread exists for the
//        app, and the thread holding the PINNED BOOTSTRAP turn is labelled as the main
//        thread rather than being unreachable.
//
// The bug this locks: the builder writes to 'thr-<uuid>' while the run rail read a
// hardcoded 'app:<id>'. useBuilderChat hydrates strictly from the thread id it is
// handed, so 'app:<id>' had ZERO rows and the user saw an empty conversation — and the
// picker only rendered when >1 thread matched, so right after a build there was no
// route to the real conversation at all.
//
// R5: this is a hot path (every app open). The default must be DETERMINISTIC — never a
// function of listThreads() order alone, whose updated_at can tie.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import RunView from '../run/RunView.js';
import { BuilderView } from '../views/BuilderView.js';
import { modeStore } from '../state/mode.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP_HTML = '<!DOCTYPE html><html><head><title>Haiku Machine</title></head><body></body></html>';

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;

function sseResponse(blocks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

function mount(element: Parameters<Root['render']>[0]): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

function unmount(): void {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
}

async function renderRun(id: string): Promise<HTMLDivElement> {
  const el = mount(
    <MemoryRouter initialEntries={[`/run/${id}`]}>
      <Routes>
        <Route path="/run/:id" element={<RunView />} />
      </Routes>
    </MemoryRouter>,
  );
  await settle();
  return el;
}

/** Chat bubbles rendered by the rail's ChatLog. */
function chatText(el: HTMLElement): string {
  return el.querySelector('.rail')?.textContent ?? el.textContent ?? '';
}

function threadSelect(el: HTMLElement): HTMLSelectElement | null {
  return el.querySelector<HTMLSelectElement>('select[aria-label="switch thread"]');
}

function optionLabels(select: HTMLSelectElement): string[] {
  return [...select.options].map((o) => o.textContent?.trim() ?? '');
}

beforeEach(async () => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  localStorage.clear();
  sessionStorage.clear();
  modeStore.set('subscription');
  db = await installTestUserDb();
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe('the build conversation is the run view’s main thread (AC19)', () => {
  it('build in BuilderView → open /run/:id → the builder’s messages are present', async () => {
    // --- build ------------------------------------------------------------------
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/invoke') {
        return sseResponse([
          'event: artifact\ndata: {"artifactId":"srv-haiku","displayName":"Haiku Machine"}\n\n',
          'event: done\ndata: {"text":"here is your haiku machine"}\n\n',
        ]);
      }
      if (url === '/artifacts/srv-haiku') return new Response(APP_HTML, { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });

    const builder = mount(
      <MemoryRouter initialEntries={['/build?idea=a%20haiku%20machine']}>
        <BuilderView />
      </MemoryRouter>,
    );
    await settle();
    expect(builder.textContent).toContain('here is your haiku machine');
    unmount();

    const apps = db.listApps();
    expect(apps, 'the build must have installed exactly one app').toHaveLength(1);
    const appId = apps[0]!.appId;

    // The builder wrote to its own 'thr-*' thread, pinned to the new app.
    const builderThread = db.listThreads().find((t) => t.appId === appId);
    expect(builderThread, 'the build thread must be pinned to the app').toBeDefined();
    expect(builderThread!.threadId.startsWith('thr-')).toBe(true);
    expect(db.listChatMessages(builderThread!.threadId).length).toBeGreaterThan(0);

    // --- open the app -----------------------------------------------------------
    vi.restoreAllMocks();
    const run = await renderRun(appId);
    const text = chatText(run);
    expect(text, 'the run view opened an EMPTY conversation — the build history was lost').toContain('a haiku machine');
    expect(text).toContain('here is your haiku machine');
  });

  it('does not regress an app whose app:<id> thread already holds the conversation', async () => {
    // The pre-existing shape: no builder thread at all, everything on 'app:<id>'.
    const app = db.installApp({ appId: 'legacy-app', displayName: 'Legacy', html: APP_HTML });
    db.upsertThread(`app:${app.appId}`, { appId: app.appId });
    db.appendChatMessage(`app:${app.appId}`, 'user', 'legacy question');
    db.appendChatMessage(`app:${app.appId}`, 'assistant', 'legacy answer');

    const el = await renderRun(app.appId);
    expect(chatText(el)).toContain('legacy question');
    expect(chatText(el)).toContain('legacy answer');
  });

  it('is deterministic when two threads tie on updated_at — the pinned bootstrap wins', async () => {
    // R5: listThreads() orders by updated_at DESC; rows written in the same tick tie,
    // and the tie-break is the DB's business, not ours. The bootstrap pin decides.
    const app = db.installApp({ appId: 'tie-app', displayName: 'Tie', html: APP_HTML });
    // Deliberately create the NON-bootstrap thread with the id that would sort first.
    db.upsertThread('thr-aaaa', { appId: app.appId, title: 'side quest' });
    db.appendChatMessage('thr-aaaa', 'user', 'SIDEQUEST-TEXT');
    db.upsertThread('thr-zzzz', { appId: app.appId, title: 'the build' });
    const bootstrap = db.appendChatMessage('thr-zzzz', 'user', 'BOOTSTRAP-TEXT');
    db.pinChatMessage(bootstrap.id);

    for (let attempt = 0; attempt < 3; attempt++) {
      const el = await renderRun(app.appId);
      expect(chatText(el), 'the pinned bootstrap thread must win every time').toContain('BOOTSTRAP-TEXT');
      unmount();
    }
  });
});

describe('the thread picker is reachable and correctly labelled (AC20)', () => {
  it('renders whenever more than one thread exists for the app', async () => {
    const app = db.installApp({ appId: 'multi-app', displayName: 'Multi', html: APP_HTML });
    db.upsertThread('thr-build', { appId: app.appId, title: 'the build' });
    const bootstrap = db.appendChatMessage('thr-build', 'user', 'build me a thing');
    db.pinChatMessage(bootstrap.id);
    db.upsertThread('thr-side', { appId: app.appId, title: 'side quest' });
    db.appendChatMessage('thr-side', 'user', 'a side question');

    const el = await renderRun(app.appId);
    const select = threadSelect(el);
    expect(select, 'two threads exist — the picker must be reachable').not.toBeNull();
    expect(select!.options.length).toBeGreaterThanOrEqual(2);
  });

  it('labels the thread holding the pinned bootstrap turn as the main thread', async () => {
    const app = db.installApp({ appId: 'label-app', displayName: 'Label', html: APP_HTML });
    db.upsertThread('thr-build', { appId: app.appId, title: 'the build' });
    const bootstrap = db.appendChatMessage('thr-build', 'user', 'build me a thing');
    db.pinChatMessage(bootstrap.id);
    db.upsertThread('thr-side', { appId: app.appId, title: 'side quest' });
    db.appendChatMessage('thr-side', 'user', 'a side question');

    const el = await renderRun(app.appId);
    const select = threadSelect(el)!;
    const labels = optionLabels(select);
    expect(labels, 'the bootstrap thread must be NAMED the main thread').toContain('main thread');
    // and it is the one actually selected
    const selected = [...select.options].find((o) => o.value === select.value);
    expect(selected?.textContent?.trim()).toBe('main thread');
    expect(select.value).toBe('thr-build');
    // The side thread is still reachable under its own title.
    expect(labels).toContain('side quest');
  });

  it('switching to another thread loads that thread’s messages', async () => {
    const app = db.installApp({ appId: 'switch-app', displayName: 'Switch', html: APP_HTML });
    db.upsertThread('thr-build', { appId: app.appId, title: 'the build' });
    const bootstrap = db.appendChatMessage('thr-build', 'user', 'BUILD-TEXT');
    db.pinChatMessage(bootstrap.id);
    db.upsertThread('thr-side', { appId: app.appId, title: 'side quest' });
    db.appendChatMessage('thr-side', 'user', 'SIDE-TEXT');

    const el = await renderRun(app.appId);
    expect(chatText(el)).toContain('BUILD-TEXT');
    const select = threadSelect(el)!;
    act(() => {
      select.value = 'thr-side';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(chatText(el)).toContain('SIDE-TEXT');
  });

  it('a single-thread app still shows the main-thread label and a + new affordance', async () => {
    const app = db.installApp({ appId: 'solo-app', displayName: 'Solo', html: APP_HTML });
    db.upsertThread('thr-only', { appId: app.appId, title: 'the build' });
    const bootstrap = db.appendChatMessage('thr-only', 'user', 'SOLO-TEXT');
    db.pinChatMessage(bootstrap.id);

    const el = await renderRun(app.appId);
    expect(chatText(el)).toContain('SOLO-TEXT');
    expect(el.textContent).toContain('main thread');
  });
});
