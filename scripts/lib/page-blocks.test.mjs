// page-blocks — the ONE grammar for the data blocks a live Snug page carries, and the ONE
// top-level tokenizer every reader of that page uses (TASK-20260905-binding-a-artifacts
// AC5/AC8/AC9). Consumers: the kit (the artifact record, the hand-in), `snug-embed.mjs`,
// `check-host-kit.mjs`, the starters-index plugin. Imported everywhere — never restated.
//
// Two block kinds live between the kit's own `<script type="module">` and `</body>`:
//   <script type="text/plain" id="snug-db">{manifest json}\n{base64}</script>     — the user file
//   <script type="application/snug-app-bundle+json" data-lineage="<uuid>">…</script> — a hand-in
// Both are SCRIPT DATA whose bodies can never end the element early: base64 and a JSON
// manifest carry no `<`; a bundle's JSON is emitted with every `<` as `<`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DB_BLOCK_FORMAT,
  BUNDLE_BLOCK_TYPE,
  escapeForInlineScript,
  externalCssRefs,
  parseDbBlockBody,
  readBundleBlocks,
  readDbBlock,
  removeBundleBlock,
  tokenizeTopLevel,
  unwrapViewerPage,
  upsertBundleBlock,
  verifyKitPage,
  writeDbBlock,
} from './page-blocks.mjs';
import { VIEWER_WRAPPER_HEAD, VIEWER_WRAPPER_TAIL, wrapAsViewerPage } from '../fixtures/viewer-wrapper.mjs';

const STAMP = '0.1.0 abcdef1';
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="snug-host-build" content="${STAMP}" />
<title>Snug</title>
<style>body{margin:0}</style>
<script type="module">const s = "<script><\\/script>"; /* the kit — esbuild escapes the closer, as the inliner requires */</script>
</head>
<body>
<div id="root"></div>
</body>
</html>
`;
const LINEAGE_A = '0f5e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const LINEAGE_B = '11111111-2222-4333-8444-555555555555';
const HOSTILE_HTML = '<!doctype html><script>alert("</script>")</script><!-- comment --> </SCRIPT > <b>end</b>';
const bundle = (lineage, html = HOSTILE_HTML) => JSON.stringify({ format: 'snug-app-bundle/1', lineage, html });

// ---------------------------------------------------------------------- tokenizer

test('tokenizeTopLevel: top-level elements with raw-text bodies captured whole, each with its index and end', () => {
  const els = tokenizeTopLevel(PAGE);
  const script = els.find((e) => e.name === 'script');
  assert.equal(script.attrs.type, 'module');
  assert.equal(script.body, 'const s = "<script><\\/script>"; /* the kit — esbuild escapes the closer, as the inliner requires */');
  assert.equal(PAGE.slice(script.index, script.end), `<script type="module">${script.body}</script>`);
  const style = els.find((e) => e.name === 'style');
  assert.equal(style.body, 'body{margin:0}');
  assert.equal(PAGE.slice(style.index, style.end), '<style>body{margin:0}</style>');
  assert.equal(els.filter((e) => e.name === 'meta').length, 2);
});

// ---------------------------------------------------------------------- db block

test('writeDbBlock inserts before </body> when absent and replaces in place when present; readDbBlock reads it back', () => {
  const manifest = { format: DB_BLOCK_FORMAT, bytes: 3, sha256: 'ab'.repeat(32), saved: 1, savedAt: '2026-09-05T00:00:00Z' };
  const once = writeDbBlock(PAGE, { manifest, base64: 'AAEC' });
  assert.equal(readDbBlock(PAGE), undefined);
  const read = readDbBlock(once);
  assert.deepEqual(read.manifest, manifest);
  assert.equal(read.base64, 'AAEC');
  assert.ok(once.indexOf('id="snug-db"') < once.indexOf('</body>'));
  assert.ok(once.indexOf('id="snug-db"') > once.indexOf('<div id="root">'));
  // Replace: the page around the block is byte-identical; only the block changed.
  const twice = writeDbBlock(once, { manifest: { ...manifest, saved: 2 }, base64: 'AQID' });
  assert.equal(readDbBlock(twice).manifest.saved, 2);
  assert.equal(readDbBlock(twice).base64, 'AQID');
  assert.equal(twice.replace(/<script type="text\/plain" id="snug-db">[\s\S]*?<\/script>/, 'X'), once.replace(/<script type="text\/plain" id="snug-db">[\s\S]*?<\/script>/, 'X'));
  assert.equal((twice.match(/id="snug-db"/g) ?? []).length, 1);
});

test('readDbBlock: a block whose manifest is not JSON, or not the format, is reported as corrupt — never "no block"', () => {
  const bad = PAGE.replace('</body>', '<script type="text/plain" id="snug-db">not json\nAAEC</script>\n</body>');
  assert.deepEqual(readDbBlock(bad), { corrupt: 'the snug-db block manifest is not JSON' });
  const wrong = PAGE.replace('</body>', '<script type="text/plain" id="snug-db">{"format":"other"}\nAAEC</script>\n</body>');
  assert.equal(readDbBlock(wrong).corrupt.includes('format'), true);
});

test('(N) writeDbBlock refuses a base64 or manifest that could close the element', () => {
  const manifest = { format: DB_BLOCK_FORMAT, bytes: 1, sha256: 'a'.repeat(64), saved: 1, savedAt: 'x' };
  assert.throws(() => writeDbBlock(PAGE, { manifest, base64: 'AA</script>' }), /base64/);
  assert.throws(() => writeDbBlock(PAGE, { manifest: { ...manifest, savedAt: '</script>' }, base64: 'AA' }), /manifest/);
});

// ------------------------------------------------------------------ bundle blocks

test('upsertBundleBlock: appends a new lineage, replaces the same lineage, keeps every other block byte-for-byte (a stale db block included)', () => {
  const withDb = writeDbBlock(PAGE, { manifest: { format: DB_BLOCK_FORMAT, bytes: 1, sha256: 'a'.repeat(64), saved: 7, savedAt: 'x' }, base64: 'AA' });
  const one = upsertBundleBlock(withDb, LINEAGE_A, bundle(LINEAGE_A));
  const two = upsertBundleBlock(one, LINEAGE_B, bundle(LINEAGE_B, '<p>b</p>'));
  const blocks = readBundleBlocks(two);
  assert.deepEqual(blocks.map((b) => b.lineage), [LINEAGE_A, LINEAGE_B]);
  assert.equal(JSON.parse(blocks[0].json).html, HOSTILE_HTML);
  assert.equal(JSON.parse(blocks[1].json).html, '<p>b</p>');
  // The hostile html never appears raw: no `</script` and no `<!--` inside the page beyond the kit's own script.
  const dataRegion = two.slice(two.indexOf('id="snug-db"'));
  assert.equal(dataRegion.includes('</script>")'), false);
  assert.equal(dataRegion.includes('<!--'), false);
  assert.equal(dataRegion.includes('</SCRIPT >'), false);
  // The db block is untouched by the bundle writes.
  assert.equal(readDbBlock(two).manifest.saved, 7);
  assert.equal(readDbBlock(two).base64, 'AA');
  // Replace A: B and the db block are byte-identical around it.
  const replaced = upsertBundleBlock(two, LINEAGE_A, bundle(LINEAGE_A, '<p>a2</p>'));
  assert.equal(readBundleBlocks(replaced).length, 2);
  assert.equal(JSON.parse(readBundleBlocks(replaced)[0].json).html, '<p>a2</p>');
  assert.equal(JSON.parse(readBundleBlocks(replaced)[1].json).html, '<p>b</p>');
  assert.equal(readDbBlock(replaced).base64, 'AA');
  assert.equal(replaced.indexOf(`data-lineage="${LINEAGE_A}"`) < replaced.indexOf(`data-lineage="${LINEAGE_B}"`), true);
});

test('removeBundleBlock drops exactly that lineage; a lineage that is not a UUID is refused by every writer', () => {
  const two = upsertBundleBlock(upsertBundleBlock(PAGE, LINEAGE_A, bundle(LINEAGE_A)), LINEAGE_B, bundle(LINEAGE_B));
  const gone = removeBundleBlock(two, LINEAGE_A);
  assert.deepEqual(readBundleBlocks(gone).map((b) => b.lineage), [LINEAGE_B]);
  assert.equal(removeBundleBlock(gone, LINEAGE_A), gone);
  assert.throws(() => upsertBundleBlock(PAGE, 'starter:chess', bundle(LINEAGE_A)), /lineage/);
  assert.throws(() => upsertBundleBlock(PAGE, 'x" onload="evil', bundle(LINEAGE_A)), /lineage/);
});

test('readBundleBlocks tolerates a block whose lineage attribute disagrees with its JSON (reported, not thrown) and skips a non-JSON body', () => {
  const page = PAGE.replace('</body>', `<script type="${BUNDLE_BLOCK_TYPE}" data-lineage="${LINEAGE_A}">{not json</script>\n</body>`);
  const blocks = readBundleBlocks(page);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lineage, LINEAGE_A);
  assert.equal(blocks[0].json, '{not json'); // the reader hands the text over; the kit's strict parser decides
});

test('escapeForInlineScript leaves no `<` at all and keeps the JSON valid', () => {
  const escaped = escapeForInlineScript(bundle(LINEAGE_A));
  assert.equal(escaped.includes('<'), false);
  assert.equal(JSON.parse(escaped).html, HOSTILE_HTML);
});

// ---------------------------------------------------------------- verifyKitPage

test('verifyKitPage: the kit page with its data blocks passes; a foreign script, a wrong stamp, a <link> or a second module each fail by name', () => {
  const good = upsertBundleBlock(writeDbBlock(PAGE, { manifest: { format: DB_BLOCK_FORMAT, bytes: 1, sha256: 'a'.repeat(64), saved: 1, savedAt: 'x' }, base64: 'AA' }), LINEAGE_A, bundle(LINEAGE_A));
  assert.deepEqual(verifyKitPage(good, { expectedStamp: STAMP }), []);
  const injected = good.replace('</head>', '<script>window.__viewer_runtime__ = 1</script></head>');
  assert.match(verifyKitPage(injected, { expectedStamp: STAMP })[0], /script/);
  const external = good.replace('</head>', '<script src="https://claude.ai/runtime.js"></script></head>');
  assert.match(verifyKitPage(external, { expectedStamp: STAMP })[0], /src/);
  assert.match(verifyKitPage(good, { expectedStamp: '9.9.9 0000000' })[0], /stamp/);
  const linked = good.replace('</head>', '<link rel="stylesheet" href="x.css"></head>');
  assert.match(verifyKitPage(linked, { expectedStamp: STAMP })[0], /link/);
  const twoModules = good.replace('</head>', '<script type="module">2</script></head>');
  assert.match(verifyKitPage(twoModules, { expectedStamp: STAMP })[0], /module/);
  assert.match(verifyKitPage('<html><body></body></html>', { expectedStamp: STAMP })[0], /doctype/);
});

test('parseDbBlockBody validates every manifest field — a hand-edited counter is corrupt, never NaN (correctness review 13)', () => {
  const good = { format: DB_BLOCK_FORMAT, bytes: 3, sha256: 'ab'.repeat(32), saved: 4, savedAt: '2026-09-05T00:00:00Z' };
  assert.deepEqual(parseDbBlockBody(`${JSON.stringify(good)}\nAAEC`), { manifest: good, base64: 'AAEC' });
  for (const [label, bad] of [
    ['saved as a string', { ...good, saved: '4' }],
    ['saved missing', { format: good.format, bytes: 3, sha256: good.sha256, savedAt: 'x' }],
    ['bytes negative', { ...good, bytes: -1 }],
    ['sha too short', { ...good, sha256: 'abc' }],
    ['savedAt missing', { format: good.format, bytes: 3, sha256: good.sha256, saved: 1 }],
  ]) {
    const out = parseDbBlockBody(`${JSON.stringify(bad)}\nAAEC`);
    assert.equal(typeof out.corrupt, 'string', label);
    assert.equal(out.manifest, undefined, label);
  }
  // readDbBlock reports the same corrupt reason from a page.
  const page = PAGE.replace('</body>', `<script type="text/plain" id="snug-db">${JSON.stringify({ ...good, saved: 'x' })}\nAAEC</script>\n</body>`);
  assert.match(readDbBlock(page).corrupt, /save counter/);
});

test('externalCssRefs: every @import and non-data url(), nothing else', () => {
  assert.deepEqual(externalCssRefs('body{background:url(data:image/png;base64,AA)} h1{color:red}'), []);
  assert.deepEqual(externalCssRefs('@import url("https://fonts.googleapis.com/css2"); p{background:url(https://cdn.example/x.png)}'), [
    { kind: 'import' },
    { kind: 'url', url: 'https://fonts.googleapis.com/css2' },
    { kind: 'url', url: 'https://cdn.example/x.png' },
  ]);
});

// ---------------------------------------------------------------- the viewer's wrapper (AC13 finding, 2026-09-06)
// The artifact viewer stores and serves a published kit page WRAPPED: its own skeleton and
// two injected classic scripts ahead of the kit's whole document (`scripts/fixtures/
// viewer-wrapper.mjs` is that shape, read back from the real artifact). Every consumer of a
// fetched or read-back page unwraps FIRST and works on the kit document; the strict shape
// check then still refuses the wrapped form itself, so a republish never carries the viewer's
// runtime inside the kit page (the A1 blocker of the plan review, kept).

const WRAP_MANIFEST = { format: DB_BLOCK_FORMAT, bytes: 3, sha256: 'a'.repeat(64), saved: 1, savedAt: '2026-09-06T00:00:00Z' };

test('unwrapViewerPage: a bare kit page is handed back unchanged and not wrapped', () => {
  assert.deepEqual(unwrapViewerPage(PAGE), { html: PAGE, wrapped: false });
  const withBlocks = upsertBundleBlock(writeDbBlock(PAGE, { manifest: WRAP_MANIFEST, base64: 'AAEC' }), LINEAGE_A, '{"format":"snug-app-bundle/1"}');
  assert.deepEqual(unwrapViewerPage(withBlocks), { html: withBlocks, wrapped: false });
});

test('unwrapViewerPage: the viewer-wrapped page yields the kit document byte-for-byte; verifyKitPage passes on it and still refuses the wrapped form', () => {
  const withBlocks = upsertBundleBlock(writeDbBlock(PAGE, { manifest: WRAP_MANIFEST, base64: 'AAEC' }), LINEAGE_A, '{"format":"snug-app-bundle/1"}');
  for (const kit of [PAGE, withBlocks]) {
    const wrapped = wrapAsViewerPage(kit);
    assert.deepEqual(unwrapViewerPage(wrapped), { html: kit, wrapped: true });
    assert.deepEqual(verifyKitPage(kit, { expectedStamp: STAMP }), []);
    // The strict check is unchanged: the wrapped form carries two foreign scripts.
    const problems = verifyKitPage(wrapped, { expectedStamp: STAMP });
    assert.equal(problems.length, 2);
    assert.match(problems[0], /unknown inline <script>/);
  }
  // Blocks written AFTER the unwrap land inside the kit body — and survive a re-wrap + unwrap.
  const saved = writeDbBlock(unwrapViewerPage(wrapAsViewerPage(PAGE)).html, { manifest: WRAP_MANIFEST, base64: 'AAEC' });
  assert.equal(unwrapViewerPage(wrapAsViewerPage(saved)).html, saved);
  assert.equal(readDbBlock(saved).base64, 'AAEC');
});

test('unwrapViewerPage: refuses by name — a wrapper inside a wrapper, content after the kit document, a wrapper whose body does not open with the kit doctype', () => {
  const twice = wrapAsViewerPage(wrapAsViewerPage(PAGE));
  assert.match(unwrapViewerPage(twice).problem, /3 <html> elements/);
  const trailing = `${VIEWER_WRAPPER_HEAD}${PAGE}\n<script>injected()</script>${VIEWER_WRAPPER_TAIL}`;
  assert.match(unwrapViewerPage(trailing).problem, /after the kit document/);
  const noDoctype = `${VIEWER_WRAPPER_HEAD}${PAGE.replace(/^<!doctype html>\n/i, '')}${VIEWER_WRAPPER_TAIL}`;
  assert.match(unwrapViewerPage(noDoctype).problem, /does not open with the kit document/);
  const beforeDoc = `${VIEWER_WRAPPER_HEAD}<div id="banner"></div>${PAGE}${VIEWER_WRAPPER_TAIL}`;
  assert.match(unwrapViewerPage(beforeDoc).problem, /does not open with the kit document/);
  for (const bad of [twice, trailing, noDoctype, beforeDoc]) {
    const out = unwrapViewerPage(bad);
    assert.equal(out.html, undefined);
    assert.equal(out.wrapped, true);
  }
});
