// Shared jsdom harness for the SDK contract tests: renders probe components that call
// the hooks under test, and plays the HOST side of the bridge on the same window.
//
// jsdom notes: in a top-level jsdom window, `window.parent === window`, so frames the
// hooks post via `window.parent.postMessage` arrive as ordinary (async) message events
// on `window` — the host stub collects them there. Host→app frames are dispatched as
// synchronous MessageEvents inside `act` so React state updates settle deterministically,
// with `source: window` — the host IS `window.parent` here, and the bridge in both forms
// accepts a frame only from `window.parent` (TASK-20261010-host-broker PR-6, D-PR6-2).
// `foreign()` dispatches the same frame from a SIBLING frame (a jsdom <iframe>'s
// contentWindow) — the negative rows of the source guard.
//
// jsdom's own postMessage never structured-clones (a function in a frame posts fine);
// `cloneFaithfulPostMessage()` makes it clone like a browser so the DataCloneError arms run.
import { act } from 'react';
import { createElement, type FunctionComponent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  FRAME_TYPES,
  PROTOCOL_VERSION,
  type ResponseError,
} from '@snugprotocol/protocol';
import { vi } from 'vitest';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Several act-wrapped timer turns: jsdom delivers postMessage on a macrotask, and act
 * flushes React work (renders + passive effects) only on exit — so a post → effect →
 * post chain (e.g. hydration then write-back) needs multiple SEPARATE act rounds, not
 * one act around many timers.
 */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/**
 * Drains message deliveries still queued from a previous test WITHOUT involving React —
 * call before installing a fresh host stub so stragglers are not misattributed.
 */
export async function drainMessageQueue(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

export interface AppFrame {
  type: string;
  requestId?: string;
  instanceId?: string | null;
  appId?: string;
  action?: string;
  payload?: unknown;
  state?: unknown;
  responseSchema?: unknown;
  op?: string;
  sql?: string;
  params?: unknown[];
  key?: string;
  value?: unknown;
  bytesBase64?: string;
  [extra: string]: unknown;
}

const APP_ORIGIN_TYPES = new Set<string>([
  FRAME_TYPES.announce,
  FRAME_TYPES.appMessage,
  FRAME_TYPES.appCancel,
  FRAME_TYPES.dbRequest,
  FRAME_TYPES.netRequest,
  FRAME_TYPES.appEvent,
  FRAME_TYPES.accessRequest, // TASK-20261010-cross-app-access AC5 — collected for accessRequests()
]);

export interface HostStub {
  /** Every app-origin frame observed on the window, in order. */
  fromApp: AppFrame[];
  frames(type: string): AppFrame[];
  /** Db-request frames of one op. */
  dbRequests(op: string): AppFrame[];
  /** Net-request frames observed on the window (AL-03). */
  netRequests(): AppFrame[];
  /** Dispatches a raw frame to the app side (inside act), FROM the host: `source` is `window` (= `window.parent` in jsdom). */
  post(frame: Record<string, unknown>): void;
  /**
   * Dispatches the same raw frame from a SIBLING frame in the same document — `source` is a jsdom
   * `<iframe>`'s contentWindow, never `window.parent` (D-PR6-2's negative rows). The bridge must
   * ignore it whole.
   */
  foreign(frame: Record<string, unknown>): void;
  /** The sibling frame's window `foreign()` posts from (created on first use, removed on dispose). */
  siblingWindow(): Window;
  /** Posts a valid host-ready frame (instanceId 'ins-1' unless overridden). */
  ready(over?: Record<string, unknown>): void;
  streaming(requestId: string, text: string, seq: number): void;
  succeed(requestId: string, data: Record<string, unknown>): void;
  failRequest(requestId: string, error: Partial<ResponseError>): void;
  dbSucceed(requestId: string, fields?: Record<string, unknown>): void;
  dbFail(requestId: string, error: Partial<ResponseError>): void;
  netSucceed(requestId: string, fields?: Record<string, unknown>): void;
  netFail(requestId: string, error: Partial<ResponseError>): void;
  /** Access-request frames observed on the window (TASK-20261010-cross-app-access AC5). */
  accessRequests(): AppFrame[];
  /** Answers one access-request with a success response; `fields` carries `op` and its result seats. */
  accessSucceed(requestId: string, fields: Record<string, unknown>): void;
  /** Answers one access-request with an error response (errors as data). */
  accessFail(requestId: string, error: Partial<ResponseError>): void;
  dispose(): void;
}

/** A message event as the browser delivers it: `data` plus the posting window as `source`. */
function messageFrom(source: Window, data: unknown): MessageEvent {
  try {
    return new MessageEvent('message', { data, source });
  } catch {
    const event = new MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: source });
    return event;
  }
}

/**
 * Makes `window.parent.postMessage` structured-clone its message first, like a browser: a value
 * `structuredClone` refuses (a function, a symbol) throws `DataCloneError` and posts nothing.
 * jsdom's own postMessage never clones. Returns the restore; the spy is also undone by
 * `vi.restoreAllMocks()`.
 */
export function cloneFaithfulPostMessage(): () => void {
  const target = window.parent;
  const original = target.postMessage.bind(target) as (message: unknown, targetOrigin: string) => void;
  const spy = vi.spyOn(target, 'postMessage').mockImplementation(((message: unknown, targetOrigin: string) => {
    structuredClone(message); // throws DataCloneError exactly where a browser would
    original(message, targetOrigin);
  }) as never);
  return () => spy.mockRestore();
}

export function hostStub(): HostStub {
  const fromApp: AppFrame[] = [];
  let sibling: HTMLIFrameElement | undefined;
  const listener = (event: MessageEvent): void => {
    const data = event.data as AppFrame | null;
    if (data && typeof data.type === 'string' && APP_ORIGIN_TYPES.has(data.type)) fromApp.push(data);
  };
  window.addEventListener('message', listener);

  const error = (over: Partial<ResponseError>): ResponseError => ({
    code: 'HOST_ERROR',
    message: 'boom',
    retryable: false,
    ...over,
  });

  const stub: HostStub = {
    fromApp,
    frames: (type) => fromApp.filter((f) => f.type === type),
    dbRequests: (op) => fromApp.filter((f) => f.type === FRAME_TYPES.dbRequest && f.op === op),
    netRequests: () => fromApp.filter((f) => f.type === FRAME_TYPES.netRequest),
    post(frame) {
      act(() => {
        window.dispatchEvent(messageFrom(window, frame));
      });
    },
    siblingWindow() {
      if (!sibling) {
        sibling = document.createElement('iframe');
        document.body.appendChild(sibling);
      }
      const win = sibling.contentWindow;
      if (!win) throw new Error('jsdom <iframe> has no contentWindow');
      if (win === window.parent) throw new Error('the sibling frame must not be window.parent');
      return win;
    },
    foreign(frame) {
      const source = stub.siblingWindow();
      act(() => {
        window.dispatchEvent(messageFrom(source, frame));
      });
    },
    ready(over = {}) {
      stub.post({
        v: PROTOCOL_VERSION,
        type: FRAME_TYPES.hostReady,
        instanceId: 'ins-1',
        protocolVersions: [PROTOCOL_VERSION],
        capabilities: { streaming: true, db: true, auth: false },
        theme: 'light',
        ...over,
      });
    },
    streaming(requestId, text, seq) {
      stub.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.appResponse, requestId, ok: true, streaming: true, text, seq });
    },
    succeed(requestId, data) {
      stub.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.appResponse, requestId, ok: true, streaming: false, data });
    },
    failRequest(requestId, over) {
      stub.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.appResponse, requestId, ok: false, error: error(over) });
    },
    dbSucceed(requestId, fields = {}) {
      stub.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.dbResponse, requestId, ok: true, ...fields });
    },
    dbFail(requestId, over) {
      stub.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.dbResponse, requestId, ok: false, error: error(over) });
    },
    netSucceed(requestId, fields = {}) {
      stub.post({
        v: PROTOCOL_VERSION,
        type: FRAME_TYPES.netResponse,
        requestId,
        ok: true,
        status: 200,
        headers: {},
        body: '',
        ...fields,
      });
    },
    netFail(requestId, over) {
      stub.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.netResponse, requestId, ok: false, error: error(over) });
    },
    accessRequests: () => fromApp.filter((f) => f.type === FRAME_TYPES.accessRequest),
    accessSucceed(requestId, fields) {
      stub.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.accessResponse, requestId, ok: true, ...fields });
    },
    accessFail(requestId, over) {
      stub.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.accessResponse, requestId, ok: false, error: error(over) });
    },
    dispose() {
      window.removeEventListener('message', listener);
      sibling?.remove();
      sibling = undefined;
    },
  };
  return stub;
}

export interface Probe<T> {
  /** The latest return value of the probed hook body. */
  result: { current: T };
  rerender(nextBody?: () => T): Promise<void>;
  unmount(): void;
}

/** Renders a component whose body runs `body()` each render, capturing the return value. */
export async function renderProbe<T>(body: () => T): Promise<Probe<T>> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const result = { current: undefined as T };
  let currentBody = body;

  const ProbeComponent: FunctionComponent = () => {
    result.current = currentBody();
    return null;
  };

  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(createElement(ProbeComponent));
    });
  };
  await render();

  return {
    result,
    rerender: async (nextBody) => {
      if (nextBody) currentBody = nextBody;
      await render();
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
