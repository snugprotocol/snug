// The desktop's `platform.scheduler.notify` seat (TASK-20261009-scheduling-framework H1;
// ADR-0074 §6–§7) over `@tauri-apps/plugin-notification`, with the plugin module faked.
//
// WHAT THE SEAT PROMISES, and what these rows pin:
//   * it answers one of the three outcomes and NEVER throws — the engine fires it and forgets
//     (`queue.ts` `.catch(() => undefined)`), so a throw would only ever vanish;
//   * it never ASKS: `requestPermission` is the Settings card's act, on a click. The card works
//     on the desktop unchanged because the plugin polyfills `window.Notification` in the webview,
//     so the desktop mirrors the web seat exactly — the same `snug:schedule-notify` flag, read
//     PER CALL (ADR-0036 rule 3), and `denied` until the user turned notifications on;
//   * the text it hands the plugin is the engine's, untouched — plain, length-capped, prefixed
//     and rate-limited before it reaches here (§6); the seat adds nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

import { WEB_NOTIFY_OPT_IN_KEY } from '@playground/platform/webNotify.js';

import { createDesktopNotifySeat, type DesktopNotifyDeps } from '../notify.js';

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => 'granted'),
  sendNotification: vi.fn(),
}));

const granted = vi.mocked(isPermissionGranted);
const ask = vi.mocked(requestPermission);
const send = vi.mocked(sendNotification);

const TEXT = { title: 'stretch', body: 'stretch · stand up and stretch' } as const;

const deps = (over: Partial<DesktopNotifyDeps> = {}): DesktopNotifyDeps => ({
  optedIn: () => true,
  isPermissionGranted,
  sendNotification,
  ...over,
});

beforeEach(() => {
  granted.mockReset().mockResolvedValue(true);
  ask.mockReset().mockResolvedValue('granted');
  send.mockReset();
  localStorage.clear();
});

afterEach(() => {
  // THE RULE, checked after every row: no path through the seat asks for permission.
  expect(ask, 'the seat never calls requestPermission — the Settings card is the one asking surface').not.toHaveBeenCalled();
});

describe('createDesktopNotifySeat — the three outcomes', () => {
  it('opted in and granted → shown, with the engine’s title and body handed over untouched', async () => {
    const notify = createDesktopNotifySeat(deps());
    await expect(notify(TEXT)).resolves.toBe('shown');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ title: TEXT.title, body: TEXT.body });
  });

  it('opted in but the plugin says not granted → denied, and nothing is sent', async () => {
    granted.mockResolvedValue(false);
    const notify = createDesktopNotifySeat(deps());
    await expect(notify(TEXT)).resolves.toBe('denied');
    expect(send).not.toHaveBeenCalled();
  });

  it('not opted in → denied without touching the plugin at all', async () => {
    const notify = createDesktopNotifySeat(deps({ optedIn: () => false }));
    await expect(notify(TEXT)).resolves.toBe('denied');
    expect(granted).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('the plugin throws on send → unavailable, never a rejection', async () => {
    send.mockImplementation(() => {
      throw new Error('no notification channel');
    });
    const notify = createDesktopNotifySeat(deps());
    await expect(notify(TEXT)).resolves.toBe('unavailable');
  });

  it('the permission read itself rejects → unavailable, never a rejection', async () => {
    granted.mockRejectedValue(new Error('plugin:notification|is_permission_granted not allowed'));
    const notify = createDesktopNotifySeat(deps());
    await expect(notify(TEXT)).resolves.toBe('unavailable');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the opt-in is the web one, read per call', () => {
  it('the default deps read `snug:schedule-notify` from localStorage on EVERY call — on, then off, with nothing recomposed', async () => {
    const notify = createDesktopNotifySeat();
    await expect(notify(TEXT), 'never opted in').resolves.toBe('denied');
    expect(send).not.toHaveBeenCalled();

    localStorage.setItem(WEB_NOTIFY_OPT_IN_KEY, '1');
    await expect(notify(TEXT), 'turned on in Settings').resolves.toBe('shown');
    expect(send).toHaveBeenCalledTimes(1);

    localStorage.removeItem(WEB_NOTIFY_OPT_IN_KEY);
    await expect(notify(TEXT), 'turned off again').resolves.toBe('denied');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('the flag’s name is the web seat’s — one flag, one Settings card, one writer', () => {
    expect(WEB_NOTIFY_OPT_IN_KEY).toBe('snug:schedule-notify');
  });
});

describe('the REAL plugin module in a window with no `Notification` (an unpolyfilled webview; this jsdom)', () => {
  it('answers unavailable and never throws — the shipped shim reads window.Notification before any invoke', async () => {
    const real = await vi.importActual<typeof import('@tauri-apps/plugin-notification')>('@tauri-apps/plugin-notification');
    expect(typeof (window as { Notification?: unknown }).Notification, 'jsdom has no Notification — the case under test').toBe('undefined');
    const notify = createDesktopNotifySeat({
      optedIn: () => true,
      isPermissionGranted: real.isPermissionGranted,
      sendNotification: real.sendNotification,
    });
    await expect(notify(TEXT)).resolves.toBe('unavailable');
  });
});
