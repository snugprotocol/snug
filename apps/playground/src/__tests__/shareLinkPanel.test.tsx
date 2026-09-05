// shareLinkPanel.test.tsx — TASK-20260904-share-link-ux AC3/AC4/AC5: the link panel
// carries BOTH link acts — copy link and share… (the OS share sheet with the LINK, never
// a file: Chrome's canShare says yes to a .snug and share() then refuses it) — and the
// sharer's expiry choice (24 hours / 1 week / 1 month, default a week) rides on both.
// share… survives the browser closing its activation window during the upload: the
// link is shown and copied, with a note, never an error.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { ShareSheet } from '../share/ShareSheet.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The relay origin is a BUILD-TIME constant; mock the config so the link panel renders.
vi.mock('../config/site.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/site.js')>();
  return { ...actual, SHARE_RELAY_ORIGIN: 'https://share.test', SHARE_LINK_ORIGIN: 'https://playground.test' };
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

async function settleUntil(done: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (done()) return;
    await settle();
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const q = (testId: string): HTMLElement | null => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

async function renderSheet(appId: string): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ShareSheet appId={appId} displayName="Weather Wall" onClose={() => undefined} />);
  });
  await settleUntil(() => q('share-link-panel') !== null, 'the link panel');
}

function relayFetch(seen: string[]): typeof fetch {
  return vi.fn(async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify({ id: 'A'.repeat(22), expiresAt: '2026-09-11T00:00:00.000Z', revokeToken: 'T'.repeat(43) }), { status: 201 });
  }) as unknown as typeof fetch;
}

let shareCalls: ShareData[];
let shareOutcome: () => Promise<void>;

beforeEach(async () => {
  db = await installTestUserDb();
  shareCalls = [];
  shareOutcome = async () => undefined;
  Object.defineProperty(globalThis.navigator, 'share', {
    configurable: true,
    value: (data: ShareData) => {
      shareCalls.push(data);
      return shareOutcome();
    },
  });
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  vi.unstubAllGlobals();
  delete (globalThis.navigator as { share?: unknown }).share;
});

function furnish(): string {
  return db.installApp({ displayName: 'Weather Wall', html: '<!doctype html><html><body>hi</body></html>' }).appId;
}

describe('the link panel (AC3, AC5)', () => {
  it('offers copy link AND share… beside an expiry choice that defaults to 1 week; share… sends the LINK to the OS sheet', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', relayFetch(seen));
    await renderSheet(furnish());
    expect(q('share-copy-link')).not.toBeNull();
    expect(q('share-os')).not.toBeNull();
    const select = q('share-expiry') as HTMLSelectElement;
    expect(select.value).toBe('7d');
    expect([...select.options].map((o) => o.textContent)).toEqual(['24 hours', '1 week', '1 month']);
    // Nothing is uploaded until an act — the sheet opening mints no link.
    expect(seen).toEqual([]);

    await act(async () => {
      q('share-os')!.click();
    });
    await settleUntil(() => shareCalls.length === 1, 'the OS share call');
    expect(seen).toEqual(['https://share.test/v1/bundles?expires=7d']);
    const url = `https://playground.test/s/${'A'.repeat(22)}#`;
    expect(shareCalls[0]?.url?.startsWith(url)).toBe(true);
    expect(shareCalls[0]?.title).toContain('Weather Wall');
    expect(shareCalls[0]).not.toHaveProperty('files');
    // The same link is shown in the field, and the terms name the date the relay answered.
    await settleUntil(() => q('share-link-url') !== null, 'the link field');
    expect((q('share-link-url') as HTMLInputElement).value).toBe(shareCalls[0]?.url);
    expect(q('share-link-terms')!.textContent).toMatch(/until .*2026/);
    expect(q('share-os-note')).toBeNull();
  });

  it('the expiry choice rides on both acts', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', relayFetch(seen));
    await renderSheet(furnish());
    const select = q('share-expiry') as HTMLSelectElement;
    await act(async () => {
      // React listens for `change` on selects through the root; set the value, then dispatch.
      select.value = '1d';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      q('share-copy-link')!.click();
    });
    await settleUntil(() => seen.length === 1, 'the copy-link upload');
    await act(async () => {
      select.value = '30d';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      q('share-os')!.click();
    });
    await settleUntil(() => seen.length === 2, 'the share… upload');
    expect(seen).toEqual(['https://share.test/v1/bundles?expires=1d', 'https://share.test/v1/bundles?expires=30d']);
  });

  it('renders no share… when the browser has no navigator.share — copy link stays', async () => {
    delete (globalThis.navigator as { share?: unknown }).share;
    vi.stubGlobal('fetch', relayFetch([]));
    await renderSheet(furnish());
    expect(q('share-copy-link')).not.toBeNull();
    expect(q('share-os')).toBeNull();
  });
});

describe('share… failure modes (AC4)', () => {
  it('(N) NotAllowedError after the upload — the browser closed its activation window — shows and copies the link with a note, never an error', async () => {
    vi.stubGlobal('fetch', relayFetch([]));
    shareOutcome = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    await renderSheet(furnish());
    await act(async () => {
      q('share-os')!.click();
    });
    await settleUntil(() => q('share-os-note') !== null, 'the note');
    expect(q('share-os-note')!.textContent).toMatch(/copied/);
    expect((q('share-link-url') as HTMLInputElement).value).toContain(`/s/${'A'.repeat(22)}#`);
    expect(document.body.querySelector('[data-testid="share-link-panel"] .error-note')).toBeNull();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith((q('share-link-url') as HTMLInputElement).value);
  });

  it('AbortError (the user dismissed the sheet) is silent — the link stays available', async () => {
    vi.stubGlobal('fetch', relayFetch([]));
    shareOutcome = () => Promise.reject(new DOMException('aborted', 'AbortError'));
    await renderSheet(furnish());
    await act(async () => {
      q('share-os')!.click();
    });
    await settleUntil(() => q('share-link-url') !== null, 'the link field');
    await settle();
    expect(q('share-os-note')).toBeNull();
    expect(document.body.querySelector('[data-testid="share-link-panel"] .error-note')).toBeNull();
  });
});
