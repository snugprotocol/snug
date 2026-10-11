// TASK-20260818-ledger-starter Phase C (ADR-0038 D5): the open-url confirm surface.
//
// The four review-SF8 pins, each with its own test: provenance copy renders (the URL
// came from the app, unchecked), the FULL URL renders, the confirm button names the
// PUNYCODE host (a homograph renders as xn--, never as the brand), and the open runs
// SYNCHRONOUSLY inside the click with 'noopener,noreferrer'. Plus the store contract:
// one pending, decline resolves declined, a stale entry is declined rather than leaked.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenUrlConfirmDialog } from '../run/OpenUrlConfirmDialog.js';
import { createOpenUrlHandlerFor, openUrlConfirmStore, resolveOpenUrlConfirm } from '../state/openUrl.js';
// TASK-20261010-host-broker PR-1 Gate-5 fold F-1 — the seat closes for a delegated run's window.
import { beginDelegatedRun, clearTouchedGeneration, endDelegatedRun } from '../schedule/runPlacement.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root | undefined;

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<OpenUrlConfirmDialog />);
  });
}

beforeEach(() => {
  openUrlConfirmStore.set(null);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  openUrlConfirmStore.set(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the dialog surface', () => {
  it('renders nothing with no pending request', async () => {
    await render();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders provenance copy, the FULL url, and the punycode host on the verb button', async () => {
    const handler = createOpenUrlHandlerFor('app-1');
    // A homograph: аpple.com with a Cyrillic а. The URL parser stores the toASCII form,
    // and the button must render THAT — the brand spelling never appears.
    void handler.open('https://аpple.com/cancel');
    await render();

    const provenance = container.querySelector('[data-testid="open-url-provenance"]');
    expect(provenance?.textContent ?? '').toMatch(/hasn't checked it/i);
    expect(provenance?.textContent ?? '').toContain('app-1');
    const full = container.querySelector('[data-testid="open-url-full"]');
    expect(full?.textContent ?? '').toContain('xn--');
    const confirm = container.querySelector('[data-testid="open-url-confirm"]');
    expect(confirm?.textContent ?? '').toContain('xn--pple-43d.com');
    expect(confirm?.textContent ?? '').not.toContain('аpple.com');
  });

  it('confirm opens SYNCHRONOUSLY inside the click with noopener,noreferrer, then resolves opened', async () => {
    const opened = vi.fn();
    vi.stubGlobal('open', opened);
    const handler = createOpenUrlHandlerFor('app-1');
    const outcome = handler.open('https://merchant.example/account/cancel');
    await render();

    let openedDuringClick = false;
    const button = container.querySelector<HTMLButtonElement>('[data-testid="open-url-confirm"]');
    opened.mockImplementation(() => {
      openedDuringClick = true;
      return null;
    });
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(openedDuringClick, 'window.open must fire during the gesture, not after an await').toBe(true);
    expect(opened).toHaveBeenCalledWith('https://merchant.example/account/cancel', '_blank', 'noopener,noreferrer');
    await expect(outcome).resolves.toBe('opened');
    expect(openUrlConfirmStore.get()).toBeNull();
  });

  it('decline resolves declined and opens NOTHING', async () => {
    const opened = vi.fn();
    vi.stubGlobal('open', opened);
    const handler = createOpenUrlHandlerFor('app-1');
    const outcome = handler.open('https://merchant.example/cancel');
    await render();
    const button = container.querySelector<HTMLButtonElement>('[data-testid="open-url-decline"]');
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(opened).not.toHaveBeenCalled();
    await expect(outcome).resolves.toBe('declined');
  });
});

describe('the store contract', () => {
  it('a second request declines the stale first rather than leaking its resolver', async () => {
    const handler = createOpenUrlHandlerFor('app-1');
    const first = handler.open('https://a.example/');
    const second = handler.open('https://b.example/');
    await expect(first).resolves.toBe('declined');
    resolveOpenUrlConfirm('opened');
    await expect(second).resolves.toBe('opened');
  });

  it('resolveOpenUrlConfirm clears the store BEFORE resolving — no double-resolve window', () => {
    let stateDuringResolve: unknown = 'unread';
    openUrlConfirmStore.set({
      appId: 'app-1',
      url: 'https://a.example/',
      resolve: () => {
        stateDuringResolve = openUrlConfirmStore.get();
      },
    });
    resolveOpenUrlConfirm('declined');
    expect(stateDuringResolve).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// TASK-20261010-host-broker PR-1, Gate-5 fold F-1 (security MAJOR) — the open-url seat CLOSES for
// a delegated run's window. A run the user did not start may execute on the VISIBLE frame
// (`schedule/runPlacement.ts`); the hidden frame composes no open-url at all, so for parity the
// live frame's seat answers `'declined'` while `delegatedRunFor(appId)` is in flight — at once,
// with NOTHING parked for the dialog (a timer-fired handler must not put a "open this link?"
// prompt in front of a user who never asked). After `endDelegatedRun` the ordinary flow resumes.
// ---------------------------------------------------------------------------------------------

describe('the seat during a delegated run (TASK-20261010-host-broker PR-1, fold F-1)', () => {
  const settledWithin = async <T,>(promise: Promise<T>, ms = 50): Promise<T | 'still parked'> =>
    Promise.race([promise, new Promise<'still parked'>((resolve) => setTimeout(() => resolve('still parked'), ms))]);

  it('while a run is in flight for THIS app, `open` answers `declined` at once and parks nothing; after the run the ordinary confirm parks again', async () => {
    const begun = beginDelegatedRun({ appId: 'app-f1', appName: 'Weather', runId: 'run-1', taskId: 't1', title: 'Morning forecast', generation: 1 });
    expect(begun.ok).toBe(true);
    try {
      const during = createOpenUrlHandlerFor('app-f1').open('https://merchant.example/account/cancel');
      expect(await settledWithin(during), 'declined at once, never parked for the dialog').toBe('declined');
      expect(openUrlConfirmStore.get()).toBeNull();

      // Another app's run does not close THIS app's seat (the record is per app).
      const other = createOpenUrlHandlerFor('app-f1-other').open('https://b.example/');
      expect(openUrlConfirmStore.get()).toMatchObject({ appId: 'app-f1-other', url: 'https://b.example/' });
      resolveOpenUrlConfirm('declined');
      await expect(other).resolves.toBe('declined');
    } finally {
      endDelegatedRun('app-f1', 'run-1');
      clearTouchedGeneration('app-f1', 1);
    }

    const after = createOpenUrlHandlerFor('app-f1').open('https://merchant.example/account/cancel');
    expect(openUrlConfirmStore.get(), 'the run ended: the seat is the ordinary one again').toMatchObject({ appId: 'app-f1', url: 'https://merchant.example/account/cancel' });
    resolveOpenUrlConfirm('opened');
    await expect(after).resolves.toBe('opened');
  });
});
