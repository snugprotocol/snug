// platform/webNotify.ts — the web shell's scheduler seat (TASK-20261009-scheduling-framework
// H2; ADR-0074 §7): the `Notification` API behind the optional `platform.scheduler.notify`.
//
// THE RULE. The seat is composed with the web default platform like every other seat, but it
// never ASKS: `Notification.requestPermission()` is the Settings card's act, on a click, and
// nothing here calls it on any path. A call answers `denied` until two facts both hold at that
// moment — the user opted in (the card writes `'1'` under `WEB_NOTIFY_OPT_IN_KEY`) and the
// browser's permission is already `granted` — so a page that was never asked stays in-page
// only, and a grant made after boot is honoured on the next alert. Both facts are read PER CALL,
// never captured at composition (ADR-0036 rule 3). Where the API is absent (an old browser, a
// node-side import of `platform.ts`) there is no `notify` at all, and the engine's inbox result
// still lands — the honesty line names the tab either way.
//
// The seat's text is the engine's: plain, length-capped, app-prefixed, rate-limited before it
// reaches here (§6); this module adds nothing and answers one of the three outcomes, never
// throwing for a refusal.

import type { SchedulerSeat } from './platform.js';

/** The `localStorage` key the Settings card writes: `'1'` = on. Anything else is off. */
export const WEB_NOTIFY_OPT_IN_KEY = 'snug:schedule-notify';

/** The slice of `window` the seat reads — `Notification` where the browser has it. */
export interface NotifyWindow {
  Notification?: typeof Notification;
}

/** The page's `window` where there is one, else an empty slice (node-side imports). */
const pageWindow = (): NotifyWindow => (typeof window === 'undefined' ? {} : (window as NotifyWindow));

/**
 * Whether the user opted in on the Settings card. Guarded: a hostile host answers storage
 * reads with a SecurityError, and a page with no storage at all (node) reads as off.
 */
export function readWebNotifyOptIn(storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    return store?.getItem(WEB_NOTIFY_OPT_IN_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The `notify` seat over the window's `Notification`, or `undefined` where the API is absent.
 * `optedIn` is read on every call, as is `Notification.permission`.
 */
export function createWebNotifySeat(win: NotifyWindow = pageWindow(), optedIn: () => boolean): SchedulerSeat['notify'] | undefined {
  const NotificationApi = win.Notification;
  if (NotificationApi === undefined) return undefined;
  return async ({ title, body }) => {
    if (!optedIn()) return 'denied';
    if (NotificationApi.permission !== 'granted') return 'denied';
    try {
      new NotificationApi(title, { body });
      return 'shown';
    } catch {
      return 'unavailable';
    }
  };
}

/**
 * The whole seat the web default platform carries: the tab as the honesty line's subject, a
 * page-bound promise, and `notify` only where the API exists. Building it has no side effect.
 */
export function webSchedulerSeat(win: NotifyWindow = pageWindow()): SchedulerSeat {
  const notify = createWebNotifySeat(win, () => readWebNotifyOptIn());
  return { ...(notify !== undefined ? { notify } : {}), wakeMode: 'page', hostLabel: 'this tab' };
}
