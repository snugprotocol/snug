// build-starters-pkg — the `@snugprotocol/starters` package (TASK-20260905-host-kit AC14,
// A3): one classic-script wrapper per starter carrying html + docs + contract + meta as
// JSON, `index.json` with the sha384 of every wrapper, deterministic bytes. The hostile
// fixture (a starter whose html carries `</script>` and `<!--`) proves the wrapper is a
// script and never markup: it contains neither sequence and hands the html back intact.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';

import { buildStartersPackage, escapeForInlineScript, wrapperSource, STARTER_PAYLOAD_FORMAT, STARTERS_INDEX_FORMAT } from './build-starters-pkg.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = path.join(REPO, 'examples');

const tmp = (label) => mkdtempSync(path.join(tmpdir(), `snug-starters-${label}-`));

/** Run a wrapper the way a page would: a classic script with a registry on `window`. */
function runWrapper(source, registry = {}) {
  const captured = [];
  // Values cross the vm realm boundary; re-parse them so deepEqual compares structure, not prototypes.
  const window = { __snugStarterRegister: (p) => captured.push(JSON.parse(JSON.stringify(p))), ...registry };
  vm.runInNewContext(source, { window }, { filename: 'wrapper.js' });
  return captured;
}

function hostileExamples() {
  const dir = tmp('examples');
  const evil = path.join(dir, 'evil');
  mkdirSync(path.join(evil, 'authoring', 'docs'), { recursive: true });
  mkdirSync(path.join(evil, 'authoring', 'prompts'), { recursive: true });
  const html = '<!doctype html><script>alert("</script>")</script><!-- comment --> </SCRIPT >    <b>end</b>\n';
  writeFileSync(path.join(evil, 'app.html'), html);
  writeFileSync(path.join(evil, 'starter.json'), JSON.stringify({ version: 1, changelog: [] }));
  writeFileSync(path.join(evil, 'runtime-contract.json'), '{"format":"x","note":"</script>"}');
  writeFileSync(path.join(evil, 'connection.json'), '{"id":"evil"}');
  writeFileSync(path.join(evil, 'authoring', 'docs', 'vision.md'), '# Vision\n\n</script><!--\n');
  writeFileSync(path.join(evil, 'authoring', 'prompts', '01-build.md'), 'build --> it');
  // A folder WITHOUT app.html is not a starter (the html glob is the catalogue rule).
  mkdirSync(path.join(dir, 'not-a-starter'));
  writeFileSync(path.join(dir, 'not-a-starter', 'README.md'), 'no');
  // A bare starter: html only.
  mkdirSync(path.join(dir, 'bare'));
  writeFileSync(path.join(dir, 'bare', 'app.html'), '<p>bare</p>');
  return { dir, html };
}

test('escapeForInlineScript leaves no `<` in the output and round-trips through JSON.parse', () => {
  const json = JSON.stringify({ a: '</script><!-- <b> -->' });
  const escaped = escapeForInlineScript(json);
  assert.equal(escaped.includes('<'), false);
  assert.deepEqual(JSON.parse(escaped), JSON.parse(json));
});

test('the wrapper of a hostile starter carries neither `</script` nor `<!--` and registers the html byte-identical', () => {
  const { dir, html } = hostileExamples();
  const out = tmp('out');
  const result = buildStartersPackage({ examplesDir: dir, outDir: out, name: '@snugprotocol/starters', version: '0.0.1' });
  assert.deepEqual(Object.keys(result.index.starters), ['bare', 'evil']);
  const wrapper = readFileSync(path.join(out, 'evil.js'), 'utf8');
  assert.equal(/<\/script/i.test(wrapper), false, 'wrapper must not contain </script');
  assert.equal(wrapper.includes('<!--'), false, 'wrapper must not contain <!--');
  const [payload] = runWrapper(wrapper);
  assert.equal(payload.format, STARTER_PAYLOAD_FORMAT);
  assert.equal(payload.folder, 'evil');
  assert.equal(payload.version, '0.0.1');
  assert.equal(payload.html, html);
  assert.equal(payload.meta, JSON.stringify({ version: 1, changelog: [] }));
  assert.equal(payload.contract, '{"format":"x","note":"</script>"}');
  assert.equal(payload.manifest, '{"id":"evil"}');
  assert.deepEqual(payload.authoring, { docs: { 'vision.md': '# Vision\n\n</script><!--\n' }, prompts: { '01-build.md': 'build --> it' } });
  // The bare starter: optional artifacts absent, not empty strings.
  const [bare] = runWrapper(readFileSync(path.join(out, 'bare.js'), 'utf8'));
  assert.equal(bare.html, '<p>bare</p>');
  assert.equal('meta' in bare, false);
  assert.equal('contract' in bare, false);
  assert.equal('manifest' in bare, false);
  assert.deepEqual(bare.authoring, { docs: {}, prompts: {} });
});

test('a wrapper on a page with no registry throws by name instead of registering into the void', () => {
  const source = wrapperSource({ name: '@snugprotocol/starters', version: '1.2.3', payload: { format: STARTER_PAYLOAD_FORMAT, folder: 'x', version: '1.2.3', html: '<p/>', authoring: { docs: {}, prompts: {} } } });
  assert.throws(() => vm.runInNewContext(source, { window: {} }), /__snugStarterRegister/);
});

test('index.json: the format literal, the pin, the sha384 + byte length of every wrapper, and the inline card metadata', () => {
  const { dir } = hostileExamples();
  const out = tmp('out');
  buildStartersPackage({ examplesDir: dir, outDir: out, name: '@snugprotocol/starters', version: '0.0.1' });
  const index = JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8'));
  assert.equal(index.format, STARTERS_INDEX_FORMAT);
  assert.equal(index.name, '@snugprotocol/starters');
  assert.equal(index.version, '0.0.1');
  for (const [folder, entry] of Object.entries(index.starters)) {
    const bytes = readFileSync(path.join(out, entry.file));
    assert.equal(entry.file, `${folder}.js`);
    assert.equal(entry.sha384, createHash('sha384').update(bytes).digest('base64'));
    assert.equal(entry.bytes, bytes.length);
  }
  assert.equal(index.starters.evil.inline.meta, JSON.stringify({ version: 1, changelog: [] }));
  assert.equal(index.starters.evil.inline.contract, '{"format":"x","note":"</script>"}');
  assert.equal(index.starters.evil.inline.manifest, '{"id":"evil"}');
  assert.deepEqual(index.starters.bare.inline, {});
  const pkg = JSON.parse(readFileSync(path.join(out, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@snugprotocol/starters');
  assert.equal(pkg.version, '0.0.1');
  assert.equal(pkg.license, 'MIT');
});

test('reproducible: two builds from the same examples produce byte-identical files', () => {
  const { dir } = hostileExamples();
  const a = tmp('a');
  const b = tmp('b');
  buildStartersPackage({ examplesDir: dir, outDir: a, name: '@snugprotocol/starters', version: '0.0.1' });
  buildStartersPackage({ examplesDir: dir, outDir: b, name: '@snugprotocol/starters', version: '0.0.1' });
  const filesA = readdirSync(a).sort();
  assert.deepEqual(filesA, readdirSync(b).sort());
  for (const f of filesA) assert.equal(readFileSync(path.join(a, f), 'utf8'), readFileSync(path.join(b, f), 'utf8'), f);
});

test('the real examples/: every folder with an app.html becomes a wrapper whose html is byte-identical to the file', () => {
  const out = tmp('real');
  const pin = JSON.parse(readFileSync(path.join(EXAMPLES, 'starters-package.json'), 'utf8'));
  const result = buildStartersPackage({ examplesDir: EXAMPLES, outDir: out, name: pin.name, version: pin.version });
  const folders = readdirSync(EXAMPLES).filter((f) => existsSync(path.join(EXAMPLES, f, 'app.html'))).sort();
  assert.ok(folders.length >= 12, `expected the twelve starters, found ${folders.length}`);
  assert.deepEqual(Object.keys(result.index.starters), folders);
  for (const folder of folders) {
    const [payload] = runWrapper(readFileSync(path.join(out, `${folder}.js`), 'utf8'));
    assert.equal(payload.html, readFileSync(path.join(EXAMPLES, folder, 'app.html'), 'utf8'), folder);
  }
  // The connected starters carry their manifest inline (the hub's badge needs it at first paint).
  assert.ok(result.index.starters.github.inline.manifest !== undefined);
  assert.ok(result.index.starters.chess.inline.meta !== undefined);
});
