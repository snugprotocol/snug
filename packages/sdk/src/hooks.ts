// Typed module-form hooks — behaviorally identical to the embedded copy-exactly hooks
// in embedded/snug-hooks.js (locked together by the shared contract test suite).
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { FRAME_TYPES } from '@snugprotocol/protocol';
import { bridge, dbRequest, ensureListener, netRequest, notConnectedResult, postToHost } from './bridge.js';
import type {
  AppDb,
  ConnectedFetch,
  ConnectedFetchOptions,
  SendMessageOptions,
  SendMessageResult,
  SnugAppMeta,
  UseSnugAppResult,
} from './types.js';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Connects the app to the Snug host: announces on mount, re-renders on host pushes
 * (ready, theme-change), and exposes the ALWAYS-resolving sendMessage.
 */
export function useSnugApp(meta: SnugAppMeta): UseSnugAppResult {
  const [, setTick] = useState(0);
  const [isWaiting, setIsWaiting] = useState(false);
  const [lastResponse, setLastResponse] = useState<SendMessageResult | null>(null);
  const inFlight = useRef(0);
  const metaRef = useRef(meta);

  useEffect(() => {
    const rerender = (): void => setTick((n) => n + 1);
    bridge.listeners.add(rerender);
    const m = metaRef.current;
    postToHost({
      type: FRAME_TYPES.announce,
      appId: m.appId,
      displayName: m.displayName,
      description: m.description,
      iconEmoji: m.iconEmoji,
      iconColor: m.iconColor,
    });
    return () => void bridge.listeners.delete(rerender);
  }, []);

  const sendMessage = useCallback(
    (action: string, payload?: unknown, opts?: SendMessageOptions): Promise<SendMessageResult> => {
      if (!bridge.ready) return Promise.resolve(notConnectedResult());
      const requestId = crypto.randomUUID(); // fresh per request — multiple in flight are legal
      inFlight.current += 1;
      setIsWaiting(true);
      return new Promise((resolve) => {
        bridge.pending.set(requestId, {
          onStream: opts?.onStream,
          resolve: (result) => {
            inFlight.current -= 1;
            if (inFlight.current === 0) setIsWaiting(false);
            setLastResponse(result);
            resolve(result);
          },
        });
        postToHost({
          type: FRAME_TYPES.appMessage,
          requestId,
          appId: metaRef.current.appId,
          action,
          payload,
          state: opts?.state,
          responseSchema: opts?.responseSchema,
        });
      });
    },
    [],
  );

  return {
    isReady: bridge.ready,
    theme: bridge.theme,
    isWaiting,
    lastResponse,
    sendMessage,
  };
}

/**
 * Host-brokered persisted key-value state. Hydrates once the host is ready (merging
 * stored objects over the initial defaults so fields added in newer code are never
 * undefined), then writes back on every change. Write-back is gated on the CURRENT
 * key having hydrated — a key change re-hydrates before any write.
 */
export function usePersistedState<T>(key: string, initialValue: T): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(initialValue);
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const initialRef = useRef(initialValue);

  useEffect(() => {
    ensureListener(); // usePersistedState may be the first (or only) hook to mount
    let cancelled = false;
    const hydrate = async (): Promise<void> => {
      const result = await dbRequest('kvGet', { key });
      if (cancelled) return;
      if (result.ok && result.value != null) {
        const stored = result.value;
        const init = initialRef.current;
        setState(isPlainObject(stored) && isPlainObject(init) ? ({ ...init, ...stored } as T) : (stored as T));
      } else {
        setState(initialRef.current); // nothing stored under this key — back to defaults
      }
      setHydratedKey(key);
    };
    const onReady = (): void => {
      if (!bridge.ready) return;
      bridge.listeners.delete(onReady);
      void hydrate();
    };
    if (bridge.ready) void hydrate();
    else bridge.listeners.add(onReady);
    return () => {
      cancelled = true;
      bridge.listeners.delete(onReady);
    };
  }, [key]);

  useEffect(() => {
    if (hydratedKey !== key) return;
    void dbRequest('kvSet', { key, value: state }); // fire-and-forget; host acks via db-response
  }, [hydratedKey, key, state]);

  return [state, setState];
}

/**
 * Host-brokered network access to the app's APPROVED hosts (AL-03). The sandboxed app
 * has no network of its own (C2); this posts a net-request and resolves the terminal
 * net-response. The host validates the frozen host ceiling, injects credentials, blocks
 * private ranges, caps sizes, gates mutating calls behind user confirmation, and scrubs
 * the response — the app never sees a credential value. ALWAYS resolves (errors as data).
 */
export function useConnectedFetch(): ConnectedFetch {
  return useMemo<ConnectedFetch>(() => {
    ensureListener(); // useConnectedFetch may be the first hook to mount
    return {
      fetch(url: string, opts?: ConnectedFetchOptions) {
        return netRequest({
          url,
          method: (opts && opts.method) || 'GET',
          ...(opts && opts.headers ? { headers: opts.headers } : {}),
          ...(opts && opts.body !== undefined ? { body: opts.body } : {}),
        });
      },
    };
  }, []);
}

/** Host-brokered SQL access to the app's namespace database. Failures throw (unlike sendMessage). */
export function useAppDB(): AppDb {
  return useMemo(() => {
    ensureListener(); // useAppDB may be the first hook to mount
    return {
      async exec(sql: string, params?: unknown[]) {
        const result = await dbRequest('exec', { sql, params });
        if (!result.ok) throw new Error(result.error.message || 'db exec failed');
        return { rows: result.rows ?? [], columns: result.columns ?? [] };
      },
      async exportDb() {
        const result = await dbRequest('export', {});
        if (!result.ok) throw new Error(result.error.message || 'db export failed');
        return result.bytesBase64 ?? '';
      },
      async importDb(bytesBase64: string) {
        const result = await dbRequest('import', { bytesBase64 });
        if (!result.ok) throw new Error(result.error.message || 'db import failed');
      },
    };
  }, []);
}
