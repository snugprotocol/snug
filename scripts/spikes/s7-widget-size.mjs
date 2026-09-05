#!/usr/bin/env node
// TASK-20260905-host-bindings-spikes — S7 widget-size spike (scratch; deleted at Gate 6).
//
// For every examples/*/app.html:
//   1. Babel-transform the <script type="text/babel"> block(s) host-side with
//      @babel/standalone (presets ['react'] — classic runtime; no env pass, no source maps).
//      In-browser Babel with no data-presets would ALSO apply env + inline maps, so these
//      sizes are the optimistic bound: valid only if T5's pre-compile ships this transform.
//   2. Inline the react / react-dom UMD bodies in place of their CDN tags; drop the
//      @babel/standalone tag. Any OTHER CDN tag (whatsapp's chart.js) stays and is reported.
//      Inlining is EVIDENCED per row (flags + a sweep of the final widget for residual
//      `<script src>` / `text/babel`), never assumed — an unevidenced row is marked invalid.
//   3. Wrap the app document in a ~6 KB stub "micro-runner" shell (sandboxed srcdoc iframe,
//      CSP via DOMParser like packages/runner/src/csp.ts, protocol-correct host-ready, every
//      request answered with an error/refusal frame). Handshake ONLY — a lower bound for
//      the runner side; T5's WidgetBridge + state-in-page shim will eat into the headroom.
//   4. Write out/<folder>-widget.html (+ -app.html, + -widget.compact.html) and tabulate
//      bytes AND chars. CAP UNIT IS AN ASSUMPTION: the task says "256 KB" (no unit basis,
//      no "characters"); 262,144 (KiB) and 256,000 (decimal) are both shown; S6 (T5) decides.
//   5. Render-check (s7-render-check.mjs): chess + chess-compact must render and connect
//      with the harness as the ONLY attempted request; whatsapp is the POSITIVE CONTROL
//      proving the harness really aborts a nested-frame CDN load.
//
// Run from anywhere: `node scripts/spikes/s7-widget-size.mjs` (Node 22). Vendor bundles
// are fetched ONCE into scripts/spikes/vendor/ (gitignored); versions in vendor/manifest.json.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { renderCell, renderChecks } from './s7-render-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const VENDOR = path.join(HERE, 'vendor');
const OUT = path.join(HERE, 'out');
const EXAMPLES = path.join(ROOT, 'examples');
const CAP_KIB = 262144; // "256 KB" read as KiB; measured as bytes AND as chars (unit unverified until S6)
const CAP_DEC = 256000; // "256 KB" read as decimal bytes
const STUB_TARGET_BYTES = 6 * 1024;
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------------ vendor bundles

const VENDOR_FILES = [
  { key: 'babel', file: 'babel.min.js', url: 'https://cdn.jsdelivr.net/npm/@babel/standalone@7/babel.min.js' },
  { key: 'react', file: 'react.production.min.js', url: 'https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js' },
  { key: 'reactDom', file: 'react-dom.production.min.js', url: 'https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js' },
];
const HEADERS_OF_INTEREST = ['x-jsd-version', 'x-jsd-version-type', 'etag', 'content-length', 'last-modified', 'content-type'];

async function ensureVendor() {
  mkdirSync(VENDOR, { recursive: true });
  const manifestPath = path.join(VENDOR, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  for (const v of VENDOR_FILES) {
    const target = path.join(VENDOR, v.file);
    if (existsSync(target) && manifest[v.key]) continue;
    process.stderr.write(`fetching ${v.url}\n`);
    const res = await fetch(v.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${v.url} → HTTP ${res.status}`);
    const text = await res.text();
    writeFileSync(target, text);
    const headers = {};
    for (const h of HEADERS_OF_INTEREST) if (res.headers.has(h)) headers[h] = res.headers.get(h);
    manifest[v.key] = {
      requested: v.url,
      resolvedUrl: res.url,
      headers,
      banner: text.slice(0, 160).split('\n').slice(0, 3).join(' ').trim(),
      bytes: bytes(text),
      sha256: sha256(text),
      fetchedAt: new Date().toISOString(),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
  return manifest;
}

function loadBabel(code) {
  // UMD: with no `exports`/`module`/`define` in scope it assigns globalThis.Babel.
  vm.runInThisContext(code, { filename: 'babel.min.js' });
  if (typeof globalThis.Babel?.transform !== 'function') throw new Error('babel.min.js did not define globalThis.Babel.transform');
  return globalThis.Babel;
}

// ------------------------------------------------------------------ transform

const BABEL_TAG_RE = /<script\s+type=["']text\/babel["'][^>]*>([\s\S]*?)<\/script>/gi;
// src may be any attribute (not only the first); http(s) only. The post-build sweep
// (RESIDUAL_SRC_RE) is the backstop for anything this misses.
const CDN_TAG_RE = /[ \t]*<script\b[^>]*\ssrc=["'](https?:\/\/[^"']+)["'][^>]*>\s*<\/script>[ \t]*\r?\n?/gi;
const RESIDUAL_SRC_RE = /<script[^>]*\ssrc=/gi;
const RESIDUAL_BABEL_RE = /<script[^>]*text\/babel/gi;

function transformApp(html, folder, Babel, vendor, babelExtra = {}) {
  let babelBlocks = 0;
  const withJs = html.replace(BABEL_TAG_RE, (_m, src) => {
    babelBlocks += 1;
    const out = Babel.transform(src, { presets: ['react'], sourceType: 'script', filename: `${folder}.jsx`, ...babelExtra }).code;
    if (/<\/script/i.test(out)) throw new Error(`${folder}: compiled script contains </script>`);
    return `<script>\n${out}\n</script>`;
  });
  const inlined = { react: false, reactDom: false, babelDropped: false };
  const extraCdn = [];
  const appOnly = withJs.replace(CDN_TAG_RE, (m, url) => {
    if (/\/react@[^/]*\/umd\/react\.production\.min\.js$/.test(url)) { inlined.react = true; return '__REACT__\n'; }
    if (/\/react-dom@[^/]*\/umd\/react-dom\.production\.min\.js$/.test(url)) { inlined.reactDom = true; return '__REACT_DOM__\n'; }
    if (/@babel\/standalone/.test(url)) { inlined.babelDropped = true; return ''; }
    extraCdn.push(url);
    return m;
  });
  // Trailing newline is PART of each tag so app + react + stub + ovh = total exactly.
  const reactTag = `  <script>/* react (inlined by S7) */\n${vendor.react}\n</script>\n`;
  const reactDomTag = `  <script>/* react-dom (inlined by S7) */\n${vendor.reactDom}\n</script>\n`;
  // Function replacements: a string replacement would interpret `$$`/`$&` inside the UMD
  // bodies (React's `$$typeof`!) as replacement patterns and silently corrupt the code.
  const appDoc = appOnly.replace('__REACT__\n', () => reactTag).replace('__REACT_DOM__\n', () => reactDomTag);
  const appTransformed = appOnly.replace('__REACT__\n', () => '').replace('__REACT_DOM__\n', () => '');
  return { appDoc, appTransformed, reactBytes: bytes(reactTag) + bytes(reactDomTag), babelBlocks, inlined, extraCdn };
}

// ------------------------------------------------------------------ stub micro-runner shell

// RUNNER_CSP verbatim from packages/runner/src/csp.ts (CDN_ALLOWLIST order preserved).
const RUNNER_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; style-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; font-src https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com data:; img-src data: blob:; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

// The app document rides inside a text/plain script; its only hazard is the literal
// `</script` (end-of-raw-text), which the shell re-inflates. Reversible because we assert
// the source never contains the escaped spelling.
const ESCAPED_END = '<\\/script';
function embedPayload(appDoc, folder) {
  if (appDoc.includes(ESCAPED_END)) throw new Error(`${folder}: app already contains ${ESCAPED_END} — pick another escape`);
  // Tokenizer hazard: an unclosed `<!--` inside script data (or `<script` between `<!--`
  // and `-->`) would put the parser in the (double-)escaped state and swallow the shell's
  // own closing tag. Refuse rather than emit a silently broken widget.
  const re = /<!--|-->|<script/gi;
  let depth = 0;
  for (const m of appDoc.matchAll(re)) {
    const tok = m[0].toLowerCase();
    if (tok === '<!--') depth = 1;
    else if (tok === '-->') depth = 0;
    else if (depth === 1) throw new Error(`${folder}: <script inside an HTML comment (double-escaped script data hazard)`);
  }
  if (depth !== 0) throw new Error(`${folder}: unclosed <!-- in the app document`);
  return appDoc.replace(/<\/script/gi, ESCAPED_END);
}

const SHELL_HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Snug micro-runner (S7 stub)</title>
<style>
  html,body{margin:0;height:100%;background:#141210;color:#d8cfc2;font:12px/1.4 system-ui,-apple-system,sans-serif}
  #snug-bar{display:flex;gap:10px;align-items:center;height:26px;padding:0 10px;background:#1f1a15;border-bottom:1px solid #3a2f24;white-space:nowrap;overflow:hidden}
  #snug-bar b{color:#f0a04b}
  #snug-bar .chip{padding:1px 7px;border:1px solid #3a2f24;border-radius:10px;color:#b8a892}
  #snug-frame{display:block;border:0;width:100%;height:calc(100% - 27px);background:#fff}
</style>
</head>
<body>
<div id="snug-bar"><b>Snug</b><span id="snug-app-name">app</span><span class="chip" id="snug-status">booting</span><span class="chip">brain: none — S7 stub (answers every think with an error frame)</span><span class="chip">your file: state-in-page (stub: not persisted)</span></div>
<iframe id="snug-frame" sandbox="allow-scripts" title="Snug app"></iframe>
<script id="snug-app-html" type="text/plain">`;

const SHELL_TAIL = `</script>
<script>
(function () {
  'use strict';
  // Stub micro-runner: the WIDGET-side half of the Snug runner, sized for the S7 spike.
  // Protocol-correct handshake (host-ready on load AND as announce-ack, instanceId
  // re-minted per load / re-announce, frames routed by source identity only), but every
  // capability is false and every request is answered with an error frame — the real
  // WidgetBridge (T5) replaces the four handlers below. No db shim, no chunking, no relay.
  var V = 1;
  var T = {
    announce: 'snug:app-announce', hostReady: 'snug:host-ready',
    appMessage: 'snug:app-message', appCancel: 'snug:app-cancel', appResponse: 'snug:app-response',
    dbRequest: 'snug:db-request', dbResponse: 'snug:db-response',
    netRequest: 'snug:net-request', netResponse: 'snug:net-response',
    openUrlRequest: 'snug:open-url-request', openUrlResult: 'snug:open-url-result',
    hostEvent: 'snug:host-event', appEvent: 'snug:app-event'
  };
  var CSP = ${JSON.stringify(RUNNER_CSP)};
  var MAX_FRAME_BYTES = 262144; // UTF-8 bytes, as packages/protocol frameWithinLimits measures
  var frame = document.getElementById('snug-frame');
  var dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var theme = dark && dark.matches ? 'dark' : 'light';
  var capabilities = { streaming: false, db: false, auth: false, net: false, openUrl: false };
  var instanceId = mint();
  var announced = false;

  function mint() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'i-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  function setText(id, text) { var el = document.getElementById(id); if (el) el.textContent = text; }
  function isId(x) { return typeof x === 'string' && x.length > 0 && x.length <= 128; }
  function post(f) {
    var w = frame.contentWindow;
    if (!w) return;
    try { if (new TextEncoder().encode(JSON.stringify(f)).byteLength > MAX_FRAME_BYTES) return; } catch (e) { return; }
    w.postMessage(f, '*');
  }
  function hostReady() {
    post({ v: V, type: T.hostReady, instanceId: instanceId, protocolVersions: [V], capabilities: capabilities, theme: theme });
  }
  function fail(code, message) { return { code: code, message: message, retryable: false }; }

  window.addEventListener('message', function (ev) {
    if (ev.source !== frame.contentWindow) return; // route by source identity only (R4)
    var d = ev.data;
    if (!d || typeof d !== 'object' || d.v !== V || typeof d.type !== 'string' || d.type.indexOf('snug:') !== 0) return;
    if (d.type === T.announce) {
      if (announced) instanceId = mint(); // a re-announce invalidates the old instance (R4)
      announced = true;
      setText('snug-app-name', String(d.displayName || d.appId || 'app'));
      setText('snug-status', 'connected · ' + instanceId.slice(0, 8));
      hostReady();
      return;
    }
    if (d.instanceId !== instanceId || !isId(d.requestId)) return; // stale instance / no requestId — drop
    if (d.type === T.appMessage) {
      post({ v: V, type: T.appResponse, requestId: d.requestId, ok: false,
        error: fail('HOST_ERROR', 'S7 micro-runner stub: no brain attached (WidgetBridge not implemented)') });
    } else if (d.type === T.dbRequest) {
      post({ v: V, type: T.dbResponse, requestId: d.requestId, ok: false,
        error: fail('HOST_ERROR', 'S7 micro-runner stub: db capability not advertised') });
    } else if (d.type === T.netRequest) {
      post({ v: V, type: T.netResponse, requestId: d.requestId, ok: false,
        error: fail('HOST_ERROR', 'S7 micro-runner stub: net capability not advertised') });
    } else if (d.type === T.openUrlRequest) {
      post({ v: V, type: T.openUrlResult, requestId: d.requestId, status: 'refused', reason: 'openUrl capability not advertised' });
    }
    // app-cancel / app-event: nothing in flight in a stub — ignored.
  });

  if (dark && dark.addEventListener) dark.addEventListener('change', function (e) {
    theme = e.matches ? 'dark' : 'light';
    post({ v: V, type: T.hostEvent, event: 'theme-change', data: { theme: theme } });
  });

  frame.addEventListener('load', function () {
    if (!frame.hasAttribute('srcdoc')) return; // initial about:blank
    instanceId = mint();
    announced = false;
    hostReady(); // ready on load AND as announce-ack (idempotent)
  });

  // Re-inflate the app document and inject the runner CSP as the FIRST element of <head>
  // via DOM parsing — never string surgery (packages/runner/src/csp.ts, F1).
  var raw = document.getElementById('snug-app-html').textContent.replace(/<\\\\\\/script/gi, '</script');
  var doc = new DOMParser().parseFromString(raw, 'text/html');
  var meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', CSP);
  doc.head.insertBefore(meta, doc.head.firstChild);
  frame.srcdoc = '<!doctype html>' + doc.documentElement.outerHTML;
})();
</script>
</body>
</html>
`;

function buildWidget(appDoc, folder) {
  const payload = embedPayload(appDoc, folder);
  const widget = SHELL_HEAD + payload + SHELL_TAIL;
  return { widget, stubBytes: bytes(SHELL_HEAD) + bytes(SHELL_TAIL), embedOverhead: bytes(payload) - bytes(appDoc) };
}

/** Inlining evidence: reasons the row must NOT be read as a valid measurement. */
function validate(t, widget, folder, sum, total) {
  const reasons = [];
  if (!t.inlined.react) reasons.push('react CDN tag not found/inlined');
  if (!t.inlined.reactDom) reasons.push('react-dom CDN tag not found/inlined');
  if (!t.inlined.babelDropped) reasons.push('@babel/standalone tag not found/dropped');
  if (t.babelBlocks < 1) reasons.push('no text/babel block compiled');
  const residualSrc = (widget.match(RESIDUAL_SRC_RE) || []).length;
  const residualBabel = (widget.match(RESIDUAL_BABEL_RE) || []).length;
  if (residualSrc !== t.extraCdn.length) reasons.push(`residual <script src> count ${residualSrc} ≠ reported extra CDN ${t.extraCdn.length}`);
  if (residualBabel !== 0) reasons.push(`${residualBabel} residual text/babel tag(s)`);
  if (sum !== total) throw new Error(`${folder}: app + react + stub + ovh = ${sum} ≠ total ${total}`);
  return { residualSrc, residualBabel, reasons };
}

// ------------------------------------------------------------------ main

const manifest = await ensureVendor();
const readVendor = (f) => readFileSync(path.join(VENDOR, f), 'utf8');
const vendor = { react: readVendor('react.production.min.js'), reactDom: readVendor('react-dom.production.min.js') };
for (const [k, v] of Object.entries(vendor)) if (/<\/script/i.test(v)) throw new Error(`${k} UMD contains </script>`);
const Babel = loadBabel(readVendor('babel.min.js'));
manifest.babel.runtimeVersion = Babel.version;
writeFileSync(path.join(VENDOR, 'manifest.json'), JSON.stringify(manifest, null, 2));
mkdirSync(OUT, { recursive: true });

const folders = readdirSync(EXAMPLES).filter((d) => existsSync(path.join(EXAMPLES, d, 'app.html')) && statSync(path.join(EXAMPLES, d)).isDirectory()).sort();
const rows = [];
for (const folder of folders) {
  const original = readFileSync(path.join(EXAMPLES, folder, 'app.html'), 'utf8');
  const t = transformApp(original, folder, Babel, vendor);
  const w = buildWidget(t.appDoc, folder);
  // Secondary data point for T5: the same pipeline with Babel's whitespace-compact output
  // and comments stripped (the app's own <style>/markup are untouched — no HTML minifier).
  const tc = transformApp(original, folder, Babel, vendor, { compact: true, comments: false });
  const wc = buildWidget(tc.appDoc, folder);
  writeFileSync(path.join(OUT, `${folder}-app.html`), t.appDoc);
  writeFileSync(path.join(OUT, `${folder}-widget.html`), w.widget);
  writeFileSync(path.join(OUT, `${folder}-widget.compact.html`), wc.widget);
  const totalBytes = bytes(w.widget);
  const sum = bytes(t.appTransformed) + t.reactBytes + w.stubBytes + w.embedOverhead;
  const v = validate(t, w.widget, folder, sum, totalBytes);
  rows.push({
    folder, connected: existsSync(path.join(EXAMPLES, folder, 'connection.json')), valid: v.reasons.length === 0, invalidReasons: v.reasons,
    originalBytes: bytes(original), appTransformedBytes: bytes(t.appTransformed), reactBytes: t.reactBytes, appDocBytes: bytes(t.appDoc),
    stubBytes: w.stubBytes, embedOverhead: w.embedOverhead, totalBytes, totalChars: w.widget.length,
    fitsKibBytes: totalBytes <= CAP_KIB, fitsKibChars: w.widget.length <= CAP_KIB, fitsDecBytes: totalBytes <= CAP_DEC,
    compactBytes: bytes(wc.widget), compactChars: wc.widget.length, fitsCompactKibChars: wc.widget.length <= CAP_KIB, fitsCompactDecBytes: bytes(wc.widget) <= CAP_DEC,
    babelBlocks: t.babelBlocks, inlined: t.inlined, residualSrc: v.residualSrc, residualBabel: v.residualBabel, extraCdn: t.extraCdn,
    render: null, renderCompact: null,
  });
}

// Render checks: chess + chess-compact (must pass with the harness as the only request);
// the first starter with an extra CDN tag (whatsapp) is the positive control that proves
// the harness aborts a nested-frame CDN load.
const chess = rows.find((r) => r.folder === 'chess');
const control = rows.find((r) => r.extraCdn.length > 0);
const jobs = [];
if (chess) {
  jobs.push({ widgetHtml: readFileSync(path.join(OUT, 'chess-widget.html'), 'utf8'), folder: 'chess', label: 'chess', outPng: path.join(OUT, 'chess-widget.png') });
  jobs.push({ widgetHtml: readFileSync(path.join(OUT, 'chess-widget.compact.html'), 'utf8'), folder: 'chess', label: 'chess-compact', outPng: path.join(OUT, 'chess-widget.compact.png') });
}
if (control) jobs.push({ widgetHtml: readFileSync(path.join(OUT, `${control.folder}-widget.html`), 'utf8'), folder: control.folder, label: `${control.folder}-control`, expectAborted: control.extraCdn });
const renders = jobs.length ? await renderChecks(jobs, path.join(ROOT, 'apps', 'playground')) : [];
for (const r of renders) {
  const row = rows.find((x) => x.folder === r.folder);
  if (r.label === 'chess-compact') row.renderCompact = r;
  else row.render = r;
}

const kb = (n) => (n / 1024).toFixed(1);
const yn = (b) => (b ? 'yes' : 'NO');
const head = '| folder | connected | valid | original B | app (babel-compiled) B | react+react-dom B | stub B | embed ovh B | total B | total chars | ≤ 262144 (B / ch) | ≤ 256000 B | headroom ch vs 262144 (stub only) | headroom B vs 256000 (stub only) | compact B / ch (≤262144 ch / ≤256000 B; size only unless rendered) | inlining evidence | extra CDN | render check |';
const sep = '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|---:|---:|---|---|---|---|';
const lines = rows.map((r) => {
  const ev = `react=${yn(r.inlined.react)} react-dom=${yn(r.inlined.reactDom)} babel dropped=${yn(r.inlined.babelDropped)} · babel blocks=${r.babelBlocks} · residual src=${r.residualSrc} babel=${r.residualBabel}`;
  const render = [r.render ? renderCell(r.render) : null, r.renderCompact ? `compact: ${renderCell(r.renderCompact)}` : null].filter(Boolean).join('<br>') || '—';
  return `| ${r.folder} | ${r.connected ? 'yes' : 'no'} | ${r.valid ? 'yes' : `**NO** (${r.invalidReasons.join('; ')})`} | ${r.originalBytes} | ${r.appTransformedBytes} | ${r.reactBytes} | ${r.stubBytes} | ${r.embedOverhead} | **${r.totalBytes}** (${kb(r.totalBytes)} KiB) | ${r.totalChars} | ${yn(r.fitsKibBytes)} / ${yn(r.fitsKibChars)} | ${yn(r.fitsDecBytes)} | ${CAP_KIB - r.totalChars} | ${CAP_DEC - r.totalBytes} | ${r.compactBytes} / ${r.compactChars} (${yn(r.fitsCompactKibChars)} / ${yn(r.fitsCompactDecBytes)}) | ${ev} | ${r.extraCdn.length ? r.extraCdn.join(' ') : '—'} | ${render} |`;
});

const valid = rows.filter((r) => r.valid);
const names = (list) => list.map((r) => r.folder).join(', ') || 'none';
const b = manifest.babel, rj = manifest.react, rd = manifest.reactDom;
const floor = rows[0].reactBytes + rows[0].stubBytes;
const report = [
  '# S7 — widget size (TASK-20260905-host-bindings-spikes)',
  '',
  `Generated ${new Date().toISOString()} by \`scripts/spikes/s7-widget-size.mjs\` (Node ${process.version}).`,
  '',
  `**Cap (assumed, not sourced):** the task text says "256 KB" for OpenClaw \`show_widget\`; neither it nor ADR-0065 states a unit basis or whether the limit is bytes or characters. Both readings are tabulated — ${CAP_KIB} (KiB) as bytes and as \`.length\` chars, and ${CAP_DEC} (decimal) as bytes — and the unit is verified only by S6 (T5). Chars ≠ bytes because the starters carry non-ASCII (chess glyphs etc.).`,
  '',
  '## Inputs',
  '',
  `- @babel/standalone: \`Babel.version\` = **${b.runtimeVersion}** (requested \`${b.requested}\`, x-jsd-version=${b.headers['x-jsd-version'] ?? '?'}, banner: \`${b.banner.slice(0, 100)}\`), presets \`['react']\` (classic runtime — global \`React.createElement\`), \`sourceType:'script'\`, no env pass, no source maps, default compaction.`,
  `- Transform fidelity: in-browser @babel/standalone with no \`data-presets\` (all starters) applies presets \`['react','env']\` + class-properties/object-rest-spread/flow-strip-types and \`sourceMaps:'inline'\`; these sizes are the optimistic bound and hold only if T5's pre-compile step ships preset \`react\` only, no env, no maps.`,
  `- react UMD: **${rj.banner.replace(/\s+/g, ' ').slice(0, 80)}** (x-jsd-version=${rj.headers['x-jsd-version'] ?? '?'}, ${rj.bytes} B, sha256 ${rj.sha256.slice(0, 12)}…)`,
  `- react-dom UMD: **${rd.banner.replace(/\s+/g, ' ').slice(0, 80)}** (x-jsd-version=${rd.headers['x-jsd-version'] ?? '?'}, ${rd.bytes} B, sha256 ${rd.sha256.slice(0, 12)}…)`,
  `- stub micro-runner shell: ${rows[0].stubBytes} B (target ~${STUB_TARGET_BYTES}); nests the app in \`<iframe sandbox="allow-scripts" srcdoc>\` with RUNNER_CSP injected via DOMParser; host-ready shape per \`packages/protocol/src/frames.ts\` (\`v, type, instanceId, protocolVersions:[1], capabilities{streaming,db,auth,net,openUrl}=false, theme\`); app-message → \`snug:app-response ok:false HOST_ERROR\`; db/net → error frames; open-url → \`refused\`. **Handshake only** — no state-in-page db shim, no bridge chunking/acks, no prompt relay, no UI: a lower bound for the runner side; every headroom figure below is against this stub and T5's WidgetBridge will consume part of it.`,
  `- embed method: app document carried in \`<script type="text/plain">\` with \`</script\` → \`<\\/script\` (the "embed ovh" column is that escaping's cost); "app (babel-compiled)" = the starter with its JSX compiled and the three CDN tags removed, BEFORE React is inlined. Identity asserted on every row: app (babel-compiled) + react+react-dom + stub + embed ovh = total B.`,
  `- inlining evidence (the "valid" column): react + react-dom inlined, @babel/standalone dropped, ≥ 1 babel block compiled, and a sweep of the FINAL widget: residual \`<script … src=\` count must equal the extra-CDN count, residual \`text/babel\` tags must be 0. An invalid row is excluded from the fit counts.`,
  '',
  '## Table',
  '',
  head, sep, ...lines,
  '',
  `Valid rows: ${valid.length}/${rows.length}${valid.length < rows.length ? ` — INVALID: ${names(rows.filter((r) => !r.valid))}` : ''}.`,
  `Fits (chars ≤ ${CAP_KIB}, KiB reading): ${valid.filter((r) => r.fitsKibChars).length}/${valid.length} — ${names(valid.filter((r) => r.fitsKibChars))}. Does not fit: ${names(valid.filter((r) => !r.fitsKibChars))}.`,
  `Fits (bytes ≤ ${CAP_DEC}, decimal reading): ${valid.filter((r) => r.fitsDecBytes).length}/${valid.length} — ${names(valid.filter((r) => r.fitsDecBytes))}. Does not fit: ${names(valid.filter((r) => !r.fitsDecBytes))}.`,
  `With compact JS (written to \`<folder>-widget.compact.html\`; size only except chess, which is render-checked below): chars ≤ ${CAP_KIB}: ${valid.filter((r) => r.fitsCompactKibChars).length}/${valid.length} (still out: ${names(valid.filter((r) => !r.fitsCompactKibChars))}); bytes ≤ ${CAP_DEC}: ${valid.filter((r) => r.fitsCompactDecBytes).length}/${valid.length} (still out: ${names(valid.filter((r) => !r.fitsCompactDecBytes))}).`,
  '',
  `Fixed floor per widget against the S7 stub (handshake only): react + react-dom ${rows[0].reactBytes} B + stub ${rows[0].stubBytes} B = ${floor} B (${kb(floor)} KiB), leaving ${CAP_KIB - floor} chars (KiB reading) / ${CAP_DEC - floor} B (decimal reading) for the compiled app itself — the real WidgetBridge + state-in-page shim will consume part of this. whatsapp's chart.js tag is NOT inlined (not in this spike's vendor set) — its widget would still need the network for it, or its own budget.`,
  '',
  '## Render checks (Playwright chromium; harness served from loopback, every other request aborted; every attempted request recorded)',
  '',
  'Pass rule (chess, chess-compact): rendered past the connecting state + stub status `connected` + the harness was the ONLY attempted request + 0 aborted + 0 console errors + 0 page errors. Positive control (whatsapp): its chart.js URL must appear in `requested` AND `abortedRequests` — proof the harness really blocks nested-frame loads, so an empty `abortedRequests` on chess means "nothing attempted", not "not intercepted".',
  '',
  ...renders.map((r) => `### ${r.label}\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``),
  '',
  `Screenshots: \`scripts/spikes/out/chess-widget.png\`, \`chess-widget.compact.png\`. Outputs: \`scripts/spikes/out/<folder>-widget.html\` (the shell), \`<folder>-widget.compact.html\` (compact-JS variant) and \`<folder>-app.html\` (the standalone compiled app document).`,
  '',
].join('\n');

writeFileSync(path.join(OUT, 's7-report.md'), report);
process.stdout.write(report);
if (rows.some((r) => !r.valid) || renders.some((r) => r.pass === false || r.controlPass === false)) process.exitCode = 1;
