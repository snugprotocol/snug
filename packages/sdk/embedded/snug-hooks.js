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
  netPending: new Map(), // requestId -> resolve
  accessPending: new Map(), // requestId -> settle (section 7)
  hostEventListeners: new Map(), // event -> Set of listeners (section 6)
  listeners: new Set(),  // re-render triggers for hooks

  post(frame) {
    window.parent.postMessage({ v: 1, instanceId: this.instanceId, ...frame }, '*');
  },
  notify() { for (const fn of this.listeners) fn(); },
};

window.addEventListener('message', (event) => {
  const data = event.data;
  if (event.source !== window.parent || !data || data.v !== 1) return; // the host alone, never a sibling frame

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

  if (data.type === 'snug:net-response') {
    const resolve = SnugBridge.netPending.get(data.requestId);
    if (!resolve) return;
    SnugBridge.netPending.delete(data.requestId);
    // Result fields (status/headers/body/truncated) live at the TOP LEVEL of the frame.
    resolve(data.ok
      ? { ok: true, status: data.status, headers: data.headers, body: data.body, truncated: data.truncated }
      : { ok: false, error: data.error });
    return;
  }

  if (data.type === 'snug:access-response') {
    const settle = SnugBridge.accessPending.get(data.requestId);
    if (!settle) return; // unknown or already-answered requestId - ignore
    SnugBridge.accessPending.delete(data.requestId); // terminal - exactly one per requestId
    settle(data);
    return;
  }

  if (data.type === 'snug:host-event') {
    if (data.event === 'theme-change' && data.data && data.data.theme) {
      SnugBridge.theme = data.data.theme;
      SnugBridge.notify();
    }
    // Unknown host events MUST be ignored (the protocol is additive).
    // Section 6's subscribers get theirs by name.
    const subscribers = SnugBridge.hostEventListeners.get(data.event);
    if (subscribers) for (const fn of [...subscribers]) fn(data.data);
  }
});

function snugDbRequest(op, args) {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    SnugBridge.dbPending.set(requestId, resolve);
    SnugBridge.post({ type: 'snug:db-request', requestId, op, ...args });
  });
}

function snugNetRequest(fields) {
  if (!SnugBridge.ready) return Promise.resolve({ ok: false, error: { code: 'HOST_ERROR', message: 'not connected to host yet', retryable: true } });
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    SnugBridge.netPending.set(requestId, resolve);
    SnugBridge.post({ type: 'snug:net-request', requestId, ...fields });
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

// ============================================================
// 5. useConnectedFetch (copy exactly when the app calls an approved API; omit otherwise)
// The sandboxed app has NO network of its own. This reaches ONLY your app's APPROVED
// hosts THROUGH the host, which injects your saved credentials, caps sizes, asks you
// before any write, and scrubs the response. You never see a token.
// A connection whose host only the USER knows (a device on their network): address it as
// snug-connection://<slot>/<path> — the host resolves the approved address; you never learn it.
// ALWAYS resolves: { ok:true, status, headers, body } or { ok:false, error }.
// ============================================================
function useConnectedFetch() {
  return useMemo(() => ({
    fetch(url, opts) {
      return snugNetRequest({
        url,
        method: (opts && opts.method) || 'GET',
        headers: opts && opts.headers,
        body: opts && opts.body,
      });
    },
  }), []);
}

// ============================================================
// 6. useHostEvents + useSnugSchedule (copy exactly when the app listens to the host or takes part in schedules; omit otherwise)
// The host rings NAMED events on one channel — hints with ids, never content. onHostEvent is
// the primitive (returns the unsubscribe); useHostEvents subscribes a component to several by
// name; useSnugSchedule answers the host's scheduled runs; proposeSchedule suggests one — once.
// ============================================================
function onHostEvent(event, listener) {
  let subscribers = SnugBridge.hostEventListeners.get(event);
  if (!subscribers) { subscribers = new Set(); SnugBridge.hostEventListeners.set(event, subscribers); }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) SnugBridge.hostEventListeners.delete(event);
  };
}

function useHostEvents(handlers) {
  const handlersRef = useRef(handlers);
  useEffect(() => { handlersRef.current = handlers; });
  const events = Object.keys(handlers).join('\n');
  useEffect(() => {
    const offs = events.split('\n').filter(Boolean).map((event) =>
      onHostEvent(event, (data) => { const fn = handlersRef.current[event]; if (typeof fn === 'function') fn(data); }));
    return () => { for (const off of offs) off(); };
  }, [events]);
}

const SNUG_SCHEDULE_REMEMBERED = 128;  // answered runIds the page keeps before the oldest is forgotten
const snugScheduleAnswered = new Set(); // runIds answered (or in flight) on this page — the first answer stands
let snugScheduleProposed = false;       // one schedule-request per page

function scheduleInputKey(runId) { return 'snug:schedule:' + runId; }

// The result as the host parses it: ok a boolean, summary a non-empty string, notify only with
// both halves — the bounds are the protocol's; anything else is dropped (a summary, never data).
function snugScheduleResult(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, summary: 'the handler returned no result' };
  const out = { ok: raw.ok === true };
  if (typeof raw.summary === 'string' && raw.summary !== '') out.summary = raw.summary.slice(0, 4096);
  const n = raw.notify;
  if (n && typeof n === 'object' && typeof n.title === 'string' && n.title !== '' && typeof n.body === 'string' && n.body !== '') {
    out.notify = { title: n.title.slice(0, 80), body: n.body.slice(0, 120) };
  }
  return out;
}

async function snugAnswerScheduleHint(data, handler) {
  if (!data || typeof data !== 'object' || typeof data.runId !== 'string' || data.runId === '' || typeof data.taskId !== 'string' || data.taskId === '') return; // not the host's shape — ignore
  if (snugScheduleAnswered.has(data.runId)) return; // a repeated hint: the first answer stands
  snugScheduleAnswered.add(data.runId); // BEFORE the kv round trip, so a duplicate arriving meanwhile is ignored too
  if (snugScheduleAnswered.size > SNUG_SCHEDULE_REMEMBERED) snugScheduleAnswered.delete(snugScheduleAnswered.values().next().value);
  const stored = await snugDbRequest('kvGet', { key: scheduleInputKey(data.runId) });
  const input = stored.ok && stored.value && typeof stored.value === 'object' && !Array.isArray(stored.value) ? stored.value.input : undefined;
  const run = { runId: data.runId, taskId: data.taskId };
  if (input !== undefined) run.input = input;
  let result;
  try {
    result = snugScheduleResult(await handler(run));
  } catch (err) {
    const message = err && err.message;
    result = { ok: false, summary: typeof message === 'string' && message !== '' ? message.slice(0, 4096) : 'the scheduled run failed' };
  }
  SnugBridge.post({ type: 'snug:app-event', event: 'schedule-result', data: result });
}

function useSnugSchedule(handler) {
  const handlerRef = useRef(handler);
  useEffect(() => { handlerRef.current = handler; });
  useEffect(() => onHostEvent('schedule-run', (data) => { snugAnswerScheduleHint(data, (run) => handlerRef.current(run)); }), []);
}

// Suggest a schedule for THIS app — once per page, after a user act, never on load. The shape is
// checked here; the host's strict parse decides. true means the suggestion was SENT, not accepted.
function proposeSchedule(proposal) {
  if (!SnugBridge.ready || snugScheduleProposed) return false;
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return false;
  for (const key of Object.keys(proposal)) if (key !== 'title' && key !== 'steps' && key !== 'spec') return false;
  if (typeof proposal.title !== 'string' || proposal.title === '' || !Array.isArray(proposal.steps) || proposal.steps.length === 0 ||
      !proposal.steps.every((s) => s && typeof s === 'object') || !proposal.spec || typeof proposal.spec !== 'object') return false;
  try {
    SnugBridge.post({ type: 'snug:app-event', event: 'schedule-request', data: proposal });
  } catch (err) {
    return false;
  }
  snugScheduleProposed = true;
  return true;
}

// ============================================================
// 7. useSnugAccess (copy exactly, WITH section 6, when the app reads or changes another app's data; omit otherwise)
// Reads — and, where the user ticked it, changes — ANOTHER app's tables through a user-granted,
// recorded, revocable access (see "Access Between Apps"). The app never names a source: it
// states a purpose and the user decides on host UI. Every call ALWAYS resolves — errors are data.
// ============================================================
function snugAccessCall(fields, settle) {
  if (!SnugBridge.ready) return Promise.resolve({ ok: false, error: { code: 'HOST_ERROR', message: 'not connected to host yet', retryable: true } });
  if (SnugBridge.capabilities.access !== true) return Promise.resolve({ ok: false, error: { code: 'HOST_ERROR', message: 'this host does not offer access between apps', retryable: false } });
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    SnugBridge.accessPending.set(requestId, (frame) => resolve(settle(frame)));
    try {
      SnugBridge.post({ type: 'snug:access-request', requestId, ...fields });
    } catch (err) {
      SnugBridge.accessPending.delete(requestId);
      resolve({ ok: false, error: { code: 'HOST_ERROR', message: 'the access request could not be posted', retryable: false } });
    }
  });
}

// Each settler hands back ONLY the seats the protocol defines for its answer. A success for a
// different op, or one missing its result, is a host fault answered as HOST_ERROR — never a
// mis-shaped success, never a hang.
function snugAccessFault(message) { return { ok: false, error: { code: 'HOST_ERROR', message, retryable: false } }; }
function snugAccessSettle(op, pick) {
  return (frame) => {
    if (frame.ok !== true) return frame.error && typeof frame.error === 'object' ? { ok: false, error: frame.error } : snugAccessFault('the host answered an access ' + op + ' with no error');
    if (typeof frame.op !== 'string') return snugAccessFault('the host answered an access ' + op + ' without its result');
    if (frame.op !== op) return snugAccessFault('the host answered an access ' + frame.op + ' to an access ' + op);
    const result = pick(frame);
    return result === undefined ? snugAccessFault('the host answered an access ' + op + ' without its result') : result;
  };
}
const SNUG_ACCESS_SETTLE = {
  request: snugAccessSettle('request', (f) => (f.grant && typeof f.grant === 'object' ? { ok: true, grant: f.grant } : undefined)),
  query: snugAccessSettle('query', (f) => {
    if (!Array.isArray(f.columns) || !Array.isArray(f.rows)) return undefined;
    const out = { ok: true, columns: f.columns, rows: f.rows };
    if (f.truncated !== undefined) out.truncated = f.truncated;
    if (f.totalRows !== undefined) out.totalRows = f.totalRows;
    return out;
  }),
  write: snugAccessSettle('write', (f) => (typeof f.changes === 'number' ? { ok: true, changes: f.changes } : undefined)),
  refresh: snugAccessSettle('refresh', (f) => (typeof f.fresh !== 'boolean' ? undefined : f.reason !== undefined ? { ok: true, fresh: f.fresh, reason: f.reason } : { ok: true, fresh: f.fresh })),
  list: snugAccessSettle('list', (f) => (Array.isArray(f.grants) ? { ok: true, grants: f.grants } : undefined)),
  release: snugAccessSettle('release', () => ({ ok: true })),
  discover: snugAccessSettle('discover', (f) => (f.candidates === 'none' || f.candidates === 'one' || f.candidates === 'several' ? { ok: true, candidates: f.candidates } : undefined)),
};

// The hints are ids only — { grantId } for three of them; data-changed is { table } or {} — and a malformed data seat is dropped.
function snugGrantHint(event) {
  return (listener) => onHostEvent(event, (data) => {
    if (data && typeof data === 'object' && typeof data.grantId === 'string' && data.grantId !== '') listener({ grantId: data.grantId });
  });
}

function useSnugAccess() {
  return useMemo(() => ({
    request(purpose, opts) {
      const fields = { op: 'request', purpose };
      if (opts && opts.hints !== undefined) fields.hints = opts.hints;
      if (opts && opts.renew !== undefined) fields.renew = opts.renew;
      if (opts && opts.access !== undefined) fields.access = opts.access;
      return snugAccessCall(fields, SNUG_ACCESS_SETTLE.request);
    },
    query(grantId, sql, params) { return snugAccessCall(params !== undefined ? { op: 'query', grantId, sql, params } : { op: 'query', grantId, sql }, SNUG_ACCESS_SETTLE.query); },
    write(grantId, sql, params) { return snugAccessCall(params !== undefined ? { op: 'write', grantId, sql, params } : { op: 'write', grantId, sql }, SNUG_ACCESS_SETTLE.write); },
    refresh(grantId) { return snugAccessCall({ op: 'refresh', grantId }, SNUG_ACCESS_SETTLE.refresh); },
    list() { return snugAccessCall({ op: 'list' }, SNUG_ACCESS_SETTLE.list); },
    release(grantId) { return snugAccessCall({ op: 'release', grantId }, SNUG_ACCESS_SETTLE.release); },
    discover(hints) { return snugAccessCall(hints !== undefined ? { op: 'discover', hints } : { op: 'discover' }, SNUG_ACCESS_SETTLE.discover); },
    onChange: snugGrantHint('access-changed'),
    onSourceChanged: snugGrantHint('access-source-changed'),
    onDataChanged(listener) {
      return onHostEvent('data-changed', (data) => {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return;
        if (data.table === undefined) listener({});
        else if (typeof data.table === 'string' && data.table !== '') listener({ table: data.table });
      });
    },
    onRead: snugGrantHint('access-read'),
  }), []);
}
