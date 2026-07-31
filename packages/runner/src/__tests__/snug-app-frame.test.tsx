// React wrapper ACs: exact sandbox attribute, CSP-injected srcDoc assigned after host
// creation, StrictMode double-mount safety, html-change = reset flow (same host), theme
// passthrough, controlsRef, and unmount teardown.
import { FRAME_TYPES } from '@snugprotocol/protocol';
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Frame, HostReadyFrame } from '@snugprotocol/protocol';
import type { RunnerHost } from '../host.js';
import { SnugAppFrame, type SnugAppFrameProps } from '../react/SnugAppFrame.js';
import type { FrameDirection } from '../host.js';
import { announceFrame, flush, jsonReply, postFromApp } from './harness.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP_HTML = '<!DOCTYPE html><html><head><title>App</title></head><body><div id="root">v1</div></body></html>';

interface Rendered {
  container: HTMLDivElement;
  root: Root;
  iframe: HTMLIFrameElement;
  posted: Frame[];
  observed: Array<{ direction: FrameDirection; type: string }>;
  controls: { current: RunnerHost | null };
  rerender(over?: Partial<SnugAppFrameProps>): Promise<void>;
  unmount(): void;
}

const rendered: Rendered[] = [];
afterEach(() => {
  while (rendered.length > 0) rendered.pop()!.unmount();
  vi.restoreAllMocks();
});

async function render(over: Partial<SnugAppFrameProps> = {}, wrap?: (el: JSX.Element) => JSX.Element): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const observed: Array<{ direction: FrameDirection; type: string }> = [];
  const controls: { current: RunnerHost | null } = { current: null };

  const build = (extra: Partial<SnugAppFrameProps>): JSX.Element => {
    const el = (
      <SnugAppFrame
        html={APP_HTML}
        transport={{ send: async () => jsonReply({ message: 'ok' }) }}
        budgetKey="react-test"
        onFrame={(direction, frame) => observed.push({ direction, type: frame.type })}
        controlsRef={controls}
        {...over}
        {...extra}
      />
    );
    return wrap ? wrap(el) : el;
  };

  await act(async () => {
    root.render(build({}));
  });
  await act(flush); // let jsdom's natural iframe load (delivered async via React's commit) settle
  const iframe = container.querySelector('iframe');
  if (!iframe) throw new Error('no iframe rendered');
  const posted: Frame[] = [];
  vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation((data: unknown) => {
    posted.push(data as Frame);
  });

  const result: Rendered = {
    container,
    root,
    iframe,
    posted,
    observed,
    controls,
    rerender: async (extra = {}) => {
      await act(async () => {
        root.render(build(extra));
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  rendered.push(result);
  return result;
}

describe('SnugAppFrame', () => {
  it('renders an iframe with exactly sandbox="allow-scripts" and passes className/style/title through', async () => {
    const r = await render({ className: 'app-frame', title: 'Chess app', style: { height: 480 } });
    expect(r.iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(r.iframe.className).toBe('app-frame');
    expect(r.iframe.title).toBe('Chess app');
    expect(r.iframe.style.height).toBe('480px');
  });

  it('assigns CSP-injected srcDoc: policy meta first in head, app content preserved', async () => {
    const r = await render();
    const doc = new DOMParser().parseFromString(r.iframe.srcdoc, 'text/html');
    const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy" i]');
    expect(meta).not.toBeNull();
    expect(doc.head.firstElementChild).toBe(meta);
    expect(doc.body.textContent).toContain('v1');
  });

  it('attaches the host before srcDoc: an immediate announce is acked with host-ready', async () => {
    const r = await render();
    postFromApp(r.iframe, announceFrame());
    await act(flush);
    const readies = r.posted.filter((f) => (f as { type?: string }).type === FRAME_TYPES.hostReady);
    expect(readies).toHaveLength(1); // the announce ack (any proactive on-load ready pre-dates the spy)
    const sequence = r.observed.map((o) => `${o.direction}:${o.type}`);
    const announceAt = sequence.indexOf(`inbound:${FRAME_TYPES.announce}`);
    expect(announceAt).toBeGreaterThanOrEqual(0);
    expect(sequence.slice(announceAt + 1)).toContain(`outbound:${FRAME_TYPES.hostReady}`);
  });

  it('is StrictMode-safe: double-mounted effects leave exactly ONE live host', async () => {
    const r = await render({}, (el) => <StrictMode>{el}</StrictMode>);
    postFromApp(r.iframe, announceFrame());
    await act(flush);
    // A leaked first host would double-handle the announce and double-ack.
    const readies = r.posted.filter((f) => (f as { type?: string }).type === FRAME_TYPES.hostReady);
    expect(readies).toHaveLength(1);
    expect(r.controls.current).not.toBeNull();
  });

  it('html change flows through reset semantics: same host, new CSP-injected srcDoc, no navigation cutoff', async () => {
    const onNavigatedAway = vi.fn();
    const r = await render({ onNavigatedAway });
    const hostBefore = r.controls.current;
    await r.rerender({ html: APP_HTML.replace('v1', 'v2') });
    expect(r.controls.current).toBe(hostBefore); // no host recreation
    expect(r.iframe.srcdoc).toContain('v2');
    expect(r.iframe.srcdoc).toContain('Content-Security-Policy');
    await act(flush); // deliver the srcdoc mutation record
    act(() => r.iframe.dispatchEvent(new Event('load'))); // the reload the reassignment causes
    await act(flush);
    expect(onNavigatedAway).not.toHaveBeenCalled();
    const readiesBefore = r.posted.filter((f) => (f as { type?: string }).type === FRAME_TYPES.hostReady).length;
    postFromApp(r.iframe, announceFrame());
    await act(flush);
    const readiesAfter = r.posted.filter((f) => (f as { type?: string }).type === FRAME_TYPES.hostReady).length;
    expect(readiesAfter).toBe(readiesBefore + 1); // the reloaded document's announce is acked
  });

  it('theme prop change posts theme-change and later readies carry it', async () => {
    const r = await render();
    await r.rerender({ theme: 'dark' });
    expect(r.posted.at(-1)).toMatchObject({ type: FRAME_TYPES.hostEvent, event: 'theme-change', data: { theme: 'dark' } });
    postFromApp(r.iframe, announceFrame());
    await act(flush);
    const ready = r.posted.filter((f): f is HostReadyFrame => (f as { type?: string }).type === FRAME_TYPES.hostReady).at(-1);
    expect(ready?.theme).toBe('dark');
  });

  it('setTheme with the current theme posts nothing — no mount-time inspector noise (Gate-5)', async () => {
    const r = await render({ theme: 'dark' });
    const before = r.posted.length;
    r.controls.current!.setTheme('dark'); // unchanged — must be a silent no-op
    await r.rerender({ theme: 'dark' }); // prop-driven path with the same value: also silent
    expect(r.posted.length).toBe(before);
    r.controls.current!.setTheme('light'); // a genuine change still posts
    expect(r.posted.at(-1)).toMatchObject({
      type: FRAME_TYPES.hostEvent,
      event: 'theme-change',
      data: { theme: 'light' },
    });
  });

  it('exposes host controls via controlsRef (reset for the R6 explicit user reset)', async () => {
    const r = await render();
    expect(r.controls.current).not.toBeNull();
    expect(() => r.controls.current!.reset()).not.toThrow();
  });

  it('unmount destroys the host: frames after unmount are neither handled nor posted', async () => {
    const r = await render();
    const iframe = r.iframe;
    r.unmount();
    expect(r.controls.current).toBeNull();
    const postedBefore = r.posted.length;
    const observedBefore = r.observed.length;
    postFromApp(iframe, announceFrame());
    await flush();
    expect(r.posted.length).toBe(postedBefore);
    expect(r.observed.length).toBe(observedBefore);
  });
});
