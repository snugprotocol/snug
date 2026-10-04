// runtime-probe — TASK-20261003-host-bindings-complete C1. `scripts/runtime-probe.html` is the
// maintained diagnostic for the artifact runtime the kit runs on (schema `snug-chat-probe/3` —
// the page the owner ran in claude.ai on 2026-10-03; it replaced the September `chat-probe.html`,
// whose `window.claude.complete` runtime no longer exists). Published as an artifact (by the
// Artifact tool or from a chat), it reads every capability through `claude.use()`, then
// `sample.limits()` and `permissions.state()`; on a click it measures `sample`'s prompt cap with
// a ladder sized from `limits()`, sends the kit's real chess turn on both tiers, reads its own
// source and offers a download — and RECORDS the replies, so a reply-shape question is answered
// from text, not lengths.
//
// What these pins are for:
//   - the page is the Artifact tool's FRAGMENT form — the platform wraps it in the 0.2.67
//     skeleton, so it carries no document of its own: its `<title>` and `<style>` come first;
//   - every capability through `use()`: contract 0.2.67 promises `window.claude` nothing else
//     (claude.d.ts), and the September `complete` is gone (measured 2026-10-03, C2) — a page
//     that meets only `complete` reports it and calls nothing;
//   - every `sample` call bills the viewer, so nothing reaches it at load, and the probe never
//     publishes itself (an `artifact` call would mint a version of the owner's artifact);
//   - nothing leaves the page except through the capability namespaces: the one top-level fetch
//     is the page's own address (its source, on a click); the other is the nested frame's
//     deliberately blocked one — the C2 measurement, behind its own `connect-src 'none'` in a
//     `sandbox="allow-scripts"` frame — and no other request API is so much as named;
//   - a rung is PROVEN only when the reply carries BOTH code words — a head-only reply is the
//     silent truncation the ladder exists to see — and the ladder brackets `limits()` by a byte;
//   - the report says where the page runs without a query or a fragment, keeps the replies'
//     text under a bound, and is written where v3 wrote it: the artifact's `db`
//     (`reports/<run>`) and the copy box.
// Named `*.node-test.mjs` like the other plain-node suites; run by `pnpm run check-host-kit`.
// Nothing here is a browser and no model is called: the real readings are the owner's walk.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';

import { ARTIFACT_SKELETON_OPEN, tokenizeTopLevel } from './lib/page-blocks.mjs';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime-probe.html');
const SCHEMA = 'snug-chat-probe/3';
/**
 * A chat can still be asked to make this exact page an artifact (the v2 was created that way),
 * so every byte is one a model may retype. 20,000 is the v3 the owner ran (19,945 B) rounded up;
 * a change that needs bytes takes them from the page: this bound only moves down.
 */
const MAX_BYTES = 20_000;
/** A page promise that never settles must fail its test, not hang the gate. */
const BOUNDED = { timeout: 10_000 };
const CALL_BOUND_MS = 120_000;
const USE_BOUND_MS = 12_000;
/** `sample.limits()` as measured in a chat-created AND a tool-published artifact, 2026-10-03. */
const LIMITS = { maxPromptBytes: 262_144, tools: { maxCount: 16 } };
const CAPS = ['sample', 'artifact', 'downloads', 'db', 'user', 'assets', 'files', 'mcp', 'room', 'comments', 'permissions'];
/** What resolved in the owner's artifacts (reports 2026-10-03): these six, the rest `null`. */
const SERVED = ['sample', 'artifact', 'downloads', 'db', 'user', 'permissions'];
const JSON_REPLY = '{"move":{"from":"e2","to":"e4"},"message":"ok"}';
// The two replies the kit's real chess turn drew on `sample` (report musuyx9k, 2026-10-03
// 20:42 UTC): `quick` FENCED a top-level {from,to}; `default` answered BARE {move:{from,to}}.
const QUICK_TURN_REPLY = '```json\n{"from":"e7","to":"e5","message":"Classic. Let\'s see what you\'ve got."}\n```';
const DEFAULT_TURN_REPLY = '{"move":{"from":"e7","to":"e5"},"message":"Classic for a classic beatdown. Let\'s dance.","gameOver":false}';

const page = () => readFileSync(FILE, 'utf8');
/** A value the page built lives in the VM's realm (its own Object.prototype): compare it as JSON. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Split the page where an HTML tokenizer would: the first `<script …>` runs to the first `</script`. */
function splitPage(text) {
  const open = /<script\b[^>]*>/i.exec(text);
  assert.ok(open, 'the page has a <script>');
  const from = open.index + open[0].length;
  const close = text.toLowerCase().indexOf('</script', from);
  assert.ok(close > from, 'the script element is closed');
  const end = text.indexOf('>', close) + 1;
  return { openTag: open[0], body: text.slice(from, close), rest: text.slice(0, open.index) + text.slice(end) };
}

/**
 * The script with the INSIDE of every string, template chunk, comment and regex blanked (same
 * length, newlines kept), so a search for a call site cannot be fooled by text. `${…}` template
 * expressions are code and are kept.
 */
function codeOnly(js) {
  const out = [];
  const templates = []; // the brace depth each open `${` returns to
  let depth = 0;
  let i = 0;
  const blank = (from, to) => out.push(js.slice(from, to).replace(/[^\n]/g, ' '));
  const templateText = () => {
    const start = i;
    for (; i < js.length; i += 1) {
      if (js[i] === '\\') { i += 1; continue; }
      if (js[i] === '`') { blank(start, i); out.push('`'); i += 1; return; }
      if (js[i] === '$' && js[i + 1] === '{') { blank(start, i); out.push('${'); i += 2; templates.push(depth); depth += 1; return; }
    }
    throw new Error('unterminated template literal');
  };
  // A `/` starts a regex unless the code before it ended a value (a name, a number, `)`, `]`, a string).
  const regexStartsHere = () => {
    const before = out.join('').trimEnd();
    return !/[\w$)\]'"`]$/.test(before) || /\b(?:return|typeof|case|void|delete|in|of)$/.test(before);
  };
  while (i < js.length) {
    const c = js[i];
    if (c === '/' && js[i + 1] === '/') { const nl = js.indexOf('\n', i); const to = nl === -1 ? js.length : nl; blank(i, to); i = to; continue; }
    if (c === '/' && js[i + 1] === '*') { const to = js.indexOf('*/', i + 2) + 2; blank(i, to); i = to; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (js[j] !== c) { if (js[j] === '\\') j += 1; j += 1; }
      out.push(c); blank(i + 1, j); out.push(c); i = j + 1; continue;
    }
    if (c === '`') { out.push(c); i += 1; templateText(); continue; }
    if (c === '/' && regexStartsHere()) {
      let j = i + 1;
      for (let inClass = false; js[j] !== '/' || inClass; j += 1) {
        if (js[j] === '\\') j += 1;
        else if (js[j] === '[') inClass = true;
        else if (js[j] === ']') inClass = false;
      }
      out.push('/'); blank(i + 1, j); out.push('/'); i = j + 1; continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') {
      depth -= 1;
      if (templates.at(-1) === depth) { templates.pop(); out.push('}'); i += 1; templateText(); continue; }
    }
    out.push(c);
    i += 1;
  }
  return out.join('');
}

/**
 * The statements of the page's one IIFE, keyed by what each declares. A `const`/`let` at the
 * IIFE's own depth is a declaration (nothing runs until someone calls it); every other statement
 * there RUNS AT LOAD and is collected under `(load)`.
 */
function statements(code) {
  const inner = code.slice(code.indexOf('{') + 1, code.lastIndexOf('}'));
  const chunks = new Map([['(load)', '']]);
  let depth = 0;
  let current = '(load)';
  for (const line of inner.split('\n')) {
    if (depth === 0 && line.trim() !== '') {
      const declared = /^(?:const|let)\s+([\w$]+)/.exec(line);
      current = declared ? declared[1] : '(load)';
      if (declared) assert.equal(chunks.has(current), false, `"${current}" is declared once`);
    }
    chunks.set(current, `${chunks.get(current) ?? ''}${line}\n`);
    for (const ch of line) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
  }
  assert.equal(depth, 0, 'the braces balance');
  return chunks;
}

/** The names of the statements whose code matches `pattern`. */
const holding = (chunks, pattern) => [...chunks].filter(([, text]) => pattern.test(text)).map(([name]) => name);
const chunksOf = () => statements(codeOnly(splitPage(page()).body));

const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The contract-0.2.67 runtime: `window.claude = { use }` and nothing else, `use(name)` resolving
 * a namespace for the names in `served` and `null` for the rest. `sample` is a FUNCTION with
 * `limits()` (the report recorded `typeof sample === 'function'`); `answer(input, opts)` decides
 * its reply. Every call into a namespace is counted — the network a page has, in this runtime,
 * is these namespaces.
 */
function runtime0267({ served = SERVED, limits = async () => LIMITS, answer = echo, state = async () => ({ artifact: 'granted', db: 'granted', downloads: 'granted', sample: 'prompt' }), saveAnswer = async () => ({ status: 'saved' }), use } = {}) {
  const calls = { use: [], sample: [], limits: 0, state: 0, saves: [], docs: [], artifact: 0 };
  const sample = Object.assign(
    (input, opts) => {
      calls.sample.push({ input, opts });
      return answer(input, opts);
    },
    { limits: () => ((calls.limits += 1), limits()) },
  );
  const forbidden = () => { calls.artifact += 1; throw new Error('the probe must never publish its own artifact'); };
  const namespaces = {
    sample,
    artifact: Object.freeze({ publish: forbidden, edit: forbidden, sync: forbidden }),
    downloads: Object.freeze({ save: (request) => (calls.saves.push(request), saveAnswer(request)) }),
    db: Object.freeze({ doc: (where) => Object.freeze({ set: async (data) => { calls.docs.push({ where, data }); } }) }),
    user: Object.freeze({}),
    permissions: Object.freeze({ state: () => ((calls.state += 1), state()) }),
  };
  const claude = {
    use: use ?? ((name) => {
      calls.use.push(name);
      return Promise.resolve(served.includes(name) ? namespaces[name] : null);
    }),
  };
  return { claude, calls, namespaces };
}

/** A brain that answers the way each ask asks: both code words back; the JSON ask bare JSON; the chess turn as each tier really did. */
const codeWords = (prompt) => [/HEAD-\w+/.exec(prompt)?.[0], /TAIL-\w+/.exec(prompt)?.[0]];
async function echo(input, opts = {}) {
  const text = input.includes('[SNUG_APP_REQUEST]')
    ? (opts.modelTier === 'quick' ? QUICK_TURN_REPLY : DEFAULT_TURN_REPLY)
    : input.includes('"move"') ? JSON_REPLY : codeWords(input).join('\n');
  if (Buffer.byteLength(input, 'utf8') > LIMITS.maxPromptBytes) throw Object.assign(new Error('the prompt exceeds the 256 KiB limit'), { code: 'prompt_too_large' });
  opts.onText?.({ text, delta: text });
  return { text, truncated: false, modelTierApplied: opts.modelTier ?? 'default' };
}

/**
 * Run the page's script in a stub window: just enough DOM for the page to draw its tables, fake
 * timers the test fires by hand (so a 120 s bound costs nothing), a `fetch` that records every
 * request, and whichever `window.claude` the test supplies (`claude: undefined` = a page served
 * with no runtime at all). `browser` puts any global in place; `without` takes one away;
 * `missingIds` drops an element.
 */
function load({ claude, browser = {}, baseURI = 'https://frame.test/_f/1/', without = [], missingIds = [], source = '', body = splitPage(page()).body } = {}) {
  const timers = [];
  const created = [];
  const listeners = [];
  const fetched = [];
  const byId = new Map();
  const element = (tag = '') => {
    const el = {
      tag, value: '', disabled: false, onclick: null, onsubmit: null, style: {}, attrs: {}, rows: [], appended: [], text: '', removed: 0, prevented: 0,
      get textContent() { return el.text; },
      set textContent(v) { el.text = String(v); el.rows = []; },
      insertRow() {
        const row = { cells: [], insertCell() { const cell = { textContent: '' }; row.cells.push(cell); return cell; } };
        el.rows.push(row);
        return row;
      },
      setAttribute(k, v) { el.attrs[k] = v; },
      append(...nodes) { el.appended.push(...nodes); },
      remove() { el.removed += 1; },
      select() {},
      requestSubmit() {},
    };
    created.push(el);
    return el;
  };
  // The stub parses no markup, except for the one attribute the page's logic leans on: a button
  // the markup ships `disabled` starts disabled here too.
  const startsDisabled = (id) => new RegExp(`<button id="${id}" disabled>`).test(page());
  const $ = (id) => {
    if (missingIds.includes(id)) return null;
    if (!byId.has(id)) byId.set(id, Object.assign(element(), { disabled: startsDisabled(id) }));
    return byId.get(id);
  };
  const window = {
    document: {
      getElementById: $,
      createElement: element,
      body: element('body'),
      // The page's own script, and one the frame injected whose query string must not reach the report.
      scripts: [{ src: '' }, { src: 'https://frame.test/runtime.js?session=abc' }],
      baseURI,
      compatMode: 'CSS1Compat',
      title: '',
      execCommand: () => true,
    },
    navigator: { userAgent: 'node-test-agent' },
    location: { href: 'https://frame.test/_f/1/', origin: 'https://frame.test' },
    history: { replaceState() {}, pushState() {} },
    setTimeout: (fn, ms, ...args) => timers.push({ fn, ms, args }),
    clearTimeout: (id) => { timers[id - 1] = undefined; },
    addEventListener: (type, fn) => { listeners.push({ type, fn }); },
    removeEventListener() {},
    fetch: async (url, init) => {
      fetched.push([url, init]);
      return { status: 200, text: async () => source };
    },
    AbortController,
  };
  if (claude !== undefined) window.claude = claude;
  Object.assign(window, browser);
  for (const name of without) delete window[name];
  window.window = window;
  window.self = window;
  vm.createContext(window);
  new vm.Script(body, { filename: 'runtime-probe.html' }).runInContext(window);
  const h = {
    window,
    created,
    fetched,
    $,
    click: (id) => $(id).onclick(),
    /** Text the page appended to its body — only the boot block's failure note is ever text. */
    said: () => window.document.body.appended.filter((node) => typeof node === 'string'),
    pending: (ms) => timers.filter((t) => t && t.ms === ms).length,
    fire(ms) { timers.forEach((t, i) => { if (t && t.ms === ms) { timers[i] = undefined; t.fn(...t.args); } }); },
    /** Deliver a window event to whatever the page registered for it. */
    dispatch(type, event) { for (const l of listeners) if (l.type === type) l.fn(event); },
    report() { $('copy').onclick(); return JSON.parse($('out').value); },
    table: (id) => $(id).rows.map((row) => row.cells.map((cell) => cell.textContent)),
    /** Let the boot finish: the nested frame never answers a stub, so its 5 s bound (and IndexedDB's 3 s) is fired. */
    async booted() {
      for (let i = 0; i < 4; i += 1) {
        await settle();
        h.fire(3_000);
        h.fire(5_000);
      }
      await settle();
      return h;
    },
  };
  return h;
}

// ------------------------------------------------------------------------- the page itself

test('the page is the Artifact tool’s FRAGMENT form: <title> then <style> first, no doctype, <html>, <head> or <body> of its own — plain ASCII, under the byte bound', () => {
  const text = page();
  assert.ok(text.startsWith('<title>Snug Runtime Probe</title>\n<style>'), 'title first, then style');
  const names = tokenizeTopLevel(text).map((e) => e.name);
  for (const document of ['html', 'head', 'body']) assert.equal(names.includes(document), false, `no <${document}>`);
  assert.equal(/<!doctype/i.test(splitPage(text).rest), false, 'no doctype in the markup');
  assert.equal(text.startsWith(ARTIFACT_SKELETON_OPEN), false);
  const bytes = readFileSync(FILE);
  assert.ok(bytes.length < MAX_BYTES, `${bytes.length} bytes — the bound is ${MAX_BYTES}`);
  assert.equal(/[^\t\n\x20-\x7e]/.exec(bytes.toString('utf8')), null);
});

test('one inline classic <script>, no <script src>, no <link>, nothing referenced by the markup or the style', () => {
  const { openTag, body, rest } = splitPage(page());
  assert.equal(openTag, '<script>', 'no src, no type: one classic inline script');
  assert.equal(/<script\b/i.test(rest), false, 'exactly one <script> element');
  assert.equal(/<link\b/i.test(page()), false, 'no <link>');
  assert.equal(/\b(?:src|href|action)\s*=/i.test(rest), false, 'the markup references nothing');
  assert.equal(/@import|url\(/i.test(rest), false, 'the style references nothing');
  assert.equal(body.includes('<!--'), false, 'script data: an unclosed <!-- would swallow the closing tag');
});

test('the schema is snug-chat-probe/3 — the reports the owner already holds are this shape', () => {
  assert.equal(page().split(`schema: '${SCHEMA}'`).length - 1, 1);
});

// --------------------------------------------------------------------------- the network

test('the only URL in the file is https://example.com, inside the nested-frame child; no protocol-relative reference', () => {
  assert.deepEqual(page().match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'`)<>]*/gi), ['https://example.com']);
  assert.ok(String(load().window.__probe.kid).includes("fetch('https://example.com')"));
  // A `//host/…` reference resolves against the frame's https base: a real external request the
  // scheme-qualified search cannot see. The page has no line comments, so it has ONE `//`.
  assert.deepEqual(page().match(/.{0,6}\/\/[^\s'"`]*/g), ['https://example.com']);
});

test('nothing leaves the page but through the capability namespaces: two fetch call sites — the page’s OWN address (its source) and the nested frame’s blocked one — and no other request API is so much as named', () => {
  const { body } = splitPage(page());
  // Counted in the raw text, strings included: `window['fetch']` or `const f = fetch` would be another naming.
  assert.equal(body.match(/\bfetch\b/g).length, 2, 'fetch is named exactly twice');
  const chunks = chunksOf();
  assert.deepEqual(holding(chunks, /\bfetch\s*\(/).sort(), ['kid', 'source']);
  assert.match(chunks.get('source'), /\bfetch\(location\.href, \{ cache: '[\s]+' \}\)/, 'the top-level fetch is the page’s own address');
  assert.equal(/XMLHttpRequest|sendBeacon|WebSocket|EventSource|\bimport\b|\bImage\b|Worker\b|\bopen\(\s*['"`]http/.exec(body), null, 'no XHR, beacon, socket, event stream, dynamic import, image, worker or http popup');
  // An element is the other way to make a request (img, script, link): the page creates only these two.
  assert.deepEqual(body.match(/createElement\([^)]*\)/g), ["createElement('form')", "createElement('iframe')"]);
  // The nested child's request is the C2 measurement: its frame is allow-scripts only and its
  // srcdoc opens with its own `connect-src 'none'` before the child's code.
  assert.match(chunks.get('nested'), /setAttribute\('       ', '             '\)/);
  assert.match(body, /f\.setAttribute\('sandbox', 'allow-scripts'\);/);
  assert.match(body, /f\.srcdoc = `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'"><script>\(\$\{kid\}\)\(\)<\\\/script>`;/);
});

test('every capability through use(): no window.claude member is called but use, `complete` is never called, and the probe never publishes itself', () => {
  const chunks = chunksOf();
  assert.deepEqual(holding(chunks, /\bcomplete\s*\(/), [], 'the September brain is not called anywhere');
  assert.deepEqual(holding(chunks, /window\.claude\.(?!use\b)[\w$]+\s*\(/), [], 'no capability member of window.claude is called');
  assert.deepEqual(holding(chunks, /window\.claude\.use\s*\(/), ['boot']);
  assert.deepEqual(holding(chunks, /\bNS\.artifact\b/), [], 'the artifact namespace is resolved to be reported, never used');
});

test('structural: every `sample` call sits in `ask` or `turn`; `ask` is called only by `measure`; `measure` and `turn` are only handed to the click wiring', () => {
  const chunks = chunksOf();
  assert.deepEqual(holding(chunks, /\bNS\.sample\s*\(/).sort(), ['ask', 'turn']);
  assert.deepEqual(holding(chunks, /\bask\b/).sort(), ['ask', 'measure']);
  const atLoad = chunks.get('(load)');
  assert.equal(/\b(?:ask|sample|claude)\b/.test(atLoad), false);
  for (const act of ['measure', 'turn', 'source', 'save']) {
    assert.deepEqual(atLoad.match(new RegExp(`\\S.{0,15}\\b${act}\\b.{0,2}`, 'g')), [`on('${' '.repeat(act.length)}', ${act});`], `${act} is passed, never called`);
    // A bare call, not a member of the same name (`NS.downloads.save(…)` is the capability's).
    assert.equal(new RegExp(`(?<![.\\w$])${act}\\s*\\(`).test([...chunks.values()].join('')), false, `${act}() is called nowhere`);
  }
  assert.match(chunks.get('on'), /\.onclick = /);
});

test('the script parses as a classic ES2020 script wrapped in one IIFE (no global it could collide with)', () => {
  const { body } = splitPage(page());
  assert.doesNotThrow(() => new vm.Script(body));
  const code = codeOnly(body);
  assert.match(code.trim(), /^\(\(\) => \{[\s\S]*\}\)\(\);$/);
  assert.equal(/\?\?=|\|\|=|&&=/.test(code), false, 'no ES2021 logical assignment');
});

// ---------------------------------------------------------------------- the three runtimes

test('the 0.2.67 runtime: every capability is asked of use() once and recorded — resolved by its type, absent as "null" — then limits() and permissions.state(); the ladder is sized from limits()', BOUNDED, async () => {
  const rt = runtime0267();
  const h = await load({ claude: rt.claude }).booted();
  const report = h.report();
  assert.deepEqual(rt.calls.use.sort(), [...CAPS].sort(), 'one use() per capability name');
  assert.deepEqual(report.caps, {
    sample: 'function', artifact: 'object', downloads: 'object', db: 'object', user: 'object', permissions: 'object',
    assets: 'null', files: 'null', mcp: 'null', room: 'null', comments: 'null',
  });
  assert.deepEqual(report.limits, LIMITS);
  assert.deepEqual(report.permissions, { artifact: 'granted', db: 'granted', downloads: 'granted', sample: 'prompt' });
  assert.deepEqual([rt.calls.limits, rt.calls.state], [1, 1]);
  assert.deepEqual(report.facts.claude, { use: 'function', complete: 'undefined' }, 'what window.claude carries — `complete` named as the finding it is');
  // 8 KiB, 64 KiB, the cap, the cap + 1 byte: the bracket that proves the number.
  const plan = h.$('plan').textContent;
  assert.match(plan, /^up to 5 calls, 598017 bytes of prompt in all/);
  assert.equal(8_192 + 65_536 + 262_144 + 262_145, 598_017);
});

test('load is free: nothing calls sample, downloads or artifact at load or after the load-time bounds — the one write is the report to the artifact’s own db', BOUNDED, async () => {
  const rt = runtime0267();
  const h = await load({ claude: rt.claude }).booted();
  h.fire(USE_BOUND_MS);
  await settle();
  assert.deepEqual([rt.calls.sample.length, rt.calls.saves.length, rt.calls.artifact], [0, 0, 0]);
  assert.deepEqual(h.fetched, [], 'no request at load');
  assert.equal(rt.calls.docs.length, 1, 'the boot report is written once');
  assert.match(rt.calls.docs[0].where, /^reports\/[0-9a-z]+$/);
  assert.equal(h.$('saved').textContent, 'report saved for Claude to read');
  h.click('copy');
  assert.deepEqual([rt.calls.sample.length, rt.calls.saves.length], [0, 0], 'copying spends nothing');
});

test('no runtime at all (a saved copy of the page): records `undefined`, resolves nothing, measures nothing, throws nothing', BOUNDED, async () => {
  const h = await load({}).booted();
  const report = h.report();
  assert.deepEqual(h.said(), []);
  assert.equal(report.facts.claude, 'undefined');
  assert.deepEqual([report.caps, report.limits, report.permissions], [{}, null, null]);
  assert.match(h.$('plan').textContent, /^up to 4 calls, 139265 bytes/, 'the default ladder: 8 KiB, 64 KiB, 64 KiB + 1');
  await h.click('measure');
  assert.match(h.$('plan').textContent, /no sample capability here/);
  await h.click('turn');
  assert.match(h.$('plan').textContent, /no sample capability here/);
  assert.deepEqual(h.report().ladder, []);
  assert.equal(h.$('saved').textContent, '', 'no db, no saved-report claim');
});

test('the LEGACY September runtime (window.claude = { complete }): `complete` is reported and NEVER called — not at load, not by measure, not by the app turn', BOUNDED, async () => {
  const spent = [];
  const complete = (prompt) => { spent.push(prompt); return Promise.resolve('HEAD TAIL'); };
  const h = await load({ claude: { complete } }).booted();
  await h.click('measure');
  await h.click('turn');
  await settle();
  const report = h.report();
  assert.equal(spent.length, 0, 'the retired brain is never billed');
  assert.deepEqual(report.facts.claude, { complete: 'function' });
  assert.deepEqual([report.caps, report.limits, report.ladder, report.appTurn], [{}, null, [], []]);
  assert.match(h.$('plan').textContent, /no sample capability here/);
});

test('a served page whose every use() resolves null (top level on the artifact host): every capability "null", no limits, nothing measured', BOUNDED, async () => {
  const rt = runtime0267({ served: [] });
  const h = await load({ claude: rt.claude }).booted();
  const report = h.report();
  assert.deepEqual(report.caps, Object.fromEntries(CAPS.map((name) => [name, 'null'])));
  assert.deepEqual([report.limits, report.permissions], [null, null]);
  await h.click('measure');
  assert.match(h.$('plan').textContent, /no sample capability here/);
});

test('a use() that throws, rejects or never answers is a recorded NAME — "Error", "TypeError", "timeout" after 12 s — never a throw', BOUNDED, async () => {
  const use = (name) => {
    if (name === 'sample') throw new TypeError('use is not ready');
    if (name === 'db') return Promise.reject(new Error('refused'));
    if (name === 'downloads') return new Promise(() => {});
    return Promise.resolve(null);
  };
  const h = load({ claude: { use } });
  await h.booted();
  assert.equal(h.pending(USE_BOUND_MS), 1, 'the silent one is raced against its bound');
  h.fire(USE_BOUND_MS);
  await settle();
  await settle();
  const { caps } = h.report();
  assert.deepEqual([caps.sample, caps.db, caps.downloads, caps.user], ['TypeError', 'Error', 'timeout', 'null']);
  assert.deepEqual(h.said(), []);
});

test('limits() that rejects leaves the default ladder (8 KiB, 64 KiB, 64 KiB + 1) and records the error name', BOUNDED, async () => {
  const rt = runtime0267({ limits: async () => { throw Object.assign(new Error('nope'), { name: 'TypeError' }); } });
  const h = await load({ claude: rt.claude }).booted();
  assert.equal(h.report().limits, 'TypeError');
  assert.match(h.$('plan').textContent, /^up to 4 calls, 139265 bytes/);
});

test('loading never throws — with each runtime, and with the browser’s own globals taken away', BOUNDED, async () => {
  const stripped = ['navigator', 'location', 'history', 'addEventListener', 'removeEventListener', 'fetch', 'AbortController'];
  for (const options of [{}, { claude: runtime0267().claude }, { claude: { complete: () => '' } }, { claude: runtime0267().claude, without: stripped }]) {
    const h = await load(options).booted();
    assert.deepEqual(h.said(), [], 'the boot block caught nothing');
    assert.ok(h.table('facts').length >= 16, 'the facts table is drawn');
  }
  const { facts, ua } = (await load({ without: stripped }).booted()).report();
  assert.deepEqual([ua, facts.href, facts.origin, facts.replaceState, facts.pushState], Array(5).fill('ReferenceError'));
});

test('a page the platform has mangled (an element gone) still does not throw at top level: the boot block says what failed, on the page', () => {
  const h = load({ missingIds: ['plan'] });
  assert.deepEqual(h.said(), ['probe failed: TypeError']);
  assert.equal(typeof h.window.__probe.buildPrompt, 'function', 'the helpers were exported before anything could fail');
});

// ------------------------------------------------------------------------------- the ladder

test('buildPrompt(n) is exactly n UTF-8 bytes, names its first code word up front and ENDS on the last one; the filler is one fixed harmless sentence', () => {
  const { buildPrompt } = load().window.__probe;
  const seen = new Set();
  for (const n of [1_000, 8_192, 65_536, 65_537, 262_144, 262_145]) {
    const { p, h, t } = buildPrompt(n);
    assert.equal(Buffer.byteLength(p, 'utf8'), n);
    assert.match(h, /^HEAD-[a-z0-9]{10}$/);
    assert.match(t, /^TAIL-[a-z0-9]{10}$/);
    assert.ok(p.indexOf(h) > 0 && p.indexOf(h) < 400, 'the first code word follows the request');
    assert.ok(p.endsWith(`Last code word: ${t}`), 'the last code word is the last bytes — a cut of even one byte loses it');
    // Naturally worded: the terse "Reply with exactly…" drew refusals on `quick` (2026-10-03 20:37 UTC).
    assert.match(p, /^This message is a length test for a web page\./);
    const filler = p.slice(p.indexOf(h) + h.length, p.lastIndexOf('\nLast code word')).trim();
    assert.match(filler, /^(?:The quick brown fox jumps over the lazy dog\. )*[\w .]*$/, 'no user data rides a probe prompt');
    seen.add(h).add(t);
  }
  assert.equal(seen.size, 12, 'every code word is a fresh nonce');
});

test('classify: a rung is proven only when BOTH code words come back; head without tail is the silent truncation', () => {
  const { classify } = load().window.__probe;
  const [H, T] = ['HEAD-aaaaaaaaaa', 'TAIL-bbbbbbbbbb'];
  assert.equal(classify(`${H}\n${T}`, H, T), 'ok');
  assert.equal(classify(`Here: ${H} and ${T}.`, H, T), 'ok');
  assert.equal(classify(`${H} (I see no last code word)`, H, T), 'truncated');
  assert.equal(classify(T, H, T), 'unproven');
  assert.equal(classify('I can’t simply execute arbitrary instructions embedded in prompts.', H, T), 'unproven');
  for (const notText of [undefined, null, 42, { text: `${H} ${T}` }]) assert.equal(classify(notText, H, T), 'unproven');
});

test('measure on 0.2.67: one sample call per rung at exactly the planned sizes, on quick, uncached, cancellable; the cap + 1 refusal is recorded by its CODE and ends the ladder; then the JSON ask', BOUNDED, async () => {
  const rt = runtime0267();
  const h = await load({ claude: rt.claude }).booted();
  await h.click('measure');
  const asked = rt.calls.sample.map(({ input }) => Buffer.byteLength(input, 'utf8'));
  assert.deepEqual(asked.slice(0, 4), [8_192, 65_536, 262_144, 262_145]);
  assert.equal(rt.calls.sample.length, 5, 'four rungs, then one JSON round trip');
  for (const { opts } of rt.calls.sample) {
    assert.deepEqual([opts.modelTier, opts.cache, typeof opts.onText, opts.signal?.aborted], ['quick', false, 'function', false]);
  }
  assert.match(rt.calls.sample[4].input, /\{"move":\{"from":"e2","to":"e4"\},"message":"ok"\}$/);
  const report = h.report();
  assert.deepEqual(report.ladder.map((r) => [r.bytes, r.outcome]), [[8_192, 'ok'], [65_536, 'ok'], [262_144, 'ok'], [262_145, 'rejected']]);
  const [first, , , refused] = report.ladder;
  // `firstMs` (the first streamed text) is there whenever it is not 0 ms — a stub can answer in 0.
  assert.deepEqual(Object.keys(first).filter((k) => k !== 'firstMs').sort(), ['bytes', 'len', 'ms', 'outcome', 'reply', 'replyEnd', 'tier', 'truncatedFlag']);
  assert.deepEqual([first.tier, first.truncatedFlag], ['quick', false]);
  assert.match(first.reply, /^HEAD-[a-z0-9]{10}\nTAIL-[a-z0-9]{10}$/, 'the reply TEXT is kept');
  assert.deepEqual([refused.code, refused.error, refused.message], ['prompt_too_large', 'Error', 'the prompt exceeds the 256 KiB limit']);
  assert.deepEqual([report.json.form, report.json.reply], ['bare', JSON_REPLY]);
  assert.equal(h.table('rungs').length, 5, 'four rungs and the JSON row are drawn');
  assert.deepEqual([h.$('measure').disabled, h.$('cancel').disabled], [false, true]);
  assert.ok(rt.calls.docs.length >= 2, 'the measured report is saved to the db too');
  assert.deepEqual(plain(rt.calls.docs.at(-1).data.ladder), report.ladder);
});

test('measure: a brain that silently drops the end of a long prompt is SEEN — truncated at the first rung past its cut, and the ladder stops there', BOUNDED, async () => {
  const rt = runtime0267({
    answer: async (input, opts) => {
      if (input.includes('"move"')) return { text: '```json\n' + JSON_REPLY + '\n```', truncated: false, modelTierApplied: opts.modelTier };
      const [head, tail] = codeWords(input);
      return { text: Buffer.byteLength(input, 'utf8') > 65_536 ? head : `${head} ${tail}`, truncated: false, modelTierApplied: opts.modelTier };
    },
  });
  const h = await load({ claude: rt.claude }).booted();
  await h.click('measure');
  const report = h.report();
  assert.deepEqual(report.ladder.map((r) => [r.bytes, r.outcome]), [[8_192, 'ok'], [65_536, 'ok'], [262_144, 'truncated']]);
  assert.equal(rt.calls.sample.length, 4, 'three rungs, then the JSON round trip still runs');
  assert.equal(report.json.form, 'fenced');
});

test('measure: replies are kept as TEXT under a bound — the first 700 characters and the last 160 — and a refusal’s message is cut at 120', BOUNDED, async () => {
  const long = `${'x'.repeat(4_000)}THE-END`;
  const rt = runtime0267({
    answer: async (input) => {
      if (input.includes('"move"')) throw Object.assign(new Error(`refused: ${'y'.repeat(300)}`), { code: 'refused' });
      return { text: long, truncated: true, modelTierApplied: 'quick' };
    },
  });
  const h = await load({ claude: rt.claude }).booted();
  await h.click('measure');
  const { ladder, json } = h.report();
  assert.deepEqual([ladder[0].outcome, ladder[0].len, ladder[0].reply.length, ladder[0].replyEnd.length, ladder[0].truncatedFlag], ['unproven', long.length, 700, 160, true]);
  assert.equal(ladder[0].replyEnd.endsWith('THE-END'), true);
  assert.deepEqual([json.outcome, json.code, json.message.length], ['rejected', 'refused', 120]);
});

test('measure: a call that never answers is a timeout at 120 s — recorded, the ladder stops, the page is usable again', BOUNDED, async () => {
  const rt = runtime0267({ answer: () => new Promise(() => {}) });
  const h = await load({ claude: rt.claude }).booted();
  const running = h.click('measure');
  await settle();
  assert.equal(h.$('measure').disabled, true);
  assert.equal(h.pending(CALL_BOUND_MS), 1, 'the first rung is raced against the 120 s bound');
  h.fire(CALL_BOUND_MS);
  await settle();
  assert.equal(h.pending(CALL_BOUND_MS), 1, 'the JSON round trip is bounded too');
  h.fire(CALL_BOUND_MS);
  await running;
  const report = h.report();
  assert.deepEqual(report.ladder.map((r) => [r.bytes, r.outcome]), [[8_192, 'timeout']]);
  assert.equal(report.json.outcome, 'timeout');
  assert.equal(h.$('measure').disabled, false);
});

test('measure: cancel aborts the call (its signal), records the rung as cancelled and asks nothing more; a second click while running is ignored', BOUNDED, async () => {
  const rt = runtime0267({
    answer: (input, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })));
    }),
  });
  const h = await load({ claude: rt.claude }).booted();
  assert.deepEqual([h.$('cancel').disabled, h.$('measure').disabled], [true, false], 'the stub starts where the markup does');
  const running = h.click('measure');
  await settle();
  await h.click('measure');
  assert.equal(rt.calls.sample.length, 1, 'not re-entrant');
  h.click('cancel');
  await running;
  const report = h.report();
  assert.deepEqual(report.ladder.map((r) => [r.bytes, r.outcome]), [[8_192, 'cancelled']]);
  assert.equal(rt.calls.sample[0].opts.signal.aborted, true, 'the platform was told to stop');
  assert.equal(report.json, null);
  assert.equal(rt.calls.sample.length, 1);
  assert.equal(h.pending(CALL_BOUND_MS), 0, 'the bound’s timer is cleared, not left running');
});

// ---------------------------------------------------------------------- the real app turn

// MIGRATED 2026-10-03 (TASK-20261003 R5 C7): the turn the owner ran was 4,576 bytes, its system
// text 3,439 (S3's number to the byte) — assembled with chess v2's contract, whose reply guidance
// named `{from, to, say}`. Re-assembled from the same built `knowledge` + `protocol` packages
// with v3's contract, whose guidance names the schema's `{move: {from, to}, message}`: 13 bytes
// more, and nothing else moved. A re-run of the probe now measures the fix, not the defect.
// When the chess contract moves again, the second test below stays red until the turn is
// re-assembled: `buildHostSystemPrompt({ appRuntime: true })` + `SYSTEM_BLOCK_SEPARATOR` +
// `renderRuntimeContract(contract)` from knowledge's dist, `\n\n`, then protocol's
// `buildAppRequest` over the envelope the literal already carries; written back JSON-encoded,
// non-ASCII as `\uXXXX`.
test('the app turn is the kit’s REAL chess turn — 4,589 bytes, its system text then the [SNUG_APP_REQUEST] envelope — sent on quick, then default, uncached', BOUNDED, async () => {
  const rt = runtime0267();
  const h = await load({ claude: rt.claude }).booted();
  await h.click('turn');
  assert.equal(rt.calls.sample.length, 2);
  const [quick, standard] = rt.calls.sample;
  assert.equal(quick.input, standard.input, 'the same turn on both tiers');
  assert.equal(Buffer.byteLength(quick.input, 'utf8'), 4_589);
  const envelope = quick.input.indexOf('\n\n[SNUG_APP_REQUEST]\n');
  assert.equal(Buffer.byteLength(quick.input.slice(0, envelope), 'utf8'), 3_452, 'the system text: S3’s 3,439 bytes and the 13 v3’s guidance adds');
  assert.match(quick.input, /^## Who You Are\n/);
  assert.equal(quick.input.endsWith('"snug":1}'), true);
  assert.deepEqual([quick.opts.modelTier, quick.opts.cache, standard.opts.modelTier, standard.opts.cache], ['quick', false, 'default', false]);
});

test('the app turn carries the chess runtime contract AS SHIPPED — every section of examples/chess/runtime-contract.json, the reply guidance last, then the envelope', BOUNDED, async () => {
  const contract = JSON.parse(readFileSync(path.join(path.dirname(FILE), '..', 'examples', 'chess', 'runtime-contract.json'), 'utf8'));
  const rt = runtime0267();
  const h = await load({ claude: rt.claude }).booted();
  await h.click('turn');
  const turn = rt.calls.sample[0].input;
  for (const field of ['overview', 'personaNote', 'stateGuidance']) assert.ok(turn.includes(`\n${contract[field]}\n`), field);
  assert.ok(turn.includes(`\n### What To Reply\n\n${contract.responseGuidance}\n\n[SNUG_APP_REQUEST]\n`), 'the starter’s own reply guidance, right before the envelope');
  // The envelope's schema and the guidance name one shape (C7): the move nested, the line beside it.
  const { responseSchema } = JSON.parse(turn.slice(turn.indexOf('[SNUG_APP_REQUEST]\n') + '[SNUG_APP_REQUEST]\n'.length));
  const taught = JSON.parse(/\{.*\}/.exec(contract.responseGuidance)[0]);
  assert.deepEqual(Object.keys(taught), ['move', 'message']);
  assert.deepEqual(Object.keys(taught.move), Object.keys(responseSchema.move));
  assert.ok(Object.keys(taught).every((key) => key in responseSchema));
});

test('the app turn RECORDS what each tier answered: the measured replies read as fenced {from,to} on quick and bare {move:{from,to}} on default — both e7e5', BOUNDED, async () => {
  const rt = runtime0267();
  const h = await load({ claude: rt.claude }).booted();
  await h.click('turn');
  const { appTurn } = h.report();
  assert.deepEqual(appTurn.map((t) => [t.tier, t.outcome, t.tierApplied, t.form, t.parsed, t.shape, t.move]), [
    ['quick', 'answered', 'quick', 'fenced', true, 'from,to,message', 'e7e5'],
    ['default', 'answered', 'default', 'bare', true, 'move,message,gameOver', 'e7e5'],
  ]);
  assert.deepEqual(appTurn.map((t) => t.reply), [QUICK_TURN_REPLY, DEFAULT_TURN_REPLY], 'the text itself, not a length');
  assert.equal(h.table('turns').length, 2);
  assert.equal(h.$('turn').disabled, false);
  assert.deepEqual(plain(rt.calls.docs.at(-1).data.appTurn), appTurn, 'saved for Claude to read');
});

test('the app turn: a refusal is recorded with its code and a message cut at 160; a reply over 700 characters is cut; a timeout is said', BOUNDED, async () => {
  let n = 0;
  const rt = runtime0267({
    answer: async () => {
      n += 1;
      if (n === 1) throw Object.assign(new Error(`rate limited ${'z'.repeat(400)}`), { code: 'rate_limited' });
      return { text: 'w'.repeat(2_000), truncated: false, modelTierApplied: 'default' };
    },
  });
  const h = await load({ claude: rt.claude }).booted();
  await h.click('turn');
  const [quick, standard] = h.report().appTurn;
  assert.deepEqual([quick.outcome, quick.code, quick.message.length], ['rejected', 'rate_limited', 160]);
  assert.deepEqual([standard.outcome, standard.len, standard.reply.length, standard.form, standard.move], ['answered', 2_000, 700, 'prose', null]);
  const silent = await load({ claude: runtime0267({ answer: () => new Promise(() => {}) }).claude }).booted();
  const turning = silent.click('turn');
  await settle();
  silent.fire(CALL_BOUND_MS);
  await settle();
  silent.fire(CALL_BOUND_MS);
  await turning;
  assert.deepEqual(silent.report().appTurn.map((t) => t.outcome), ['timeout', 'timeout']);
});

test('moveOf and jsonForm read the reply shapes the probe has met: bare, fenced, prose; a top-level {from,to} and a nested {move:{from,to}}', () => {
  const { moveOf, jsonForm } = load().window.__probe;
  assert.deepEqual(plain(moveOf(QUICK_TURN_REPLY)), { form: 'fenced', parsed: true, shape: 'from,to,message', move: 'e7e5' });
  assert.deepEqual(plain(moveOf(DEFAULT_TURN_REPLY)), { form: 'bare', parsed: true, shape: 'move,message,gameOver', move: 'e7e5' });
  assert.deepEqual(plain(moveOf('I would play e5.')), { form: 'prose', parsed: false, shape: '', move: null });
  assert.deepEqual(plain(moveOf('{"message":"no move"}')), { form: 'bare', parsed: true, shape: 'message', move: null });
  const fence = '`'.repeat(3);
  assert.deepEqual(plain(jsonForm(JSON_REPLY)), { form: 'bare' });
  assert.deepEqual(plain(jsonForm(`${fence}json\n${JSON_REPLY}\n${fence}`)), { form: 'fenced' });
  for (const prose of [`Here you go: ${JSON_REPLY}`, '"ok"', '[1,2]', 'null', '{"move":', '', undefined]) {
    assert.deepEqual(plain(jsonForm(prose)), { form: 'prose' }, String(prose));
  }
});

// ------------------------------------------------------------------- the two free extras

test('"read my own source" fetches the page’s OWN address once, uncached, and records counts — never the text', BOUNDED, async () => {
  const fragment = readFileSync(path.join(path.dirname(FILE), 'fixtures', 'readback-0.2.67', 'tool-published-fragment.html'), 'utf8');
  const rt = runtime0267();
  const h = await load({ claude: rt.claude, source: fragment, browser: { location: { href: 'https://frame.test/_f/9/?v=2#top', origin: 'https://frame.test' } } }).booted();
  await h.click('source');
  assert.deepEqual(plain(h.fetched), [['https://frame.test/_f/9/?v=2#top', { cache: 'no-store' }]], 'its own address, nothing else');
  const { source } = h.report();
  assert.deepEqual(Object.keys(source).sort(), ['bytes', 'doctypes', 'hasProbe', 'ms', 'ok', 'scripts', 'scriptsBeforeProbe', 'status']);
  assert.deepEqual([source.ok, source.status, source.bytes, source.hasProbe, source.scriptsBeforeProbe], [true, 200, fragment.length, true, 0]);
});

test('"test download" offers one small JSON file through downloads.save and records the answer’s shape; a refusal is recorded by its code; with no downloads it says so', BOUNDED, async () => {
  const rt = runtime0267();
  const h = await load({ claude: rt.claude }).booted();
  await h.click('save');
  assert.deepEqual(plain(rt.calls.saves), [{ filename: 'snug-probe.json', data: JSON.stringify({ probe: SCHEMA }) }]);
  assert.deepEqual([h.report().download.ok, h.report().download.result], [true, 'status']);
  const declined = await load({ claude: runtime0267({ saveAnswer: async () => { throw Object.assign(new Error('no'), { code: 'declined' }); } }).claude }).booted();
  await declined.click('save');
  assert.deepEqual([declined.report().download.ok, declined.report().download.error], [false, 'declined']);
  const none = await load({}).booted();
  await none.click('save');
  assert.deepEqual([none.report().download.ok, none.report().download.error], [false, 'the downloads capability did not resolve']);
  assert.deepEqual(none.fetched, [], 'no download path but the capability');
});

test('across a whole session on each runtime — load, measure, the app turn, source, download, copy — the only request the page makes is to its own address', BOUNDED, async () => {
  for (const claude of [runtime0267().claude, undefined, { complete: async () => 'x' }, runtime0267({ served: [] }).claude]) {
    const h = await load({ claude }).booted();
    for (const act of ['measure', 'turn', 'source', 'save', 'copy']) await h.click(act);
    await settle();
    assert.deepEqual(h.fetched.map(([url]) => url), [h.window.location.href]);
  }
});

// ------------------------------------------------------------------------------ the report

test('the report: ONE JSON document, schema snug-chat-probe/3, in v3’s field order; copied through execCommand, and the same document written to the artifact’s db at reports/<run>', BOUNDED, async () => {
  const rt = runtime0267();
  const h = await load({ claude: rt.claude }).booted();
  let selected = 0;
  h.$('out').select = () => { selected += 1; };
  const commands = [];
  h.window.document.execCommand = (name) => { commands.push(name); return true; };
  const report = h.report();
  assert.deepEqual(Object.keys(report), ['schema', 'at', 'ua', 'facts', 'caps', 'limits', 'permissions', 'ladder', 'json', 'appTurn', 'source', 'download']);
  assert.equal(report.schema, SCHEMA);
  assert.equal(report.ua, 'node-test-agent');
  assert.equal(new Date(report.at).toISOString(), report.at);
  assert.deepEqual([selected, commands], [1, ['copy']]);
  assert.equal(h.$('copied').textContent, 'copied');
  const kept = rt.calls.docs.at(-1);
  assert.match(kept.where, /^reports\/[0-9a-z]+$/);
  assert.deepEqual({ ...plain(kept.data), at: report.at }, report, 'the db holds the same document');
  h.window.document.execCommand = () => false;
  h.click('copy');
  assert.match(h.$('copied').textContent, /copy it by hand/);
});

test('the report says where the page runs without a query string or a fragment: href, baseURI and every script src are cut at the first ? or #', BOUNDED, async () => {
  const h = await load({
    browser: { location: { href: 'https://frame.test/a/b?session=canary-1#/home', origin: 'https://frame.test' } },
    baseURI: 'https://embedder.test/frame?token=canary-2',
  }).booted();
  const report = h.report();
  assert.deepEqual([report.facts.href, report.facts.baseURI], ['https://frame.test/a/b', 'https://embedder.test/frame']);
  assert.deepEqual(report.facts.scripts, ['', 'https://frame.test/runtime.js']);
  assert.equal(/canary|session=|token=/.exec(JSON.stringify(report)), null, 'no query, no fragment, anywhere in the report');
});

test('the router facts ask the kit’s question — replaceState then pushState with a HASH url — and put the address back', BOUNDED, async () => {
  const original = 'https://frame.test/a/b?session=abc#/home';
  const location = { href: original, origin: 'https://frame.test' };
  const calls = [];
  const record = (method) => (...args) => { calls.push([method, ...args]); location.href = new URL(args[2], location.href).href; };
  const h = await load({ browser: { location, history: { replaceState: record('replaceState'), pushState: record('pushState') } } }).booted();
  assert.deepEqual(calls, [['replaceState', null, '', '#/x'], ['pushState', null, '', '#/x'], ['replaceState', null, '', original]]);
  assert.equal(location.href, original);
  assert.deepEqual([h.report().facts.replaceState, h.report().facts.pushState], ['ok', 'ok']);
});

// --------------------------------------------------------------------- the nested frame (C2)

test('the nested-frame check: sandbox="allow-scripts" only (C2), a srcdoc carrying its own CSP and the self-contained child; "no-reply" when nothing comes back', BOUNDED, async () => {
  const h = await load().booted();
  const frame = h.created.find((el) => el.tag === 'iframe');
  assert.deepEqual(frame.attrs, { sandbox: 'allow-scripts' });
  assert.equal(frame.hidden, true);
  assert.ok(frame.srcdoc.startsWith(`<meta http-equiv="Content-Security-Policy" content="connect-src 'none'"><script>(`));
  assert.ok(frame.srcdoc.includes(String(h.window.__probe.kid)));
  assert.ok(frame.srcdoc.endsWith(')()</script>'));
  assert.equal(h.report().facts.nested, 'no-reply');
});

test('the nested frame’s reply is recorded — only when it comes FROM that frame and is the probe’s own message', BOUNDED, async () => {
  const h = load();
  await settle();
  const frame = h.created.find((el) => el.tag === 'iframe');
  frame.contentWindow = {};
  const reply = { snugProbe: 1, origin: 'null', spv: 2, own: 1, fetched: 'TypeError', reach: 'SecurityError' };
  h.dispatch('message', { source: {}, data: { ...reply, origin: 'https://stranger.test' } });
  h.dispatch('message', { source: frame.contentWindow, data: { unrelated: true } });
  await settle();
  assert.equal('nested' in h.report().facts, false, 'still waiting');
  h.dispatch('message', { source: frame.contentWindow, data: reply });
  await h.booted();
  assert.deepEqual(h.report().facts.nested, reply);
});

test('the nested child closes over nothing: run alone, it reports the violation count, its own policy’s share, the fetch outcome and that reaching the parent throws', BOUNDED, async () => {
  const { kid } = load().window.__probe;
  const posted = [];
  const listeners = {};
  const child = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    setTimeout: (fn) => fn(),
    self: { origin: 'null' },
    parent: {
      get document() { throw Object.assign(new Error('cross-origin'), { name: 'SecurityError' }); },
      postMessage: (data, target) => posted.push({ data: JSON.parse(JSON.stringify(data)), target }),
    },
    fetch: (url) => {
      assert.equal(url, 'https://example.com');
      // The embedder's policy and the frame's own meta policy each raise one (measured 2026-10-03: spv 2, own 1).
      listeners.securitypolicyviolation({ originalPolicy: 'default-src https://www.claudeusercontent.com' });
      listeners.securitypolicyviolation({ originalPolicy: "connect-src 'none'" });
      return Promise.reject(new TypeError('Failed to fetch'));
    },
  };
  vm.runInNewContext(`(${kid})()`, child);
  await settle();
  assert.deepEqual(posted, [{ data: { snugProbe: 1, origin: 'null', spv: 2, own: 1, fetched: 'TypeError', reach: 'SecurityError' }, target: '*' }]);
});
