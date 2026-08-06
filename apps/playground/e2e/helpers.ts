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
//   role=button "open inspector"              mobile toggle for the rail-as-sheet
//   aria-label "watch it think"               the rail (desktop) / sheet dialog (mobile)
//
// If the app shell is absent (src/main.tsx not landed), those specs skip with an
// explicit reason; the CSP / StrictMode / bridge round-trip specs run against the
// self-contained fixture harness (e2e/fixtures) and are green independent of the app.

import fs from 'node:fs';
import path from 'node:path';

export const FIXTURE_PORT = 43117;
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
