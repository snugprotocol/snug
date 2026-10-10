/**
 * The running-app host registry (TASK-20260819-inbox-copilot-fixes).
 *
 * WHY THIS MODULE EXISTS. The connection wizard proves a connection works — it runs the
 * probe, it knows the round trip succeeded — and then throws that knowledge away: the
 * outcome is local state in `DoneScreen` and dies with the sheet. Meanwhile the app is
 * still on screen showing sample data, with nothing admitting it has not caught up.
 *
 * The object that can tell the app is `RunnerHost.notifyEvent`, and it lives ONLY in
 * `RunView`'s `controlsRef`. The wizard is mounted as a SIBLING of the run view
 * (`App.tsx`), so there is no prop path between them and no reason to invent one — the
 * wizard should not own a reference to a frame, and the run view should not know that
 * wizards exist. This registry is the seam: the run view publishes "app X is live and
 * reachable", the wizard asks "is app X reachable? then tell it its data is stale".
 *
 * WHAT RIDES IT, AND WHAT MUST NOT. An INVALIDATION — "go and refetch through the
 * governed seam" — and never data. Two constraints from ADR-0034 force that:
 *   - host-event frames carry no `instanceId`, so a listening app cannot verify the
 *     sender; anything pushed as data would be state the app trusted unverifiably;
 *   - they ride the ordinary 256 KB frame class, where the runner DROPS an oversize
 *     frame silently — a payload that grew with the user's mailbox would fail invisibly
 *     at exactly the moment it mattered.
 * A stale hint costs one redundant governed refetch. That is the whole trade.
 *
 * The event NAME is the existing `connection-event` (ADR-0034, emitted today by the
 * sidecar live pump and consumed by Telepath). The namespace is deliberately open
 * (`hostEventSchema.event` is a bare bounded string) and apps ignore what they do not
 * handle, so this is additive: no new frame type, no schema byte changes, no spec-sync.
 *
 * READINESS AND GENERATIONS (TASK-20261010-host-broker PR-1; ADR-0077 §6). The registry is also
 * where the scheduler's *Run [app]* executor asks whether the OPEN app can take a run — placement
 * (`schedule/runPlacement.ts`) reads "registered"; the live dispatch waits for "ready". An entry
 * carries `{ generation, announced }`: registration stays keyed on the app (a `frameEpoch`
 * remount must NEVER read as a retraction — `setAppHostGeneration` fires no host listener), a
 * separate RunView effect sets the generation and clears `announced`, and only the announce of the
 * CURRENT generation marks the entry ready. Every app-event the live frame forwards carries the
 * generation it came from, so a `schedule-result` can be accepted only from the generation that
 * was hinted. This module stays a LEAF (no imports) — `runPlacement.ts`, `state/net.ts` and the
 * executor all sit above it.
 */

/** What a registered view lends the registry: the frame-facing emit, nothing more. */
type NotifyEvent = (event: string, data?: unknown) => void;

/** One live view: its emit, its registration token, the frame generation and whether that generation announced. */
interface LiveHost {
  notify: NotifyEvent;
  token: symbol;
  generation: number;
  announced: boolean;
}

/**
 * appId → the live handle. A Map rather than a single slot because two app views can be
 * mounted across a navigation, and the registry must answer for the RIGHT one.
 */
const hosts = new Map<string, LiveHost>();

/**
 * Who wants to know when an app's live host registers or retracts: a run delivered to the live
 * frame (TASK-20261009 A2; ADR-0077 §5) settles or hands over when that app closes, and a hidden
 * attempt hands over to the live frame when the app opens. A REMOUNT is neither — the generation
 * changes through `setAppHostGeneration`, which never reaches these listeners.
 */
type HostListener = (appId: string, live: boolean) => void;
const hostListeners = new Set<HostListener>();

/** What a readiness watcher is told; it re-reads the entry itself. */
type ReadyChange = 'registered' | 'announced' | 'retracted';
type ReadyListener = (change: ReadyChange) => void;
const readyListeners = new Map<string, Set<ReadyListener>>();

/**
 * The app→host events a LIVE frame forwards (TASK-20261009 A3): RunView's `onAppEvent`
 * publishes here so a scheduled run delivered to the open app can read its `schedule-result`
 * without holding the frame. Keyed by the HOST-assigned id the view registered under; every
 * event carries the frame generation it came from (ADR-0077 §6).
 */
type AppEventListener = (event: string, data: unknown, generation: number) => void;
const eventListeners = new Map<string, Set<AppEventListener>>();

function announceHosts(appId: string, live: boolean): void {
  for (const listener of hostListeners) listener(appId, live);
}

function announceReady(appId: string, change: ReadyChange): void {
  const listeners = readyListeners.get(appId);
  if (listeners === undefined) return;
  for (const listener of [...listeners]) listener(change);
}

/**
 * Publish a running app's frame handle. Returns its own unregister.
 *
 * A fresh registration is generation 0 and NOT announced: the frame has mounted, its listener
 * may not exist yet (the *run now* race ADR-0077 §6 closes).
 *
 * The returned unregister is TOKEN-SCOPED, and that is load-bearing rather than tidy:
 * StrictMode (and a `frameEpoch` remount) runs mount(A) → mount(B) → unmount(A). A naive
 * `hosts.delete(appId)` in A's cleanup would evict B — the LIVE view — leaving the app
 * unreachable while looking perfectly mounted. That bug presents as "the refresh prompt
 * does nothing, sometimes", which is close to undiagnosable from a bug report.
 */
export function registerAppHost(appId: string, notify: NotifyEvent): () => void {
  const token = Symbol(appId);
  hosts.set(appId, { notify, token, generation: 0, announced: false });
  announceHosts(appId, true);
  announceReady(appId, 'registered');
  return () => {
    // Only retract if this registration is still the current one.
    if (hosts.get(appId)?.token === token) {
      hosts.delete(appId);
      announceHosts(appId, false);
      announceReady(appId, 'retracted');
    }
  };
}

/**
 * The view's frame generation changed (RunView's `frameEpoch`, from its own effect): the entry
 * keeps its registration and its token, takes the generation and is no longer announced until
 * the NEW frame announces. No host listener fires — a remount is not a retraction.
 */
export function setAppHostGeneration(appId: string, generation: number): void {
  const entry = hosts.get(appId);
  if (entry === undefined) return;
  entry.generation = generation;
  entry.announced = false;
}

/** The frame of `generation` announced. A stale call (a replaced frame's late announce) is ignored. */
export function markAppHostAnnounced(appId: string, generation: number): void {
  const entry = hosts.get(appId);
  if (entry === undefined || entry.generation !== generation) return;
  entry.announced = true;
  announceReady(appId, 'announced');
}

/** Is this app on screen and reachable right now? Drives whether the prompt is offered. "Registered", not "ready". */
export function hasLiveAppHost(appId: string): boolean {
  return hosts.has(appId);
}

/** Registered AND its current generation announced — the app's listener exists, a hint will be heard. */
export function isAppHostReady(appId: string): boolean {
  const entry = hosts.get(appId);
  return entry !== undefined && entry.announced;
}

/** The registered view's frame generation; `undefined` when the app is not registered. */
export function liveAppHostGeneration(appId: string): number | undefined {
  return hosts.get(appId)?.generation;
}

/**
 * The registration's token — the identity of ONE mounted view across its remounts. A delegated
 * run captures it beside the generation it began on (`schedule/runPlacement.ts`): a retraction
 * and re-registration mints a new one, so the sticky ask-only posture dies by itself.
 */
export function liveAppHostToken(appId: string): symbol | undefined {
  return hosts.get(appId)?.token;
}

/**
 * Wait for the app to be READY — registered and announced at its current generation — within
 * `timeoutMs`. `true` at once when it already is; `true` when the announce lands (a registration
 * that arrives first is waited through); `false` on the timeout or on a retraction. A remount
 * (a new generation) keeps the wait open: only the NEW generation's announce answers it.
 * `setTimeout` only — vitest's fake clock drives the suites.
 */
export function awaitAppHostReady(appId: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (isAppHostReady(appId)) {
      resolve(true);
      return;
    }
    let done = false;
    let unsubscribe: () => void = () => undefined;
    const settle = (ready: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(ready);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    unsubscribe = watchReady(appId, (change) => {
      if (change === 'retracted') settle(false);
      else if (isAppHostReady(appId)) settle(true);
    });
  });
}

function watchReady(appId: string, listener: ReadyListener): () => void {
  let listeners = readyListeners.get(appId);
  if (listeners === undefined) {
    listeners = new Set();
    readyListeners.set(appId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = readyListeners.get(appId);
    if (current === undefined) return;
    current.delete(listener);
    if (current.size === 0) readyListeners.delete(appId);
  };
}

/** Hear every registration and retraction (`live` says which). Returns the unsubscribe. */
export function subscribeAppHosts(listener: HostListener): () => void {
  hostListeners.add(listener);
  return () => {
    hostListeners.delete(listener);
  };
}

/**
 * Ring one host-event into an app's LIVE frame — a HINT (an event name and ids), never
 * content, for the same two ADR-0034 reasons `notifyAppRefresh` states. Returns whether a
 * frame was there to ring; never throws.
 */
export function notifyAppHost(appId: string, event: string, data?: unknown): boolean {
  const entry = hosts.get(appId);
  if (!entry) return false;
  try {
    entry.notify(event, data);
    return true;
  } catch {
    return false;
  }
}

/** A live view forwards its frame's app-events here (the id is the view's, host-assigned) with the generation they came from. */
export function publishAppEvent(appId: string, event: string, data: unknown, generation: number): void {
  const listeners = eventListeners.get(appId);
  if (listeners === undefined) return;
  for (const listener of listeners) listener(event, data, generation);
}

/** Hear the app-events the live frame of `appId` forwards. Returns the unsubscribe. */
export function subscribeAppEvents(appId: string, listener: AppEventListener): () => void {
  let listeners = eventListeners.get(appId);
  if (listeners === undefined) {
    listeners = new Set();
    eventListeners.set(appId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = eventListeners.get(appId);
    if (current === undefined) return;
    current.delete(listener);
    if (current.size === 0) eventListeners.delete(appId);
  };
}

/**
 * Tell one app that a connection it holds is verified and its data is stale.
 *
 * Returns whether the signal was delivered, so the caller can tell "the app refreshed"
 * from "there was no app to tell" — the wizard opens from settings and from the library,
 * where no frame is mounted at all, and the prompt must degrade to silence there rather
 * than promising something that did not happen.
 *
 * Never throws: `post()` reaches a possibly-destroyed iframe, and an app disappearing
 * mid-click is ordinary, not exceptional. A failure to reach a frame must not surface as
 * an error in the wizard the user is standing in.
 */
export function notifyAppRefresh(appId: string, slot: string): boolean {
  const entry = hosts.get(appId);
  if (!entry) return false;
  try {
    entry.notify('connection-event', { slot, verified: true, requestRefresh: true });
    return true;
  } catch {
    return false;
  }
}

/** Test seam — the registry is module state, so suites must be able to clear it (every listener kind too). */
export function __resetAppHostsForTest(): void {
  hosts.clear();
  hostListeners.clear();
  readyListeners.clear();
  eventListeners.clear();
}
