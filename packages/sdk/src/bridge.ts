// The module-form SnugBridge singleton — the SAME contract as embedded/snug-hooks.js
// (announce/ready handshake, per-request UUID maps, terminal resolution, top-level db
// response fields), but typed and importing every wire constant from the protocol
// package (no retyped literals). One bridge per window, like the embedded form.
import {
  ERROR_CODES,
  FRAME_TYPES,
  PROTOCOL_VERSION,
  parseFrame,
  type AccessOp,
  type AccessResponseFrame,
  type ResponseError,
} from '@snugprotocol/protocol';
import type { AccessFailure, ConnectedFetchResult, HostCapabilities, SendMessageResult, SnugTheme } from './types.js';

/** Result of one host-brokered db op, resolved from TOP-LEVEL db-response frame fields. */
export type DbBridgeResult =
  | { ok: true; rows?: unknown[][]; columns?: string[]; value?: unknown; bytesBase64?: string }
  | { ok: false; error: ResponseError };

export interface PendingEntry {
  onStream?: ((text: string) => void) | undefined;
  resolve(result: SendMessageResult): void;
}

interface BridgeState {
  instanceId: string | null;
  theme: SnugTheme;
  capabilities: HostCapabilities;
  ready: boolean;
  /** requestId → pending sendMessage. Deleted on the terminal frame — exactly one per id. */
  pending: Map<string, PendingEntry>;
  /** requestId → db resolve. */
  dbPending: Map<string, (result: DbBridgeResult) => void>;
  /** requestId → net resolve (AL-03). */
  netPending: Map<string, (result: ConnectedFetchResult) => void>;
  /**
   * requestId → access settle (TASK-20261010-cross-app-access AC5). Each entry maps the PARSED
   * terminal access-response to its own op's result, so the bridge never guesses the op.
   */
  accessPending: Map<string, (frame: AccessResponseFrame) => void>;
  /** Re-render triggers for mounted hooks. */
  listeners: Set<() => void>;
  /**
   * Named host-event subscribers (the open additive channel, R2) — `schedule-run` for the
   * scheduled-run hook (TASK-20261009, ADR-0074 §3). `theme-change` is handled by the bridge
   * itself, before any subscriber, exactly as the embedded form handles it.
   */
  hostEventListeners: Map<string, Set<HostEventListener>>;
}

/** A subscriber to one named host-event; receives the frame's `data` seat (unknown — validate it). */
export type HostEventListener = (data: unknown) => void;

const initialState = (): Omit<BridgeState, 'pending' | 'dbPending' | 'netPending' | 'accessPending' | 'listeners' | 'hostEventListeners'> => ({
  instanceId: null,
  theme: 'light',
  capabilities: {},
  ready: false,
});

export const bridge: BridgeState = {
  ...initialState(),
  pending: new Map(),
  dbPending: new Map(),
  netPending: new Map(),
  accessPending: new Map(),
  listeners: new Set(),
  hostEventListeners: new Map(),
};

function notify(): void {
  for (const fn of bridge.listeners) fn();
}

function onMessage(event: MessageEvent): void {
  const parsed = parseFrame(event.data);
  if (!parsed.ok) return; // non-snug traffic, malformed, or foreign-version frames — ignore (R2)
  const frame = parsed.frame;
  switch (frame.type) {
    case FRAME_TYPES.hostReady: {
      bridge.instanceId = frame.instanceId;
      bridge.theme = frame.theme;
      bridge.capabilities = frame.capabilities;
      bridge.ready = true;
      notify();
      return;
    }
    case FRAME_TYPES.appResponse: {
      const entry = bridge.pending.get(frame.requestId);
      if (!entry) return; // unknown or superseded requestId — ignore
      if (frame.ok && frame.streaming) {
        // Cumulative provisional text — display only. NEVER resolve here.
        entry.onStream?.(frame.text);
        return;
      }
      bridge.pending.delete(frame.requestId); // terminal — exactly one per requestId
      entry.resolve(frame.ok ? { ok: true, data: frame.data } : { ok: false, error: frame.error });
      return;
    }
    case FRAME_TYPES.dbResponse: {
      const resolve = bridge.dbPending.get(frame.requestId);
      if (!resolve) return;
      bridge.dbPending.delete(frame.requestId);
      // Result fields (rows/columns/value/bytesBase64) live at the TOP LEVEL of the frame.
      resolve(
        frame.ok
          ? { ok: true, rows: frame.rows, columns: frame.columns, value: frame.value, bytesBase64: frame.bytesBase64 }
          : { ok: false, error: frame.error },
      );
      return;
    }
    case FRAME_TYPES.netResponse: {
      const resolve = bridge.netPending.get(frame.requestId);
      if (!resolve) return;
      bridge.netPending.delete(frame.requestId);
      // Result fields (status/headers/body/truncated) live at the TOP LEVEL of the frame.
      resolve(
        frame.ok
          ? {
              ok: true,
              status: frame.status,
              headers: frame.headers,
              body: frame.body,
              ...(frame.truncated !== undefined ? { truncated: frame.truncated } : {}),
            }
          : { ok: false, error: frame.error },
      );
      return;
    }
    case FRAME_TYPES.accessResponse: {
      const settle = bridge.accessPending.get(frame.requestId);
      if (!settle) return; // unknown or already-answered requestId — ignore
      bridge.accessPending.delete(frame.requestId); // terminal — exactly one per requestId
      settle(frame);
      return;
    }
    case FRAME_TYPES.hostEvent: {
      if (frame.event === 'theme-change') {
        const theme = (frame.data as { theme?: unknown } | null | undefined)?.theme;
        if (theme === 'light' || theme === 'dark') {
          bridge.theme = theme;
          notify();
        }
      }
      // Unknown host events MUST be ignored (the protocol is additive) — by the bridge. A
      // subscriber that asked for an event by name gets it; nothing else changes.
      dispatchHostEvent(frame.event, frame.data);
      return;
    }
    default:
      return; // app-origin frame types echoed on this window — not ours to handle
  }
}

function dispatchHostEvent(event: string, data: unknown): void {
  const subscribers = bridge.hostEventListeners.get(event);
  if (!subscribers) return;
  for (const fn of [...subscribers]) fn(data); // a copy: a subscriber may unsubscribe mid-dispatch
}

/**
 * Subscribe to one named host-event (host-event frames carry `{event, data}`).
 * Returns the unsubscribe. The bridge keeps handling `theme-change` itself; a subscriber to it
 * simply observes. Idempotent listener install, like every hook.
 */
export function onHostEvent(event: string, listener: HostEventListener): () => void {
  ensureListener();
  let subscribers = bridge.hostEventListeners.get(event);
  if (!subscribers) {
    subscribers = new Set();
    bridge.hostEventListeners.set(event, subscribers);
  }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) bridge.hostEventListeners.delete(event);
  };
}

let listenerInstalled = false;

/**
 * Idempotent: the bridge listens once per window. The embedded form installs its
 * listener at script load; the module form installs on first hook mount or post —
 * every hook calls this so host-ready is never missed regardless of which hook
 * mounts first.
 */
export function ensureListener(): void {
  if (listenerInstalled || typeof window === 'undefined') return;
  listenerInstalled = true;
  window.addEventListener('message', onMessage);
}

/** Posts to the embedding host with the protocol version and current instanceId attached. */
export function postToHost(frame: Record<string, unknown>): void {
  ensureListener();
  window.parent.postMessage({ v: PROTOCOL_VERSION, instanceId: bridge.instanceId, ...frame }, '*');
}

export function dbRequest(op: string, args: Record<string, unknown>): Promise<DbBridgeResult> {
  ensureListener();
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    bridge.dbPending.set(requestId, resolve);
    postToHost({ type: FRAME_TYPES.dbRequest, requestId, op, ...args });
  });
}

/** Post a net-request and resolve on its terminal net-response (AL-03). Always resolves. */
export function netRequest(fields: Record<string, unknown>): Promise<ConnectedFetchResult> {
  ensureListener();
  if (!bridge.ready) {
    return Promise.resolve({
      ok: false,
      error: { code: ERROR_CODES.HOST_ERROR, message: 'not connected to host yet', retryable: true },
    });
  }
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    bridge.netPending.set(requestId, resolve);
    postToHost({ type: FRAME_TYPES.netRequest, requestId, ...fields });
  });
}

/**
 * Post a `snug:access-request` and resolve on its terminal `snug:access-response`, mapped by
 * the caller's `settle` (TASK-20261010-cross-app-access AC5). ALWAYS resolves, never rejects
 * and never hangs on a host that will not answer:
 * - before host-ready it posts nothing and answers the retryable HOST_ERROR (the netRequest
 *   precedent — the strict request needs the host-assigned instanceId);
 * - on a ready host that does not advertise `capabilities.access === true` (a 1.0 host, which
 *   ignores the unknown frame type; a 1.1 host with no handler) it posts nothing and answers a
 *   non-retryable HOST_ERROR — the capability's absence is how the app renders its fallback;
 * - a post the browser refuses (postMessage throws DataCloneError) answers a non-retryable
 *   HOST_ERROR and leaves nothing pending.
 * `fields` carries the protocol's `op` and its seats.
 */
export function accessRequest<R>(
  fields: { op: AccessOp } & Record<string, unknown>,
  settle: (frame: AccessResponseFrame) => R,
): Promise<R | AccessFailure> {
  ensureListener();
  if (!bridge.ready) {
    return Promise.resolve({
      ok: false,
      error: { code: ERROR_CODES.HOST_ERROR, message: 'not connected to host yet', retryable: true },
    });
  }
  if (bridge.capabilities.access !== true) {
    return Promise.resolve({
      ok: false,
      error: { code: ERROR_CODES.HOST_ERROR, message: 'this host does not offer access between apps', retryable: false },
    });
  }
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    bridge.accessPending.set(requestId, (frame) => resolve(settle(frame)));
    try {
      postToHost({ type: FRAME_TYPES.accessRequest, requestId, ...fields });
    } catch {
      bridge.accessPending.delete(requestId);
      resolve({
        ok: false,
        error: { code: ERROR_CODES.HOST_ERROR, message: 'the access request could not be posted', retryable: false },
      });
    }
  });
}

/** The pre-ready guard result: appMessage frames need the host-assigned instanceId. */
export function notConnectedResult(): SendMessageResult {
  return {
    ok: false,
    error: { code: ERROR_CODES.HOST_ERROR, message: 'not connected to host yet', retryable: true },
  };
}

/**
 * TEST-ONLY: resets connection state, pending maps, and hook listeners so contract
 * tests run against a fresh bridge. The window listener stays installed.
 */
export function __resetSnugBridgeForTests(): void {
  Object.assign(bridge, initialState());
  bridge.pending.clear();
  bridge.dbPending.clear();
  bridge.netPending.clear();
  bridge.accessPending.clear();
  bridge.listeners.clear();
  bridge.hostEventListeners.clear();
}
