// Shared jsdom harness for host tests.
//
// jsdom notes (probed, documented per task):
// - jsdom does NOT reliably fire iframe `load` for srcdoc documents: the single
//   natural load is only delivered to listeners registered BEFORE appendChild, and
//   srcdoc (re)assignment never fires one. Hosts attach after append (as in real
//   embedding), so this harness simulates every document load explicitly with
//   `iframe.dispatchEvent(new Event('load'))` after the srcdoc assignment settles.
// - `new MessageEvent('message', { source: iframe.contentWindow })` works; a
//   defineProperty fallback is kept for safety.
// - srcdoc content is never parsed/executed by jsdom — real-browser behavior is
//   covered by browser-csp.spec.template.ts in the Playwright harness.
import {
  FRAME_TYPES,
  PROTOCOL_VERSION,
  type Frame,
  type HostReadyFrame,
} from '@snugprotocol/protocol';
import { vi } from 'vitest';
import { createRunnerHost, type FrameDirection, type RunnerHost, type RunnerHostOptions } from '../host.js';
import type { AgentTransportOptions, BudgetStore, TransportResult } from '../transport.js';

export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface TransportCall {
  wire: string;
  options: AgentTransportOptions;
}

export type TransportHandler = (call: TransportCall, index: number) => Promise<TransportResult>;

export function fakeTransport(handler: TransportHandler) {
  const calls: TransportCall[] = [];
  return {
    calls,
    send(wire: string, options: AgentTransportOptions): Promise<TransportResult> {
      const call = { wire, options };
      calls.push(call);
      return handler(call, calls.length - 1);
    },
  };
}

export const jsonReply = (data: Record<string, unknown>): TransportResult => ({
  ok: true,
  text: JSON.stringify(data),
});

export function memoryBudget(): BudgetStore & { data: Map<string, number> } {
  const data = new Map<string, number>();
  return {
    data,
    get: (key) => data.get(key) ?? 0,
    set: (key, value) => void data.set(key, value),
  };
}

export const announceFrame = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.announce,
  appId: 'chess',
  displayName: 'Chess',
  ...over,
});

export const messageFrame = (
  requestId: string,
  instanceId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.appMessage,
  requestId,
  instanceId,
  appId: 'chess',
  action: 'player_move',
  payload: { from: 'e2', to: 'e4' },
  ...over,
});

export function postFromApp(iframe: HTMLIFrameElement, data: unknown): void {
  let event: MessageEvent;
  try {
    event = new MessageEvent('message', { data, source: iframe.contentWindow });
  } catch {
    event = new MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: iframe.contentWindow });
  }
  window.dispatchEvent(event);
}

export interface HostContext {
  iframe: HTMLIFrameElement;
  host: RunnerHost;
  /** Every frame handed to contentWindow.postMessage, in order. */
  posted: Frame[];
  /** onFrame observation log. */
  observed: Array<{ direction: FrameDirection; type: string }>;
  transport: ReturnType<typeof fakeTransport>;
  budget: ReturnType<typeof memoryBudget>;
  /** Dispatches a simulated document load on the iframe. */
  fireLoad(): void;
  /** Announces the app and returns the instanceId from the latest host-ready ack. */
  connect(): Promise<string>;
  readies(): HostReadyFrame[];
  destroy(): void;
}

export interface MountOptions {
  transportHandler?: TransportHandler;
  options?: Partial<Omit<RunnerHostOptions, 'iframe' | 'transport'>> & Record<string, unknown>;
  /** Assign srcdoc and await the natural jsdom load before returning (default true). */
  load?: boolean;
}

export async function mountHost(mount: MountOptions = {}): Promise<HostContext> {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  document.body.appendChild(iframe);

  const transport = fakeTransport(mount.transportHandler ?? (async () => jsonReply({ message: 'ok' })));
  const budget = memoryBudget();
  const observed: Array<{ direction: FrameDirection; type: string }> = [];
  const posted: Frame[] = [];

  const host = createRunnerHost({
    iframe,
    transport,
    budgetKey: 'test-budget',
    budgetStore: budget,
    onFrame: (direction, frame) => observed.push({ direction, type: frame.type }),
    ...(mount.options as object),
  } as RunnerHostOptions);

  const target = iframe.contentWindow;
  if (!target) throw new Error('jsdom iframe has no contentWindow');
  vi.spyOn(target, 'postMessage').mockImplementation((data: unknown) => {
    posted.push(data as Frame);
  });

  if (mount.load !== false) {
    // The embedder (not the host) assigns srcdoc — AFTER the host attached its listener.
    iframe.srcdoc = '<p>app</p>';
    await flush(); // let the srcdoc mutation record reach the host's observer
    iframe.dispatchEvent(new Event('load')); // simulated browser load (see jsdom notes)
    await flush();
  }

  const ctx: HostContext = {
    iframe,
    host,
    posted,
    observed,
    transport,
    budget,
    fireLoad: () => iframe.dispatchEvent(new Event('load')),
    readies: () =>
      posted.filter((f): f is HostReadyFrame => (f as { type?: string }).type === FRAME_TYPES.hostReady),
    connect: async () => {
      postFromApp(iframe, announceFrame());
      await flush();
      const ready = ctx.readies().at(-1);
      if (!ready) throw new Error('no host-ready ack after announce');
      return ready.instanceId;
    },
    destroy: () => {
      host.destroy();
      iframe.remove();
    },
  };
  return ctx;
}

/** Terminal + streaming app-response frames posted for a requestId. */
export function responsesFor(ctx: HostContext, requestId: string): Frame[] {
  return ctx.posted.filter(
    (f) =>
      (f as { type?: string }).type === FRAME_TYPES.appResponse &&
      (f as { requestId?: string }).requestId === requestId,
  );
}
