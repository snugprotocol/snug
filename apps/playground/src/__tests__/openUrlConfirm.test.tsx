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
