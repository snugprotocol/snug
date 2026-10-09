/**
 * The desktop's scheduler notification seat (TASK-20261009-scheduling-framework H1; ADR-0074
 * §6–§7) — `platform.scheduler.notify` over `@tauri-apps/plugin-notification`.
 *
 * THE RULE, the web seat's (`@playground/platform/webNotify.ts`), mirrored exactly: the seat
 * never ASKS. `requestPermission` is the Settings card's act, on a click; nothing here calls it
 * on any path. A call answers `denied` until two facts both hold at that moment — the user
 * turned notifications on in Settings (the card writes `'1'` under `snug:schedule-notify`) and
 * the plugin reports the permission granted — and both are read PER CALL, never captured at
 * composition (ADR-0036 rule 3), so a grant made after boot is honoured on the next alert and
 * a switch-off is honoured on the next alert too.
 *
 * WHY THE SETTINGS OPT-IN, and not a prompt at the first scheduled alert. The plugin's init
 * script POLYFILLS `window.Notification` in the webview (its `new Notification()` and
 * `requestPermission()` become `plugin:notification|notify` / `|request_permission` invokes),
 * so the playground's Settings card — the ONE consent surface for notifications, web and
 * desktop alike — renders and works on the desktop unchanged, and its state line is truthful
 * only if this seat honours the same flag the card writes. A prompt raised from a scheduled
 * run would be consent asked by a timer rather than by a gesture — the posture §6 exists to
 * refuse — and it would leave the card saying "off" while alerts fired. One flag, one card,
 * one writer.
 *
 * WHAT THE ANSWERS MEAN HERE. `shown` = the text was handed to the OS notification channel;
 * macOS may still hold it (Focus, the per-app switch in System Settings → Notifications —
 * the plugin cannot see those, its desktop `permission_state` is always granted). `denied` =
 * not opted in, or the plugin says not granted. `unavailable` = the channel threw (no
 * `window.Notification` in this webview, an invoke refused). The seat never throws: the engine
 * fires it and forgets, so a throw could only vanish.
 *
 * THE TEXT is the engine's — plain, length-capped, prefixed with the schedule's title and
 * rate-limited before it reaches here (§6). Nothing is added, nothing is read back.
 *
 * MEASURED: an UNBUNDLED binary (`tauri dev`) shows no notification on macOS — the OS keys
 * delivery on the bundle identifier (`org.snugprotocol.desktop`), which only `tauri build`
 * gives it. The owner's walk needs the bundled app; `pnpm --filter desktop bundle`.
 *
 * A sandboxed app frame cannot reach the plugin: `plugin:notification|notify` is key-gated
 * like every command, pinned by the gate rows `ipc-notification-refused` /
 * `ipc-notification-dispatchable` (src/gate/ipc.ts), so an app cannot raise a notification
 * in Snug's name.
 */

import { isPermissionGranted, sendNotification } from '@tauri-apps/plugin-notification';

import type { SchedulerSeat } from '@playground/platform/platform';
import { readWebNotifyOptIn } from '@playground/platform/webNotify.js';

export type DesktopNotify = NonNullable<SchedulerSeat['notify']>;

/** Seam injection for tests only — the shipped wiring uses the real plugin calls and the real flag. */
export interface DesktopNotifyDeps {
  /** Whether the user turned notifications on in Settings — read on every call. */
  optedIn: () => boolean;
  isPermissionGranted: typeof isPermissionGranted;
  sendNotification: typeof sendNotification;
}

const REAL_DEPS: DesktopNotifyDeps = { optedIn: () => readWebNotifyOptIn(), isPermissionGranted, sendNotification };

export function createDesktopNotifySeat(deps: DesktopNotifyDeps = REAL_DEPS): DesktopNotify {
  return async ({ title, body }) => {
    if (!deps.optedIn()) return 'denied';
    let granted: boolean;
    try {
      granted = await deps.isPermissionGranted();
    } catch {
      // The shipped shim reads `window.Notification.permission` before any invoke: a webview
      // without the polyfill (no plugin) throws here, and that is "no channel", not "no".
      return 'unavailable';
    }
    if (!granted) return 'denied';
    try {
      // Synchronous in the shim: `new window.Notification(title, options)` → the polyfill's
      // `plugin:notification|notify` invoke, whose promise the shim drops. A throw is the
      // constructor's (no polyfill), so it is the channel that is missing.
      deps.sendNotification({ title, body });
      return 'shown';
    } catch {
      return 'unavailable';
    }
  };
}
