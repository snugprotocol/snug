// scheduledRunHost.test.tsx — TASK-20261009-scheduling-framework A2 (ADR-0074 §3; security F5;
// feasibility F14): the ONE hidden app frame. It is the SAME `SnugAppFrame` RunView mounts —
// so the C2 negatives hold by construction (`sandbox="allow-scripts"` exactly, the CSP meta
// injected first) — rendered 1×1 with `visibility: hidden` and NEVER `display: none`; it never
// registers as the app's live host; it lends the executor the frame's controls and callbacks;
// it mounts what `hiddenMountStore` holds and nothing when it holds nothing; and it sits
// app-level in `App.tsx` beside `ConnectionWizardNote` (pinned by reading the source, the
// `runningChip.test.tsx` precedent).
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hiddenMountStore, type HiddenMount } from '../schedule/appRun.js';
import { SCHEDULED_RUN_HOST_TEST_ID, ScheduledRunHost } from '../schedule/ScheduledRunHost.js';
import { __resetAppHostsForTest, hasLiveAppHost } from '../state/appHosts.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP_HTML = '<!DOCTYPE html><html><head><title>Weather</title></head><body><div id="root">v1</div></body></html>';

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function mount(over: Partial<HiddenMount> = {}): HiddenMount {
  return {
    appId: 'weather',
    runId: 'run-1',
    html: APP_HTML,
    transport: { send: async () => ({ ok: true, text: '{}' }) },
    frameProps: { db: { handle: async () => ({ ok: true }) } as never, dbNamespace: 'weather' },
    controls: { current: null },
    onAnnounce: vi.fn(),
    onAppEvent: vi.fn(),
    onNavigatedAway: vi.fn(),
    onBudgetExhausted: vi.fn(),
    onUnmounted: vi.fn(),
    ...over,
  };
}

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ScheduledRunHost />);
  });
}

async function show(m: HiddenMount): Promise<HTMLIFrameElement> {
  await act(async () => {
    hiddenMountStore.set(m);
  });
  await act(flush);
  const iframe = container!.querySelector<HTMLIFrameElement>(`[data-testid="${SCHEDULED_RUN_HOST_TEST_ID}"] iframe`);
  if (iframe === null) throw new Error('the hidden frame did not mount');
  return iframe;
}

function postFromApp(iframe: HTMLIFrameElement, data: unknown): void {
  let event: MessageEvent;
  try {
    event = new MessageEvent('message', { data, source: iframe.contentWindow });
  } catch {
    event = new MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: iframe.contentWindow });
  }
  window.dispatchEvent(event);
}

beforeEach(() => {
  __resetAppHostsForTest();
  hiddenMountStore.set(undefined);
});

afterEach(async () => {
  await act(async () => {
    hiddenMountStore.set(undefined);
  });
  if (root !== undefined) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  __resetAppHostsForTest();
});

describe('ScheduledRunHost — one hidden frame, the same component', () => {
  it('renders nothing while no run is mounted', async () => {
    await render();
    expect(container!.querySelector(`[data-testid="${SCHEDULED_RUN_HOST_TEST_ID}"]`)).toBeNull();
    expect(container!.querySelector('iframe')).toBeNull();
  });

  it('C2: the frame is `sandbox="allow-scripts"` EXACTLY and its srcdoc carries the injected CSP meta first — the same component as RunView', async () => {
    await render();
    const iframe = await show(mount());
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    const doc = new DOMParser().parseFromString(iframe.srcdoc, 'text/html');
    const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy" i]');
    expect(meta).not.toBeNull();
    expect(doc.head.firstElementChild).toBe(meta);
    expect(doc.body.textContent).toContain('v1');
  });

  it('is 1×1 and visibility:hidden — never display:none (rAF stalls in a display-none frame), on the frame AND its wrapper', async () => {
    await render();
    const iframe = await show(mount());
    const wrapper = container!.querySelector<HTMLElement>(`[data-testid="${SCHEDULED_RUN_HOST_TEST_ID}"]`)!;
    expect(iframe.style.width).toBe('1px');
    expect(iframe.style.height).toBe('1px');
    expect(iframe.style.visibility).toBe('hidden');
    expect(iframe.style.display).not.toBe('none');
    expect(wrapper.style.visibility).toBe('hidden');
    expect(wrapper.style.display).not.toBe('none');
    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
    expect(iframe.title).toBe('scheduled run');
  });

  it('is out of the TAB ORDER as well as out of sight (S5): `inert` on the wrapper, tabindex=-1 on the frame', async () => {
    await render();
    const iframe = await show(mount());
    const wrapper = container!.querySelector<HTMLElement>(`[data-testid="${SCHEDULED_RUN_HOST_TEST_ID}"]`)!;
    expect(wrapper.hasAttribute('inert')).toBe(true);
    expect(iframe.getAttribute('tabindex')).toBe('-1');
    expect(iframe.tabIndex).toBe(-1);
  });

  it('never registers as the app’s live host (F5): the registry does not know the app while the hidden frame is up', async () => {
    await render();
    await show(mount({ appId: 'weather' }));
    expect(hasLiveAppHost('weather')).toBe(false);
  });

  it('lends the executor the frame’s controls, and routes the app’s announce and app-events to the mount’s callbacks', async () => {
    await render();
    const m = mount();
    const iframe = await show(m);
    expect(m.controls.current).not.toBeNull();
    expect(typeof m.controls.current?.notifyEvent).toBe('function');

    postFromApp(iframe, { v: PROTOCOL_VERSION, type: FRAME_TYPES.announce, appId: 'weather', displayName: 'Weather' });
    await act(flush);
    expect(m.onAnnounce).toHaveBeenCalledTimes(1);

    postFromApp(iframe, { v: PROTOCOL_VERSION, type: FRAME_TYPES.appEvent, event: 'schedule-result', data: { ok: true, summary: 'sunny' } });
    await act(flush);
    expect(m.onAppEvent).toHaveBeenCalledWith('schedule-result', { ok: true, summary: 'sunny' });
  });

  it('a mount for another run REPLACES the frame (keyed by runId); clearing the store unmounts it and returns the controls', async () => {
    await render();
    const first = mount({ runId: 'run-1' });
    const firstFrame = await show(first);
    const second = mount({ runId: 'run-2' });
    const secondFrame = await show(second);
    expect(secondFrame).not.toBe(firstFrame);
    expect(container!.querySelectorAll('iframe')).toHaveLength(1);
    expect(first.controls.current).toBeNull();
    expect(second.controls.current).not.toBeNull();

    await act(async () => {
      hiddenMountStore.set(undefined);
    });
    expect(container!.querySelector('iframe')).toBeNull();
    expect(second.controls.current).toBeNull();
  });

  it('declares streaming:false to the app — the scheduled transport never forwards deltas, so the ready ack must not promise them', async () => {
    await render();
    const m = mount();
    const iframe = await show(m);
    const posted: Array<Record<string, unknown>> = [];
    vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation((data: unknown) => {
      posted.push(data as Record<string, unknown>);
    });
    postFromApp(iframe, { v: PROTOCOL_VERSION, type: FRAME_TYPES.announce, appId: 'weather', displayName: 'Weather' });
    await act(flush);
    const ready = posted.find((frame) => frame.type === FRAME_TYPES.hostReady) as { capabilities?: { streaming?: boolean; openUrl?: boolean } } | undefined;
    expect(ready?.capabilities?.streaming).toBe(false);
    expect(ready?.capabilities?.openUrl).toBe(false); // no user to confirm an open from a hidden frame
  });
});

// ---------------------------------------------------------------------------------------------
// TASK-20261010-host-broker PR-1 (ADR-0077 §5; contract v2 D-PR1-4) — the hidden frame REPORTS
// that it is gone. A hidden attempt handed over to the live frame must not overlap it: the
// executor awaits `HiddenMount.onUnmounted()` before it hints the live frame, so the component
// calls it from its effect CLEANUP keyed by `runId` — when the store is cleared and when the mount
// is replaced by another run's. Exactly once per mount, and never while the frame is still up.
// ---------------------------------------------------------------------------------------------

describe('ScheduledRunHost — reports its unmount (TASK-20261010-host-broker PR-1)', () => {
  it('`onUnmounted` is NOT called while the frame is up', async () => {
    await render();
    const m = mount();
    await show(m);
    expect(m.onUnmounted).not.toHaveBeenCalled();
  });

  it('clearing `hiddenMountStore` calls the mount’s `onUnmounted` once, and the frame is gone', async () => {
    await render();
    const m = mount();
    await show(m);
    await act(async () => {
      hiddenMountStore.set(undefined);
    });
    await act(flush);
    expect(m.onUnmounted).toHaveBeenCalledTimes(1);
    expect(container!.querySelector('iframe')).toBeNull();
  });

  it('a mount for ANOTHER run (the runId changes) calls the PREVIOUS mount’s `onUnmounted` — and not the new one’s', async () => {
    await render();
    const first = mount({ runId: 'run-1' });
    await show(first);
    const second = mount({ runId: 'run-2' });
    await show(second);
    expect(first.onUnmounted).toHaveBeenCalledTimes(1);
    expect(second.onUnmounted).not.toHaveBeenCalled();
  });

  it('a re-render with the SAME runId (a store write of an equal mount) is not an unmount', async () => {
    await render();
    const m = mount({ runId: 'run-1' });
    await show(m);
    await act(async () => {
      hiddenMountStore.set({ ...m });
    });
    await act(flush);
    expect(m.onUnmounted).not.toHaveBeenCalled();
  });
});

describe('the mount in App.tsx', () => {
  it('sits app-level, directly after ConnectionWizardNote — a run can happen on any route', () => {
    const source = readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf8');
    expect(source).toMatch(/import \{ ScheduledRunHost \} from '\.\/schedule\/ScheduledRunHost\.js';/);
    expect(source).toMatch(/<ConnectionWizardNote \/>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<ScheduledRunHost \/>/);
  });
});
