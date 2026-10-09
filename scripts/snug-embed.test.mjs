// snug-embed — TASK-20260905-binding-a-artifacts AC9: merging hand-in bundles into a live
// artifact page mechanically, keeping every block the script does not own, refusing whole,
// and linting for the artifact viewer's narrower CDN policy (a LOADING aid, never safety).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { VIEWER_WRAPPER_HEAD, VIEWER_WRAPPER_TAIL, wrapAsViewerPage } from './fixtures/viewer-wrapper.mjs';
import { ARTIFACT_SKELETON_OPEN, DB_BLOCK_FORMAT, readBundleBlocks, readDbBlock, unwrapViewerPage, writeDbBlock } from './lib/page-blocks.mjs';
import { ARTIFACT_SCRIPT_ALLOWLIST, BUNDLE_MAX_BYTES, BUNDLE_MAX_HTML_CHARS, embed, lintBundleHtml, listBlocks, ownAssetsRefusal, parseArgs } from './snug-embed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAMP = '0.1.0 abcdef1';
const PAGE = `<!doctype html>\n<html><head><meta name="snug-host-build" content="${STAMP}" /><script type="module">/* kit */</script></head>\n<body><div id="root"></div>\n</body></html>\n`;
const A = '0f5e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const B = '11111111-2222-4333-8444-555555555555';
const bundle = (lineage, html, extra = {}) => JSON.stringify({ format: 'snug-app-bundle/1', lineage, sharedAt: '2026-09-05T00:00:00.000Z', app: { displayName: 'Pomodoro', usesDb: true }, html, connections: [], ...extra });
const HOSTILE = '<!doctype html><html><body><script>alert("</script>")</script><!-- c --></body></html>';
const withDb = writeDbBlock(PAGE, { manifest: { format: DB_BLOCK_FORMAT, bytes: 2, sha256: 'a'.repeat(64), saved: 3, savedAt: 'x' }, base64: 'AAA=' });

test('embed: appends new lineages, replaces the same lineage, removes on request, and keeps the db block byte-for-byte', () => {
  const one = embed({ page: withDb, bundles: [{ name: 'a.json', text: bundle(A, HOSTILE) }] });
  assert.deepEqual(one.errors, []);
  assert.deepEqual(readBundleBlocks(one.html).map((b) => b.lineage), [A]);
  assert.equal(JSON.parse(readBundleBlocks(one.html)[0].json).html, HOSTILE);
  assert.equal(one.html.includes('</script>")'), false);
  const two = embed({ page: one.html, bundles: [{ name: 'b.json', text: bundle(B, '<p>b</p>') }, { name: 'a2.json', text: bundle(A, '<p>a2</p>') }] });
  assert.deepEqual(readBundleBlocks(two.html).map((b) => [b.lineage, JSON.parse(b.json).html]), [[A, '<p>a2</p>'], [B, '<p>b</p>']]);
  assert.deepEqual(readDbBlock(two.html).manifest, readDbBlock(withDb).manifest);
  assert.equal(readDbBlock(two.html).base64, 'AAA=');
  const gone = embed({ page: two.html, remove: [A] });
  assert.deepEqual(readBundleBlocks(gone.html).map((b) => b.lineage), [B]);
  assert.deepEqual(listBlocks(gone.html), [{ lineage: B, displayName: 'Pomodoro', bytes: Buffer.byteLength(readBundleBlocks(gone.html)[0].json) }]);
});

test('the Artifact tool’s read-back is the VIEWER-WRAPPED page (AC13, 2026-09-06): embed unwraps it, merges into the kit body, and writes the BARE kit page — what a republish takes; a wrapper of another shape is refused', () => {
  const wrapped = wrapAsViewerPage(withDb);
  const out = embed({ page: wrapped, bundles: [{ name: 'a.json', text: bundle(A, '<p>a</p>') }] });
  assert.deepEqual(out.errors, []);
  assert.equal(out.unwrapped, true);
  assert.equal(out.html.startsWith('<!doctype html>\n<html>'), true);
  assert.equal(out.html.includes('frame-runtime'), false);
  assert.deepEqual(unwrapViewerPage(out.html), { html: out.html, wrapped: false });
  assert.deepEqual(readBundleBlocks(out.html).map((b) => b.lineage), [A]);
  assert.equal(readDbBlock(out.html).base64, 'AAA=');
  // The block sits inside the kit body, not in the wrapper's: the bare output, wrapped again by the viewer, unwraps to itself.
  assert.equal(unwrapViewerPage(wrapAsViewerPage(out.html)).html, out.html);
  assert.deepEqual(listBlocks(wrapped), []);
  assert.deepEqual(listBlocks(wrapAsViewerPage(out.html)).map((b) => b.lineage), [A]);
  const bare = embed({ page: withDb, bundles: [{ name: 'a.json', text: bundle(A, '<p>a</p>') }] });
  assert.equal(bare.unwrapped, false);
  assert.equal(bare.html, out.html);
  for (const [label, page] of [
    ['double wrap', wrapAsViewerPage(wrapped)],
    ['trailing content', `${VIEWER_WRAPPER_HEAD}${withDb}<script>x()</script>${VIEWER_WRAPPER_TAIL}`],
  ]) {
    const refused = embed({ page, bundles: [{ name: 'a.json', text: bundle(A, '<p>a</p>') }] });
    assert.equal(refused.errors.length, 1, label);
    assert.match(refused.errors[0], /wrapper/, label);
    assert.equal(refused.html, page, label);
  }
});

// ---- TASK-20261003 C3: the read-back under contract 0.2.67 ------------------------------
// The Artifact tool's read now returns every page inside the 0.2.67 skeleton (charset,
// viewport, a reset — no injected script; two REAL read-backs in fixtures/readback-0.2.67/).
// The kit page is a full document, so its read-back is the skeleton around that document.

const READBACKS = path.join(HERE, 'fixtures', 'readback-0.2.67');
/** The platform's form of a page, as both real read-backs show it. */
const skeleton = (page) => `${ARTIFACT_SKELETON_OPEN}\n${page}\n</body></html>`;

test('(C3) a 0.2.67 read-back of the kit page: embed lifts the kit document out of the skeleton, merges, and writes the BARE kit page — the same bytes a bare input gives', () => {
  const read = skeleton(withDb);
  const out = embed({ page: read, bundles: [{ name: 'a.json', text: bundle(A, '<p>a</p>') }] });
  assert.deepEqual(out.errors, []);
  assert.equal(out.unwrapped, true);
  assert.equal(out.html.includes(ARTIFACT_SKELETON_OPEN), false, 'the skeleton is not carried into the output');
  assert.equal(out.html.startsWith('<!doctype html>\n<html>'), true);
  assert.equal(out.html, embed({ page: withDb, bundles: [{ name: 'a.json', text: bundle(A, '<p>a</p>') }] }).html);
  assert.deepEqual(readBundleBlocks(out.html).map((b) => b.lineage), [A]);
  assert.equal(readDbBlock(out.html).base64, 'AAA=', 'the saved file rides through untouched');
  assert.deepEqual(listBlocks(read), []);
  assert.deepEqual(listBlocks(skeleton(out.html)).map((b) => b.lineage), [A]);
  // The next hand-in reads the republished page back — skeleton again — and the page never nests.
  const next = embed({ page: skeleton(out.html), bundles: [{ name: 'b.json', text: bundle(B, '<p>b</p>') }] });
  assert.deepEqual(next.errors, []);
  assert.deepEqual(unwrapViewerPage(next.html), { html: next.html, wrapped: false });
  assert.deepEqual(readBundleBlocks(next.html).map((b) => b.lineage), [A, B]);
  assert.equal(next.html.split('<!doctype html>').length - 1, 1, 'one document, one doctype');
});

test('(N, C3) the REAL tool-published fragment read-back is refused by name (a fragment is not the kit page), as are a skeleton around nothing and a skeleton inside a skeleton — the page unchanged each time', () => {
  const fragment = readFileSync(path.join(READBACKS, 'tool-published-fragment.html'), 'utf8');
  for (const [label, page, problem] of [
    ['the tool-published fragment', fragment, /page fragment, not a kit document/],
    ['a skeleton around nothing', `${ARTIFACT_SKELETON_OPEN}\n\n</body></html>`, /carries nothing/],
    ['a skeleton inside a skeleton', skeleton(skeleton(withDb)), /a skeleton inside a skeleton/],
  ]) {
    const refused = embed({ page, bundles: [{ name: 'a.json', text: bundle(A, '<p>a</p>') }] });
    assert.equal(refused.errors.length, 1, label);
    assert.match(refused.errors[0], problem, label);
    assert.equal(refused.html, page, label);
  }
});

test('(C3) CLI over a 0.2.67 read-back file: writes the bare page and says the skeleton was lifted off; the real fragment read-back exits 2 and writes nothing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'snug-embed-0267-'));
  try {
    const live = path.join(dir, 'live.html');
    const a = path.join(dir, 'a.json');
    writeFileSync(live, skeleton(withDb));
    writeFileSync(a, bundle(A, '<p>a</p>'));
    const ok = spawnSync(process.execPath, [path.join(HERE, 'snug-embed.mjs'), live, '--bundle', a], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /lifted off — publish this bare page as it is/);
    const written = readFileSync(live, 'utf8');
    assert.deepEqual(unwrapViewerPage(written), { html: written, wrapped: false });
    assert.deepEqual(readBundleBlocks(written).map((b) => b.lineage), [A]);
    const fragment = path.join(dir, 'fragment.html');
    cpSync(path.join(READBACKS, 'tool-published-fragment.html'), fragment);
    const before = readFileSync(fragment, 'utf8');
    const refused = spawnSync(process.execPath, [path.join(HERE, 'snug-embed.mjs'), fragment, '--bundle', a], { encoding: 'utf8' });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /page fragment, not a kit document/);
    assert.match(refused.stderr, /nothing written/);
    assert.equal(readFileSync(fragment, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(N) refusals leave the page UNCHANGED: not a bundle, a bad lineage, over the cap, a page with no </body>, a bad --remove', () => {
  for (const [label, text] of [
    ['not json', '{nope'],
    ['not a bundle', JSON.stringify({ format: 'x' })],
    ['bad lineage', bundle('starter:chess', '<p/>')],
    ['empty html', bundle(A, '')],
    ['over the cap', bundle(A, 'x'.repeat(BUNDLE_MAX_BYTES))],
  ]) {
    const r = embed({ page: PAGE, bundles: [{ name: label, text }] });
    assert.equal(r.errors.length, 1, label);
    assert.equal(r.html, PAGE, label);
  }
  assert.equal(embed({ page: '<html><body></body></html>', bundles: [{ text: bundle(A, '<p/>') }] }).errors.length, 1);
  assert.equal(embed({ page: PAGE, remove: ['nope'] }).errors.length, 1);
  // One bad bundle among good ones refuses ALL of them — never a half-merged page.
  const mixed = embed({ page: PAGE, bundles: [{ text: bundle(A, '<p/>') }, { text: '{nope' }] });
  assert.equal(mixed.html, PAGE);
});

test('lint: names every load the artifact viewer blocks; --strict turns warnings into a refusal', () => {
  const html = `<!doctype html><html><head>
<script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/dayjs/1.11.10/dayjs.min.js"></script>
<script src="https://unpkg.com/mitt@3/dist/mitt.umd.js"></script>
<script src="https://cdn.jsdelivr.net/gh/someone/repo@v1/lib.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/normalize.css@8/normalize.css">
<style>@import url("https://fonts.googleapis.com/css2?family=Inter"); body { background: url(https://cdn.example/x.png) } h1 { background: url(data:image/png;base64,AAAA) }</style>
</head><body></body></html>`;
  const warnings = lintBundleHtml(html);
  // Six: the @import line is both an import AND an external url(), and both are true.
  assert.equal(warnings.length, 6, warnings.join('\n'));
  assert.match(warnings[0], /unpkg/);
  assert.match(warnings[1], /\/gh\//);
  assert.match(warnings[2], /stylesheet/);
  assert.match(warnings[3], /@import/);
  assert.match(warnings[4], /url\(https:\/\/fonts\.googleapis/);
  assert.match(warnings[5], /url\(https:\/\/cdn\.example/);
  assert.deepEqual(ARTIFACT_SCRIPT_ALLOWLIST, ['https://cdn.jsdelivr.net/npm/', 'https://cdnjs.cloudflare.com/']);
  const lenient = embed({ page: PAGE, bundles: [{ name: 'x', text: bundle(A, html) }] });
  assert.equal(lenient.errors.length, 0);
  assert.equal(lenient.warnings.length, 6);
  const strict = embed({ page: PAGE, bundles: [{ name: 'x', text: bundle(A, html) }], strict: true });
  assert.equal(strict.errors.length, 1);
  assert.equal(strict.html, PAGE);
  assert.deepEqual(lintBundleHtml('<!doctype html><html><body><p>plain</p></body></html>'), []);
});

test('parseArgs: the flags, both spellings; a missing page is a usage error', () => {
  assert.deepEqual(parseArgs(['live.html', '--bundle', 'a.json', '--bundle=b.json', '--remove', A, '--out=o.html', '--strict']), {
    page: 'live.html',
    bundles: ['a.json', 'b.json'],
    remove: [A],
    out: 'o.html',
    strict: true,
    list: false,
  });
  assert.throws(() => parseArgs(['--bundle', 'a.json']), /usage/);
  assert.throws(() => parseArgs(['live.html', '--wat']), /unknown flag/);
});

test('CLI: merges into --out, exit 0; a refusal exits 2 and writes nothing', () => {
  // Removed in `finally`, as its siblings are: without it every run left one directory behind (214 found, 2026-10-04).
  const dir = mkdtempSync(path.join(tmpdir(), 'snug-embed-'));
  try {
    const live = path.join(dir, 'live.html');
    const out = path.join(dir, 'out.html');
    const a = path.join(dir, 'a.json');
    writeFileSync(live, withDb);
    writeFileSync(a, bundle(A, HOSTILE));
    const ok = spawnSync(process.execPath, [path.join(HERE, 'snug-embed.mjs'), live, '--bundle', a, '--out', out], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /1 bundle\(s\) merged/);
    assert.deepEqual(readBundleBlocks(readFileSync(out, 'utf8')).map((b) => b.lineage), [A]);
    assert.equal(readFileSync(live, 'utf8'), withDb); // --out leaves the input alone
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{nope');
    const refused = spawnSync(process.execPath, [path.join(HERE, 'snug-embed.mjs'), live, '--bundle', bad, '--out', path.join(dir, 'never.html')], { encoding: 'utf8' });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /nothing written/);
    const listed = spawnSync(process.execPath, [path.join(HERE, 'snug-embed.mjs'), out, '--list'], { encoding: 'utf8' });
    assert.equal(listed.status, 0);
    assert.match(listed.stdout, new RegExp(`${A}\\s+Pomodoro`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(N, D4) a bundle carrying connections, a bundle with no app/connections seat, or an html over the per-field cap is refused at EMBED time — never merged to be refused at boot', () => {
  const withConnections = bundle(A, '<p/>', { connections: [{ slot: 'w', provider: { name: 'X' }, kind: 'api_key' }] });
  const r1 = embed({ page: PAGE, bundles: [{ name: 'c', text: withConnections }] });
  assert.match(r1.errors[0], /connection/);
  assert.equal(r1.html, PAGE);
  const noApp = JSON.stringify({ format: 'snug-app-bundle/1', lineage: A, html: '<p/>', connections: [] });
  assert.match(embed({ page: PAGE, bundles: [{ name: 'n', text: noApp }] }).errors[0], /app\.displayName/);
  const noConnections = JSON.stringify({ format: 'snug-app-bundle/1', lineage: A, app: { displayName: 'x' }, html: '<p/>' });
  assert.match(embed({ page: PAGE, bundles: [{ name: 'n', text: noConnections }] }).errors[0], /connections/);
  const bigHtml = bundle(A, 'x'.repeat(BUNDLE_MAX_HTML_CHARS + 1));
  assert.match(embed({ page: PAGE, bundles: [{ name: 'h', text: bigHtml }] }).errors[0], /character cap/);
});

test('the caps restated here equal the protocol source (one home, text-pinned)', () => {
  const protocol = readFileSync(path.join(HERE, '..', 'packages', 'protocol', 'src', 'app-bundle.ts'), 'utf8');
  const valueOf = (name) => {
    const m = new RegExp(`export const ${name} = ([0-9 *]+);`).exec(protocol);
    assert.ok(m, `${name} not found in the protocol source`);
    return Function(`return ${m[1]}`)();
  };
  assert.equal(BUNDLE_MAX_BYTES, valueOf('APP_BUNDLE_MAX_BYTES'));
  assert.equal(BUNDLE_MAX_HTML_CHARS, valueOf('APP_BUNDLE_MAX_HTML_CHARS'));
});

// ---- TASK-20261003 K6: the skill's own page is never an OUTPUT -------------------------

/**
 * The skill as the plugin ships it: `<skill>/scripts/snug-embed.mjs` (+ its one module) and
 * `<skill>/assets/snug-host.html` — which is ALSO the page the local runner serves, pinned by
 * its hash. A script copied here is the script an agent actually runs.
 */
function skillLayout() {
  const dir = mkdtempSync(path.join(tmpdir(), 'snug-embed-skill-'));
  const skill = path.join(dir, 'skills', 'snug');
  mkdirSync(path.join(skill, 'scripts', 'lib'), { recursive: true });
  mkdirSync(path.join(skill, 'assets'), { recursive: true });
  cpSync(path.join(HERE, 'snug-embed.mjs'), path.join(skill, 'scripts', 'snug-embed.mjs'));
  cpSync(path.join(HERE, 'lib', 'page-blocks.mjs'), path.join(skill, 'scripts', 'lib', 'page-blocks.mjs'));
  const asset = path.join(skill, 'assets', 'snug-host.html');
  writeFileSync(asset, PAGE);
  const app = path.join(dir, 'a.json');
  writeFileSync(app, bundle(A, '<p>a</p>'));
  const run = (...args) => spawnSync(process.execPath, [path.join(skill, 'scripts', 'snug-embed.mjs'), ...args], { encoding: 'utf8', cwd: dir, env: { ...process.env, HOME: dir, SNUG_HOME: path.join(dir, 'snug-home') } });
  return { dir, skill, asset, app, run, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

test('(N, K6) an input that IS the skill’s own page requires --out — the default (write in place) would rewrite the page the runner serves', () => {
  const s = skillLayout();
  try {
    const refused = s.run(s.asset, '--bundle', s.app);
    assert.equal(refused.status, 2, refused.stdout);
    assert.match(refused.stderr, /--out/);
    assert.match(refused.stderr, /nothing written/);
    assert.equal(readFileSync(s.asset, 'utf8'), PAGE, 'the skill’s page is byte-identical');
    // …and reached by ANOTHER SPELLING of the same file, it is still the skill's page.
    const relative = s.run(path.join('skills', 'snug', 'scripts', '..', 'assets', 'snug-host.html'), '--bundle', s.app);
    assert.equal(relative.status, 2);
    assert.equal(readFileSync(s.asset, 'utf8'), PAGE);
  } finally {
    s.remove();
  }
});

test('(N, K6) refuses to WRITE into its own skill’s assets/ — by the resolved real path, so a symlink is no way round', () => {
  const s = skillLayout();
  try {
    const live = path.join(s.dir, 'live.html');
    writeFileSync(live, PAGE);
    // A new file beside the page.
    const beside = s.run(live, '--bundle', s.app, '--out', path.join(s.skill, 'assets', 'merged.html'));
    assert.equal(beside.status, 2, beside.stdout);
    assert.match(beside.stderr, /assets/);
    // Over the page itself.
    assert.equal(s.run(live, '--bundle', s.app, '--out', s.asset).status, 2);
    // Through a symlinked directory, and through a symlinked file.
    symlinkSync(path.join(s.skill, 'assets'), path.join(s.dir, 'elsewhere'));
    assert.equal(s.run(live, '--bundle', s.app, '--out', path.join(s.dir, 'elsewhere', 'merged.html')).status, 2);
    symlinkSync(s.asset, path.join(s.dir, 'innocent.html'));
    assert.equal(s.run(live, '--bundle', s.app, '--out', path.join(s.dir, 'innocent.html')).status, 2);
    // A subdirectory of assets/ is inside it.
    mkdirSync(path.join(s.skill, 'assets', 'sub'));
    assert.equal(s.run(live, '--bundle', s.app, '--out', path.join(s.skill, 'assets', 'sub', 'merged.html')).status, 2);

    assert.deepEqual(readdirSync(path.join(s.skill, 'assets')).sort(), ['snug-host.html', 'sub'], 'nothing was written into assets/');
    assert.deepEqual(readdirSync(path.join(s.skill, 'assets', 'sub')), []);
    assert.equal(readFileSync(s.asset, 'utf8'), PAGE);
  } finally {
    s.remove();
  }
});

test('(K6) the positive twin: the skill’s page as INPUT with --out elsewhere merges, and the page itself is untouched', () => {
  const s = skillLayout();
  try {
    const out = path.join(s.dir, 'artifact.html');
    const ok = s.run(s.asset, '--bundle', s.app, '--out', out);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(readBundleBlocks(readFileSync(out, 'utf8')).map((b) => b.lineage), [A]);
    assert.equal(readFileSync(s.asset, 'utf8'), PAGE);
    // A live page anywhere else is still merged in place, as it always was.
    const live = path.join(s.dir, 'live.html');
    writeFileSync(live, PAGE);
    assert.equal(s.run(live, '--bundle', s.app).status, 0);
    assert.deepEqual(readBundleBlocks(readFileSync(live, 'utf8')).map((b) => b.lineage), [A]);
    // --list reads; it writes nothing, so the skill's page may be listed.
    assert.equal(s.run(s.asset, '--list').status, 0);
  } finally {
    s.remove();
  }
});

test('the CLI RUNS when it is reached through a symlinked path — it used to exit 0 having done nothing', () => {
  // Found by the cases above on macOS, where the temp directory is itself behind a link
  // (/var → /private/var): the "am I the program?" check compared the path as typed with the
  // module's resolved URL, so an installed skill reached through any link was a silent no-op.
  const s = skillLayout();
  try {
    symlinkSync(path.join(s.skill, 'scripts'), path.join(s.dir, 'linked-scripts'));
    const live = path.join(s.dir, 'live.html');
    writeFileSync(live, PAGE);
    const ran = spawnSync(process.execPath, [path.join(s.dir, 'linked-scripts', 'snug-embed.mjs'), live, '--bundle', s.app], { encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /1 bundle\(s\) merged/);
    assert.deepEqual(readBundleBlocks(readFileSync(live, 'utf8')).map((b) => b.lineage), [A]);
    // …and through that link it still knows which assets/ is its own.
    assert.equal(spawnSync(process.execPath, [path.join(s.dir, 'linked-scripts', 'snug-embed.mjs'), s.asset, '--bundle', s.app], { encoding: 'utf8' }).status, 2);
  } finally {
    s.remove();
  }
});

test('(K6) run from the repo (no assets/ beside scripts/) the rule constrains nothing', () => {
  assert.equal(existsSync(path.join(HERE, '..', 'assets')), false, 'this repo has no top-level assets/ — if one appears, this rule would start guarding it');
});

// ---- Gate 5 security F4: letter case is no way round the K6 rule ------------------------
// The guard compared the JS `realpathSync` of each side, which resolves links but keeps the
// caller's letter case: on macOS's default (case-insensitive) APFS `…/Assets/snug-host.html`
// IS the guarded page, yet compared unequal — and the run rewrote the page the runner serves.

/** Measured, never assumed from the platform: does the temp volume fold letter case? (macOS's default APFS does; Linux CI's ext4 does not.) */
const TMP_FOLDS_CASE = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'snug-embed-case-'));
  try {
    writeFileSync(path.join(dir, 'probe'), '');
    return existsSync(path.join(dir, 'PROBE'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
const ON_A_CASE_SENSITIVE_VOLUME = 'this volume is case-sensitive: ASSETS/ beside assets/ is ANOTHER directory here, not a spelling of it — the case-sensitive twin runs instead';

test('(N, K6, F4) a case-variant spelling of the skill’s assets/ is refused — as the page, as --out over the page, as a new file beside it, and spelled differently ABOVE assets/', { skip: TMP_FOLDS_CASE ? false : ON_A_CASE_SENSITIVE_VOLUME }, (t) => {
  const s = skillLayout();
  try {
    const live = path.join(s.dir, 'live.html');
    writeFileSync(live, PAGE);
    // As the input with no --out: the default writes in place.
    const asPage = s.run(path.join('skills', 'snug', 'ASSETS', 'snug-host.html'), '--bundle', s.app);
    assert.equal(asPage.status, 2, asPage.stdout);
    assert.match(asPage.stderr, /pass --out/);
    assert.match(asPage.stderr, /nothing written/);
    const outs = [path.join(s.skill, 'Assets', 'snug-host.html'), path.join(s.skill, 'aSSets', 'merged.html'), path.join(s.dir, 'SKILLS', 'Snug', 'assets', 'merged.html')];
    // APFS folds by Unicode, not by ASCII: the long s (U+017F) is an `s` to it, which no JS case
    // mapping makes it — only the volume's own spelling (`realpathSync.native`) catches this one.
    const longS = path.join(s.skill, 'aſſets', 'merged.html');
    const assetsDir = statSync(path.join(s.skill, 'assets'));
    const longSDir = statSync(path.dirname(longS), { throwIfNoEntry: false });
    if (longSDir !== undefined && longSDir.dev === assetsDir.dev && longSDir.ino === assetsDir.ino) outs.push(longS);
    else t.diagnostic('this volume does not fold ſ to s — the long-s spelling is another directory here, not asserted');
    for (const out of outs) {
      const refused = s.run(live, '--bundle', s.app, '--out', out);
      assert.equal(refused.status, 2, `${out}: ${refused.stdout}`);
      assert.match(refused.stderr, /inside this skill's own assets\//, out);
      assert.match(refused.stderr, /nothing written/, out);
    }
    assert.deepEqual(readdirSync(path.join(s.skill, 'assets')), ['snug-host.html'], 'nothing was written into assets/');
    assert.equal(readFileSync(s.asset, 'utf8'), PAGE, 'the skill’s page is byte-identical');
  } finally {
    s.remove();
  }
});

test('(N, K6, F4) on a case-folding volume the comparison folds case too — a realpath that KEEPS the caller’s spelling is no way round', { skip: TMP_FOLDS_CASE ? false : ON_A_CASE_SENSITIVE_VOLUME }, () => {
  // `realpathSync.native` returns the on-disk spelling on macOS; a realpath that keeps the typed
  // spelling instead would leave `ASSETS/` unequal to `assets/`. The JS `realpathSync` behaves
  // exactly so (measured, 2026-10-04) — it stands in for one here, through the guard's seam.
  const s = skillLayout();
  try {
    const script = path.join(s.skill, 'scripts', 'snug-embed.mjs');
    const live = path.join(s.dir, 'live.html');
    writeFileSync(live, PAGE);
    assert.match(ownAssetsRefusal({ page: path.join(s.skill, 'ASSETS', 'snug-host.html') }, script, realpathSync) ?? '', /pass --out/);
    assert.match(ownAssetsRefusal({ page: live, out: path.join(s.skill, 'Assets', 'merged.html') }, script, realpathSync) ?? '', /own assets\//);
    assert.match(ownAssetsRefusal({ page: live, out: path.join(s.dir, 'SKILLS', 'snug', 'assets', 'snug-host.html') }, script, realpathSync) ?? '', /own assets\//);
    // The fold refuses no more than the same directory: a sibling whose name only STARTS like it is not inside it.
    assert.equal(ownAssetsRefusal({ page: live, out: path.join(s.skill, 'ASSETS-old', 'merged.html') }, script, realpathSync), undefined);
    assert.equal(ownAssetsRefusal({ page: live, out: path.join(s.dir, 'artifact.html') }, script, realpathSync), undefined);
  } finally {
    s.remove();
  }
});

test('(K6, F4) the case-sensitive twin: ASSETS/ beside assets/ is ANOTHER directory, and writing there is not refused', { skip: TMP_FOLDS_CASE ? 'this volume folds case: ASSETS/ IS assets/ here — the refusal above runs instead' : false }, () => {
  const s = skillLayout();
  try {
    mkdirSync(path.join(s.skill, 'ASSETS'));
    const live = path.join(s.dir, 'live.html');
    writeFileSync(live, PAGE);
    const out = path.join(s.skill, 'ASSETS', 'merged.html');
    const ok = s.run(live, '--bundle', s.app, '--out', out);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(readBundleBlocks(readFileSync(out, 'utf8')).map((b) => b.lineage), [A]);
    assert.deepEqual(readdirSync(path.join(s.skill, 'assets')), ['snug-host.html']);
    assert.equal(readFileSync(s.asset, 'utf8'), PAGE);
  } finally {
    s.remove();
  }
});
