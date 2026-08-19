// open-url-harness.js — mounts the PRODUCTION SnugAppFrame with an OpenUrlHandler whose
// confirm surface uses the EXACT mechanics the playground dialog ships (ADR-0038 D5 /
// review SF8): render the request, and on a REAL user click call window.open
// SYNCHRONOUSLY with 'noopener,noreferrer', THEN resolve 'opened'. The popup-blocker
// escape is the one claim jsdom cannot carry; this page carries it through production
// runner bytes in a real Chromium. The playground dialog's own synchronous ordering is
// pinned by its unit test (openUrlConfirm.test.tsx) against the same contract.
import { SnugAppFrame } from '@snugprotocol/runner';

const React = window.React;
const { createRoot } = window.ReactDOM;

window.__openUrlResults = [];
let root = null;

window.__mount = (opts) => {
  const surface = document.getElementById('confirm-surface');
  const openUrlHandler = {
    open(url) {
      return new Promise((resolve) => {
        const button = document.createElement('button');
        button.id = 'host-open-confirm';
        button.textContent = 'open ' + new URL(url).hostname;
        button.onclick = () => {
          // OPEN FIRST, INSIDE THE GESTURE — the production dialog's exact order.
          window.open(url, '_blank', 'noopener,noreferrer');
          surface.removeChild(button);
          resolve('opened');
        };
        surface.appendChild(button);
      });
    },
  };

  const mountNode = document.getElementById('root');
  root?.unmount();
  root = createRoot(mountNode);
  root.render(
    React.createElement(SnugAppFrame, {
      html: opts.html,
      transport: { send: async () => ({ ok: false, error: { code: 'HOST_ERROR', message: 'no llm here', retryable: false } }) },
      budgetKey: 'e2e-open-url',
      ...(opts.withHandler === false ? {} : { openUrl: openUrlHandler }),
      onFrame: (direction, frame) => {
        if (frame.type === 'snug:open-url-result') window.__openUrlResults.push(frame);
      },
    }),
  );
};

window.__harnessReady = true;
