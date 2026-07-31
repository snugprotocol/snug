// Shared jsdom harness for the SDK contract tests: renders probe components that call
// the hooks under test, and plays the HOST side of the bridge on the same window.
//
// jsdom notes: in a top-level jsdom window, `window.parent === window`, so frames the
// hooks post via `window.parent.postMessage` arrive as ordinary (async) message events
// on `window` — the host stub collects them there. Host→app frames are dispatched as
// synchronous MessageEvents inside `act` so React state updates settle deterministically.
import { act } from 'react';
import { createElement, type FunctionComponent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  FRAME_TYPES,
  PROTOCOL_VERSION,
  type ResponseError,
} from '@snugprotocol/protocol';

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
  FRAME_TYPES.appEvent,
]);

export interface HostStub {
  /** Every app-origin frame observed on the window, in order. */
  fromApp: AppFrame[];
  frames(type: string): AppFrame[];
  /** Db-request frames of one op. */
  dbRequests(op: string): AppFrame[];
  /** Dispatches a raw frame to the app side (inside act). */
  post(frame: Record<string, unknown>): void;
  /** Posts a valid host-ready frame (instanceId 'ins-1' unless overridden). */
  ready(over?: Record<string, unknown>): void;
  streaming(requestId: string, text: string, seq: number): void;
  succeed(requestId: string, data: Record<string, unknown>): void;
  failRequest(requestId: string, error: Partial<ResponseError>): void;
  dbSucceed(requestId: string, fields?: Record<string, unknown>): void;
  dbFail(requestId: string, error: Partial<ResponseError>): void;
  dispose(): void;
}

export function hostStub(): HostStub {
  const fromApp: AppFrame[] = [];
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
    post(frame) {
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data: frame }));
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
    dispose() {
      window.removeEventListener('message', listener);
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
