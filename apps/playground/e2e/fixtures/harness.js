// harness.js — mounts the PRODUCTION SnugAppFrame (runner dist, via import map) with a
// scripted in-page AgentTransport, and exposes plain window hooks for the Playwright
// specs (build-run round-trip, StrictMode F-4). No JSX, no bundler.

import { SnugAppFrame } from '@snugprotocol/runner';

const React = window.React;
const { createRoot } = window.ReactDOM;

// ------------------------------------------------------------------ observability
window.__navigatedAway = 0;
window.__budgetExhausted = 0;
window.__announces = []; // AppAnnounceFrame[]
window.__frames = []; // { dir, type, streaming?, ok? }
window.__wires = []; // wire strings handed to the transport (host-built envelopes)
window.__themeAtLastReady = null;

// Scripted transport config — set per __mount call.
let script = { replyJson: '{"ok":true}', deltas: null, delayMs: 0 };

/** AgentTransport per packages/runner/src/transport.ts — errors as data, never thrown. */
const transport = {
  async send(wire, options) {
    window.__wires.push(wire);
    if (script.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, script.delayMs));
    if (options.signal.aborted) {
      return { ok: false, code: 'CANCELLED', message: 'aborted', retryable: false };
    }
    if (Array.isArray(script.deltas)) {
      for (const delta of script.deltas) options.onDelta?.(delta);
    }
    return { ok: true, text: script.replyJson };
  },
};

// ------------------------------------------------------------------------ mount
let root = null;
let setHtmlFn = null;
let controls = null;

function Harness(props) {
  const [html, setHtml] = React.useState(props.html);
  setHtmlFn = setHtml;
  return React.createElement(SnugAppFrame, {
    html,
    transport,
    budgetKey: 'e2e-fixture',
    theme: props.theme ?? 'dark',
    title: 'e2e app frame',
    controlsRef: (value) => {
      controls = value;
    },
    onNavigatedAway: () => {
      window.__navigatedAway += 1;
    },
    onBudgetExhausted: () => {
      window.__budgetExhausted += 1;
    },
    onAnnounce: (frame) => {
      window.__announces.push(frame);
    },
    onFrame: (dir, frame) => {
      const entry = { dir, type: frame.type };
      if (typeof frame.streaming === 'boolean') entry.streaming = frame.streaming;
      if (typeof frame.ok === 'boolean') entry.ok = frame.ok;
      if (frame.type === 'snug:host-ready') window.__themeAtLastReady = frame.theme;
      window.__frames.push(entry);
    },
  });
}

/**
 * Mount (or remount) the frame.
 * @param {{ html: string, strict?: boolean, theme?: 'light'|'dark',
 *           replyJson?: string, deltas?: string[]|null, delayMs?: number }} opts
 */
window.__mount = (opts) => {
  script = {
    replyJson: opts.replyJson ?? '{"ok":true}',
    deltas: opts.deltas ?? null,
    delayMs: opts.delayMs ?? 0,
  };
  window.__navigatedAway = 0;
  window.__budgetExhausted = 0;
  window.__announces = [];
  window.__frames = [];
  window.__wires = [];
  if (root !== null) root.unmount();
  root = createRoot(document.getElementById('root'));
  const element = React.createElement(Harness, { html: opts.html, theme: opts.theme });
  root.render(opts.strict === true ? React.createElement(React.StrictMode, null, element) : element);
};

/** Swap the app HTML through the srcdoc-reassignment path (NOT a remount). */
window.__setHtml = (html) => {
  if (setHtmlFn === null) throw new Error('harness not mounted');
  setHtmlFn(html);
};

/** Live RunnerHost controls (setTheme/reset/notifyEvent) — null when unmounted. */
window.__controls = () => controls;
window.__setTheme = (theme) => {
  if (controls === null) throw new Error('no live host');
  controls.setTheme(theme);
};

window.__harnessReady = true;
