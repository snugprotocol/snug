// schedule/ScheduleSettingsCard.tsx — Settings → schedule (TASK-20261009-scheduling-framework
// U6; ADR-0074 §6–§7). One grouped card: the global pause, the browser-notification opt-in, the
// host's honesty line (and the follower state), and *clear history* behind an armed inline
// confirm.
//
// NOTIFICATIONS ARE ASKED FOR ON THE CLICK, NEVER AT BOOT (H2, ADR-0074 §7): this card reads
// `Notification.permission` to SAY where things stand and calls `requestPermission()` only
// from the button. The opt-in itself is the localStorage flag `WEB_NOTIFY_OPT_IN_KEY`
// (`snug:schedule-notify`, single-homed in `platform/webNotify.ts`): the web seat reads it and
// the browser's permission PER CALL, so turning it on here is honoured on the next alert with
// nothing recomposed. A result that asks for a notification lands in Snug either way, which
// the hint says.
//
// "NEVER LET APPS SUGGEST SCHEDULES" is the localStorage flag `NO_SUGGESTIONS_KEY`
// (`snug:schedule-no-suggestions`). PR-B's suggestion strip (P3) reads it before rendering any
// app's request; nothing in PR-A consumes it, so the switch is NOT rendered yet — a control
// that changes nothing would be a lie on a Settings page. The key stays exported here so PR-B
// reads the name this card will write, and the sentences stay in `copy.page.SETTINGS`. Both
// flags are per browser on purpose: they are about THIS browser's notifications and THIS
// person's patience, not facts of the file.

import { useId, useState } from 'react';
import type { ReactElement } from 'react';

import { WEB_NOTIFY_OPT_IN_KEY, readWebNotifyOptIn } from '../platform/webNotify.js';
import { Card } from '../ui/Card.js';
import { Button } from '../ui/Button.js';
import { followerTab, globalPaused } from './copy.js';
import { SETTINGS } from './copy.page.js';
import { hostHonesty } from './honesty.js';
import { Switch } from './ScheduleStates.js';
import { clearHistory, setGlobalPause, useScheduler } from './scheduler.js';

/** The opt-in flag the web seat reads (`'1'` when on) — `platform/webNotify.ts` owns the name. */
export const NOTIFY_OPT_IN_KEY = WEB_NOTIFY_OPT_IN_KEY;
// PR-B: the mute-every-app flag the suggestion strip reads (`'1'` when on). The switch that
// writes it returns to this card with PR-B, when something reads it.
export const NO_SUGGESTIONS_KEY = 'snug:schedule-no-suggestions';

export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function writeFlag(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // Storage denied (a private window, a blocked origin): the switch still answers for the session.
  }
}

export type NotifyPermission = NotificationPermission | 'unavailable';

/** Where this browser stands — read, never requested. */
export function notifyPermission(): NotifyPermission {
  return typeof Notification === 'undefined' ? 'unavailable' : Notification.permission;
}

function notifyLine(permission: NotifyPermission, optedIn: boolean): string {
  switch (permission) {
    case 'granted':
      return optedIn ? SETTINGS.notifyOn : SETTINGS.notifyAllowed;
    case 'denied':
      return SETTINGS.notifyDenied;
    case 'default':
      return SETTINGS.notifyDefault;
    case 'unavailable':
      return SETTINGS.notifyUnavailable;
    default: {
      const never: never = permission;
      return never;
    }
  }
}

export function ScheduleSettingsCard(): ReactElement {
  const view = useScheduler();
  const paused = view.state?.globalPause === true;
  const follower = view.leader !== undefined && !view.leader.leader;
  const honesty = hostHonesty(view.leader);

  const [permission, setPermission] = useState<NotifyPermission>(notifyPermission);
  const [notifyOptIn, setNotifyOptIn] = useState(() => readWebNotifyOptIn());
  const [asking, setAsking] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [busy, setBusy] = useState(false);

  const pauseId = useId();

  const askForNotifications = async (): Promise<void> => {
    if (typeof Notification === 'undefined') return;
    setAsking(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      const granted = result === 'granted';
      writeFlag(NOTIFY_OPT_IN_KEY, granted);
      setNotifyOptIn(granted);
    } finally {
      setAsking(false);
    }
  };

  const turnOffNotifications = (): void => {
    writeFlag(NOTIFY_OPT_IN_KEY, false);
    setNotifyOptIn(false);
  };

  const togglePause = async (next: boolean): Promise<void> => {
    setBusy(true);
    try {
      await setGlobalPause(next);
    } finally {
      setBusy(false);
    }
  };

  const confirmClear = async (): Promise<void> => {
    setBusy(true);
    try {
      await clearHistory();
      setCleared(true);
    } finally {
      setBusy(false);
      setClearArmed(false);
    }
  };

  const offerNotifyButton = permission === 'default' || (permission === 'granted' && !notifyOptIn);

  return (
    <Card className="settings-group" data-testid="schedule-settings-card">
      <div className="settings-row schedule-settings-row">
        <div className="schedule-settings-copy">
          <strong id={pauseId}>{SETTINGS.pauseAll}</strong>
          <span className="hint">{SETTINGS.pauseHint}</span>
        </div>
        <Switch checked={paused} onChange={(next) => void togglePause(next)} labelledBy={pauseId} disabled={busy} testId="schedule-global-pause" />
      </div>
      {paused ? (
        <div className="settings-row">
          <div className="connection-note" role="status" data-testid="schedule-global-paused-banner">
            <p className="connection-note-title">{globalPaused}</p>
          </div>
        </div>
      ) : null}

      <div className="settings-row schedule-settings-row">
        <div className="schedule-settings-copy">
          <strong>{SETTINGS.notifyHeading}</strong>
          <span className="hint" data-testid="schedule-notify-state">
            {notifyLine(permission, notifyOptIn)}
          </span>
          <span className="hint">{SETTINGS.notifyHint}</span>
        </div>
        {offerNotifyButton ? (
          <Button onClick={() => void askForNotifications()} disabled={asking} data-testid="schedule-notify-ask">
            {SETTINGS.notifyAsk}
          </Button>
        ) : permission === 'granted' && notifyOptIn ? (
          <Button variant="ghost" onClick={turnOffNotifications} data-testid="schedule-notify-off">
            {SETTINGS.notifyOff}
          </Button>
        ) : null}
      </div>

      <div className="settings-row schedule-settings-row">
        <div className="schedule-settings-copy">
          <span data-testid="schedule-honesty">{honesty}</span>
          {follower ? (
            <span className="hint" data-testid="schedule-follower">
              {followerTab}
            </span>
          ) : null}
        </div>
      </div>

      <div className="settings-row schedule-settings-row">
        {clearArmed ? (
          <div className="schedule-confirm" role="group" aria-label={SETTINGS.clearHistory} data-testid="schedule-clear-confirm">
            <span className="hint">{SETTINGS.clearArm}</span>
            <Button variant="danger" onClick={() => void confirmClear()} disabled={busy}>
              {SETTINGS.clearConfirm}
            </Button>
            <Button variant="ghost" onClick={() => setClearArmed(false)}>
              {SETTINGS.clearKeep}
            </Button>
          </div>
        ) : (
          <>
            <div className="schedule-settings-copy">
              <strong>{SETTINGS.clearHistory}</strong>
              {cleared ? (
                <span className="hint" role="status">
                  {SETTINGS.cleared}
                </span>
              ) : null}
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                setCleared(false);
                setClearArmed(true);
              }}
              data-testid="schedule-clear-history"
            >
              {SETTINGS.clearHistory}
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
