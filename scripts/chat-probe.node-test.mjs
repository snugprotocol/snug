// chat-probe — TASK-20261003-host-bindings-complete A0. `scripts/chat-probe.html` is the page a
// person pastes into a claude.ai chat ("make this exact HTML an artifact") to measure the one
// runtime nobody has measured where it matters: what `window.claude.complete` does over prompt
// size, `window.storage` before and after publish, the router facts, the nested frame's CSP
// signal (T1's S1/S2/S10 measured the rest — `git show 65a009f^:docs/tasks/active/TASK-20260905-host-bindings-spikes.md`).
//
// What these pins are for:
//   - every `complete` call bills the viewer, so NOTHING may reach it at load — proven twice,
//     structurally (the one call site sits in a function only the measure click starts) and
//     under a spy in a stub window;
//   - the page is retyped by a model, so it stays small, ASCII, one inline script, and has no
//     way to phone home: one URL in the whole file and one network call site in the whole script,
//     both the nested frame's deliberately blocked fetch — no other request API is so much as named;
//   - a rung is PROVEN only when the reply carries BOTH nonces — a head-only reply is the silent
//     truncation the ladder exists to see;
//   - the report is pasted into a chat, so it carries where the page runs without a query string
//     or a fragment, and never a stored value;
//   - a fact that can only ever read "refused" proves nothing about the probe, so every sandbox
//     hint is also run in a browser where it WORKS.
// The page itself carries no comments (they are bytes a model must retype): the WHY lives here.
// Named `*.node-test.mjs` like the other plain-node suites; run by `pnpm run check-host-kit`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'chat-probe.html');
/**
 * The paste budget: a model retypes this page, so every byte is one it can get wrong. The brief's
 * target is about 9 KB and the page is not there yet. It carries no comment (the WHY is in this
 * file); what is left is what the brief asks for plus three additions the walk needs — the
 * ancestors, the run mark that makes "after publish" readable, and the nested frame's OWN-policy
 * violation count (T1's S1-chat record: `RUNNER_CSP` enforcement inside the chat nested child was
 * "not measured"). A change that needs bytes takes them from the page: this bound only moves down.
 */
const MAX_BYTES = 10_000;
/** A page promise that never settles must fail its test, not hang the gate. */
const BOUNDED = { timeout: 10_000 };
// "KB" is decimal on purpose: 64 KB (64,000) and "65,536 B exactly" are two different rungs, and
// the pair 65,536 / 65,537 brackets the cap the kit ASSUMES (ADR-0072 §5) by a single byte.
const LADDER = [8_000, 32_000, 64_000, 65_536, 65_537, 96_000, 128_000, 256_000, 512_000, 1_000_000];
const CALL_BOUND_MS = 120_000;
const JSON_REPLY = '{"move":{"from":"e2","to":"e4"},"message":"ok"}';
const NESTED_FETCH = "fetch('https://example.com')";

const page = () => readFileSync(FILE, 'utf8');

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

const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Run the page's script in a stub window: just enough DOM for the page to draw its tables, fake
 * timers the test fires by hand (so a 120 s bound costs nothing), and whichever chat globals the
 * test supplies (`without` takes a browser global away; `missingIds` an element). The default is
 * the chat frame as T1 measured it — `about:srcdoc`, an opaque origin, a History API that refuses,
 * no storage, no popup, a form that never submits; `browser` puts any global in its place,
 * `baseURI` the document's, and `submits` is a frame that has `allow-forms`. Nothing here is a
 * browser — the real readings are the owner's walk.
 */
function load({ complete, storage, browser = {}, baseURI = 'about:srcdoc', submits = false, without = [], missingIds = [], body = splitPage(page()).body } = {}) {
  const timers = [];
  const created = [];
  const listeners = [];
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
      // Without `allow-forms` the submit event never fires; with it, the handler runs.
      requestSubmit() { if (submits) el.onsubmit({ preventDefault() { el.prevented += 1; } }); },
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
  const refuse = () => { throw Object.assign(new Error('refused at an opaque origin'), { name: 'SecurityError' }); };
  const window = {
    document: {
      getElementById: $,
      createElement: element,
      body: element('body'),
      // One inline script and one the viewer injected, whose query string must not reach the report.
      scripts: [{ src: '' }, { src: 'https://viewer.test/runtime.js?session=abc' }],
      baseURI,
      compatMode: 'CSS1Compat',
      title: '',
      execCommand: () => true,
    },
    navigator: { userAgent: 'node-test-agent' },
    location: { href: 'about:srcdoc', origin: 'null' },
    history: { replaceState: refuse, pushState: refuse },
    setTimeout: (fn, ms, ...args) => timers.push({ fn, ms, args }),
    clearTimeout: (id) => { timers[id - 1] = undefined; },
    addEventListener: (type, fn) => { listeners.push({ type, fn }); },
    removeEventListener() {},
    performance,
  };
  if (complete) window.claude = { complete };
  if (storage) window.storage = storage;
  Object.assign(window, browser);
  for (const name of without) delete window[name];
  window.window = window;
  window.self = window;
  vm.createContext(window);
  new vm.Script(body, { filename: 'chat-probe.html' }).runInContext(window);
  return {
    window,
    created,
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
  };
}

/** A brain that answers the way the ladder asks: both markers back; the JSON ask gets bare JSON. */
const markers = (prompt) => [/HEAD-\w+/.exec(prompt)?.[0], /TAIL-\w+/.exec(prompt)?.[0]];
const echo = (prompt) => (prompt.includes('"move"') ? JSON_REPLY : markers(prompt).join(' '));
function spy(answer = echo) {
  const calls = [];
  return { calls, complete: (prompt) => { calls.push(prompt); return answer(prompt); } };
}

/**
 * `window.storage` as S10 measured it: typed envelopes (`set` echoes key + value; `list` carries
 * `keys`, `prefix`, `shared`), and `get` of a missing key THROWS with a generic message. The
 * `delete` envelope is not in the S10 record — this shape is a stand-in the page never reads.
 */
function fakeStorage() {
  const kept = new Map();
  return {
    kept,
    api: {
      async set(key, value) { kept.set(key, value); return { key, value, shared: false }; },
      async get(key) {
        if (!kept.has(key)) throw new Error('Storage get failed: Unexpected response type');
        return { key, value: kept.get(key), shared: false };
      },
      async delete(key) { kept.delete(key); return { key, deleted: true, shared: false }; },
      async list() { return { keys: [...kept.keys()], prefix: '', shared: false }; },
    },
  };
}

test('the page is small enough to paste, and plain ASCII (a retyped page must not depend on an encoding)', () => {
  const bytes = readFileSync(FILE);
  assert.ok(bytes.length < MAX_BYTES, `${bytes.length} bytes — the paste budget is ${MAX_BYTES}`);
  assert.equal(/[^\t\n\x20-\x7e]/.exec(bytes.toString('utf8')), null);
});

test('one inline classic <script>, no <script src>, no <link>, nothing loaded from anywhere', () => {
  const { openTag, body, rest } = splitPage(page());
  assert.equal(openTag, '<script>', 'no src, no type: one classic inline script');
  assert.equal(/<script\b/i.test(rest), false, 'exactly one <script> element');
  assert.equal(/<link\b/i.test(page()), false, 'no <link>');
  assert.equal(/\b(?:src|href|action)\s*=/i.test(rest), false, 'the markup references nothing');
  assert.equal(/@import|url\(/i.test(rest), false, 'the style references nothing');
  // Script data: an unclosed `<!--` followed by `<script` would swallow the real closing tag.
  assert.equal(body.includes('<!--'), false);
});

test('the only URL in the file is https://example.com, inside the nested-frame probe', () => {
  assert.deepEqual(page().match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'`)<>]*/gi), ['https://example.com']);
  const { kid } = load().window.__probe;
  assert.ok(String(kid).includes(NESTED_FETCH), 'the URL is the nested frame’s blocked-fetch target');
  // At `about:srcdoc` a `//host/…` reference resolves against the EMBEDDER's https base: a real
  // external request the scheme-qualified search above cannot see, in a string, in markup written
  // by the script, anywhere. The page has no line comments, so it has ONE `//`: the URL's own.
  assert.deepEqual(page().match(/.{0,6}\/\/[^\s'"`]*/g), ['https://example.com'], 'no protocol-relative reference');
});

test('one network call site in the whole script — the nested frame’s blocked fetch — and no other request API is so much as named', () => {
  const { body } = splitPage(page());
  // Counted in the raw text, strings included: `window['fetch']` and `const f = fetch` are a second naming.
  assert.equal(body.match(/\bfetch\b/g).length, 1, 'fetch is named exactly once');
  assert.deepEqual(holding(statements(codeOnly(body)), /\bfetch\s*\(/), ['kid'], 'and that one naming is a call inside the nested-frame child');
  assert.equal(/XMLHttpRequest|sendBeacon|WebSocket|EventSource|\bimport\b|\bImage\b|Worker\b/.exec(body), null, 'no XHR, beacon, socket, event stream, dynamic import, image or worker');
  // An element is the other way to make a request (img, script, link): the page creates only these two.
  assert.deepEqual(body.match(/createElement\([^)]*\)/g), ["createElement('form')", "createElement('iframe')"]);
});

test('the script parses as a classic ES2020 script wrapped in one IIFE (no global it could collide with)', () => {
  const { body } = splitPage(page());
  assert.doesNotThrow(() => new vm.Script(body));
  const code = codeOnly(body);
  assert.match(code.trim(), /^\(\(\) => \{[\s\S]*\}\)\(\);$/);
  assert.equal(/\?\?=|\|\|=|&&=/.test(code), false, 'no ES2021 logical assignment');
});

test('loading never throws — with the chat globals, with none of them, and with the browser’s own globals taken away', BOUNDED, async () => {
  const stripped = ['navigator', 'location', 'history', 'performance', 'addEventListener', 'removeEventListener'];
  for (const globals of [{}, { complete: spy().complete, storage: fakeStorage().api }, { without: stripped }]) {
    const h = load(globals);
    await settle();
    assert.deepEqual(h.said(), [], 'the boot block caught nothing');
    assert.deepEqual([...h.window.__probe.LADDER], LADDER);
    assert.ok(h.table('facts').length >= 16, 'the facts table is drawn before anything is awaited');
  }
  const { facts, ua } = load({ without: stripped }).report();
  assert.deepEqual([ua, facts.href, facts.origin, facts.replaceState, facts.pushState], Array(5).fill('ReferenceError'));
});

test('a page the viewer has mangled (an element gone) still does not throw at top level: the boot block says what failed, on the page', () => {
  const h = load({ missingIds: ['plan'] });
  assert.deepEqual(h.said(), ['probe failed: TypeError']);
  assert.deepEqual([...h.window.__probe.LADDER], LADDER, 'the helpers were exported before anything could fail');
});

test('the ladder is exactly the ten sizes', () => {
  const { LADDER: sizes } = load().window.__probe;
  assert.deepEqual([...sizes], LADDER);
  assert.equal(sizes.length, 10);
});

test('buildPrompt(n) is exactly n UTF-8 bytes, opens with the instruction and the head nonce, and ENDS on the tail nonce', () => {
  const { buildPrompt } = load().window.__probe;
  const seen = new Set();
  for (const n of [1_000, ...LADDER]) {
    const { p, h, t } = buildPrompt(n);
    assert.equal(Buffer.byteLength(p, 'utf8'), n);
    assert.match(h, /^HEAD-[a-z0-9]{10}$/);
    assert.match(t, /^TAIL-[a-z0-9]{10}$/);
    assert.ok(p.indexOf(h) > 0 && p.indexOf(h) < 400, 'the head marker follows the instruction');
    assert.ok(p.endsWith(t), 'the tail marker is the last bytes — a cut of even one byte loses it');
    assert.match(p.slice(0, p.indexOf(h)), /^Reply with exactly the two markers/);
    seen.add(h).add(t);
  }
  assert.equal(seen.size, 22, 'every marker is a fresh nonce');
});

test('the filler is one fixed harmless sentence — no user data rides a probe prompt', () => {
  const { buildPrompt } = load().window.__probe;
  const { p, h, t } = buildPrompt(8_000);
  const filler = p.slice(p.indexOf(h) + h.length, p.lastIndexOf(t)).trim();
  assert.match(filler, /^(?:The quick brown fox jumps over the lazy dog\. )+[\w .]*$/);
});

test('classify: a rung is proven only when BOTH nonces come back; head without tail is the silent truncation', () => {
  const { classify } = load().window.__probe;
  assert.equal(classify('HEAD-aaaaaaaaaa TAIL-bbbbbbbbbb', 'HEAD-aaaaaaaaaa', 'TAIL-bbbbbbbbbb'), 'ok');
  assert.equal(classify('Here: HEAD-aaaaaaaaaa\nTAIL-bbbbbbbbbb.', 'HEAD-aaaaaaaaaa', 'TAIL-bbbbbbbbbb'), 'ok');
  assert.equal(classify('HEAD-aaaaaaaaaa (I see no TAIL- marker)', 'HEAD-aaaaaaaaaa', 'TAIL-bbbbbbbbbb'), 'truncated');
  assert.equal(classify('TAIL-bbbbbbbbbb', 'HEAD-aaaaaaaaaa', 'TAIL-bbbbbbbbbb'), 'unproven');
  assert.equal(classify('I cannot help with that.', 'HEAD-aaaaaaaaaa', 'TAIL-bbbbbbbbbb'), 'unproven');
  for (const notText of [undefined, null, 42, { text: 'HEAD-aaaaaaaaaa TAIL-bbbbbbbbbb' }]) {
    assert.equal(classify(notText, 'HEAD-aaaaaaaaaa', 'TAIL-bbbbbbbbbb'), 'unproven');
  }
});

test('jsonForm: a reply is bare JSON, a fenced block, or prose — only a JSON OBJECT counts as either of the first two', () => {
  const { jsonForm } = load().window.__probe;
  const fence = '`'.repeat(3);
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(jsonForm(JSON_REPLY)), { form: 'bare' });
  assert.deepEqual(plain(jsonForm(`  ${JSON_REPLY}\n`)), { form: 'bare' });
  assert.deepEqual(plain(jsonForm('{"from":"e2","to":"e4","say":"ok"}')), { form: 'bare' }, 'the form is the question, not which object came back');
  assert.deepEqual(plain(jsonForm(`${fence}json\n${JSON_REPLY}\n${fence}`)), { form: 'fenced' });
  assert.deepEqual(plain(jsonForm(`${fence}\n${JSON_REPLY}\n${fence}`)), { form: 'fenced' });
  for (const prose of [`Here you go: ${JSON_REPLY}`, `${fence}json\n${JSON_REPLY}\n${fence}\nYour move.`, '"ok"', '[1,2]', 'null', `${fence}\n"ok"\n${fence}`, '{"move":', '', undefined, { move: {} }]) {
    assert.deepEqual(plain(jsonForm(prose)), { form: 'prose' }, String(prose));
  }
});

test('structural: the one `complete(` call site is inside `ask`, `ask` is called only by `measure`, and `measure` is only ever handed to the click wiring', () => {
  const chunks = statements(codeOnly(splitPage(page()).body));
  assert.deepEqual(holding(chunks, /\bcomplete\s*\(/), ['ask'], 'no statement that runs at load calls complete');
  assert.deepEqual(holding(chunks, /\bask\b/).sort(), ['ask', 'measure']);
  assert.deepEqual(holding(chunks, /\bmeasure\b/).sort(), ['(load)', 'measure']);
  const load_ = chunks.get('(load)');
  assert.equal(/\b(?:complete|ask|claude)\b/.test(load_), false);
  assert.deepEqual(load_.match(/\S.{0,15}\bmeasure\b.{0,2}/g), ["on('       ', measure);"], 'measure is passed, never called');
  assert.equal(/\bmeasure\s*\(/.test([...chunks.values()].join('')), false);
  assert.match(chunks.get('on'), /\.onclick = /);
});

test('under a spy: nothing calls complete at load, after the load-time timers, or from the storage and copy buttons', BOUNDED, async () => {
  const brain = spy();
  const h = load({ complete: brain.complete, storage: fakeStorage().api });
  await settle();
  h.fire(3_000);
  h.fire(5_000);
  await settle();
  assert.equal(brain.calls.length, 0, 'load is free');
  await h.click('store');
  h.click('copy');
  await settle();
  assert.equal(brain.calls.length, 0, 'only the measure button spends usage');
  await h.click('measure');
  assert.ok(brain.calls.length > 0, 'the spy is wired: the measure click does reach it');
});

test('measure: the plan is on the page BEFORE the click, and an echoing brain proves all ten rungs at exactly the planned sizes, then one JSON round trip', BOUNDED, async () => {
  const brain = spy();
  const h = load({ complete: brain.complete });
  const plan = h.$('plan').textContent;
  assert.equal(brain.calls.length, 0);
  await h.click('measure');
  assert.deepEqual(brain.calls.slice(0, 10).map((p) => Buffer.byteLength(p, 'utf8')), LADDER);
  assert.equal(brain.calls.length, 11);
  assert.match(brain.calls[10], /\{"move":\{"from":"e2","to":"e4"\},"message":"ok"\}$/);
  const total = brain.calls.reduce((sum, p) => sum + Buffer.byteLength(p, 'utf8'), 0);
  assert.ok(plan.includes('up to 11 calls'), plan);
  assert.ok(plan.includes(`${total.toLocaleString('en-US')} bytes`), plan);
  assert.equal(total, 2_227_167);
  assert.ok(plan.includes('about 495k tokens'), 'the cost is said in tokens too, as an estimate');
  const report = h.report();
  assert.deepEqual(report.ladder.map((r) => [r.bytes, r.outcome]), LADDER.map((n) => [n, 'ok']));
  for (const rung of report.ladder) {
    assert.deepEqual(Object.keys(rung).sort(), ['bytes', 'len', 'ms', 'outcome']);
    assert.equal(typeof rung.ms, 'number');
  }
  assert.deepEqual(Object.keys(report.json).sort(), ['form', 'len', 'ms']);
  assert.deepEqual({ form: report.json.form, len: report.json.len }, { form: 'bare', len: JSON_REPLY.length });
  assert.equal(typeof report.json.ms, 'number');
  assert.equal(h.table('rungs').length, 11, 'ten rungs and the JSON row are drawn');
  assert.equal(h.$('measure').disabled, false);
  assert.equal(h.$('cancel').disabled, true);
});

test('measure: a brain that silently drops the end of a long prompt is SEEN — truncated at the first rung past its cut, and the ladder stops there', BOUNDED, async () => {
  const brain = spy((prompt) => {
    if (prompt.includes('"move"')) return `${'`'.repeat(3)}json\n${JSON_REPLY}\n${'`'.repeat(3)}`;
    const [head, tail] = markers(prompt);
    return Buffer.byteLength(prompt, 'utf8') > 65_536 ? `${head}` : `${head} ${tail}`;
  });
  const h = load({ complete: brain.complete });
  await h.click('measure');
  const report = h.report();
  assert.deepEqual(report.ladder.map((r) => [r.bytes, r.outcome]), [[8_000, 'ok'], [32_000, 'ok'], [64_000, 'ok'], [65_536, 'ok'], [65_537, 'truncated']]);
  assert.equal(brain.calls.length, 6, 'five rungs, then the JSON round trip still runs');
  assert.equal(report.json.form, 'fenced');
});

test('measure: a rejection is recorded by name with the first 120 characters of its message, and stops the ladder', BOUNDED, async () => {
  const tooLarge = Object.assign(new Error(`prompt too large: ${'x'.repeat(300)}`), { name: 'PromptTooLargeError' });
  const brain = spy((prompt) => (Buffer.byteLength(prompt, 'utf8') > 32_000 ? Promise.reject(tooLarge) : echo(prompt)));
  const h = load({ complete: brain.complete });
  await h.click('measure');
  const { ladder } = h.report();
  assert.deepEqual(ladder.map((r) => r.outcome), ['ok', 'ok', 'rejected']);
  assert.equal(ladder[2].bytes, 64_000);
  assert.equal(ladder[2].error, 'PromptTooLargeError');
  assert.equal(ladder[2].message, tooLarge.message.slice(0, 120));
  assert.equal(ladder[2].message.length, 120);
});

test('measure: a rejection that is not an Error (a string, undefined) and a non-string reply are recorded, never thrown', BOUNDED, async () => {
  const replies = [() => Promise.reject('quota'), () => ({ text: 'HEAD TAIL' })];
  for (const answer of replies) {
    const brain = spy((prompt) => (prompt.includes('"move"') ? undefined : answer()));
    const h = load({ complete: brain.complete });
    await h.click('measure');
    const report = h.report();
    assert.equal(report.ladder.length, 1);
    assert.match(report.ladder[0].outcome, /^(?:rejected|unproven)$/);
    assert.equal(report.json.form, 'prose');
  }
});

test('measure: a call that never answers is a timeout at 120 s — recorded, the ladder stops, the page is usable again', BOUNDED, async () => {
  const brain = spy(() => new Promise(() => {}));
  const h = load({ complete: brain.complete });
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
  assert.deepEqual(report.ladder.map((r) => [r.bytes, r.outcome]), [[8_000, 'timeout']]);
  assert.equal(report.json.outcome, 'timeout');
  assert.equal(brain.calls.length, 2);
  assert.equal(h.$('measure').disabled, false);
});

test('measure: cancel ends the wait at once, records the rung as cancelled and makes no further call; a second click while running is ignored', BOUNDED, async () => {
  const brain = spy(() => new Promise(() => {}));
  const h = load({ complete: brain.complete });
  assert.match(page(), /<button id="cancel" disabled>/, 'cancel starts disabled in the markup');
  assert.deepEqual([h.$('cancel').disabled, h.$('measure').disabled], [true, false], 'and the stub starts where the markup does');
  const running = h.click('measure');
  await settle();
  await h.click('measure');
  assert.equal(brain.calls.length, 1, 'not re-entrant');
  assert.equal(h.$('cancel').disabled, false);
  h.click('cancel');
  await running;
  const report = h.report();
  assert.deepEqual(report.ladder.map((r) => [r.bytes, r.outcome]), [[8_000, 'cancelled']]);
  assert.equal(report.json, null);
  assert.equal(brain.calls.length, 1);
  assert.equal(h.pending(CALL_BOUND_MS), 0, 'the bound’s timer is cleared, not left running');
});

test('measure without window.claude: says so, calls nothing, throws nothing', BOUNDED, async () => {
  const h = load();
  await h.click('measure');
  assert.match(h.$('plan').textContent, /no window\.claude\.complete here/);
  assert.deepEqual(h.report().ladder, []);
  assert.equal(h.$('measure').disabled, false);
});

test('storage: set → get → delete on a small key and on a 200 KB value, the missing-key read, list() — each timed, recorded as booleans, counts and error text; never a stored value', BOUNDED, async () => {
  const store = fakeStorage();
  const h = load({ storage: store.api });
  await h.click('store');
  const first = h.report().storage[0];
  assert.deepEqual(Object.keys(first), ['at', 'set', 'get', 'delete', 'set200k', 'get200k', 'delete200k', 'earlierRuns', 'markRun', 'list']);
  assert.equal(new Date(first.at).toISOString(), first.at);
  for (const step of Object.values(first).slice(1)) assert.equal(typeof step.ms, 'number');
  assert.deepEqual([first.set.ok, first.get.ok, first.get.same, first.delete.ok], [true, true, true, true]);
  assert.equal(first.set.shape, 'key,value,shared', 'the envelope’s field names, not its contents');
  assert.deepEqual([first.set200k.ok, first.get200k.ok, first.get200k.same, first.delete200k.ok], [true, true, true, true]);
  // S10: `get` of a missing key THROWS. The first press reads a mark nobody has written yet.
  assert.deepEqual([first.earlierRuns.ok, first.earlierRuns.error], [false, 'Storage get failed: Unexpected response type']);
  assert.equal(first.markRun.ok, true);
  assert.deepEqual([first.list.ok, first.list.count, first.list.shape], [true, 1, 'keys,prefix,shared'], 'a count, never the key names');
  assert.deepEqual([...store.kept.keys()], ['snug-probe-runs'], 'only the run mark is left behind');
  await h.click('store');
  const report = h.report();
  assert.equal(report.storage.length, 2);
  assert.deepEqual([report.storage[1].earlierRuns.ok, report.storage[1].earlierRuns.count], [true, 1], 'the second press sees the first one’s mark — what “after publish” is read against');
  assert.equal(store.kept.get('snug-probe-runs'), '2');
  assert.ok(JSON.stringify(report).length < 8_000, 'the 200 KB value is not in the report');
  assert.equal(JSON.stringify(report.storage).includes('snug-probe'), false, 'nor any storage key');
  assert.equal(h.table('stores').length, 10);
  assert.equal(h.$('store').disabled, false);
});

test('storage absent or refusing: every step is a recorded failure with its text, not a throw', BOUNDED, async () => {
  const absent = load();
  await absent.click('store');
  const run = absent.report().storage[0];
  for (const [label, step] of Object.entries(run).slice(1)) {
    assert.equal(step.ok, false, label);
    assert.equal(typeof step.error, 'string', label);
    assert.ok(step.error.length <= 120, label);
  }
  const refusing = load({ storage: { set: async () => { throw new Error(`not published: ${'y'.repeat(300)}`); }, get: () => new Promise(() => {}), delete: async () => {}, list: async () => ({}) } });
  const pressed = refusing.click('store');
  for (let i = 0; i < 4; i += 1) { await settle(); refusing.fire(30_000); }
  await pressed;
  const second = refusing.report().storage[0];
  assert.equal(second.set.error.length, 120);
  assert.deepEqual([second.get.ok, second.get.error], [false, 'no answer in 30 s']);
  assert.equal(second.delete.ok, true);
});

test('storage: "no answer in 30 s" is said only when the 30 s bound is what ended the wait — a rejection that carries no text is a rejection, recorded with the text it has', BOUNDED, async () => {
  const wordless = load({ storage: { set: () => Promise.reject(''), get: () => Promise.reject(new Error('')), delete: async () => {}, list: async () => [] } });
  await wordless.click('store');
  const run = wordless.report().storage[0];
  assert.deepEqual([run.set.ok, run.set.error], [false, ''], 'an empty reason stays empty — it is not a timeout');
  assert.deepEqual([run.get.ok, run.get.error], [false, 'Error']);
  assert.equal(JSON.stringify(run).includes('no answer'), false, 'no bound fired, so no step says one did');
  assert.equal(wordless.pending(30_000), 0);
  // The other way round: a step that resolves to nothing at all is a success, not a timeout.
  assert.deepEqual([run.delete.ok, run.delete.shape], [true, 'undefined']);
});

test('runtime facts are read on load, each guarded — a refusal is recorded by its error NAME', BOUNDED, async () => {
  const h = load({ complete: spy().complete, storage: fakeStorage().api });
  await settle();
  const { facts } = h.report();
  assert.equal(facts.href, 'about:srcdoc');
  assert.equal(facts.origin, 'null');
  assert.equal(facts.baseURI, 'about:srcdoc');
  assert.equal(facts.compatMode, 'CSS1Compat');
  assert.deepEqual(facts.claude, { complete: 'function' });
  assert.deepEqual(facts.storage, { set: 'function', get: 'function', delete: 'function', list: 'function' });
  assert.deepEqual(facts.scripts, ['', 'https://viewer.test/runtime.js'], 'one entry per script: empty for inline, the src without its query otherwise');
  // The router facts (K3): the stub refuses both, as an opaque origin is expected to.
  assert.deepEqual([facts.replaceState, facts.pushState], ['SecurityError', 'SecurityError']);
  // Globals this stub does not have at all: a name, never a throw.
  for (const key of ['isSecureContext', 'cryptoSubtle', 'popup', 'localStorage', 'sessionStorage', 'indexedDB', 'ancestors']) {
    assert.match(facts[key], /^(?:Reference|Type)Error$/, key);
  }
  assert.equal(facts.form, 'blocked', 'requestSubmit fired no submit event');
  const bare = load();
  await settle();
  assert.deepEqual([bare.report().facts.claude, bare.report().facts.storage], ['undefined', 'undefined']);
});

test('the router probe asks the kit’s question (K3): replaceState(null, "", "#/x") then pushState, both with a HASH url; "ok" when the History API takes them; and the address is put back', BOUNDED, async () => {
  const original = 'https://artifact.test/a/b?session=abc#/home';
  // A History API that works, and moves the address the way a browser does.
  const working = () => {
    const location = { href: original, origin: 'https://artifact.test' };
    const calls = [];
    const record = (method) => (...args) => { calls.push([method, ...args]); location.href = new URL(args[2], location.href).href; };
    return { location, calls, history: { replaceState: record('replaceState'), pushState: record('pushState') } };
  };
  const top = working();
  const h = load({ browser: { location: top.location, history: top.history } });
  await settle();
  assert.deepEqual(top.calls, [
    ['replaceState', null, '', '#/x'],
    ['pushState', null, '', '#/x'],
    // The WHOLE original address — query and fragment — not the trimmed one the report carries.
    ['replaceState', null, '', original],
  ]);
  assert.equal(top.location.href, original, 'the probe leaves the address as it found it');
  const { facts } = h.report();
  assert.deepEqual([facts.replaceState, facts.pushState], ['ok', 'ok']);

  // Each call is its own fact: a browser that takes one and refuses the other says so.
  const half = working();
  half.history.pushState = () => { throw Object.assign(new Error('refused'), { name: 'SecurityError' }); };
  const g = load({ browser: { location: half.location, history: half.history } });
  await settle();
  assert.deepEqual([g.report().facts.replaceState, g.report().facts.pushState], ['ok', 'SecurityError']);
  assert.equal(half.location.href, original);
});

test('the sandbox hints can all say "ok": in a secure, unsandboxed browser every probe WORKS, reports a real value, and leaves nothing behind', BOUNDED, async () => {
  const webStorage = () => {
    const kept = new Map();
    const ops = [];
    return { kept, ops, setItem(k, v) { ops.push(['setItem', k]); kept.set(k, String(v)); }, removeItem(k) { ops.push(['removeItem', k]); kept.delete(k); } };
  };
  const localStorage = webStorage();
  const sessionStorage = webStorage();
  const db = { opened: [], closed: 0, deleted: [] };
  const indexedDB = {
    open(name) {
      db.opened.push(name);
      const request = { result: { close() { db.closed += 1; } } };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
    deleteDatabase(name) { db.deleted.push(name); },
  };
  const popups = { opened: [], closed: 0 };
  const h = load({
    submits: true,
    browser: {
      isSecureContext: true,
      crypto: { subtle: {} },
      localStorage,
      sessionStorage,
      indexedDB,
      open: (url) => { popups.opened.push(url); return { close() { popups.closed += 1; } }; },
      location: { href: 'https://artifact.test/a', origin: 'https://artifact.test', ancestorOrigins: ['https://claude.ai'] },
      history: { replaceState() {}, pushState() {} },
    },
  });
  await settle();
  const { facts } = h.report();
  assert.deepEqual(
    [facts.isSecureContext, facts.cryptoSubtle, facts.localStorage, facts.sessionStorage, facts.indexedDB, facts.popup, facts.form],
    [true, 'object', 'ok', 'ok', 'ok', 'ok', 'ok'],
  );
  assert.deepEqual(facts.ancestors, ['https://claude.ai']);
  assert.deepEqual([facts.origin, facts.replaceState, facts.pushState], ['https://artifact.test', 'ok', 'ok']);
  for (const store of [localStorage, sessionStorage]) {
    assert.deepEqual(store.ops, [['setItem', 'snug-probe'], ['removeItem', 'snug-probe']], 'a real write, then its removal');
    assert.equal(store.kept.size, 0, 'nothing is left in web storage');
  }
  assert.deepEqual(db, { opened: ['snug-probe'], closed: 1, deleted: ['snug-probe'] }, 'the database is closed and deleted');
  assert.deepEqual(popups, { opened: ['about:blank'], closed: 1 }, 'a blank window, closed at once');
  const form = h.created.find((el) => el.tag === 'form');
  assert.ok(h.window.document.body.appended.includes(form), 'the form was in the document when it submitted');
  assert.deepEqual([form.prevented, form.removed], [1, 1], 'the submit is cancelled (it navigates nowhere) and the form is taken out again');
});

test('a browser that refuses by ANSWERING — window.open returning null, an IndexedDB request that errors, an insecure context with no crypto.subtle — is recorded as what it answered', BOUNDED, async () => {
  const indexedDB = {
    open() {
      const request = { error: { name: 'InvalidStateError' } };
      queueMicrotask(() => request.onerror());
      return request;
    },
  };
  const h = load({ browser: { open: () => null, indexedDB, isSecureContext: false, crypto: {} } });
  await settle();
  const { facts } = h.report();
  assert.deepEqual([facts.popup, facts.indexedDB], ['blocked', 'InvalidStateError']);
  assert.deepEqual([facts.isSecureContext, facts.cryptoSubtle], [false, 'undefined']);
  const silent = load({ browser: { indexedDB: { open: () => ({}) } } });
  await settle();
  silent.fire(3_000);
  await settle();
  assert.equal(silent.report().facts.indexedDB, 'timeout', 'a request that never answers is bounded at 3 s');
});

test('window.claude / window.storage are listed with their PROTOTYPE’s members too: a class instance is not reported as an empty object', BOUNDED, async () => {
  // S10's typed envelopes suggest classes behind `window.storage`: every method then lives on the
  // prototype, and an own-property listing would show only the names the probe already expects.
  class ViewerStorage {
    shared = false;
    async get() {}
    async set() {}
    async delete() {}
    async list() {}
    async clear() {}
    get quota() { return 5_000_000; }
    get broken() { throw new RangeError('a getter that refuses'); }
  }
  class ViewerClaude {
    complete() {}
    stream() {}
  }
  const h = load({ storage: new ViewerStorage(), browser: { claude: new ViewerClaude() } });
  await settle();
  const { facts } = h.report();
  assert.deepEqual(facts.claude, { complete: 'function', stream: 'function' }, 'the method nobody expected is the one worth reporting; `constructor` is not a finding');
  assert.deepEqual(facts.storage, {
    shared: 'boolean',
    get: 'function', set: 'function', delete: 'function', list: 'function',
    clear: 'function',
    quota: 'number',
    broken: 'RangeError',
  });
  // A plain object's prototype is Object.prototype: none of ITS members is a finding either.
  const plain = load({ complete: spy().complete, storage: { ...fakeStorage().api, extra: 1 } });
  await settle();
  assert.deepEqual(plain.report().facts.claude, { complete: 'function' });
  assert.deepEqual(plain.report().facts.storage, { set: 'function', get: 'function', delete: 'function', list: 'function', extra: 'number' });
  // A method the kit counts on that is NOT there is a finding as well: it is named, as undefined.
  const partial = load({ storage: { get: async () => {}, set: async () => {} }, browser: { claude: {} } });
  await settle();
  assert.deepEqual(partial.report().facts.claude, { complete: 'undefined' });
  assert.deepEqual(partial.report().facts.storage, { get: 'function', set: 'function', delete: 'undefined', list: 'undefined' });
});

test('the report says where the page runs without a query string or a fragment: href, baseURI and every script src are cut at the first ? or #', BOUNDED, async () => {
  const h = load({
    browser: { location: { href: 'https://artifact.test/a/b?session=canary-1#/home', origin: 'https://artifact.test' } },
    baseURI: 'https://embedder.test/frame?token=canary-2',
  });
  await settle();
  const report = h.report();
  assert.deepEqual([report.facts.href, report.facts.baseURI], ['https://artifact.test/a/b', 'https://embedder.test/frame']);
  assert.deepEqual(report.facts.scripts, ['', 'https://viewer.test/runtime.js']);
  assert.equal(/canary|session=|token=|[?#]/.exec(JSON.stringify(report)), null, 'no query, no fragment, anywhere in the report');
  // A fragment alone can carry a token too (an OAuth implicit-flow redirect).
  const hashed = load({ browser: { location: { href: 'https://artifact.test/a#access_token=canary-3', origin: 'https://artifact.test' } }, baseURI: 'https://embedder.test/#canary-4' });
  await settle();
  assert.deepEqual([hashed.report().facts.href, hashed.report().facts.baseURI], ['https://artifact.test/a', 'https://embedder.test/']);
});

test('the nested-frame check: sandbox="allow-scripts" only (C2), a srcdoc carrying its own CSP and the self-contained child; "no-reply" when nothing comes back', BOUNDED, async () => {
  const h = load();
  await settle();
  const frame = h.created.find((el) => el.tag === 'iframe');
  assert.deepEqual(frame.attrs, { sandbox: 'allow-scripts' });
  assert.equal(frame.hidden, true, 'the frame is plumbing: it takes no room on the page');
  assert.ok(frame.srcdoc.startsWith(`<meta http-equiv="Content-Security-Policy" content="connect-src 'none'"><script>(`));
  assert.ok(frame.srcdoc.includes(String(h.window.__probe.kid)));
  assert.ok(frame.srcdoc.endsWith(')()</script>'));
  h.fire(5_000);
  await settle();
  assert.equal(h.report().facts.nested, 'no-reply');
});

test('the nested frame’s reply is recorded as sent — and only when it comes FROM that frame and is the probe’s own message', BOUNDED, async () => {
  const h = load();
  await settle();
  const frame = h.created.find((el) => el.tag === 'iframe');
  assert.ok(h.window.document.body.appended.includes(frame), 'the frame is in the document');
  frame.contentWindow = {};
  const reply = { snugProbe: 1, origin: 'null', spv: 2, own: 1, fetched: 'TypeError', reach: 'SecurityError' };
  // Any frame on the page can post to this window: neither a stranger's look-alike nor the
  // right frame's unrelated message is the answer.
  h.dispatch('message', { source: {}, data: { ...reply, origin: 'https://stranger.test' } });
  h.dispatch('message', { source: frame.contentWindow, data: null });
  h.dispatch('message', { source: frame.contentWindow, data: { unrelated: true } });
  await settle();
  assert.equal('nested' in h.report().facts, false, 'still waiting');
  h.dispatch('message', { source: frame.contentWindow, data: reply });
  await settle();
  assert.deepEqual(h.report().facts.nested, reply);
  assert.equal(h.pending(5_000), 0, 'the 5 s bound is cleared once the reply is in');
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
      // The embedder's policy and the frame's own meta policy each raise one (S1 hosted saw exactly this pair).
      listeners.securitypolicyviolation({ originalPolicy: 'default-src https://www.claudeusercontent.com' });
      listeners.securitypolicyviolation({ originalPolicy: "connect-src 'none'" });
      return Promise.reject(new TypeError('Failed to fetch'));
    },
  };
  vm.runInNewContext(`(${kid})()`, child);
  await settle();
  assert.deepEqual(posted, [{ data: { snugProbe: 1, origin: 'null', spv: 2, own: 1, fetched: 'TypeError', reach: 'SecurityError' }, target: '*' }]);
});

test('copy report: ONE JSON document, schema snug-chat-probe/1, with the user agent and an ISO timestamp; copied through execCommand on the textarea', BOUNDED, async () => {
  const h = load({ complete: spy().complete, storage: fakeStorage().api });
  await settle();
  let selected = 0;
  h.$('out').select = () => { selected += 1; };
  const commands = [];
  h.window.document.execCommand = (name) => { commands.push(name); return true; };
  const report = h.report();
  assert.deepEqual(Object.keys(report), ['schema', 'at', 'ua', 'facts', 'ladder', 'json', 'storage']);
  assert.equal(report.schema, 'snug-chat-probe/1');
  assert.equal(report.ua, 'node-test-agent');
  assert.equal(new Date(report.at).toISOString(), report.at);
  assert.deepEqual([selected, commands], [1, ['copy']]);
  assert.equal(h.$('copied').textContent, 'copied');
  h.window.document.execCommand = () => false;
  h.click('copy');
  assert.match(h.$('copied').textContent, /copy it by hand/);
});
