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
 */

/** What a registered view lends the registry: the frame-facing emit, nothing more. */
type NotifyEvent = (event: string, data?: unknown) => void;

/**
 * appId → the live handle. A Map rather than a single slot because two app views can be
 * mounted across a navigation, and the registry must answer for the RIGHT one.
 */
const hosts = new Map<string, { notify: NotifyEvent; token: symbol }>();

/**
 * Publish a running app's frame handle. Returns its own unregister.
 *
 * The returned unregister is TOKEN-SCOPED, and that is load-bearing rather than tidy:
 * StrictMode (and a `frameEpoch` remount) runs mount(A) → mount(B) → unmount(A). A naive
 * `hosts.delete(appId)` in A's cleanup would evict B — the LIVE view — leaving the app
 * unreachable while looking perfectly mounted. That bug presents as "the refresh prompt
 * does nothing, sometimes", which is close to undiagnosable from a bug report.
 */
export function registerAppHost(appId: string, notify: NotifyEvent): () => void {
  const token = Symbol(appId);
  hosts.set(appId, { notify, token });
  return () => {
    // Only retract if this registration is still the current one.
    if (hosts.get(appId)?.token === token) hosts.delete(appId);
  };
}

/** Is this app on screen and reachable right now? Drives whether the prompt is offered. */
export function hasLiveAppHost(appId: string): boolean {
  return hosts.has(appId);
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

/** Test seam — the registry is module state, so suites must be able to clear it. */
export function __resetAppHostsForTest(): void {
  hosts.clear();
}
