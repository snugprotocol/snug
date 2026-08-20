// TASK-20260819-inbox-copilot-fixes AC1-AC3 — the running-app host registry and the
// verified-connection refresh signal. RED-FIRST at Gate 3 against a repo where the
// wizard has NO path to a running app's frame.
//
// WHY THIS EXISTS. The connection wizard proves a connection works and then throws that
// knowledge away: the probe outcome is local `useState` in `DoneScreen` and dies with
// the sheet. A user finishes the wizard and keeps looking at sample data, with nothing
// on screen admitting the app has not caught up. `RunnerHost` — the one object that can
// ring the frame — lives only in `RunView`'s ref, and the wizard is mounted as a SIBLING
// of the run view (App.tsx), so there is no path between them. This registry is that
// path, and nothing more.
//
// The contract it must keep is set by ADR-0034: host-event frames carry no `instanceId`
// (an app cannot verify the sender) and ride the 256 KB frame class where the runner
// DROPS an oversize frame silently. So the signal is an INVALIDATION — "your data is
// stale, go and refetch through the governed seam" — never a delivery of data.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerAppHost,
  notifyAppRefresh,
  hasLiveAppHost,
  __resetAppHostsForTest,
} from '../state/appHosts.js';

describe('the running-app host registry', () => {
  beforeEach(() => {
    __resetAppHostsForTest();
  });

  it('routes a refresh signal to the registered app', () => {
    const notify = vi.fn();
    registerAppHost('app-1', notify);

    const delivered = notifyAppRefresh('app-1', 'gmail');

    expect(delivered).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    const [event, payload] = notify.mock.calls[0]!;
    // AC2: the EXISTING event name, not a new one — the namespace already carries the
    // sidecar pump's emissions and one shipped app-side consumer (Telepath).
    expect(event).toBe('connection-event');
    expect(payload).toMatchObject({ slot: 'gmail', verified: true, requestRefresh: true });
  });

  it('AC3 NEGATIVE: the payload is an invalidation hint — it never carries app data', () => {
    // The load-bearing negative. A host-event frame has no `instanceId`, so a listening
    // app cannot verify who sent it; anything the host pushes as DATA would be state the
    // app trusted without being able to check its provenance. And an oversize frame is
    // dropped silently by the runner, so a payload that grows with the user's mailbox
    // would fail invisibly at exactly the moment it mattered most.
    const notify = vi.fn();
    registerAppHost('app-1', notify);
    notifyAppRefresh('app-1', 'gmail');

    const payload = notify.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['requestRefresh', 'slot', 'verified']);
    expect(JSON.stringify(payload).length).toBeLessThan(200);
  });

  it('is a no-op when the app is not running — the wizard opens from places the app is not', () => {
    // Connections are reachable from settings and from the library, where no frame is
    // mounted at all. The prompt must degrade to "nothing happens", never to a throw.
    expect(hasLiveAppHost('app-1')).toBe(false);
    expect(() => notifyAppRefresh('app-1', 'gmail')).not.toThrow();
    expect(notifyAppRefresh('app-1', 'gmail')).toBe(false);
  });

  it('never rings a DIFFERENT app than the one whose connection was verified', () => {
    // Connections are per-app (`db.listConnections(appId)`), so a verified row belongs to
    // exactly one app. Ringing another app's frame would make it refetch on a signal
    // about a connection it does not hold.
    const mine = vi.fn();
    const other = vi.fn();
    registerAppHost('app-1', mine);
    registerAppHost('app-2', other);

    notifyAppRefresh('app-1', 'gmail');

    expect(mine).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it('unregisters cleanly — a closed view must not be rung through a stale handle', () => {
    const notify = vi.fn();
    const unregister = registerAppHost('app-1', notify);
    unregister();

    expect(hasLiveAppHost('app-1')).toBe(false);
    expect(notifyAppRefresh('app-1', 'gmail')).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('a remount REPLACES the handle rather than stacking a second one', () => {
    // StrictMode mounts, unmounts and remounts; a frameEpoch bump does the same. Two live
    // handles for one app would deliver the signal twice and refetch twice.
    const first = vi.fn();
    const second = vi.fn();
    registerAppHost('app-1', first);
    registerAppHost('app-1', second);

    notifyAppRefresh('app-1', 'gmail');

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('a superseded unregister does not silence the handle that replaced it', () => {
    // The StrictMode ordering hazard: mount(A) → mount(B) → unmount(A). A naive
    // `delete(appId)` on A's cleanup would leave the LIVE view unreachable, and the bug
    // would present as "the prompt does nothing, sometimes".
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerAppHost('app-1', first);
    registerAppHost('app-1', second);
    unregisterFirst();

    expect(hasLiveAppHost('app-1')).toBe(true);
    notifyAppRefresh('app-1', 'gmail');
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('a throwing frame handle never breaks the wizard that rang it', () => {
    // `post()` reaches a possibly-destroyed iframe. The prompt's confirm handler must not
    // surface a runtime error into the wizard because the app went away mid-click.
    registerAppHost('app-1', () => {
      throw new Error('frame is gone');
    });
    expect(() => notifyAppRefresh('app-1', 'gmail')).not.toThrow();
    expect(notifyAppRefresh('app-1', 'gmail')).toBe(false);
  });
});
