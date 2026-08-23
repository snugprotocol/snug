// Desktop open path — TASK-20260822-feedback-loop AC6: on the desktop shell the
// preview's confirm rides the platform's system-browser opener (the WebsiteLink /
// OpenUrlConfirmDialog pattern — a bare window.open would navigate or spawn inside
// the Tauri webview). Pinned via a mocked platform module because getPlatform()
// locks on first read (the documented platform test trap).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const openExternal = vi.fn(() => Promise.resolve());

vi.mock('../platform/platform.js', () => ({
  getPlatform: () => ({
    kind: 'desktop',
    oauth: {
      redirectUriFor: () => Promise.resolve(''),
      openExternal,
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

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

describe('desktop confirm (AC6)', () => {
  it('opens via the system browser, never window.open', () => {
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<ReportErrorLink context={{ surface: 'run', errorText: 'boom' }} />);
    });
    act(() => {
      (container!.querySelector('[data-testid="report-error-link"]') as HTMLElement).click();
    });
    act(() => {
      (container!.querySelector('[data-testid="report-confirm"]') as HTMLElement).click();
    });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(String(openExternal.mock.calls[0]![0])).toContain('/issues/new?');
    expect(openSpy).not.toHaveBeenCalled();
  });
});
