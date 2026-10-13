// sync-starter-hooks — TASK-20261010-host-broker PR-6 (D-PR6-7, contract note N35). The re-copy
// of the embedded hooks block into every starter is a TOOL, not a one-off: these tests prove the
// splice leaves exactly the validator's "hooks block" equal to the embedded file and touches
// nothing in the authored region but the two banner numbers, refuses any page it would have to
// guess about, and that --release writes ADR-0045's release (version + 1, the wave's words, the
// validator's appHash) exactly once — a second run changes nothing.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  announcedDisplayName,
  appHtmlHash,
  DEFAULT_EMBEDDED_FILE,
  lastSection,
  normalizeAppHtml,
  normalizeHooks,
  parseArgs,
  releaseStarterMeta,
  RESPONSE_SCHEMA_BANNER,
  serializeStarterMeta,
  splice,
  syncStarters,
  UsageError,
} from './sync-starter-hooks.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (label) => mkdtempSync(path.join(tmpdir(), `snug-sync-hooks-${label}-`));
const RULE = '// ============================================================';
const DATE = '2026-10-12';

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

/** A three-section block (the shape of snug-hooks.js: a rule, `// N. ` and a rule per section). */
const EMBEDDED = [
  'const { useState, useEffect } = React;',
  '',
  RULE,
  '// 1. SNUG BRIDGE RUNTIME (copy exactly)',
  RULE,
  'const SnugBridge = {',
  '  ready: false, // the host says when',
  '};',
  '',
  RULE,
  '// 2. useSnugApp (copy exactly)',
  RULE,
  'function useSnugApp(meta) {',
  '  return { isReady: SnugBridge.ready, meta };',
  '}',
  '',
  RULE,
  '// 3. useHostEvents (copy exactly when the app listens to the host)',
  RULE,
  'function useHostEvents(handlers) {',
  '  useEffect(() => undefined, [handlers]);',
  '}',
  '',
].join('\n');

/** The block one release ago: two sections. */
const OLD_BLOCK = EMBEDDED.split(`\n${RULE}\n// 3.`)[0];

/** A starter page: the old block at `indent`, then the authored region at `authored` indent. */
function page({ indent = '', authored = '    ', blankBeforeRule = true, yourApp = true, displayName = 'Fixture App', block = OLD_BLOCK } = {}) {
  const blockLines = block.replace(/\n+$/, '').split('\n').map((line) => (line === '' ? '' : indent + line));
  const a = (line) => (line === '' ? '' : authored + line);
  return [
    '<!DOCTYPE html>',
    '<html><body><div id="root"></div>',
    '  <script type="text/babel">',
    ...blockLines,
    ...(blankBeforeRule ? [''] : []),
    a(RULE),
    a('// 3. RESPONSE SCHEMA — describe the JSON the agent must return'),
    a(RULE),
    a('const RESPONSE_SCHEMA = null;'),
    '',
    ...(yourApp ? [a(RULE), a('// 4. YOUR APP — Fixture'), a(RULE)] : []),
    a('// 2. steps — a numbered comment that is not a banner, left alone'),
    a('function App() {'),
    a(`  const app = useSnugApp({ appId: 'fx', displayName: '${displayName}', description: 'd', iconEmoji: '🧪', iconColor: '#333' });`),
    a('  return app.isReady ? <main /> : null;'),
    a('}'),
    a("ReactDOM.createRoot(document.getElementById('root')).render(<App />);"),
    '  </script>',
    '</body></html>',
    '',
  ].join('\n');
}

/** The validator's reading of a page (`examples/validate.test.mjs` hookBlock / authoredRegion). */
function regions(html) {
  const script = /<script type="text\/babel">\n([\s\S]*?)\n\s*<\/script>/.exec(html)[1];
  const lines = script.split('\n');
  const banner = lines.findIndex((line) => RESPONSE_SCHEMA_BANNER.test(line));
  assert.ok(banner >= 1 && /^\s*\/\/ =+$/.test(lines[banner - 1]), 'the banner sits under its rule');
  return { block: lines.slice(0, banner - 1), authored: lines.slice(banner - 1) };
}

const meta = (version = 2, appHash = 'old-hash') => ({
  version,
  appHash,
  changelog: [
    { version, date: '2026-08-21', title: 'An earlier release', sections: [{ title: "What's new", items: ['Something real.'] }] },
    ...(version > 1 ? [{ version: 1, date: '2026-08-20', title: 'Initial release', sections: [{ title: "What's new", items: ['The app.'] }] }] : []),
  ],
});

const SHARED = (name) => [
  `${name} works just as before: this release updates the built-in code every Snug app uses to talk to Snug to the version new apps are built with.`,
  'Customized your copy? You can skip this one — your version keeps working as it is.',
];

// ── The splice ────────────────────────────────────────────────────────────────────────────────

test('splice: the region the validator calls the hooks block normalises to the embedded file', () => {
  for (const indent of ['', '    ']) {
    const out = splice(page({ indent }), EMBEDDED);
    assert.equal(normalizeHooks(regions(out).block.join('\n')), normalizeHooks(EMBEDDED), `indent ${JSON.stringify(indent)}`);
    assert.notEqual(normalizeHooks(regions(page({ indent })).block.join('\n')), normalizeHooks(EMBEDDED), 'the fixture starts out stale');
  }
});

test('splice: the block is re-indented to the page’s own first-line indent, blank lines stay empty', () => {
  for (const indent of ['', '    ', '\t']) {
    const { block } = regions(splice(page({ indent }), EMBEDDED));
    const expected = EMBEDDED.replace(/\n+$/, '').split('\n').map((line) => (line === '' ? '' : indent + line));
    assert.deepEqual(block.slice(0, expected.length), expected, `indent ${JSON.stringify(indent)}`);
    assert.ok(block.every((line) => !/[ \t]$/.test(line)), 'no trailing whitespace');
  }
});

test('splice: the page’s blank line before the banner rule is kept when it has one, and not invented when it has none', () => {
  const embeddedLines = EMBEDDED.replace(/\n+$/, '').split('\n').length;
  const withBlank = regions(splice(page({ blankBeforeRule: true }), EMBEDDED)).block;
  assert.equal(withBlank.length, embeddedLines + 1);
  assert.equal(withBlank.at(-1), '');
  assert.notEqual(withBlank.at(-2), '', 'exactly one blank line');
  const without = regions(splice(page({ blankBeforeRule: false }), EMBEDDED)).block;
  assert.equal(without.length, embeddedLines);
  assert.notEqual(without.at(-1), '');
});

test('splice: in the authored region only the two banner lines change — to the block’s last section + 1 and + 2', () => {
  const before = page();
  const after = splice(before, EMBEDDED);
  const a = regions(before).authored;
  const b = regions(after).authored;
  assert.equal(a.length, b.length);
  const changed = a.flatMap((line, at) => (line === b[at] ? [] : [[line, b[at]]]));
  assert.deepEqual(changed, [
    ['    // 3. RESPONSE SCHEMA — describe the JSON the agent must return', '    // 4. RESPONSE SCHEMA — describe the JSON the agent must return'],
    ['    // 4. YOUR APP — Fixture', '    // 5. YOUR APP — Fixture'],
  ]);
  assert.ok(b.includes('    // 2. steps — a numbered comment that is not a banner, left alone'));
  // Everything outside the babel script is byte-identical too.
  assert.equal(after.slice(0, after.indexOf('<script type="text/babel">')), before.slice(0, before.indexOf('<script type="text/babel">')));
  assert.equal(after.slice(after.lastIndexOf('</script>')), before.slice(before.lastIndexOf('</script>')));
});

test('splice: a page with no YOUR APP banner gets only its RESPONSE SCHEMA banner renumbered', () => {
  const before = page({ yourApp: false });
  const a = regions(before).authored;
  const b = regions(splice(before, EMBEDDED)).authored;
  const changed = a.flatMap((line, at) => (line === b[at] ? [] : [b[at]]));
  assert.deepEqual(changed, ['    // 4. RESPONSE SCHEMA — describe the JSON the agent must return']);
});

test('splice: with today’s embedded file the block has seven sections and the banners become 8 and 9', () => {
  const embedded = readFileSync(DEFAULT_EMBEDDED_FILE, 'utf8');
  assert.equal(lastSection(embedded), 7);
  const out = splice(page(), embedded);
  assert.match(out, /^ {4}\/\/ 8\. RESPONSE SCHEMA — /m);
  assert.match(out, /^ {4}\/\/ 9\. YOUR APP — Fixture$/m);
  assert.equal(normalizeHooks(regions(out).block.join('\n')), normalizeHooks(embedded));
});

test('splice: is a fixed point — a second splice changes nothing', () => {
  for (const options of [{}, { indent: '    ' }, { blankBeforeRule: false }, { yourApp: false }]) {
    const once = splice(page(options), EMBEDDED);
    assert.equal(splice(once, EMBEDDED), once, JSON.stringify(options));
  }
});

test('splice: refuses a page it would have to guess about', () => {
  const good = page();
  const refuses = (html, pattern, why) => assert.throws(() => splice(html, EMBEDDED), pattern, why);
  refuses(good.replace('<script type="text/babel">', '<script>'), /no <script type="text\/babel"> block/, 'no babel script');
  refuses(good.replace('// 3. RESPONSE SCHEMA', '// RESPONSE SCHEMA'), /no RESPONSE SCHEMA banner/, 'no numbered banner');
  refuses(good.replace(`${RULE}\n    // 3. RESPONSE SCHEMA`, '    // 3. RESPONSE SCHEMA'), /no `\/\/ ====` rule above the RESPONSE SCHEMA banner/, 'no rule above the banner');
  refuses(good.replace('// 2. steps', '// 7. RESPONSE SCHEMA, mentioned twice'), /2 RESPONSE SCHEMA banner lines/, 'two banners');
  refuses(good.replace('// 2. steps', '// 6. YOUR APP, mentioned twice'), /2 YOUR APP banner lines/, 'two YOUR APP banners');
  refuses(good.replace('    // 3. RESPONSE SCHEMA — describe the JSON the agent must return', "    const label = '3. RESPONSE SCHEMA';"), /is not a `\/\/ N\. RESPONSE SCHEMA` comment/, 'a banner that is not a comment');
  refuses(good.replace(/\n/g, '\r\n'), /CR line endings/, 'CRLF');
  assert.throws(() => splice(good, 'const x = 1;\n'), /no numbered section banner/, 'an embedded file without sections');
  // F1 (Gate 5): the block's sections are numbered 1..N in order, or the authored banners' numbers are a guess.
  assert.throws(() => lastSection(EMBEDDED.replace('// 2. useSnugApp', '// 3. useSnugApp')), /not numbered 1\.\.3 in order \(found 1, 3, 3\)/, 'a skipped number');
  assert.throws(() => splice(good, EMBEDDED.replace('// 2. useSnugApp', '// 3. useSnugApp')), /not numbered 1\.\.3 in order/, 'the splice refuses it too');
});

// RS-3 (Gate 5): `line.includes(BABEL_OPEN)` let a decoy — the tag quoted in a comment above the
// script, as the e2e fixtures' headers quote it — become the opening line: the splice then deleted
// everything from the decoy to the real tag (the real tag included) and still passed its
// post-condition. The opening tag is the ONE line whose trimmed text IS the tag.
test('splice: a decoy babel tag — one quoted in a comment is ignored (the real tag kept); a second bare opening-tag line is a refusal', () => {
  const good = page();
  const decoy = '<!-- the app lives in the <script type="text/babel"> block below -->';
  const withDecoy = good.replace('<html><body><div id="root"></div>', `${decoy}\n<html><body><div id="root"></div>`);
  const out = splice(withDecoy, EMBEDDED);
  assert.equal(out, splice(good, EMBEDDED).replace('<html><body><div id="root"></div>', `${decoy}\n<html><body><div id="root"></div>`), 'only the hooks block moved — the decoy and the lines after it are untouched');
  assert.equal(out.split('\n').filter((line) => line.trim() === '<script type="text/babel">').length, 1, 'the real opening tag is kept');
  const doubled = good.replace('  <script type="text/babel">', '  <script type="text/babel">\n  <script type="text/babel">');
  assert.throws(() => splice(doubled, EMBEDDED), (err) => err instanceof Error && err.message.includes('<script type="text/babel">'), 'two opening-tag lines make the cut a guess');
});

test('the banner regex is the examples’ ONE banner helper’s regex (examples/infer-connection.mjs)', () => {
  const helper = readFileSync(path.join(REPO, 'examples/infer-connection.mjs'), 'utf8');
  assert.ok(helper.includes(`export const RESPONSE_SCHEMA_BANNER = ${RESPONSE_SCHEMA_BANNER};`), 'the two regexes are the same');
});

// ── The release ───────────────────────────────────────────────────────────────────────────────

test('appHash: the validator’s normalisation, restated nowhere else (examples/validate.test.mjs)', () => {
  const validator = readFileSync(path.join(REPO, 'examples/validate.test.mjs'), 'utf8');
  assert.ok(validator.includes(`const normalizeAppHtml = ${normalizeAppHtml.toString()};`), 'the two normalisations are the same');
  const html = page();
  assert.equal(appHtmlHash(html), createHash('sha256').update(html.trim(), 'utf8').digest('hex'));
  assert.equal(appHtmlHash(`\n${html.replace(/\n/g, ' \r\n')}  \n`), appHtmlHash(html), 'CRLF, trailing whitespace and the outer trim do not move it');
});

test('--release: version + 1, the dated wave entry first with the exact words, older entries untouched, appHash recomputed', () => {
  const html = splice(page({ displayName: 'Should I?' }), EMBEDDED);
  for (const [folder, extra] of [
    ['alpha', []],
    ['weather', ['The morning forecast and its one-time suggestion run on that updated code and work as before.']],
    ['gmail', ["'Load my real data' after connecting Gmail runs on that updated code and works as before."]],
  ]) {
    const before = meta(3);
    const { meta: next, action } = releaseStarterMeta(before, { folder, html, date: DATE });
    assert.equal(action, 'released');
    assert.equal(next.version, 4);
    assert.deepEqual(Object.keys(next), Object.keys(before), 'key order kept');
    assert.deepEqual(next.changelog[0], {
      version: 4,
      date: DATE,
      title: 'Up to date with Snug',
      sections: [{ title: 'What changed', items: [...SHARED('Should I?'), ...extra] }],
    }, `${folder}: the two shared sentences first, the extra item last${extra.length ? '' : ' — none for this starter'}`);
    assert.deepEqual(next.changelog.slice(1), before.changelog);
    assert.equal(next.appHash, appHtmlHash(html));
    assert.deepEqual(before, meta(3), 'the input is not mutated');
  }
});

test('--release: idempotent — a second release of the same page changes nothing; a later hand edit is only re-hashed', () => {
  const html = splice(page(), EMBEDDED);
  const first = releaseStarterMeta(meta(2), { folder: 'weather', html, date: DATE }).meta;
  const second = releaseStarterMeta(first, { folder: 'weather', html, date: DATE });
  assert.equal(second.action, 'unchanged');
  assert.equal(serializeStarterMeta(second.meta), serializeStarterMeta(first));
  const edited = html.replace('return app.isReady', 'return app && app.isReady');
  const third = releaseStarterMeta(first, { folder: 'weather', html: edited, date: DATE });
  assert.equal(third.action, 'rehashed');
  assert.equal(third.meta.version, 3, 'no second bump');
  assert.deepEqual(third.meta.changelog, first.changelog, 'the same entry carries the hand edit');
  assert.equal(third.meta.appHash, appHtmlHash(edited));
});

test('--release: a page that did not change is never released (ADR-0045: no empty entries)', () => {
  const html = splice(page(), EMBEDDED);
  const { meta: next, action } = releaseStarterMeta(meta(2, appHtmlHash(html)), { folder: 'alpha', html, date: DATE });
  assert.equal(action, 'unchanged');
  assert.deepEqual(next, meta(2, appHtmlHash(html)));
});

test('--release: refuses a bad date and a same-date wave entry in other words', () => {
  const html = splice(page(), EMBEDDED);
  assert.throws(() => releaseStarterMeta(meta(2), { folder: 'alpha', html, date: '12/10/2026' }), /YYYY-MM-DD/);
  const released = releaseStarterMeta(meta(2), { folder: 'alpha', html, date: DATE }).meta;
  const reworded = structuredClone(released);
  reworded.changelog[0].sections[0].items.pop();
  assert.throws(() => releaseStarterMeta(reworded, { folder: 'alpha', html, date: DATE }), /not this wave's — fix it by hand/);
  // F1 (Gate 5): the same words at another version (the file bumped by hand after the wave) are not this wave's either.
  const bumped = structuredClone(released);
  bumped.version += 1;
  assert.throws(() => releaseStarterMeta(bumped, { folder: 'alpha', html, date: DATE }), /not this wave's — fix it by hand/);
});

// F1 (Gate 5): the wave's marker is its title AND its date — a later wave with the same title is a
// new release, never a re-hash of the earlier one.
test('--release: a later wave (same title, another date) is a new release — version + 1 and a second "Up to date with Snug" entry', () => {
  const html = splice(page(), EMBEDDED);
  const first = releaseStarterMeta(meta(2), { folder: 'alpha', html, date: DATE }).meta;
  const edited = html.replace('return app.isReady', 'return app && app.isReady');
  const later = releaseStarterMeta(first, { folder: 'alpha', html: edited, date: '2026-11-02' });
  assert.equal(later.action, 'released');
  assert.equal(later.meta.version, 4);
  assert.deepEqual(later.meta.changelog.filter((entry) => entry.title === 'Up to date with Snug').map((entry) => [entry.version, entry.date]), [[4, '2026-11-02'], [3, DATE]]);
  assert.deepEqual(later.meta.changelog.slice(1), first.changelog);
  assert.equal(later.meta.appHash, appHtmlHash(edited));
});

test('announcedDisplayName: read from the useSnugApp call below the banner, as the validator reads it', () => {
  assert.equal(announcedDisplayName(page({ displayName: 'Coinbase Trade Copilot' })), 'Coinbase Trade Copilot');
  assert.throws(() => announcedDisplayName(page().replace("displayName: 'Fixture App'", 'displayName: name')), /no literal displayName/);
});

// ── The tool over a tree ──────────────────────────────────────────────────────────────────────

/** An examples tree: each starter folder with a stale app.html and a released-at-v2 starter.json. */
function fixtureTree(folders) {
  const dir = tmp('tree');
  const examples = path.join(dir, 'examples');
  for (const [folder, options] of Object.entries(folders)) {
    mkdirSync(path.join(examples, folder), { recursive: true });
    const html = page(options);
    writeFileSync(path.join(examples, folder, 'app.html'), html);
    writeFileSync(path.join(examples, folder, 'starter.json'), serializeStarterMeta(meta(2, appHtmlHash(html))));
  }
  mkdirSync(path.join(examples, 'not-a-starter'), { recursive: true }); // no app.html — ignored
  const embeddedFile = path.join(dir, 'snug-hooks.js');
  writeFileSync(embeddedFile, EMBEDDED);
  const read = () => Object.fromEntries(Object.keys(folders).flatMap((folder) => ['app.html', 'starter.json'].map((file) => [`${folder}/${file}`, readFileSync(path.join(examples, folder, file), 'utf8')])));
  return { examples, embeddedFile, read };
}

test('syncStarters --release: re-copies every starter and releases each; a second run writes nothing', () => {
  const { examples, embeddedFile, read } = fixtureTree({ alpha: {}, weather: { indent: '    ', displayName: 'Should I?' } });
  const report = syncStarters({ examplesDir: examples, embeddedFile, release: true, date: DATE });
  assert.deepEqual(report.map((r) => [r.folder, r.page, r.release, r.from, r.to]), [
    ['alpha', 'changed', 'released', 2, 3],
    ['weather', 'changed', 'released', 2, 3],
  ]);
  const once = read();
  for (const folder of ['alpha', 'weather']) {
    const html = once[`${folder}/app.html`];
    const released = JSON.parse(once[`${folder}/starter.json`]);
    assert.equal(normalizeHooks(regions(html).block.join('\n')), normalizeHooks(EMBEDDED));
    assert.equal(released.appHash, appHtmlHash(html));
    assert.equal(released.changelog[0].sections[0].items.length, folder === 'weather' ? 3 : 2);
  }
  const again = syncStarters({ examplesDir: examples, embeddedFile, release: true, date: DATE });
  assert.ok(again.every((r) => r.page === 'unchanged' && r.release === 'unchanged'), 'the second run reports nothing to do');
  assert.deepEqual(read(), once, 'and writes nothing');
});

test('syncStarters: --dry writes nothing; --only limits the run; an unknown folder is a usage error', () => {
  const { examples, embeddedFile, read } = fixtureTree({ alpha: {}, beta: {} });
  const before = read();
  const dry = syncStarters({ examplesDir: examples, embeddedFile, dry: true, release: true, date: DATE });
  assert.deepEqual(dry.map((r) => r.page), ['changed', 'changed']);
  assert.deepEqual(read(), before);
  syncStarters({ examplesDir: examples, embeddedFile, only: ['beta'] });
  const after = read();
  assert.equal(after['alpha/app.html'], before['alpha/app.html']);
  assert.notEqual(after['beta/app.html'], before['beta/app.html']);
  assert.equal(after['beta/starter.json'], before['beta/starter.json'], 'no --release: the metadata is left alone');
  assert.throws(() => syncStarters({ examplesDir: examples, embeddedFile, only: ['gamma'] }), (err) => err instanceof UsageError && /not a starter folder: gamma/.test(err.message));
});

test('syncStarters: one page it cannot splice refuses the whole run — nothing is written for any starter', () => {
  const { examples, embeddedFile, read } = fixtureTree({ alpha: {}, beta: {} });
  writeFileSync(path.join(examples, 'beta', 'app.html'), page().replace('// 3. RESPONSE SCHEMA', '// RESPONSE SCHEMA'));
  const before = read();
  assert.throws(() => syncStarters({ examplesDir: examples, embeddedFile, release: true, date: DATE }), /beta\/app\.html: no RESPONSE SCHEMA banner/);
  assert.deepEqual(read(), before);
});

test('syncStarters --release: refuses to rewrite a starter.json that is not 2-space JSON with a trailing newline', () => {
  const { examples, embeddedFile, read } = fixtureTree({ alpha: {} });
  writeFileSync(path.join(examples, 'alpha', 'starter.json'), JSON.stringify(meta(2)));
  const before = read();
  assert.throws(() => syncStarters({ examplesDir: examples, embeddedFile, release: true, date: DATE }), /alpha\/starter\.json is not 2-space JSON/);
  assert.deepEqual(read(), before);
});

test('parseArgs: --release needs --date=YYYY-MM-DD; --date only with --release; unknown flags refused', () => {
  assert.deepEqual(parseArgs(['--release', `--date=${DATE}`, '--only=weather,gmail']), { dry: false, release: true, date: DATE, only: ['weather', 'gmail'] });
  assert.deepEqual(parseArgs([]), { dry: false, release: false });
  assert.throws(() => parseArgs(['--release']), UsageError);
  assert.throws(() => parseArgs(['--release', '--date=2026-10']), UsageError);
  assert.throws(() => parseArgs([`--date=${DATE}`]), UsageError);
  assert.throws(() => parseArgs(['--write']), UsageError);
});

// ── The e2e fixtures (F2 / RS-2, Gate 5) ──────────────────────────────────────────────────────

/**
 * The four playground e2e fixtures carry the hooks block by their SYNC RULE ("re-copy it here
 * WHOLE … never edit the block in place"); nothing else holds them to it. The block is the lines
 * between the ONE opening-tag line (the line whose trimmed text IS the tag — the fixtures' header
 * comments quote the tag) and the `// ====` rule above the ONE RESPONSE SCHEMA banner.
 */
test('the e2e fixtures’ hooks blocks normalise to snug-hooks.js (apps/playground/e2e/fixtures)', () => {
  const embedded = readFileSync(DEFAULT_EMBEDDED_FILE, 'utf8');
  for (const fixture of ['schedule-app', 'access-reader', 'access-source', 'access-source-fetch']) {
    const file = `apps/playground/e2e/fixtures/${fixture}.html`;
    const lines = readFileSync(path.join(REPO, file), 'utf8').split('\n');
    const opens = lines.flatMap((line, at) => (line.trim() === '<script type="text/babel">' ? [at] : []));
    assert.equal(opens.length, 1, `${file}: exactly one <script type="text/babel"> line`);
    const open = opens[0];
    const close = lines.findIndex((line, at) => at > open && line.trim() === '</script>');
    assert.ok(close > open, `${file}: the babel script is closed`);
    const banners = lines.flatMap((line, at) => (at > open && at < close && RESPONSE_SCHEMA_BANNER.test(line) ? [at] : []));
    assert.equal(banners.length, 1, `${file}: exactly one RESPONSE SCHEMA banner in the babel script`);
    const rule = banners[0] - 1;
    assert.match(lines[rule], /^\s*\/\/ =+$/, `${file}: a // ==== rule directly above the banner`);
    assert.equal(normalizeHooks(lines.slice(open + 1, rule).join('\n')), normalizeHooks(embedded), `${file}: re-copy snug-hooks.js (its SYNC RULE)`);
  }
});
