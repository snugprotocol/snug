// TASK-20260905-host-bindings-spikes — S7 render check (scratch; deleted at Gate 6).
// Imported by s7-widget-size.mjs. Playwright chromium (resolved from apps/playground):
// a harness page served from loopback embeds the widget in a sandboxed srcdoc iframe;
// the harness URL is the ONLY request the browser may complete — every other URL is
// aborted and logged, and `page.on('request')` records every ATTEMPT independently of
// routing, so "nothing attempted" and "attempted but not intercepted" are distinguishable.
//
// Two modes:
//   - default: pass = app #root rendered past its connecting state + stub status says
//     connected + the harness was the only request attempted + 0 aborted + 0 console
//     errors + 0 page errors. Rendering alone is NOT the pass (a widget that fetched from
//     a CDN and still rendered would be a false green).
//   - positive control (expectAborted non-empty): controlPass = every expected URL was
//     attempted AND aborted — proves the harness really blocks nested-frame requests.
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

export const RENDER_TIMEOUT_MS = 5000;

async function loadChromium(playgroundDir) {
  const require = createRequire(import.meta.url);
  const pwPath = require.resolve('@playwright/test', { paths: [playgroundDir] });
  const pw = await import(pwPath);
  const chromium = pw.chromium ?? pw.default?.chromium;
  if (!chromium) throw new Error('@playwright/test did not export chromium');
  return chromium;
}

async function checkOne(browser, widgetHtml, { folder, label, outPng, expectAborted = [] }) {
  // Loopback is a secure context (the starters call crypto.randomUUID(), which
  // about:blank via setContent does NOT provide).
  const srcdoc = widgetHtml.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const harness = `<!doctype html><html><head><meta charset="utf-8"><title>S7 harness</title></head><body style="margin:0"><iframe id="w" sandbox="allow-scripts" srcdoc="${srcdoc}" style="border:0;width:900px;height:760px"></iframe></body></html>`;
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(harness); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const harnessUrl = `http://127.0.0.1:${server.address().port}/s7-harness`;
  const result = {
    label, folder, harnessUrl, expectAborted, rendered: false, connected: false, ms: null,
    requested: [], allowedRequests: [], abortedRequests: [],
    consoleErrors: [], consoleWarnings: [], pageErrors: [], evalErrors: { count: 0, last: null },
    rootText: '', frames: 0, appFrameSecureContext: null,
  };
  try {
    const context = await browser.newContext({ viewport: { width: 900, height: 760 } });
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url === harnessUrl) { result.allowedRequests.push(url); return route.continue(); }
      result.abortedRequests.push(url);
      return route.abort();
    });
    const page = await context.newPage();
    page.on('request', (r) => result.requested.push(r.url())); // every attempt, routed or not
    page.on('console', (m) => {
      if (m.type() === 'error') result.consoleErrors.push(`[error] ${m.text()}`);
      else if (m.type() === 'warning') result.consoleWarnings.push(`[warning] ${m.text()}`);
    });
    page.on('pageerror', (e) => result.pageErrors.push(String(e && e.message || e)));
    const t0 = Date.now();
    await page.goto(harnessUrl, { waitUntil: 'domcontentloaded' });
    const deadline = t0 + RENDER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        const probe = await f.evaluate(() => {
          const root = document.getElementById('root');
          const status = document.getElementById('snug-status');
          return { root: root ? root.innerText.slice(0, 200) : null, rootChildren: root ? root.children.length : -1, status: status ? status.textContent : null, secure: window.isSecureContext };
        }).catch((e) => { result.evalErrors.count += 1; result.evalErrors.last = String(e && e.message || e); return null; });
        if (!probe) continue;
        if (probe.status && probe.status.startsWith('connected')) result.connected = true;
        if (probe.rootChildren > 0 && !/setting up the board/.test(probe.root)) {
          result.rendered = true;
          result.rootText = probe.root;
          result.appFrameSecureContext = probe.secure;
        }
      }
      if (result.rendered && result.connected) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    result.ms = Date.now() - t0;
    result.frames = page.frames().length;
    if (outPng) await page.screenshot({ path: outPng });
    await context.close();
  } finally {
    server.close();
  }
  result.onlyHarnessRequested = result.requested.length === 1 && result.requested[0] === harnessUrl;
  if (expectAborted.length) {
    result.control = expectAborted.map((u) => ({ url: u, requested: result.requested.includes(u), aborted: result.abortedRequests.includes(u) }));
    result.controlPass = result.control.every((c) => c.requested && c.aborted);
    result.pass = null; // a control is judged by controlPass; rendering is informational
  } else {
    result.pass = result.rendered && result.connected && result.onlyHarnessRequested
      && result.abortedRequests.length === 0 && result.consoleErrors.length === 0 && result.pageErrors.length === 0;
  }
  return result;
}

/** jobs: [{ widgetHtml, folder, label, outPng?, expectAborted? }] → results in the same order. */
export async function renderChecks(jobs, playgroundDir) {
  const chromium = await loadChromium(playgroundDir);
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const job of jobs) results.push(await checkOne(browser, job.widgetHtml, job));
  } finally {
    await browser.close();
  }
  return results;
}

/** One-line table cell: the enforcement signals, never only a green/red word. */
export function renderCell(r) {
  if (!r) return '—';
  const counts = `requested=${r.requested.length}${r.onlyHarnessRequested ? ' (harness only)' : ''}, aborted=${r.abortedRequests.length}, console errors=${r.consoleErrors.length}, warnings=${r.consoleWarnings.length}, pageerrors=${r.pageErrors.length}, eval errors=${r.evalErrors.count}`;
  if (r.control) {
    const ctl = r.control.map((c) => `${path.basename(c.url)} requested=${c.requested} aborted=${c.aborted}`).join('; ');
    return `${r.controlPass ? 'CONTROL OK' : 'CONTROL FAILED'} (${ctl}; rendered=${r.rendered} connected=${r.connected} in ${r.ms} ms; ${counts})`;
  }
  return `${r.pass ? 'PASS' : 'FAIL'} (rendered=${r.rendered} connected=${r.connected} in ${r.ms} ms; ${counts})`;
}
