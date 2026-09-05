#!/usr/bin/env node
// s11-gen.mjs — emits the S11 probe page (TASK-20260905-binding-a-artifacts, Q4): the
// BUILDER's whole-app turn through the artifact runtime's `sample`, with the exact bytes the
// host kit will send under its tool-free arm (apps/playground/src/agent/builder.ts:243/308):
//   system  = buildHostSystemPrompt({ appBuilder: true, artifacts: false, platform: 'host' })
//             + CONTEXT_SEPARATOR + WEBLLM_BUILD_SUFFIX  (+ CONTEXT_SEPARATOR + the app-context block)
//   message = the user's edit request
// concatenated into ONE user turn (T1 S3: one turn ≡ two). Scratch, deleted at Gate 6;
// the numbers live in the task file. Every `<` in the embedded JSON is written `<`
// (scripts/build-starters-pkg.mjs precedent) so a starter's `</script>` cannot end the block.
//
// Run: node scripts/spikes/s11-gen.mjs  → scripts/spikes/s11-sample-whole-app.html
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const here = (rel) => path.join(ROOT, rel);

const { buildHostSystemPrompt } = await import(here('packages/knowledge/dist/index.js'));

// Verbatim from apps/playground/src/agent/webllm/appHtml.ts (the kit reuses this arm).
const WEBLLM_BUILD_SUFFIX = `## Building Apps Without Tools (in-browser model)

File-creation tools are not available in this mode. When the user asks you to build
or change an app, reply with the COMPLETE single-file HTML document — starting with
<!doctype html> and ending with </html> — inside ONE \`\`\`html fenced code block:
styles in a <style> block, logic in a <script> block, no separate files, and a
<title> naming the app. The host extracts that block and installs it as the app.
Keep any explanation brief and OUTSIDE the fence. Never send a partial document.`;
const CONTEXT_SEPARATOR = '\n\n---\n\n';
const TRUNCATION_MARKER = '\n…[truncated to fit the context budget]';

const SYSTEM = `${buildHostSystemPrompt({ appBuilder: true, artifacts: false, platform: 'host' })}${CONTEXT_SEPARATOR}${WEBLLM_BUILD_SUFFIX}`;

// Mirrors buildAppTurnContext (apps/playground/src/agent/appContext.ts) for a fresh install:
// no schema registered, no docs, current version v1.
function contextBlock(name, html) {
  return [
    '## The app you are working on',
    `Name: ${name}\nCurrent version: v1`,
    '### Registered data schema',
    '(none registered yet — design one with the schema tool before writing data-backed code)',
    '### Current app code (v1)',
    '```html\n' + html + '\n```',
    'When changing the app, write the ENTIRE updated file via the artifact write tool — it lands as the next version of THIS app.',
  ].join('\n\n');
}

const app = (folder, name) => ({ folder, name, html: readFileSync(here(`examples/${folder}/app.html`), 'utf8') });
const APPS = {
  chess: app('chess', 'ember chess'),
  pig: app('flying-pig', 'Flying Pig Feed!'),
  copilot: app('trade-copilot', 'Coinbase Trade Copilot'),
};

const DATA = {
  system: SYSTEM,
  separator: CONTEXT_SEPARATOR,
  truncationMarker: TRUNCATION_MARKER,
  apps: Object.fromEntries(Object.entries(APPS).map(([k, a]) => [k, { folder: a.folder, name: a.name, html: a.html, block: contextBlock(a.name, a.html) }])),
  requests: {
    chess: 'Add a move counter under the board that shows the number of full moves played so far. Keep everything else exactly as it is.',
    pig: 'Add a pause button that freezes the game and shows PAUSED over the canvas; pressing it again resumes. Keep everything else exactly as it is.',
    copilot: 'Add a small "last refreshed" timestamp to the header. Keep everything else exactly as it is.',
    fresh: 'Build me a pomodoro timer: 25-minute focus and 5-minute break cycles, a start/pause/reset control, and a log of completed sessions kept in the app database.',
  },
};

const json = JSON.stringify(DATA).replace(/</g, '\\u003c');

const page = `<title>S11 whole-app sample probe</title>
<style>
  :root { --bg:#f7f7f5; --fg:#1d1d1b; --mut:#6b6b66; --line:#d9d9d4; --card:#ffffff; --ok:#1a7f4b; --bad:#b3261e; --warn:#9a6700; --acc:#2f5bea; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#141413; --fg:#ececea; --mut:#9a9a94; --line:#33332f; --card:#1e1e1c; --ok:#4cc38a; --bad:#ff7b72; --warn:#e3b341; --acc:#7aa2ff; } }
  :root[data-theme="dark"] { --bg:#141413; --fg:#ececea; --mut:#9a9a94; --line:#33332f; --card:#1e1e1c; --ok:#4cc38a; --bad:#ff7b72; --warn:#e3b341; --acc:#7aa2ff; }
  body { background:var(--bg); color:var(--fg); font:14px/1.45 system-ui,sans-serif; margin:0; padding:20px; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:15px; margin:22px 0 8px; }
  .mut { color:var(--mut); } .ok { color:var(--ok); } .bad { color:var(--bad); } .warn { color:var(--warn); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin:10px 0; }
  .row { display:flex; flex-wrap:wrap; gap:8px 16px; align-items:center; }
  button { font:inherit; padding:6px 12px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); cursor:pointer; }
  button.primary { background:var(--acc); color:#fff; border-color:var(--acc); } button:disabled { opacity:.5; cursor:default; }
  button:focus-visible { outline:2px solid var(--acc); outline-offset:2px; }
  code, pre { font-family:var(--mono); font-size:12px; } pre { white-space:pre-wrap; word-break:break-word; margin:0; }
  .box { max-height:260px; overflow:auto; border:1px solid var(--line); border-radius:6px; padding:8px; background:var(--bg); }
  .scroll { overflow-x:auto; } table { border-collapse:collapse; font-size:12px; white-space:nowrap; font-variant-numeric:tabular-nums; }
  th, td { border-bottom:1px solid var(--line); padding:3px 8px; text-align:left; vertical-align:top; } th { color:var(--mut); font-weight:600; }
  td.snip { white-space:normal; min-width:220px; max-width:460px; font-family:var(--mono); font-size:11px; }
  details summary { cursor:pointer; color:var(--acc); } ol { margin:6px 0 0 18px; padding:0; } ol li { margin:3px 0; }
</style>

<h1>S11 — the builder's whole-app turn through <code>sample</code></h1>
<p class="mut">TASK-20260905-binding-a-artifacts, Q4. Sends the host kit's tool-free builder prompt (the same bytes <code>apps/host</code> will send: system layers + the in-page build suffix + the app-context block with the CURRENT app code + the edit request) through this viewer's <code>sample()</code> as ONE user turn, and records per call: latency, first-token latency, <code>truncated</code>, <code>modelTierApplied</code>, whether a COMPLETE document came back (<code>&lt;!doctype html&gt; … &lt;/html&gt;</code>, the extractor the kit uses), its size against the original, and how the 64 KiB input cap behaves at the boundary. Nothing runs and nothing is written until you click <b>run all arms</b>.</p>

<div class="card"><b>What to do</b>
  <ol>
    <li>Click <b>run all arms</b> (10 calls; the <code>default</code>-tier whole-app replies take 1–3 minutes each, so expect ~15 minutes; <b>stop</b> ends the run after the call in flight).</li>
    <li>Allow Claude's consent dialog when it appears (expected on call #1). After call #1 the page pauses and asks whether it appeared — answer, and the run continues on its own.</li>
    <li>When the status reads <b>finished</b>, tell the session "done". Do not reload or close the page before that.</li>
  </ol>
</div>

<div class="card">
  <div class="row"><b>Runtime</b> <span id="rt-sample" class="mut">claude.use('sample') … resolving</span> · <span id="rt-db" class="mut">claude.use('db') … resolving</span></div>
  <div class="row" style="margin-top:6px"><b>sample.limits()</b> <code id="limits">…</code></div>
</div>

<div class="card">
  <div class="row">
    <button id="run" class="primary" disabled>run all arms</button>
    <button id="stop" disabled>stop</button>
    <button id="copy">copy JSON</button>
    <span class="mut">in flight: <span id="inflight">none</span></span>
  </div>
  <div id="ask" class="row" hidden style="margin-top:8px"><span id="ask-text" class="warn"></span> <button id="ask-yes" class="primary">yes, it appeared</button> <button id="ask-no">no dialog</button></div>
  <div id="status" class="row mut" style="margin-top:8px">idle</div>
  <div id="dbstat" class="row mut" style="margin-top:4px">db: nothing written (nothing is ever written on load)</div>
</div>

<h2>Arms (sequential, one fresh AbortController per call, <code>cache:false</code>, <code>sample()</code> text verb)</h2>
<div class="card scroll"><table id="arms"><thead><tr><th>arm</th><th>app</th><th>tier</th><th>calls</th><th>input bytes</th><th>what it answers</th></tr></thead><tbody></tbody></table></div>

<h2>Live calls</h2>
<div class="card scroll"><table id="calls"><thead><tr><th>#</th><th>arm</th><th>i</th><th>ms</th><th>first token ms</th><th>onText</th><th>code</th><th>truncated</th><th>tier applied</th><th>text bytes</th><th>fenced</th><th>complete doc</th><th>doc bytes</th><th>÷ original</th><th>title</th><th>reply head / tail</th></tr></thead><tbody></tbody></table></div>

<h2>Result document (<code>results/s11</code>)</h2>
<div class="card"><pre class="box" id="json" style="max-height:420px">{}</pre></div>

<script type="application/json" id="s11-data">${json}</script>
<script>
'use strict';
const DATA = JSON.parse(document.getElementById('s11-data').textContent);
const RESULT_PATH = 'results/s11', GAP_MS = 500, DB_TIMEOUT_MS = 10000, HEAD_KEEP = 1500, TAIL_KEEP = 600;
const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const bytes = (s) => enc.encode(s).length;
const STOP_RUN = new Set(['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed', 'session_expired', 'queue_overflow']);

const turn = (system, block, message) => (block ? system + DATA.separator + block : system) + DATA.separator + message;
const capHtml = (html, cap) => (html.length <= cap ? html : html.slice(0, cap) + DATA.truncationMarker);
const blockFor = (app, cap) => {
  const a = DATA.apps[app];
  return cap === undefined ? a.block : a.block.replace('\\x60\\x60\\x60html\\n' + a.html + '\\n\\x60\\x60\\x60', '\\x60\\x60\\x60html\\n' + capHtml(a.html, cap) + '\\n\\x60\\x60\\x60');
};
// Byte-exact inputs at the cap: shrink the chess html until the whole turn is exactly "target" bytes.
function inputAtBytes(target) {
  const a = DATA.apps.chess, msg = DATA.requests.chess;
  let lo = 0, hi = a.html.length, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, s = turn(DATA.system, blockFor('chess', mid), msg), b = bytes(s);
    if (b <= target) { best = { s, b, cap: mid }; lo = mid + 1; } else hi = mid - 1;
  }
  if (!best) return null;
  // Pad the last line with spaces (ASCII, one byte each) up to the exact target.
  const pad = target - best.b;
  return { input: pad > 0 ? best.s + ' '.repeat(pad) : best.s, htmlCap: best.cap, bytes: target };
}

const ARMS = [
  { id: 'A', app: 'chess', tier: 'default', n: 2, input: () => turn(DATA.system, blockFor('chess'), DATA.requests.chess), what: 'the builder EDIT turn on the kit\\u2019s default builder tier — does a whole 33 KB app come back complete, and how long does it take' },
  { id: 'B', app: 'chess', tier: 'quick', n: 2, input: () => turn(DATA.system, blockFor('chess'), DATA.requests.chess), what: 'the same edit on quick — is a whole-app reply even attempted, and is the tier honoured' },
  { id: 'C', app: 'pig', tier: 'default', n: 1, input: () => turn(DATA.system, blockFor('pig'), DATA.requests.pig), what: 'a 51 KB app: the largest input that fits under the cap with nothing cut — output ceiling / truncated?' },
  { id: 'D', app: '(none)', tier: 'default', n: 1, input: () => turn(DATA.system, undefined, DATA.requests.fresh), what: 'a fresh build from the create bar (no app attached): size and completeness of a from-scratch app' },
  { id: 'E', app: 'copilot', tier: 'default', n: 1, input: () => turn(DATA.system, blockFor('copilot'), DATA.requests.copilot), what: 'OVER the cap (117 KB app, no budget applied): which error, how fast, and whether it spends anything' },
  { id: 'F', app: 'chess@cap', tier: 'default', n: 1, input: (lim) => inputAtBytes(lim).input, what: 'EXACTLY maxPromptBytes (chess html cut with the kit\\u2019s truncation marker, space-padded to the byte): accepted?' },
  { id: 'G', app: 'chess@cap+1', tier: 'default', n: 1, input: (lim) => inputAtBytes(lim + 1).input, what: 'maxPromptBytes + 1: is the cap inclusive and counted in UTF-8 bytes' },
  { id: 'H', app: 'chess', tier: 'complex', n: 1, input: () => turn(DATA.system, blockFor('chess'), DATA.requests.chess), what: 'informative: the complex tier on the same edit (thinking time, tier honoured)' },
];

const doc = {
  spike: 's11', version: 1, startedAt: null, updatedAt: null, writeSeq: 0, finished: false, stopReason: null, armStops: {},
  runtime: { sampleAvailable: null, dbAvailable: null, limits: null, limitsError: null, userAgent: navigator.userAgent },
  consent: { firstCall: { dialogSeen: null, answeredAt: null, callMs: null, firstTokenMs: null } },
  inputs: { systemBytes: bytes(DATA.system), apps: Object.fromEntries(Object.entries(DATA.apps).map(([k, a]) => [k, { folder: a.folder, htmlBytes: bytes(a.html), blockBytes: bytes(a.block) }])), arms: {}, requests: DATA.requests },
  calls: [], summary: {}, dbFailures: [], dbWrites: { coalesced: 0, lastLandedSeq: 0 },
};
let sample = null, db = null, running = false, stopRequested = false, currentCtl = null, callIndex = 0, pauseResolve = null, limit = null;

// ---- the extractor the kit uses (apps/playground/src/agent/webllm/appHtml.ts), replicated ----
const DOCUMENT_PATTERN = /<!doctype html[\\s\\S]*?<\\/html\\s*>/gi;
const FENCE_PATTERN = /\\x60\\x60\\x60(?:html)?\\s*\\n([\\s\\S]*?)\\x60\\x60\\x60/g;
function lastCompleteDocument(text) { const m = [...text.matchAll(DOCUMENT_PATTERN)]; return m.length ? m[m.length - 1][0] : undefined; }
function extractAppHtml(text) {
  const candidates = [];
  for (const m of text.matchAll(FENCE_PATTERN)) { const d = lastCompleteDocument(m[1] || ''); if (d !== undefined) candidates.push(d); }
  const fenced = candidates.length > 0;
  if (!candidates.length) { const bare = lastCompleteDocument(text); if (bare !== undefined) candidates.push(bare); }
  const html = candidates[candidates.length - 1];
  if (html === undefined) return { html: undefined, fenced };
  const t = /<title[^>]*>([^<]*)<\\/title>/i.exec(html);
  return { html, fenced, title: t && t[1].trim() ? t[1].trim() : '(no title)' };
}
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((p, q) => p - q), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function setStatus(t, cls) { $('status').textContent = t; $('status').className = 'row ' + (cls || 'mut'); }

function renderArms() {
  const tb = $('arms').querySelector('tbody'); tb.innerHTML = '';
  for (const a of ARMS) {
    let b = '—';
    try { b = limit == null && /cap/.test(a.app) ? 'needs limits()' : String(bytes(a.input(limit))); } catch (e) { b = 'n/a'; }
    doc.inputs.arms[a.id] = { app: a.app, tier: a.tier, n: a.n, inputBytes: b, what: a.what };
    const tr = tb.insertRow(); for (const v of [a.id, a.app, a.tier, a.n, b, a.what]) tr.insertCell().textContent = String(v);
  }
}
function renderCall(c) {
  const tr = $('calls').querySelector('tbody').insertRow();
  const vals = [c.callIndex, c.arm, c.i, c.ms, c.firstTokenMs ?? '—', c.onTextCalls, c.code ?? '', c.truncated ?? 'n/a', c.modelTierApplied ?? 'n/a', c.textBytes, c.fenced, c.completeDoc, c.docBytes ?? '—', c.ratioToOriginal ?? '—', c.title ?? '—'];
  vals.forEach((v, k) => { const td = tr.insertCell(); td.textContent = String(v); if (k === 6 && c.code) td.className = 'bad'; if (k === 7) td.className = v === true ? 'bad' : v === false ? 'ok' : ''; if (k === 11) td.className = v === true ? 'ok' : v === false ? 'bad' : ''; });
  const td = tr.insertCell(); td.className = 'snip'; td.textContent = c.head.slice(0, 200) + ' … ' + c.tail.slice(-160);
}
function summarize() {
  for (const a of ARMS) {
    const cs = doc.calls.filter((c) => c.arm === a.id); if (!cs.length) continue;
    doc.summary[a.id] = { n: cs.length, medianMs: median(cs.map((c) => c.ms)), medianFirstTokenMs: median(cs.filter((c) => c.firstTokenMs != null).map((c) => c.firstTokenMs)),
      completeDocs: cs.filter((c) => c.completeDoc).length, truncated: cs.filter((c) => c.truncated === true).length, tiers: cs.filter((c) => c.modelTierApplied).map((c) => c.modelTierApplied),
      errors: cs.filter((c) => c.code).map((c) => c.code), medianDocBytes: median(cs.filter((c) => c.docBytes != null).map((c) => c.docBytes)), medianRatio: median(cs.filter((c) => c.ratioToOriginal != null).map((c) => c.ratioToOriginal)) };
  }
}

// ---- db: the S3 machinery (reads raced, writes chained + coalesced, failures logged as data) ----
async function dbCall(label, fn, race) {
  const once = () => (race ? Promise.race([fn(), sleep(DB_TIMEOUT_MS).then(() => Promise.reject({ code: 'db_timeout', message: label + ' not settled after ' + DB_TIMEOUT_MS + ' ms' }))]) : fn());
  let err;
  try { return { ok: true, value: await once() }; } catch (e) { err = e; }
  if (err && err.code === 'unavailable') { await sleep(500 + Math.random() * 1000); try { return { ok: true, value: await once() }; } catch (e) { err = e; } }
  const f = { at: new Date().toISOString(), op: label, code: (err && err.code) || 'unknown', message: String((err && err.message) || err).slice(0, 200) };
  doc.dbFailures.push(f); $('dbstat').textContent = 'db: ' + label + ' FAILED code=' + f.code + ' — ' + f.message; $('dbstat').className = 'row bad';
  $('json').textContent = JSON.stringify(doc, null, 1);
  return { ok: false, error: f };
}
let writer = Promise.resolve(), flight = null;
function setViaChain(path, body, seq) {
  const label = 'set ' + path + ' #' + seq;
  const send = async () => { flight = { label, at: Date.now() }; body.writtenAt = new Date().toISOString(); const r = await dbCall(label, () => db.doc(path).set(body), false); flight = null; return r; };
  const p = writer.then(send); writer = p.then(() => {}, () => {}); return p;
}
setInterval(() => { if (!flight || Date.now() - flight.at < DB_TIMEOUT_MS) return; $('dbstat').textContent = 'db: ' + flight.label + ' in flight for ' + Math.round((Date.now() - flight.at) / 1000) + ' s — not abandoned; use "copy JSON" if it never lands'; $('dbstat').className = 'row warn'; }, 1000);
let pendingDoc = null, drain = null;
function persist() {
  doc.updatedAt = new Date().toISOString(); doc.writeSeq += 1;
  if (pendingDoc) doc.dbWrites.coalesced += 1;
  const clean = JSON.parse(JSON.stringify(doc));
  $('json').textContent = JSON.stringify(clean, null, 1);
  if (!db) { $('dbstat').textContent = 'db: unavailable in this view — use "copy JSON"'; return Promise.resolve(); }
  pendingDoc = clean;
  if (!drain) drain = (async () => {
    while (pendingDoc) {
      const body = pendingDoc; pendingDoc = null;
      const r = await setViaChain(RESULT_PATH, body, body.writeSeq);
      if (!r.ok) continue;
      doc.dbWrites.lastLandedSeq = body.writeSeq;
      $('dbstat').textContent = 'db: ' + RESULT_PATH + ' written ' + body.writtenAt + ' (write #' + body.writeSeq + ', ' + body.calls.length + ' calls)'; $('dbstat').className = 'row ok';
    }
    drain = null;
  })();
  return drain;
}
async function archivePrevious() {
  const r = await dbCall('get ' + RESULT_PATH, () => db.doc(RESULT_PATH).get(), true);
  if (!r.ok) { setStatus('could not read ' + RESULT_PATH + ' (' + r.error.code + ') — not starting (a run would overwrite it). Reload and try again.', 'bad'); return false; }
  const prev = r.value.exists ? r.value.data() || {} : {};
  if (!Array.isArray(prev.calls) || !prev.calls.length) return true;
  const id = RESULT_PATH + '-prev-' + String(prev.startedAt || 'unknown').replace(/[^A-Za-z0-9_.:-]/g, '-');
  const w = await setViaChain(id, { ...prev, archivedAt: new Date().toISOString() }, 0);
  if (!w.ok) { setStatus('could not archive the stored run to ' + id + ' — not starting.', 'bad'); return false; }
  doc.archivedPrevious = id; return true;
}

async function oneCall(arm, i) {
  const ctl = new AbortController(); currentCtl = ctl; callIndex += 1;
  $('inflight').textContent = arm.id + i + ' (#' + callIndex + ')';
  const rec = { callIndex, arm: arm.id, i, tier: arm.tier, ms: null, firstTokenMs: null, onTextCalls: 0, code: null, truncated: null, modelTierApplied: null, textBytes: 0, fenced: false, completeDoc: false, docBytes: null, ratioToOriginal: null, title: null, head: '', tail: '', startedAt: new Date().toISOString() };
  let input;
  try { input = arm.input(limit); rec.inputBytes = bytes(input); } catch (e) { rec.code = 'page_error'; rec.errorMessage = 'input: ' + String(e && e.message || e); rec.ms = 0; return rec; }
  let raw = '';
  const t0 = Date.now();
  const opts = { signal: ctl.signal, modelTier: arm.tier, cache: false, onText: ({ text }) => { rec.onTextCalls += 1; if (rec.firstTokenMs == null) rec.firstTokenMs = Date.now() - t0; raw = text; } };
  try { const r = await sample(input, opts); raw = r.text; rec.truncated = r.truncated; rec.modelTierApplied = r.modelTierApplied; }
  catch (e) {
    if (e && typeof e.code === 'string') { rec.code = e.code; rec.errorMessage = String(e.message || '').slice(0, 300); if (typeof e.text === 'string') raw = e.text; }
    else { rec.code = 'page_error'; rec.errorMessage = String((e && (e.stack || e.message)) || e).slice(0, 500); }
  }
  rec.ms = Date.now() - t0; rec.textBytes = bytes(raw); rec.head = raw.slice(0, HEAD_KEEP); rec.tail = raw.slice(-TAIL_KEEP);
  const ex = extractAppHtml(raw); rec.fenced = ex.fenced; rec.completeDoc = ex.html !== undefined;
  if (ex.html !== undefined) { rec.docBytes = bytes(ex.html); rec.title = ex.title; const orig = DATA.apps[arm.app.replace(/@.*$/, '')]; if (orig) rec.ratioToOriginal = Math.round((rec.docBytes / bytes(orig.html)) * 100) / 100; }
  $('inflight').textContent = 'none'; return rec;
}
function askFirstCall(rec) {
  return new Promise((resolve) => {
    $('ask-text').textContent = 'Call #1 (' + rec.arm + rec.i + ') finished in ' + rec.ms + ' ms (first token ' + (rec.firstTokenMs ?? '—') + ' ms, code ' + (rec.code ?? 'none') + "). Did Claude's consent dialog appear during it?"; $('ask').hidden = false;
    const done = (seen) => { $('ask').hidden = true; pauseResolve = null; doc.consent.firstCall = { dialogSeen: seen, answeredAt: new Date().toISOString(), callMs: rec.ms, firstTokenMs: rec.firstTokenMs }; resolve(); };
    $('ask-yes').onclick = () => done(true); $('ask-no').onclick = () => done(false); pauseResolve = () => done(null);
  });
}

async function runAll() {
  running = true; stopRequested = false; $('run').disabled = true; $('stop').disabled = false;
  doc.startedAt = new Date().toISOString(); doc.finished = false; doc.stopReason = null;
  if (db && !(await archivePrevious())) { running = false; $('run').disabled = false; $('stop').disabled = true; return; }
  persist();
  outer: for (const arm of ARMS) {
    for (let i = 1; i <= arm.n; i++) {
      if (stopRequested) { doc.stopReason = 'stopped by operator'; break outer; }
      setStatus('running arm ' + arm.id + ' call ' + i + '/' + arm.n + ' (#' + (callIndex + 1) + ') — tier ' + arm.tier + ' (a whole-app reply on default can take 1–3 minutes)…');
      const rec = await oneCall(arm, i);
      doc.calls.push(rec); renderCall(rec); summarize(); persist();
      if (rec.callIndex === 1 && !stopRequested) { setStatus('paused — answer the consent question above, then the run continues', 'warn'); await askFirstCall(rec); persist(); }
      if (rec.code === 'cancelled') { doc.stopReason = 'stopped by operator'; break outer; }
      if (rec.code === 'rate_limited') { doc.stopReason = 'rate_limited at ' + arm.id + i + ' — run stopped, never retried'; break outer; }
      if (STOP_RUN.has(rec.code)) { doc.stopReason = 'run stopped: ' + rec.code + ' — ' + rec.errorMessage; break outer; }
      await sleep(GAP_MS);
    }
  }
  doc.finished = true; running = false; currentCtl = null; $('stop').disabled = true; $('inflight').textContent = 'none';
  const verdict = doc.stopReason ? 'finished with: ' + doc.stopReason : 'finished: ' + doc.calls.length + ' calls';
  if (db) setStatus(verdict + ' — waiting for the final db write to land…', 'warn');
  await persist();
  if (db && doc.dbWrites.lastLandedSeq !== doc.writeSeq) { setStatus(verdict + ' — the FINAL db write FAILED; click "copy JSON" and paste it to the session instead of saying "done".', 'bad'); return; }
  setStatus(verdict + ' — tell the session "done". To run again, reload the page.', doc.stopReason ? 'warn' : 'ok');
}

$('run').onclick = () => { if (!running) runAll(); };
$('stop').onclick = () => { stopRequested = true; if (currentCtl) currentCtl.abort(); if (pauseResolve) pauseResolve(); setStatus('stop requested — aborting the call in flight', 'warn'); };
$('copy').onclick = async () => {
  const txt = $('json').textContent;
  try { await navigator.clipboard.writeText(txt); setStatus('JSON copied to clipboard', 'ok'); }
  catch (e) { const r = document.createRange(); r.selectNodeContents($('json')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); setStatus('clipboard blocked — the JSON box is selected, press Ctrl/Cmd+C', 'warn'); }
};

(async () => {
  renderArms(); $('json').textContent = JSON.stringify(doc, null, 1);
  if (!window.claude || typeof window.claude.use !== 'function') { $('rt-sample').textContent = 'window.claude.use absent — not inside a Claude viewer'; $('rt-sample').className = 'bad'; return; }
  [sample, db] = await Promise.all([window.claude.use('sample'), window.claude.use('db')]);
  doc.runtime.sampleAvailable = !!sample; doc.runtime.dbAvailable = !!db;
  $('rt-sample').textContent = sample ? "claude.use('sample') resolved" : "claude.use('sample') → null (not served here)"; $('rt-sample').className = sample ? 'ok' : 'bad';
  $('rt-db').textContent = db ? "claude.use('db') resolved" : "claude.use('db') → null (results stay on screen only)"; $('rt-db').className = db ? 'ok' : 'warn';
  if (db) {
    const r = await dbCall('get ' + RESULT_PATH + ' (load)', () => db.doc(RESULT_PATH).get(), true);
    if (r.ok && r.value.exists) { const p = r.value.data() || {}; $('dbstat').textContent = 'db: ' + RESULT_PATH + ' already holds a run (startedAt ' + p.startedAt + ', ' + (Array.isArray(p.calls) ? p.calls.length : 0) + ' calls, finished ' + p.finished + ') — clicking run archives it first'; $('dbstat').className = 'row warn'; $('json').textContent = JSON.stringify(p, null, 1); }
    else if (r.ok) $('dbstat').textContent = 'db: ' + RESULT_PATH + ' does not exist yet — nothing written on load';
  }
  if (sample) {
    try { const lim = await sample.limits(); doc.runtime.limits = lim; limit = lim.maxPromptBytes; $('limits').textContent = JSON.stringify(lim); }
    catch (e) { doc.runtime.limitsError = (e && e.code) || String(e); $('limits').textContent = 'limits() rejected: ' + doc.runtime.limitsError; }
    renderArms(); $('json').textContent = JSON.stringify(doc, null, 1);
    $('run').disabled = false; setStatus('ready — click "run all arms" (10 calls, ~15 min; the page pauses once after call #1)');
  } else setStatus('sample unavailable in this view — nothing to run', 'bad');
})();
</script>
`;

const out = path.join(ROOT, 'scripts/spikes/s11-sample-whole-app.html');
writeFileSync(out, page);
console.log(`wrote ${out} (${Buffer.byteLength(page)} bytes); system ${Buffer.byteLength(SYSTEM)} B; chess block ${Buffer.byteLength(DATA.apps.chess.block)} B; pig block ${Buffer.byteLength(DATA.apps.pig.block)} B; copilot block ${Buffer.byteLength(DATA.apps.copilot.block)} B`);
