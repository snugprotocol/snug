// The module-form SnugBridge singleton — the SAME contract as embedded/snug-hooks.js
// (announce/ready handshake, per-request UUID maps, terminal resolution, top-level db
// response fields), but typed and importing every wire constant from the protocol
// package (no retyped literals). One bridge per window, like the embedded form.
import {
  ERROR_CODES,
  FRAME_TYPES,
  PROTOCOL_VERSION,
  parseFrame,
  type ResponseError,
} from '@snugprotocol/protocol';
import type { HostCapabilities, SendMessageResult, SnugTheme } from './types.js';

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
  /** Re-render triggers for mounted hooks. */
  listeners: Set<() => void>;
}

const initialState = (): Omit<BridgeState, 'pending' | 'dbPending' | 'listeners'> => ({
  instanceId: null,
  theme: 'light',
  capabilities: {},
  ready: false,
});

export const bridge: BridgeState = {
  ...initialState(),
  pending: new Map(),
  dbPending: new Map(),
  listeners: new Set(),
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
    case FRAME_TYPES.hostEvent: {
      if (frame.event === 'theme-change') {
        const theme = (frame.data as { theme?: unknown } | null | undefined)?.theme;
        if (theme === 'light' || theme === 'dark') {
          bridge.theme = theme;
          notify();
        }
      }
      // Unknown host events MUST be ignored (the protocol is additive).
      return;
    }
    default:
      return; // app-origin frame types echoed on this window — not ours to handle
  }
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
  bridge.listeners.clear();
}
