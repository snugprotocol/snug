// threadSidebar.test.tsx — TASK-20260903-build-thread-continuity AC5/AC5b.
//
// The build page lists EVERY conversation in the user DB (build threads and run-view
// threads alike), marks the active one, badges the ones in flight, and lets the user
// switch, start fresh, rename and delete. Before this, /build knew exactly one thread id
// and `listThreads()` had a single caller in the whole playground (RunView).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { resetThreadSessions } from '../agent/threadSessions.js';
import { BUILD_THREAD_KEY, activeBuildThreadStore, setActiveBuildThread } from '../state/buildThread.js';
import { modeStore } from '../state/mode.js';
import { BuilderView } from '../views/BuilderView.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HTML = '<!DOCTYPE html><html><body>ledger</body></html>';

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;
let appId: string;

function mountBuilder(): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={['/build']}>
        <BuilderView />
      </MemoryRouter>,
    );
  });
  return container;
}

async function settle(ms = 5): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const rows = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('[data-testid="thread-row"]')];
const rowByText = (el: HTMLElement, text: string): HTMLElement => {
  const hit = rows(el).find((row) => (row.textContent ?? '').includes(text));
  if (hit === undefined) throw new Error(`no thread row containing "${text}"; rows: ${rows(el).map((r) => r.textContent).join(' | ')}`);
  return hit;
};
const activeRow = (el: HTMLElement): HTMLElement | undefined => rows(el).find((row) => row.getAttribute('aria-current') === 'true');
const click = (el: Element | null | undefined): void => {
  if (el === null || el === undefined) throw new Error('nothing to click');
  act(() => (el as HTMLElement).click());
};
const chatText = (el: HTMLElement): string => el.querySelector('.chat-log')?.textContent ?? '';

function typeInComposer(el: HTMLElement, text: string): void {
  const textarea = el.querySelector('textarea');
  if (textarea === null) throw new Error('no composer');
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  modeStore.set('subscription');
  db = await installTestUserDb();
  resetThreadSessions();
  appId = db.installApp({ displayName: 'Pocket Ledger', html: HTML }).appId;
  db.upsertThread('thr-1', { title: 'haiku machine' });
  db.appendChatMessage('thr-1', 'user', 'a haiku machine');
  db.appendChatMessage('thr-1', 'assistant', 'here is your haiku machine');
  db.upsertThread('thr-2', { appId });
  db.appendChatMessage('thr-2', 'user', 'make the ledger blue');
  db.appendChatMessage('thr-2', 'assistant', 'made it blue');
  setActiveBuildThread('thr-1');
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  resetThreadSessions();
  vi.restoreAllMocks();
});

describe('the thread sidebar lists every conversation (AC5)', () => {
  it('lists both threads, labelled title → app name, and marks the active one', async () => {
    const el = mountBuilder();
    await settle();
    expect(rows(el)).toHaveLength(2);
    expect(rowByText(el, 'haiku machine')).toBeDefined();
    // No title: the attached app's display name is the label, never the raw id.
    expect(rowByText(el, 'Pocket Ledger')).toBeDefined();
    expect(el.textContent).not.toContain('thr-2');
    expect(activeRow(el)?.textContent).toContain('haiku machine');
    expect(chatText(el)).toContain('here is your haiku machine');
  });

  it('selecting a row switches the chat to that thread and remembers it for the tab', async () => {
    const el = mountBuilder();
    await settle();
    click(rowByText(el, 'Pocket Ledger').querySelector('[data-testid="thread-open"]'));
    await settle();
    expect(chatText(el)).toContain('made it blue');
    expect(chatText(el)).not.toContain('haiku');
    expect(activeRow(el)?.textContent).toContain('Pocket Ledger');
    expect(activeBuildThreadStore.get()).toBe('thr-2');
    expect(sessionStorage.getItem(BUILD_THREAD_KEY)).toBe('thr-2');
  });

  it('"+ new" mints a fresh thread: empty chat, a pending row marked active, nothing persisted yet', async () => {
    const el = mountBuilder();
    await settle();
    click(el.querySelector('[data-testid="thread-new"]'));
    await settle();
    const minted = activeBuildThreadStore.get();
    expect(minted.startsWith('thr-')).toBe(true);
    expect(minted).not.toBe('thr-1');
    expect(el.textContent).toContain('build something');
    expect(activeRow(el)?.textContent).toContain('new conversation');
    expect(db.getThread(minted), 'a thread row exists only once a message does').toBeUndefined();
    expect(rows(el), 'two persisted rows plus the pending one').toHaveLength(3);
  });

  it('badges a thread while its turn is in flight, and the list refreshes when a turn settles', async () => {
    let finish: (() => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              finish = () => {
                controller.enqueue(new TextEncoder().encode('event: done\ndata: {"text":"a chess coach, coming up"}\n\n'));
                controller.close();
              };
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const el = mountBuilder();
    await settle();
    click(el.querySelector('[data-testid="thread-new"]'));
    await settle();
    typeInComposer(el, 'a chess coach');
    await settle();

    const pending = activeRow(el);
    expect(pending?.querySelector('[data-testid="thread-busy"]'), 'the in-flight thread carries a live badge').not.toBeNull();
    expect(rowByText(el, 'haiku machine').querySelector('[data-testid="thread-busy"]')).toBeNull();

    act(() => finish?.());
    await settle(10);
    // The first message gave the thread its row and its title — the list picked it up.
    expect(rowByText(el, 'a chess coach')).toBeDefined();
    expect(activeRow(el)?.querySelector('[data-testid="thread-busy"]')).toBeNull();
    expect(rows(el)).toHaveLength(3);
  });
});

describe('rename and delete (AC5b)', () => {
  it('renames a thread inline and persists the title', async () => {
    const el = mountBuilder();
    await settle();
    click(rowByText(el, 'haiku machine').querySelector('[data-testid="thread-rename"]'));
    const input = el.querySelector<HTMLInputElement>('[data-testid="thread-rename-input"]');
    expect(input).not.toBeNull();
    act(() => {
      input!.value = 'my haiku';
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(db.getThread('thr-1')?.title).toBe('my haiku');
    expect(rowByText(el, 'my haiku')).toBeDefined();
    expect(el.querySelector('[data-testid="thread-rename-input"]')).toBeNull();
  });

  it('Escape cancels a rename without persisting', async () => {
    const el = mountBuilder();
    await settle();
    click(rowByText(el, 'haiku machine').querySelector('[data-testid="thread-rename"]'));
    const input = el.querySelector<HTMLInputElement>('[data-testid="thread-rename-input"]');
    act(() => {
      input!.value = 'nope';
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(db.getThread('thr-1')?.title).toBe('haiku machine');
    expect(el.querySelector('[data-testid="thread-rename-input"]')).toBeNull();
  });

  it('deletes a thread after an inline confirm — messages gone, the app untouched', async () => {
    const el = mountBuilder();
    await settle();
    click(rowByText(el, 'Pocket Ledger').querySelector('[data-testid="thread-delete"]'));
    // Armed, not deleted: the confirm is the act.
    expect(db.getThread('thr-2')).toBeDefined();
    click(el.querySelector('[data-testid="thread-delete-confirm"]'));
    await settle();
    expect(db.getThread('thr-2')).toBeUndefined();
    expect(db.listChatMessages('thr-2')).toEqual([]);
    expect(db.getApp(appId), 'deleting a thread must never delete its app').toBeDefined();
    expect(rows(el)).toHaveLength(1);
    // The active thread was not the deleted one — it stays.
    expect(activeBuildThreadStore.get()).toBe('thr-1');
  });

  it('deleting the ACTIVE thread selects the newest remaining one', async () => {
    const el = mountBuilder();
    await settle();
    click(rowByText(el, 'haiku machine').querySelector('[data-testid="thread-delete"]'));
    click(el.querySelector('[data-testid="thread-delete-confirm"]'));
    await settle();
    expect(activeBuildThreadStore.get()).toBe('thr-2');
    expect(chatText(el)).toContain('made it blue');
    expect(activeRow(el)?.textContent).toContain('Pocket Ledger');
  });

  it('deleting the last thread mints a fresh one', async () => {
    db.deleteThread('thr-2');
    const el = mountBuilder();
    await settle();
    click(rowByText(el, 'haiku machine').querySelector('[data-testid="thread-delete"]'));
    click(el.querySelector('[data-testid="thread-delete-confirm"]'));
    await settle();
    const minted = activeBuildThreadStore.get();
    expect(minted.startsWith('thr-')).toBe(true);
    expect(minted).not.toBe('thr-1');
    expect(el.textContent).toContain('build something');
  });

  it('a thread with a turn in flight is aborted by its delete', async () => {
    let seenSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seenSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const el = mountBuilder();
    await settle();
    typeInComposer(el, 'make it purple');
    await settle();
    expect(seenSignal?.aborted).toBe(false);
    click(rowByText(el, 'haiku machine').querySelector('[data-testid="thread-delete"]'));
    click(el.querySelector('[data-testid="thread-delete-confirm"]'));
    await settle();
    expect(seenSignal?.aborted).toBe(true);
    expect(db.getThread('thr-1')).toBeUndefined();
  });
});
