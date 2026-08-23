// Desktop open path — TASK-20260822-feedback-loop AC6: on the desktop shell the
// preview's confirm rides the platform's GENERIC opener seat (openExternalUrl,
// wired to openInSystemBrowser) — deliberately NOT oauth.openExternal, whose
// pending-flow bind is an OAuth side effect a feedback click must never trigger
// (Gate-5 finding). A rejected open keeps the preview up and offers the URL as a
// plain link instead of silently closing as if it worked. Pinned via a mocked
// platform module because getPlatform() locks on first read (the documented
// platform test trap).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openExternalUrl = vi.fn((_url: string) => Promise.resolve());
const oauthOpenExternal = vi.fn((_url: string) => Promise.resolve());

vi.mock('../platform/platform.js', () => ({
  getPlatform: () => ({
    kind: 'desktop',
    openExternalUrl,
    oauth: {
      redirectUriFor: () => Promise.resolve(''),
      openExternal: oauthOpenExternal,
      channelFor: () => ({ onmessage: null, close: () => undefined }),
      cancel: () => Promise.resolve(),
    },
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  }),
  setPlatform: () => undefined,
}));

import { ReportErrorLink } from '../feedback/ReportErrorLink.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let openSpy: ReturnType<typeof vi.fn>;

function mountAndOpenPreview(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<ReportErrorLink context={{ surface: 'run', errorText: 'boom' }} />);
  });
  act(() => {
    (container!.querySelector('[data-testid="report-error-link"]') as HTMLElement).click();
  });
}

beforeEach(() => {
  openExternalUrl.mockClear();
  oauthOpenExternal.mockClear();
  openSpy = vi.fn();
  vi.stubGlobal('open', openSpy);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

describe('desktop confirm (AC6)', () => {
  it('opens via the generic system-browser seat — never window.open, never the OAuth opener', async () => {
    mountAndOpenPreview();
    await act(async () => {
      (container!.querySelector('[data-testid="report-confirm"]') as HTMLElement).click();
    });
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(String(openExternalUrl.mock.calls[0]![0])).toContain('/issues/new?');
    expect(oauthOpenExternal).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="report-preview"]')).toBeNull();
  });

  it('a rejected open keeps the preview up and offers the plain-link fallback', async () => {
    openExternalUrl.mockRejectedValueOnce(new Error('opener refused'));
    mountAndOpenPreview();
    await act(async () => {
      (container!.querySelector('[data-testid="report-confirm"]') as HTMLElement).click();
    });
    expect(container!.querySelector('[data-testid="report-preview"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="report-fallback-link"]')).not.toBeNull();
  });
});
