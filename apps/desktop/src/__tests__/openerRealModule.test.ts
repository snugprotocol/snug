// Real-module coverage for ../oauth.ts (TASK-20260812-desktop-auth-awareness AC3, P1).
//
// platform-oauth.test.ts mocks ../oauth.js WHOLESALE — which is exactly how the
// opener-scope defect shipped invisibly (lesson 2026-08-08: whenever a test seam
// short-circuits production wiring, at least one test must run with the seam OFF).
// Here only the tauri plugin boundary is mocked; openInSystemBrowser's own logic —
// the https-only guard and the exact URL handoff — runs for real.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openUrl = vi.fn<(url: string) => Promise<void>>(async () => undefined);
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (url: string) => openUrl(url),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => 0) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));

import { openInSystemBrowser } from '../oauth.js';

beforeEach(() => {
  openUrl.mockClear();
});

describe('openInSystemBrowser — the REAL module (plugin boundary mocked only)', () => {
  it('hands an https authorize URL to the plugin byte-identically', async () => {
    const url = 'https://accounts.spotify.com/authorize?client_id=cid&redirect_uri=http%3A%2F%2F127.0.0.1%3A41420%2Fcallback';
    await openInSystemBrowser(url);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(url);
  });

  it('refuses a non-https URL BEFORE the plugin is reached (arbitrary schemes never reach the OS)', async () => {
    await expect(openInSystemBrowser('http://127.0.0.1:8080/evil')).rejects.toThrow(
      'refusing to open non-https URL',
    );
    await expect(openInSystemBrowser('file:///etc/passwd')).rejects.toThrow('refusing to open non-https URL');
    expect(openUrl).not.toHaveBeenCalled();
  });
});
