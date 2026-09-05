// snug-embed — TASK-20260905-binding-a-artifacts AC9: merging hand-in bundles into a live
// artifact page mechanically, keeping every block the script does not own, refusing whole,
// and linting for the artifact viewer's narrower CDN policy (a LOADING aid, never safety).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { DB_BLOCK_FORMAT, readBundleBlocks, readDbBlock, writeDbBlock } from './lib/page-blocks.mjs';
import { ARTIFACT_SCRIPT_ALLOWLIST, BUNDLE_MAX_BYTES, embed, lintBundleHtml, listBlocks, parseArgs } from './snug-embed.mjs';

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
  const dir = mkdtempSync(path.join(tmpdir(), 'snug-embed-'));
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
});
