const { useState, useEffect, useCallback, useMemo, useRef } = React;

// ============================================================
// 1. SNUG BRIDGE RUNTIME (MANDATORY — copy exactly, never edit)
// ============================================================
const SnugBridge = {
  instanceId: null,
  theme: 'light',
  capabilities: {},
  ready: false,
  pending: new Map(),    // requestId -> { resolve, onStream }
  dbPending: new Map(),  // requestId -> resolve
  listeners: new Set(),  // re-render triggers for hooks

  post(frame) {
    window.parent.postMessage({ v: 1, instanceId: this.instanceId, ...frame }, '*');
  },
  notify() { for (const fn of this.listeners) fn(); },
};

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.v !== 1) return;

  if (data.type === 'snug:host-ready') {
    SnugBridge.instanceId = data.instanceId;
    if (data.theme) SnugBridge.theme = data.theme;
    if (data.capabilities) SnugBridge.capabilities = data.capabilities;
    SnugBridge.ready = true;
    SnugBridge.notify();
    return;
  }

  if (data.type === 'snug:app-response') {
    const entry = SnugBridge.pending.get(data.requestId);
    if (!entry) return; // unknown or superseded requestId — ignore
    if (data.streaming) {
      // Cumulative provisional text — display only. NEVER resolve here.
      if (entry.onStream && typeof data.text === 'string') entry.onStream(data.text);
      return;
    }
    SnugBridge.pending.delete(data.requestId); // terminal — exactly one per requestId
    entry.resolve(data.ok ? { ok: true, data: data.data } : { ok: false, error: data.error });
    return;
  }

  if (data.type === 'snug:db-response') {
    const resolve = SnugBridge.dbPending.get(data.requestId);
    if (!resolve) return;
    SnugBridge.dbPending.delete(data.requestId);
    // Result fields (rows/columns/value/bytesBase64) live at the TOP LEVEL of the frame.
    resolve(data.ok
      ? { ok: true, rows: data.rows, columns: data.columns, value: data.value, bytesBase64: data.bytesBase64 }
      : { ok: false, error: data.error });
    return;
  }

  if (data.type === 'snug:host-event') {
    if (data.event === 'theme-change' && data.data && data.data.theme) {
      SnugBridge.theme = data.data.theme;
      SnugBridge.notify();
    }
    // Unknown host events MUST be ignored (the protocol is additive).
  }
});

function snugDbRequest(op, args) {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    SnugBridge.dbPending.set(requestId, resolve);
    SnugBridge.post({ type: 'snug:db-request', requestId, op, ...args });
  });
}

// ============================================================
// 2. useSnugApp (MANDATORY — copy exactly, never edit)
// ============================================================
function useSnugApp(meta) {
  const [, setTick] = useState(0);
  const [isWaiting, setIsWaiting] = useState(false);
  const [lastResponse, setLastResponse] = useState(null);
  const inFlight = useRef(0);
  const metaRef = useRef(meta);

  useEffect(() => {
    const rerender = () => setTick((n) => n + 1);
    SnugBridge.listeners.add(rerender);
    const m = metaRef.current;
    SnugBridge.post({
      type: 'snug:app-announce',
      appId: m.appId,
      displayName: m.displayName,
      description: m.description,
      iconEmoji: m.iconEmoji,
      iconColor: m.iconColor,
    });
    return () => SnugBridge.listeners.delete(rerender);
  }, []);

  const sendMessage = useCallback((action, payload, opts) => {
    if (!SnugBridge.ready) return Promise.resolve({ ok: false, error: { code: 'HOST_ERROR', message: 'not connected to host yet', retryable: true } });
    const requestId = crypto.randomUUID(); // fresh per request — multiple in flight are legal
    inFlight.current += 1;
    setIsWaiting(true);
    return new Promise((resolve) => {
      SnugBridge.pending.set(requestId, {
        onStream: opts && opts.onStream,
        resolve: (result) => {
          inFlight.current -= 1;
          if (inFlight.current === 0) setIsWaiting(false);
          setLastResponse(result);
          resolve(result);
        },
      });
      SnugBridge.post({
        type: 'snug:app-message',
        requestId,
        appId: metaRef.current.appId,
        action,
        payload,
        state: opts && opts.state,
        responseSchema: opts && opts.responseSchema,
      });
    });
  }, []);

  return {
    isReady: SnugBridge.ready,
    theme: SnugBridge.theme,
    isWaiting,
    lastResponse,
    sendMessage,
  };
}

// ============================================================
// 3. usePersistedState (MANDATORY — copy exactly, never edit)
// Storage is HOST-BROKERED key-value. The sandboxed iframe has a
// null origin: no browser storage API works here.
// ============================================================
function usePersistedState(key, initialValue) {
  const [state, setState] = useState(initialValue);
  // Tracks WHICH key hydrated: a key change must re-hydrate before any write-back,
  // or the old key's state would overwrite the new key's stored value.
  const [hydratedKey, setHydratedKey] = useState(null);
  const initialRef = useRef(initialValue);

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const result = await snugDbRequest('kvGet', { key });
      if (cancelled) return;
      if (result.ok && result.value != null) {
        const stored = result.value;
        const init = initialRef.current;
        // Merge objects with defaults so fields added in newer code are never undefined.
        setState(
          stored && typeof stored === 'object' && !Array.isArray(stored) &&
          init && typeof init === 'object' && !Array.isArray(init)
            ? { ...init, ...stored }
            : stored
        );
      } else {
        setState(initialRef.current); // nothing stored under this key — back to defaults
      }
      setHydratedKey(key);
    };
    const onReady = () => {
      if (!SnugBridge.ready) return;
      SnugBridge.listeners.delete(onReady);
      hydrate();
    };
    if (SnugBridge.ready) hydrate();
    else SnugBridge.listeners.add(onReady);
    return () => { cancelled = true; SnugBridge.listeners.delete(onReady); };
  }, [key]);

  useEffect(() => {
    if (hydratedKey !== key) return;
    snugDbRequest('kvSet', { key, value: state }); // fire-and-forget; host acks via db-response
  }, [hydratedKey, key, state]);

  return [state, setState];
}

// ============================================================
// 4. useAppDB (copy exactly when the app needs SQL; omit otherwise)
// ============================================================
function useAppDB() {
  return useMemo(() => ({
    async exec(sql, params) {
      const result = await snugDbRequest('exec', { sql, params });
      if (!result.ok) throw new Error((result.error && result.error.message) || 'db exec failed');
      return { rows: result.rows, columns: result.columns }; // { rows: unknown[][], columns: string[] }
    },
    async exportDb() {
      const result = await snugDbRequest('export', {});
      if (!result.ok) throw new Error((result.error && result.error.message) || 'db export failed');
      return result.bytesBase64;
    },
    async importDb(bytesBase64) {
      const result = await snugDbRequest('import', { bytesBase64 });
      if (!result.ok) throw new Error((result.error && result.error.message) || 'db import failed');
    },
  }), []);
}
