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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerAppHost,
  notifyAppRefresh,
  hasLiveAppHost,
  __resetAppHostsForTest,
  // TASK-20261010-host-broker PR-1 (ADR-0077 §6): readiness and generations.
  awaitAppHostReady,
  isAppHostReady,
  liveAppHostGeneration,
  markAppHostAnnounced,
  publishAppEvent,
  setAppHostGeneration,
  subscribeAppEvents,
  subscribeAppHosts,
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

// ---------------------------------------------------------------------------------------------
// TASK-20261010-host-broker PR-1 — readiness is explicit (ADR-0077 §6; contract v2 D-PR1-5).
//
// The registry used to register on MOUNT, before the frame announced, with no generation and no
// readiness: *run now* navigated then hinted before the app's listener existed (a 90 s
// `failed`). Entries now carry `{generation, announced}`. Registration stays keyed on the app
// (a remount must NEVER read as a retraction — that is why `setAppHostGeneration` fires no host
// listener), a separate effect sets the generation and clears `announced`, and only an announce
// for the CURRENT generation marks the entry ready. A `schedule-result` is accepted only from
// the generation that was hinted, so every app-event carries the generation it came from.
// ---------------------------------------------------------------------------------------------

describe('readiness and generations (TASK-20261010-host-broker PR-1, ADR-0077 §6)', () => {
  beforeEach(() => {
    __resetAppHostsForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a fresh registration is generation 0, registered but NOT ready — `hasLiveAppHost` keeps meaning "registered"', () => {
    expect(liveAppHostGeneration('app-1')).toBeUndefined();
    registerAppHost('app-1', vi.fn());
    expect(hasLiveAppHost('app-1')).toBe(true);
    expect(liveAppHostGeneration('app-1')).toBe(0);
    expect(isAppHostReady('app-1')).toBe(false);
    markAppHostAnnounced('app-1', 0);
    expect(isAppHostReady('app-1')).toBe(true);
  });

  it('`setAppHostGeneration` sets the generation and CLEARS `announced` — and fires NO host listener (a remount is not a retraction)', () => {
    registerAppHost('app-1', vi.fn());
    markAppHostAnnounced('app-1', 0);
    expect(isAppHostReady('app-1')).toBe(true);
    const listener = vi.fn();
    subscribeAppHosts(listener);

    setAppHostGeneration('app-1', 3);

    expect(liveAppHostGeneration('app-1')).toBe(3);
    expect(isAppHostReady('app-1')).toBe(false);
    expect(hasLiveAppHost('app-1')).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it('`markAppHostAnnounced` ignores a STALE generation — an announce from the frame that was just replaced never marks the new one ready', () => {
    registerAppHost('app-1', vi.fn());
    setAppHostGeneration('app-1', 2);
    markAppHostAnnounced('app-1', 1);
    expect(isAppHostReady('app-1')).toBe(false);
    markAppHostAnnounced('app-1', 2);
    expect(isAppHostReady('app-1')).toBe(true);
  });

  it('`markAppHostAnnounced` for an app that is not registered is a no-op (never registers it)', () => {
    markAppHostAnnounced('app-1', 0);
    expect(hasLiveAppHost('app-1')).toBe(false);
    expect(isAppHostReady('app-1')).toBe(false);
  });

  it('`awaitAppHostReady` answers true AT ONCE when the host is already ready', async () => {
    vi.useFakeTimers();
    registerAppHost('app-1', vi.fn());
    markAppHostAnnounced('app-1', 0);
    let settled: boolean | undefined;
    void awaitAppHostReady('app-1', 10_000).then((ready) => {
      settled = ready;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });

  it('`awaitAppHostReady` answers true when the host BECOMES ready inside the bound', async () => {
    vi.useFakeTimers();
    registerAppHost('app-1', vi.fn());
    let settled: boolean | undefined;
    void awaitAppHostReady('app-1', 10_000).then((ready) => {
      settled = ready;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBeUndefined();
    markAppHostAnnounced('app-1', 0);
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(true);
  });

  it('`awaitAppHostReady` is not answered by a remount: a new generation keeps it waiting, and the NEW generation’s announce answers it', async () => {
    vi.useFakeTimers();
    registerAppHost('app-1', vi.fn());
    let settled: boolean | undefined;
    void awaitAppHostReady('app-1', 10_000).then((ready) => {
      settled = ready;
    });
    setAppHostGeneration('app-1', 1);
    markAppHostAnnounced('app-1', 0); // the replaced frame's late announce
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBeUndefined();
    markAppHostAnnounced('app-1', 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(true);
  });

  it('`awaitAppHostReady` answers false on RETRACTION (the app closed before it announced)', async () => {
    vi.useFakeTimers();
    const unregister = registerAppHost('app-1', vi.fn());
    let settled: boolean | undefined;
    void awaitAppHostReady('app-1', 10_000).then((ready) => {
      settled = ready;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBeUndefined();
    unregister();
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
  });

  it('`awaitAppHostReady` answers false on TIMEOUT (registered, never announced) — and not a moment before', async () => {
    vi.useFakeTimers();
    registerAppHost('app-1', vi.fn());
    let settled: boolean | undefined;
    void awaitAppHostReady('app-1', 10_000).then((ready) => {
      settled = ready;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    expect(hasLiveAppHost('app-1')).toBe(true); // the timeout never retracts
  });

  it('`publishAppEvent(appId, event, data, generation)` carries the generation to every `subscribeAppEvents` listener', () => {
    const listener = vi.fn();
    subscribeAppEvents('app-1', listener);
    publishAppEvent('app-1', 'schedule-result', { runId: 'r1', ok: true }, 4);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('schedule-result', { runId: 'r1', ok: true }, 4);
  });

  it('an app-event for one app never reaches another app’s listener, whatever its generation', () => {
    const mine = vi.fn();
    const other = vi.fn();
    subscribeAppEvents('app-1', mine);
    subscribeAppEvents('app-2', other);
    publishAppEvent('app-1', 'schedule-result', {}, 0);
    expect(mine).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });
});
