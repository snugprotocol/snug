// webNotify.test.ts — TASK-20261009-scheduling-framework H2 (ADR-0074 §7): the web shell's
// `Notification`-API seat. Composed at boot like every other seat, but INERT until two facts
// both hold at the moment of a call — the Settings opt-in (`'1'` under the storage key the
// card writes) and a permission the user already granted on that click. The seat never asks:
// `requestPermission` is the Settings card's act, on a gesture, and a fake that would record
// the call is handed in here to prove it is never made on any path.
//
// Pure over an injected window slice and storage, so no case depends on what jsdom ships.
import { describe, expect, it, vi } from 'vitest';

import { WEB_NOTIFY_OPT_IN_KEY, createWebNotifySeat, readWebNotifyOptIn, webSchedulerSeat } from '../platform/webNotify.js';

type Permission = 'default' | 'denied' | 'granted';

interface FakeNotificationApi {
  ctor: typeof Notification;
  constructed: Array<{ title: string; options: NotificationOptions | undefined }>;
  requestPermission: ReturnType<typeof vi.fn>;
}

/** A `Notification` the way the browser exposes it: a constructor with static `permission` and `requestPermission`. */
function fakeNotification(permission: Permission, opts: { throws?: boolean } = {}): FakeNotificationApi {
  const constructed: FakeNotificationApi['constructed'] = [];
  const requestPermission = vi.fn(async () => 'granted' as const);
  class FakeNotification {
    static permission: Permission = permission;
    static requestPermission = requestPermission;
    constructor(title: string, options?: NotificationOptions) {
      if (opts.throws === true) throw new TypeError('Illegal constructor');
      constructed.push({ title, options });
    }
  }
  return { ctor: FakeNotification as unknown as typeof Notification, constructed, requestPermission };
}

const ALERT = { title: 'Ledger', body: 'your digest is ready' };

describe('createWebNotifySeat — absent API, absent seat', () => {
  it('answers undefined when the window has no Notification at all (in-page only)', () => {
    expect(createWebNotifySeat({}, () => true)).toBeUndefined();
  });
});

describe('createWebNotifySeat — the two gates, read at the call', () => {
  it('not opted in → denied, and NOTHING is constructed even though permission is granted', async () => {
    const api = fakeNotification('granted');
    const notify = createWebNotifySeat({ Notification: api.ctor }, () => false);
    expect(notify).toBeTypeOf('function');
    await expect(notify!(ALERT)).resolves.toBe('denied');
    expect(api.constructed).toEqual([]);
    expect(api.requestPermission).not.toHaveBeenCalled();
  });

  it('opted in but permission still `default` → denied; the seat never asks for it', async () => {
    const api = fakeNotification('default');
    const notify = createWebNotifySeat({ Notification: api.ctor }, () => true)!;
    await expect(notify(ALERT)).resolves.toBe('denied');
    expect(api.constructed).toEqual([]);
    expect(api.requestPermission).not.toHaveBeenCalled();
  });

  it('opted in but permission `denied` → denied, nothing constructed', async () => {
    const api = fakeNotification('denied');
    const notify = createWebNotifySeat({ Notification: api.ctor }, () => true)!;
    await expect(notify(ALERT)).resolves.toBe('denied');
    expect(api.constructed).toEqual([]);
  });

  it('granted + opted in → shown, with the title and the body as given', async () => {
    const api = fakeNotification('granted');
    const notify = createWebNotifySeat({ Notification: api.ctor }, () => true)!;
    await expect(notify(ALERT)).resolves.toBe('shown');
    expect(api.constructed).toEqual([{ title: 'Ledger', options: { body: 'your digest is ready' } }]);
    expect(api.requestPermission).not.toHaveBeenCalled();
  });

  it('the opt-in is read PER CALL: switching it off after composition denies the next alert', async () => {
    const api = fakeNotification('granted');
    let on = true;
    const notify = createWebNotifySeat({ Notification: api.ctor }, () => on)!;
    await expect(notify(ALERT)).resolves.toBe('shown');
    on = false;
    await expect(notify(ALERT)).resolves.toBe('denied');
    expect(api.constructed).toHaveLength(1);
  });

  it('the permission is read PER CALL too: a grant made by the Settings click after boot is honoured', async () => {
    const api = fakeNotification('default');
    const notify = createWebNotifySeat({ Notification: api.ctor }, () => true)!;
    await expect(notify(ALERT)).resolves.toBe('denied');
    (api.ctor as unknown as { permission: Permission }).permission = 'granted';
    await expect(notify(ALERT)).resolves.toBe('shown');
  });

  it('a constructor that throws → unavailable, never a rejection', async () => {
    const api = fakeNotification('granted', { throws: true });
    const notify = createWebNotifySeat({ Notification: api.ctor }, () => true)!;
    await expect(notify(ALERT)).resolves.toBe('unavailable');
  });
});

describe('readWebNotifyOptIn — the key the Settings card writes', () => {
  const storageOf = (value: string | null): Pick<Storage, 'getItem'> => ({ getItem: (key) => (key === WEB_NOTIFY_OPT_IN_KEY ? value : null) });

  it('the key is the one the Settings card writes', () => {
    expect(WEB_NOTIFY_OPT_IN_KEY).toBe('snug:schedule-notify');
  });

  it("'1' is on; anything else — absent, '0', 'true' — is off", () => {
    expect(readWebNotifyOptIn(storageOf('1'))).toBe(true);
    expect(readWebNotifyOptIn(storageOf(null))).toBe(false);
    expect(readWebNotifyOptIn(storageOf('0'))).toBe(false);
    expect(readWebNotifyOptIn(storageOf('true'))).toBe(false);
  });

  it('a storage that throws (a hostile host answers reads with a SecurityError) reads as off', () => {
    const hostile: Pick<Storage, 'getItem'> = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    };
    expect(readWebNotifyOptIn(hostile)).toBe(false);
  });

  it('with no storage reachable at all it reads as off, never throws', () => {
    expect(readWebNotifyOptIn(undefined)).toBe(false);
  });
});

describe('webSchedulerSeat — what WEB_DEFAULT composes', () => {
  it('names the tab, promises only the page, and carries the notify seat when the window has the API', () => {
    const api = fakeNotification('granted');
    const seat = webSchedulerSeat({ Notification: api.ctor });
    expect(seat.wakeMode).toBe('page');
    expect(seat.hostLabel).toBe('this tab');
    expect(seat.notify).toBeTypeOf('function');
    expect(api.requestPermission).not.toHaveBeenCalled();
  });

  it('without the API the seat still names the host — `notify` is simply absent', () => {
    const seat = webSchedulerSeat({});
    expect(seat).toEqual({ wakeMode: 'page', hostLabel: 'this tab' });
    expect('notify' in seat).toBe(false);
  });

  it('composing is side-effect free: nothing is constructed and no permission is requested', () => {
    const api = fakeNotification('default');
    webSchedulerSeat({ Notification: api.ctor });
    expect(api.constructed).toEqual([]);
    expect(api.requestPermission).not.toHaveBeenCalled();
  });

  it('is safe to build outside a browser (the shells’ node-side tests import platform.ts)', () => {
    expect(() => webSchedulerSeat(undefined)).not.toThrow();
  });
});
