// check-host-kit — the tokenizer never scans script/style bodies (AC1 is structural), every
// rule reds on a mutant page and passes on the real one, and two clean builds at the same
// commit are byte-identical (AC11). Run by `pnpm run check-host-kit` beside the checker.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  KIT_DIST_DIR,
  KIT_FILE_NAME,
  KIT_SIZE_CEILING_BYTES,
  checkHostKitDist,
  checkHostKitPage,
  tokenizeTopLevel,
} from './check-host-kit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = path.join(REPO, 'apps/host');

const GOOD = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="UTF-8" />',
  '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
  '    <meta name="snug-host-build" content="0.1.0 abc1234-dirty" />',
  '    <title>Snug</title>',
  // The script BODY carries every forbidden shape as text — none may count.
  `    <script type="module">const a = '<script src="./assets/x.js">'; const b = '<link rel="stylesheet" href="y.css">'; const c = "<base href='/'>"; const d = 'url(https://x/y.png)'; const e = "</style>";</script>`,
  '    <style>body{margin:0;background:url(data:image/png;base64,AAAA)}</style>',
  '  </head>',
  '  <body>',
  '    <div id="root"></div>',
  '  </body>',
  '</html>',
  '',
].join('\n');

const withHead = (extra) => GOOD.replace('    <title>Snug</title>', `    <title>Snug</title>\n${extra}`);

test('the tokenizer captures script and style bodies whole and never reads inside them', () => {
  const elements = tokenizeTopLevel(GOOD);
  const names = elements.map((e) => e.name);
  assert.deepEqual(names, ['html', 'head', 'meta', 'meta', 'meta', 'title', 'script', 'style', 'body', 'div']);
  const script = elements.find((e) => e.name === 'script');
  assert.ok(script.body.includes('<script src="./assets/x.js">'));
  assert.equal(script.attrs.type, 'module');
  const style = elements.find((e) => e.name === 'style');
  assert.ok(style.body.startsWith('body{margin:0'));
});

test('attributes: quoted values may contain ">", names are lower-cased, boolean attributes are empty strings', () => {
  const [a] = tokenizeTopLevel('<meta content="a > b" DATA-X=\'q\' hidden>');
  assert.deepEqual(a.attrs, { content: 'a > b', 'data-x': 'q', hidden: '' });
});

test('the good page passes with zero problems', () => {
  assert.deepEqual(checkHostKitPage(GOOD), []);
});

const reds = [
  ['<script src>', withHead('    <script type="module" src="./assets/index-abc.js"></script>'), /<script src=/],
  ['a second inline module script', withHead('    <script type="module">1</script>'), /exactly one inline <script type="module">/],
  ['an inline classic script', withHead('    <script>1</script>'), /inline classic <script>/],
  ['<link rel="stylesheet">', withHead('    <link rel="stylesheet" href="./assets/a.css">'), /<link rel="stylesheet">/],
  ['<link rel="modulepreload">', withHead('    <link rel="modulepreload" href="./assets/b.js">'), /<link rel="modulepreload">/],
  ['<link rel="preload">', withHead('    <link rel="preload" as="font" href="./assets/f.woff2">'), /<link rel="preload">/],
  ['a favicon link', withHead('    <link rel="icon" href="data:image/svg+xml,x">'), /<link rel="icon">/],
  ['<base>', withHead('    <base href="https://example.test/">'), /<base href=/],
  ['<meta http-equiv="refresh">', withHead('    <meta http-equiv="refresh" content="0;url=https://x">'), /http-equiv="refresh"/],
  ['@import in a top-level style', withHead('    <style>@import url("x.css");</style>'), /@import/],
  ['a non-data url() in a top-level style', withHead('    <style>a{background:url(https://x/y.png)}</style>'), /url\(https:\/\/x\/y\.png\)/],
  ['an <img src> that is not a data: URL', GOOD.replace('<div id="root"></div>', '<div id="root"></div><img src="./assets/logo.png">'), /<img> references/],
  ['a missing build stamp', GOOD.replace(/ *<meta name="snug-host-build"[^>]*>\n/, ''), /exactly one <meta name="snug-host-build">, found 0/],
  ['a malformed build stamp', GOOD.replace('0.1.0 abc1234-dirty', 'dev'), /build stamp "dev" is not/],
];
for (const [label, page, expected] of reds) {
  test(`reds on ${label}`, () => {
    const problems = checkHostKitPage(page);
    assert.ok(problems.some((p) => expected.test(p)), `expected a problem matching ${expected}, got: ${problems.join(' | ') || '(none)'}`);
  });
}

test('reds over the size ceiling and over the 16 MiB cap, by the size it is GIVEN (the file, not the string)', () => {
  assert.ok(checkHostKitPage(GOOD, { sizeBytes: KIT_SIZE_CEILING_BYTES + 1 }).some((p) => /ceiling/.test(p)));
  assert.ok(checkHostKitPage(GOOD, { sizeBytes: 16 * 1024 * 1024 + 1 }).some((p) => /16 MiB/.test(p)));
  assert.deepEqual(checkHostKitPage(GOOD, { sizeBytes: KIT_SIZE_CEILING_BYTES }), []);
});

test('the dist rule: exactly one file, named as the kit', () => {
  const problems = checkHostKitDist(path.join(REPO, 'scripts'));
  assert.ok(problems.some((p) => /must contain exactly snug-host\.html/.test(p)));
  assert.ok(checkHostKitDist(path.join(REPO, 'no-such-dir'))[0].includes('does not exist'));
});

// ---- the real page, and reproducibility ----------------------------------------------

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  return r;
};
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const kitFile = path.join(KIT_DIST_DIR, KIT_FILE_NAME);

test('AC11: two clean builds at the same commit produce byte-identical pages', () => {
  // The starters package is an input of the kit build; build it once (deterministic, pinned
  // by its own test), then the page twice from an empty dist/.
  run('node', [path.join(REPO, 'scripts/build-starters-pkg.mjs')], HOST);
  rmSync(KIT_DIST_DIR, { recursive: true, force: true });
  run('pnpm', ['exec', 'vite', 'build'], HOST);
  const first = sha256(kitFile);
  rmSync(KIT_DIST_DIR, { recursive: true, force: true });
  run('pnpm', ['exec', 'vite', 'build'], HOST);
  assert.equal(sha256(kitFile), first, 'the second build differs from the first');
});

test('AC1: the REAL built page passes every structural rule and is not vacuous', () => {
  assert.ok(existsSync(kitFile), `${kitFile} missing — run \`pnpm --filter host build\``);
  assert.deepEqual(checkHostKitDist(), []);
  const elements = tokenizeTopLevel(readFileSync(kitFile, 'utf8'));
  assert.equal(elements.filter((e) => e.name === 'script').length, 1, 'one script element');
  assert.ok(elements.filter((e) => e.name === 'style').length >= 1, 'at least one style element');
  const script = elements.find((e) => e.name === 'script');
  // Non-vacuity: the tokenizer saw the body (which carries strings that LOOK like tags).
  assert.ok(script.body.length > 1_000_000, `script body is ${script.body.length} chars`);
  assert.ok(script.body.includes('<script'), 'the body carries tag-like strings the sweep must ignore');
});
