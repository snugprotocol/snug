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
import { readFileSync, statSync } from 'node:fs';
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
];

/**
 * ADR-0011 posture, declared per app and enforced here (TASK-20260806 AC2): an
 * LLM-free app sets `RESPONSE_SCHEMA = null` and never calls `sendMessage` in its
 * authored code; an agent-driven app calls `sendMessage` WITH a `responseSchema`.
 * Everything not in this set is agent-driven.
 */
const LLM_FREE_APPS = new Set(['flying-pig', 'trivia-night', 'trip-planner', 'pocket-ledger']);
const CDN_ALLOWLIST = ['https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://unpkg.com'];
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

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
    // Every absolute URL in the file must sit on the CDN allowlist…
    for (const [url] of html.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
      assert.ok(
        CDN_ALLOWLIST.some((cdn) => url.startsWith(cdn + '/')),
        `URL ${url} is on the CDN allowlist`,
      );
    }
    // …and may only appear as a <script src>. No stylesheets, imports, images, or fetches.
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
    assert.doesNotMatch(html, /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/, 'no network APIs (connect-src is blocked)');
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
