// e2e/helpers.ts — shared constants and canned app documents for the Playwright suite.
//
// ── Selector contract with the app (workstream A, as shipped) ───────────────────────
// The app-dependent specs (build-run part A, mobile) locate UI through the app's real
// accessible affordances — renaming any of these breaks the e2e contract:
//
//   role=textbox "describe your app"          builder composer (BuilderView)
//   role=textbox "describe the app to build"  hub create bar (HubView)
//   data-testid="artifact-card"               card rendered when the SSE artifact lands
//   role=link "run it"                        primary CTA on the artifact card
//   data-testid="frame-wrap"                  wrapper around the SnugAppFrame iframe
//   data-testid="mobile-view-toggle"          mobile app ⇄ think full-view toggle, named
//                                             "show/hide watch it think" (TASK-20260821)
//   aria-label "watch it think"               the rail (desktop) / full think view (mobile)
//
// If the app shell is absent (src/main.tsx not landed), those specs skip with an
// explicit reason; the CSP / StrictMode / bridge round-trip specs run against the
// self-contained fixture harness (e2e/fixtures) and are green independent of the app.

import fs from 'node:fs';
import path from 'node:path';

export const FIXTURE_PORT = 43117;
/** The self-signed HTTPS provider stub for the AL-03 net e2e (net-stub.mjs). */
export const NET_STUB_PORT = 43120;
export const NET_STUB_URL = `https://127.0.0.1:${NET_STUB_PORT}`;
/** The local fake IdP for the AL-04 PKCE popup e2e (fake-idp.mjs). */
export const FAKE_IDP_PORT = 43121;
export const FAKE_IDP_URL = `http://127.0.0.1:${FAKE_IDP_PORT}`;
/**
 * Default 8787: the app's vite.config.ts dev proxy targets 127.0.0.1:8787. Both sides
 * honor SNUG_SERVER_PORT (the playwright config forwards it to the vite webServer), so
 * a parallel worktree can run this suite while another checkout's dev server holds the
 * default port — the proxy target and the reference server always move together.
 */
export const SERVER_PORT = Number(process.env.SNUG_SERVER_PORT ?? '') || 8787;
export const APP_PORT = 43119;

export const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;
export const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;

/** apps/playground — the suite is run via `pnpm --filter playground test:e2e`. */
export function playgroundDir(): string {
  const cwd = process.cwd();
  if (path.basename(cwd) === 'playground') return cwd;
  const fromRoot = path.join(cwd, 'apps', 'playground');
  if (fs.existsSync(fromRoot)) return fromRoot;
  return cwd;
}

/**
 * True once workstream A's Vite app is bootable — gates the app-dependent specs.
 * Requires the entry module (index.html references /src/main.tsx), not just the config:
 * a half-landed shell must skip, not fail.
 */
export function appIsPresent(): boolean {
  const dir = playgroundDir();
  return (
    fs.existsSync(path.join(dir, 'index.html')) &&
    fs.existsSync(path.join(dir, 'src', 'main.tsx')) &&
    (fs.existsSync(path.join(dir, 'vite.config.ts')) || fs.existsSync(path.join(dir, 'vite.config.js')))
  );
}

export const AWAITS_INTEGRATION = 'playground app not present yet (workstream A) — spec awaits integration';

/**
 * Minimal single-file Snug app implementing the app side of the bridge by hand
 * (protocol frames per packages/protocol/src/frames.ts). It announces, fires ONE
 * app-message probe, and renders the terminal reply — the app half of the AC-7
 * round-trip. Deliberately CDN-free so the round-trip needs no network at all.
 */
export function echoAppHtml(opts: { appId?: string; displayName?: string } = {}): string {
  const appId = opts.appId ?? 'e2e-echo';
  const displayName = opts.displayName ?? 'e2e echo';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${displayName}</title></head>
<body>
<div id="status">connecting</div>
<div id="out"></div>
<div id="theme"></div>
<script>
(function () {
  var V = 1;
  var instanceId = null;
  var sent = false;
  function setText(id, text) { document.getElementById(id).textContent = text; }
  window.addEventListener('message', function (event) {
    var d = event.data;
    if (!d || d.v !== V) return;
    if (d.type === 'snug:host-ready') {
      var first = instanceId === null;
      instanceId = d.instanceId;
      if (d.theme) setText('theme', d.theme);
      if (first) {
        parent.postMessage({ v: V, type: 'snug:app-announce', appId: '${appId}',
          displayName: '${displayName}', description: 'bridge round-trip probe',
          iconEmoji: '\\ud83d\\udd01', iconColor: '#e8853b' }, '*');
      }
      if (!sent) {
        sent = true;
        parent.postMessage({ v: V, type: 'snug:app-message', requestId: 'req-1',
          instanceId: instanceId, appId: '${appId}', action: 'probe',
          payload: { ping: 1 }, state: {}, responseSchema: { answer: 'string' } }, '*');
        setText('status', 'sent');
      }
      return;
    }
    if (d.type === 'snug:app-response' && d.requestId === 'req-1') {
      if (d.streaming) { setText('status', 'streaming'); return; }
      setText('status', d.ok ? 'done' : 'error');
      setText('out', d.ok ? JSON.stringify(d.data) : JSON.stringify(d.error));
      return;
    }
    if (d.type === 'snug:host-event' && d.event === 'theme-change' && d.data && d.data.theme) {
      setText('theme', d.data.theme);
    }
  });
})();
</script>
</body></html>`;
}

/**
 * A single-file app that drives the AL-03 net protocol by hand: on host-ready it fires a
 * net-request to `netUrl` (method configurable), renders the terminal net-response, and
 * exposes the raw response body in `#net-out` so the spec can assert the injected key was
 * SCRUBBED. Deliberately hand-rolled (no SDK bundle) — the production bridge is the thing
 * under test. CDN-free.
 */
export function netAppHtml(opts: { netUrl: string; method?: string; forgeAuth?: boolean } = { netUrl: '' }): string {
  const method = opts.method ?? 'GET';
  // A forged Authorization header the app tries to smuggle — the schema rejects it at the
  // bridge AND the executor strips it, so it must never reach the stub (C1 negative).
  const headersField = opts.forgeAuth ? ", headers: { 'Authorization': 'Bearer app-forged-token' }" : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>net app</title></head>
<body>
<div id="status">connecting</div>
<div id="net-status"></div>
<pre id="net-out"></pre>
<div id="net-headers"></div>
<script>
(function () {
  var V = 1;
  var instanceId = null;
  var sent = false;
  function setText(id, text) { document.getElementById(id).textContent = text; }
  window.addEventListener('message', function (event) {
    var d = event.data;
    if (!d || d.v !== V) return;
    if (d.type === 'snug:host-ready') {
      instanceId = d.instanceId;
      setText('status', 'ready:net=' + (d.capabilities && d.capabilities.net));
      if (!sent) {
        sent = true;
        parent.postMessage({ v: V, type: 'snug:app-announce', appId: 'e2e-net-app',
          displayName: 'e2e net', iconColor: '#3ba36f' }, '*');
        parent.postMessage({ v: V, type: 'snug:net-request', requestId: 'net-1',
          instanceId: instanceId, url: ${JSON.stringify(opts.netUrl)}, method: '${method}'${
            method === 'GET' || method === 'HEAD' ? '' : ", body: '{}'"
          }${headersField} }, '*');
      }
      return;
    }
    if (d.type === 'snug:net-response' && d.requestId === 'net-1') {
      setText('net-status', d.ok ? ('ok:' + d.status) : ('err:' + d.error.code));
      setText('net-out', d.ok ? d.body : JSON.stringify(d.error));
      if (d.ok) setText('net-headers', JSON.stringify(d.headers));
      return;
    }
  });
})();
</script>
</body></html>`;
}
