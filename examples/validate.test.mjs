// Validates the curated example apps against the Snug app-authoring contract.
//
// Run from the repo root (plain node, no build step):
//
//   node --test examples/validate.test.mjs
//
// Checks, per app:
//   1. single-file HTML — no external references beyond the allowlisted CDN <script> tags
//   2. the embedded hooks block is byte-identical to packages/sdk/embedded/snug-hooks.js
//      (after the same whitespace normalization the sdk kb-sync test uses)
//   3. announce metadata (appId / displayName / description / iconEmoji / iconColor) present
//   4. no direct browser-storage usage (the sandboxed iframe has a null origin)
//   5. parses as HTML (jsdom when available at the repo root; structural checks otherwise)
//   6. under the 5 MB artifact limit
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const EMBEDDED_HOOKS = path.join(REPO_ROOT, 'packages', 'sdk', 'embedded', 'snug-hooks.js');
const APPS = [
  'chess',
  'flying-pig',
  'habit-tracker',
  // The five pillar starters (TASK-20260806-starters-pillars, roadmap §5).
  'adventure-quest',
  'quiz-me',
  'trivia-night',
  'trip-planner',
  'pocket-ledger',
  // The connected demo (TASK-20260807-connection-reachability): the FIRST shipped
  // example that actually CALLS the governed seam. It is validated exactly like every
  // other app — no exemption, no skip — which is what made the rule repair above
  // necessary in the first place.
  'connection-demo',
];

/**
 * ADR-0011 posture, declared per app and enforced here (TASK-20260806 AC2): an
 * LLM-free app sets `RESPONSE_SCHEMA = null` and never calls `sendMessage` in its
 * authored code; an agent-driven app calls `sendMessage` WITH a `responseSchema`.
 * Everything not in this set is agent-driven.
 */
const LLM_FREE_APPS = new Set([
  'flying-pig',
  'trivia-night',
  'trip-planner',
  'pocket-ledger',
  // `connection-demo` is LLM-free ON PURPOSE: it exists to show an app reaching a real
  // API through the governed seam, and a model in the loop would blur exactly that —
  // you could not tell whether the body on screen came off the wire or out of a
  // sentence generator.
  'connection-demo',
]);
/**
 * The no-network-APIs rule, as a PAIR of patterns with one home (so the per-app rule
 * below and the rule-behavior test at the bottom of this file can never diverge).
 * See the long comment at the call site for why both are load-bearing.
 */
const DIRECT_NETWORK_API = /(?<![.\w])(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/;
const QUALIFIED_NETWORK_API = /\b(window|globalThis|self)\s*\.\s*(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/;

const CDN_ALLOWLIST = ['https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://unpkg.com'];
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

/**
 * A connected app's own `connection.json` (TASK-20260807-connection-reachability):
 * the install-act declaration. Returns `null` when the folder ships no manifest —
 * which is most apps, and which grants NO exception of any kind.
 *
 * Read as raw text and JSON.parsed here (never `import`ed) so a malformed manifest is
 * this suite's failure to report, not a module-load crash.
 */
function readDeclaredHosts(app) {
  let raw;
  try {
    raw = readFileSync(path.join(HERE, app, 'connection.json'), 'utf8');
  } catch {
    return null; // no manifest — no exception
  }
  const parsed = JSON.parse(raw); // a malformed manifest MUST fail the suite loudly
  const hosts = parsed.declaredApiHosts;
  assert.ok(Array.isArray(hosts) && hosts.length > 0, `${app}: connection.json declares a non-empty declaredApiHosts`);
  return hosts;
}

/**
 * The allowlist decision for ONE url in ONE app. A declared API host is permitted as a
 * URL LITERAL in authored code — that is the whole point of a connected app — but the
 * caller still refuses it as a `<script src>`/`href`, so a declared host can never
 * become executable code or a subresource load. Host match is exact (never a prefix:
 * `api.example.com.evil.test` must not pass on `api.example.com`).
 */
function urlAllowed(url, declaredHosts) {
  if (CDN_ALLOWLIST.some((cdn) => url.startsWith(cdn + '/'))) return true;
  if (declaredHosts === null) return false;
  let host;
  try {
    ({ host } = new URL(url));
  } catch {
    return false;
  }
  return declaredHosts.includes(host);
}

// jsdom lives in the repo-root devDependencies; the suite degrades gracefully without it.
let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  // fine — structural checks still run
}

/** Same normalization as packages/sdk/src/__tests__/kb-sync.test.ts: per-line trim, blank lines dropped. */
const normalize = (code) =>
  code
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

/**
 * The hook portion of an app: the `<script type="text/babel">` body, cut before the
 * section-5 RESPONSE SCHEMA banner (app-authored code starts there). Mirrors the sdk
 * kb-sync test's extraction so all three checks share one definition of "the hook block".
 */
function hookBlock(html, name) {
  const script = /<script type="text\/babel">\n([\s\S]*?)\n\s*<\/script>/.exec(html)?.[1];
  assert.ok(script, `${name}: has a <script type="text/babel"> block`);
  const lines = script.split('\n');
  const bannerIndex = lines.findIndex((line) => line.includes('5. RESPONSE SCHEMA'));
  assert.ok(bannerIndex >= 1, `${name}: has the section-5 RESPONSE SCHEMA banner delimiting the hook block`);
  return lines.slice(0, bannerIndex - 1).join('\n'); // also drops the ==== line above the banner
}

const expectedHooks = normalize(readFileSync(EMBEDDED_HOOKS, 'utf8'));

for (const app of APPS) {
  const file = path.join(HERE, app, 'app.html');
  const html = readFileSync(file, 'utf8');

  test(`${app}: single-file HTML with no external refs beyond allowlisted CDN scripts`, () => {
    assert.match(html, /^<!DOCTYPE html>/i, 'starts with <!DOCTYPE html>');
    // Every absolute URL in the file must sit on the CDN allowlist — or, for a
    // connected app, be a host that app's own connection.json declares (the URL it is
    // entitled to call through the governed seam). Undeclared hosts still fail.
    const declaredHosts = readDeclaredHosts(app);
    for (const [url] of html.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
      assert.ok(urlAllowed(url, declaredHosts), `URL ${url} is on the CDN allowlist or declared by this app`);
    }
    // …and may only appear as a <script src>. No stylesheets, imports, images, or
    // fetches. NOTE the deliberate asymmetry: a DECLARED host is permitted as a URL
    // literal above, but never here — a declared API host must not become executable
    // code or any subresource load, so this check stays CDN-only.
    for (const m of html.matchAll(/(src|href)\s*=\s*["']([^"']*)["']/g)) {
      const [, attr, value] = m;
      assert.equal(attr, 'src', `${value}: no href-based external references`);
      assert.ok(
        CDN_ALLOWLIST.some((cdn) => value.startsWith(cdn + '/')),
        `src ${value} is an allowlisted CDN script`,
      );
    }
    assert.doesNotMatch(html, /<link\b/i, 'no <link> elements');
    assert.doesNotMatch(html, /@import\b/, 'no CSS @import');
    assert.doesNotMatch(html, /url\(\s*['"]?https?:/i, 'no remote url() in CSS');
    // The no-network-APIs rule applies to the APP-AUTHORED region: the canonical hook
    // block is byte-locked to sdk/embedded by the sync test below, and since AL-03 it
    // legitimately DEFINES a `fetch(url, opts)` method on the useConnectedFetch handle
    // — that method posts a snug:net-request frame; connect-src stays blocked, so it
    // is the governed seam, not a network API call. Anything an APP writes is still
    // fully checked (AL-04 repair of the AL-03 rule conflict this suite carried,
    // masked until now by turbo's own-files cache key).
    const appAuthored = html.replace(hookBlock(html, app), '');
    // AL-03-rule repair #2 (cherry-picked from TASK-20260807-starters-auth-spectrum so
    // the two tasks cannot fork on a security literal — 2026-08-03 shared-literal
    // lesson): `useConnectedFetch()` hands the app an object whose `.fetch(url)` METHOD
    // is the governed net seam, so a METHOD call (`api.fetch(`) is legal app code while
    // a BARE network call stays forbidden. `\bfetch` treated the dot as a boundary and
    // flagged the seam itself.
    //
    // THE TWO ASSERTIONS ARE A PAIR — neither ships without the other. The bare-call
    // regex below uses `(?<![.\w])`, which by design no longer matches `window.fetch(`;
    // the old single regex caught that case incidentally via `\b`. Assertion 2 is what
    // keeps window-qualified calls forbidden. Deleting it opens a real hole.
    assert.doesNotMatch(appAuthored, DIRECT_NETWORK_API, 'no direct network APIs (connect-src is blocked)');
    assert.doesNotMatch(appAuthored, QUALIFIED_NETWORK_API, 'no window-qualified network APIs either');
  });

  test(`${app}: embedded hooks block is byte-identical to sdk/embedded/snug-hooks.js (normalized)`, () => {
    assert.equal(normalize(hookBlock(html, app)), expectedHooks);
  });

  test(`${app}: announce metadata is complete`, () => {
    for (const field of ['appId', 'displayName', 'description', 'iconEmoji', 'iconColor']) {
      assert.match(html, new RegExp(`${field}:\\s*['"\`]`), `announce field ${field} present with a literal value`);
    }
    assert.match(html, /useSnugApp\(\{/, 'announces via useSnugApp');
  });

  test(`${app}: no direct browser storage (sandboxed iframe has a null origin)`, () => {
    for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
      assert.ok(!html.includes(banned), `does not reference ${banned}`);
    }
  });

  test(`${app}: no <form> elements (sandbox blocks submission BEFORE the submit event fires)`, () => {
    // C2's sandbox is allow-scripts only — no allow-forms. Chromium blocks a form
    // submission at initiation ("Blocked form submission to ''…"), so a React
    // onSubmit handler NEVER RUNS: the pattern looks fine in jsdom and is dead in
    // every real browser (found live by the AL-08 Playwright spec). Buttons with
    // onClick + an Enter keydown on the input are the working equivalent.
    assert.doesNotMatch(html, /<form\b/i, 'no <form> — submission is sandbox-blocked before any handler runs');
  });

  test(`${app}: parses as HTML`, () => {
    assert.match(html, /<html\b[^>]*>/i, 'has <html>');
    assert.match(html, /<\/html>\s*$/i, 'closes </html>');
    assert.match(html, /<title>[^<]+<\/title>/i, 'has a non-empty <title>');
    assert.match(html, /<div id="root"><\/div>/, 'has the #root mount node');
    assert.match(html, /<meta name="viewport"/, 'has a viewport meta (mobile-usable)');
    if (JSDOM) {
      const dom = new JSDOM(html); // scripts NOT executed — parse only
      const doc = dom.window.document;
      assert.ok(doc.getElementById('root'), 'jsdom: #root exists');
      assert.equal(doc.querySelectorAll('script[src]').length, 3, 'jsdom: exactly the three CDN UMD scripts');
      assert.equal(doc.querySelectorAll('script[type="text/babel"]').length, 1, 'jsdom: exactly one babel script');
      assert.ok(doc.querySelector('style'), 'jsdom: inline styles present');
    }
  });

  test(`${app}: within the ${MAX_ARTIFACT_BYTES / (1024 * 1024)} MB artifact limit`, () => {
    assert.ok(statSync(file).size <= MAX_ARTIFACT_BYTES, 'app.html is within the artifact size limit');
  });

  test(`${app}: SQL at exec() call sites is literal, never string-built`, () => {
    // Adversarial-review NOTE on AL-08: a statement assembled from strings at the call
    // site ('DELETE FROM ' + table) is the habit that graduates into injection. Apps
    // that run agent-authored SQL pass a validated VARIABLE (allowed); apps issuing
    // their own statements write them as literals.
    assert.doesNotMatch(html, /\.exec\(\s*['"][^'"]*['"]\s*\+/, 'no concatenated SQL literal at an exec() call site');
  });

  test(`${app}: declares its ADR-0011 LLM posture honestly`, () => {
    // The authored region: everything from the section-5 banner to the end of the
    // babel script — the hook block above it is contract code and legitimately
    // DEFINES sendMessage, so posture is only meaningful below the banner.
    const script = /<script type="text\/babel">\n([\s\S]*?)\n\s*<\/script>/.exec(html)?.[1] ?? '';
    const lines = script.split('\n');
    const bannerIndex = lines.findIndex((line) => line.includes('5. RESPONSE SCHEMA'));
    assert.ok(bannerIndex >= 0, 'has the section-5 banner');
    const authored = lines.slice(bannerIndex).join('\n');
    if (LLM_FREE_APPS.has(app)) {
      assert.match(authored, /const RESPONSE_SCHEMA = null/, 'LLM-free: RESPONSE_SCHEMA is null');
      assert.doesNotMatch(authored, /\bsendMessage\s*\(/, 'LLM-free: authored code never calls sendMessage');
    } else {
      assert.match(authored, /\bsendMessage\s*\(/, 'agent-driven: authored code calls sendMessage');
      assert.match(authored, /responseSchema:/, 'agent-driven: a responseSchema travels with the request');
    }
  });
}

// ── Behavior checks on money arithmetic (adversarial review of AL-08, fix 2) ────────
// parseCents is extracted from the shipped source and executed — the one place in the
// portfolio where a parse bug corrupts a BALANCE, so it gets real cases, not a shape
// check. "1,000" must be a thousands separator, never one dollar.
test('pocket-ledger: parseCents handles decimal commas, thousands separators, and rejects ambiguity', () => {
  const html = readFileSync(path.join(HERE, 'pocket-ledger', 'app.html'), 'utf8');
  const src = /const parseCents = \(raw\) => \{[\s\S]*?\n {4}\};/.exec(html)?.[0];
  assert.ok(src, 'parseCents found in the app source');
  const parseCents = new Function(`${src} return parseCents;`)();
  const cases = [
    ['12.50', 1250],
    ['4', 400],
    ['1,000', 100000], // thousands separator — NOT one dollar
    ['1,50', 150], // decimal comma
    ['1,234.56', 123456], // thousands + decimal dot
    ['1,000,000', 100000000], // repeated well-formed groups, exactly at the $1M sanity cap
    ['1,234,567', null], // well-formed groups but over the cap — rejected by design
    ['1,2,3', null], // ambiguous → rejected (the warn path)
    ['1,0000', null], // malformed grouping → rejected
    ['0', null],
    ['', null],
    ['-5', null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseCents(input), expected, `parseCents(${JSON.stringify(input)})`);
  }
});

// ---------------------------------------------------------------------------
// The no-network-APIs rule, tested directly (TASK-20260807-connection-reachability,
// owner decision (i)). The per-app assertions above prove the SHIPPED apps are clean;
// this proves the RULE ITSELF discriminates correctly — a green suite of compliant
// apps cannot tell a working guard from a broken one.
//
// Both patterns are asserted together exactly as the call site uses them, so the
// documented invariant ("neither ships without the other") is enforced, not just
// commented: deleting QUALIFIED_NETWORK_API turns the three qualified rows red.
test('the no-network-APIs rule forbids direct calls and allows only the governed seam', () => {
  const forbidden = (src) => DIRECT_NETWORK_API.test(src) || QUALIFIED_NETWORK_API.test(src);
  const cases = [
    // [source, must be forbidden?]
    ['const r = await fetch(url);', true],
    ['const r = await window.fetch(url);', true], // the case DIRECT_ alone would miss
    ['globalThis.fetch(url);', true],
    ['self . fetch (url);', true], // whitespace must not defeat it
    ['new XMLHttpRequest();', true],
    ['new WebSocket(wsUrl);', true],
    ['new EventSource(streamUrl);', true],
    // The AL-03 governed seam: `useConnectedFetch()` returns a handle whose `.fetch`
    // METHOD posts a snug:net-request frame. connect-src stays blocked; the host is
    // the only caller that reaches the network. This is the line the old rule broke.
    ['const r = await api.fetch(url);', false],
    ['const r = await net.fetch(url, { method: "POST" });', false],
    ['const data = await this.fetch(path);', false],
    // Identifiers that merely CONTAIN a forbidden name are not calls to it.
    ['const doFetch = () => refetch(url);', false],
    ['prefetchAssets();', false],
  ];
  for (const [src, mustBeForbidden] of cases) {
    assert.equal(forbidden(src), mustBeForbidden, `${JSON.stringify(src)} forbidden=${mustBeForbidden}`);
  }
});

// The declared-host allowlist exception, tested directly (TASK-20260807, owner decision
// (i)). Negative cases first and in the majority: this rule EXISTS to keep the check
// total, so the only thing worth proving is what it still refuses.
test('the CDN allowlist admits a declared API host only for the app that declares it', () => {
  const declared = ['api.example.com'];
  const cases = [
    // [url, declaredHosts, allowed?]
    ['https://cdn.jsdelivr.net/npm/react@18/x.js', null, true], // CDN, no manifest needed
    ['https://api.example.com/v1/data', declared, true], // the whole point
    ['https://api.example.com/v1/data', null, false], // NO manifest ⇒ no exception
    ['https://api.evil.test/v1/data', declared, false], // undeclared host
    ['https://api.example.com.evil.test/x', declared, false], // suffix attack — exact host only
    ['https://evil.test/?x=api.example.com', declared, false], // declared host in the QUERY, not the host
    ['https://sub.api.example.com/x', declared, false], // subdomain is a different host
    ['http://api.example.com/v1', declared, true], // scheme is not this rule's job (CSP/connect-src is)
    ['not a url at all', declared, false],
  ];
  for (const [url, hosts, allowed] of cases) {
    assert.equal(urlAllowed(url, hosts), allowed, `${url} (declared: ${JSON.stringify(hosts)}) allowed=${allowed}`);
  }
});

/**
 * THE CURATION GATE ITSELF (TASK-20260807-connection-reachability).
 *
 * `APPS` is a hand-maintained list, and every per-app check above iterates it — so a new
 * folder that nobody adds to the list ships to the shelf COMPLETELY UNVALIDATED while
 * this suite stays green and merely reports a smaller number. That is the worst possible
 * failure mode for a curation gate: silence that reads as approval. (Found by mutating
 * `connection-demo` out of `APPS`: the suite went 84 → 75 and stayed green.)
 *
 * The playground's shelf is glob-driven (`import.meta.glob('examples/*./app.html')`), so
 * the filesystem — not this list — decides what users actually get. This test makes the
 * filesystem the authority here too.
 */
test('every examples/ folder shipping an app.html is in APPS — the list cannot silently under-report', () => {
  const onDisk = readdirSync(HERE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return statSync(path.join(HERE, name, 'app.html')).isFile();
      } catch {
        return false;
      }
    })
    .sort();

  assert.deepEqual(
    [...APPS].sort(),
    onDisk,
    'APPS and the examples/ folders on disk have drifted — a shelf app is unvalidated, or APPS names a folder that no longer exists',
  );
});
