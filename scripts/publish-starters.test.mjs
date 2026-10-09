// publish-starters — TASK-20261008-p0-clearance W1 (ADR-0073). Publishing to npm is
// irreversible (a version can never be republished) and every kit bakes the published bytes'
// sha384, so every refusal below must be reachable and must fire BEFORE `npm publish` runs.
// The world is faked through one deps object; the real build/pack/extract path is proven by
// an integration test over a throwaway git repo at the bottom.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { parseArgs, runPublishStarters, realBuild, realPack, realReadTarball, PUBLISH_REGISTRY_ARGS } from './publish-starters.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = '@snugprotocol/starters';
const R = 'https://registry.npmjs.org/';
const sha = (s) => createHash('sha384').update(Buffer.from(s, 'utf8')).digest('base64');
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

/** A consistent world where every preflight passes. Override any piece per test. */
function world(over = {}) {
  const calls = [];
  const lockWrites = [];
  const logs = [];
  const wrappers = { 'alpha.js': 'ALPHA', 'beta.js': 'BETA' };
  const index = (version) => ({ format: 'snug-starters-index/1', name: NAME, version, starters: { alpha: { file: 'alpha.js', sha384: sha('ALPHA'), bytes: 5, inline: {} }, beta: { file: 'beta.js', sha384: sha('BETA'), bytes: 4, inline: {} } } });
  const files = ['LICENSE', 'README.md', 'alpha.js', 'beta.js', 'index.json', 'package.json'];
  const state = {
    pin: { name: NAME, version: '0.1.1' },
    lock: { format: 'snug-starters-lock/1', name: NAME, versions: { '0.1.1': { published: false, starters: { alpha: sha('ALPHA'), beta: sha('BETA') } } } },
    porcelain: '',
    head: HEAD,
    originMain: HEAD,
    registryConfig: R,
    scopedRegistry: 'undefined',
    whoami: { status: 0, stdout: 'jeetu\n' },
    scope: 200,
    packument: { status: 404 },
    publishStatus: 0,
    node: '22.13.1',
    build: (ref, version) => index(version),
    buildTwiceDiffers: false,
    pack: { integrity: 'sha512-local', files },
    tarball: Object.fromEntries(files.map((f) => [f, Buffer.from(wrappers[f] ?? `${f} text`, 'utf8')])),
    scrub: [],
    afterPublish: { integrity: 'sha512-local', cdn: wrappers },
    ...over,
  };
  let published = false;
  const deps = {
    root: '/repo',
    nodeVersion: state.node,
    log: (line) => logs.push(line),
    sleep: async () => {},
    exec: (cmd, args) => {
      calls.push([cmd, ...args]);
      const key = [cmd, ...args].join(' ');
      if (key === 'git status --porcelain') return { status: 0, stdout: state.porcelain };
      if (key.startsWith('git fetch')) return { status: 0, stdout: '' };
      if (key === 'git rev-parse HEAD') return { status: 0, stdout: `${state.head}\n` };
      if (key === 'git rev-parse origin/main') return { status: 0, stdout: `${state.originMain}\n` };
      if (key.startsWith('git rev-parse --verify')) return { status: 0, stdout: `${OLD}\n` };
      if (key === 'npm config get registry') return { status: 0, stdout: `${state.registryConfig}\n` };
      if (key === 'npm config get @snugprotocol:registry') return { status: 0, stdout: `${state.scopedRegistry}\n` };
      if (key.startsWith('npm whoami')) return state.whoami;
      if (key.startsWith('npm --version')) return { status: 0, stdout: '10.9.2\n' };
      if (key.startsWith('npm publish')) { published = state.publishStatus === 0; return { status: state.publishStatus, stdout: '' }; }
      throw new Error(`unexpected exec: ${key}`);
    },
    fetchImpl: async (url) => {
      calls.push(['fetch', url]);
      if (url === `${R}-/org/snugprotocol/package`) return { status: state.scope, json: async () => ({}) };
      if (url === `${R}@snugprotocol%2fstarters`) {
        if (state.packument instanceof Error) throw state.packument;
        if (published) return { status: 200, json: async () => ({ versions: { [state.publishedVersion ?? '0.1.1']: { dist: { integrity: state.afterPublish.integrity } } } }) };
        return state.packument.status === 404 ? { status: 404, json: async () => ({}) } : { status: 200, json: async () => state.packument.body };
      }
      const m = /^https:\/\/cdn\.jsdelivr\.net\/npm\/@snugprotocol\/starters@[^/]+\/(.+)$/.exec(url);
      if (m) {
        const body = state.afterPublish.cdn[m[1]];
        if (body instanceof Error) throw body;
        return body === undefined ? { status: 404, text: async () => '' } : { status: 200, text: async () => body };
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    readPin: () => state.pin,
    readLock: () => JSON.parse(JSON.stringify(state.lock)),
    writeLock: (lock) => lockWrites.push(lock),
    build: async ({ ref, version, outDir }) => {
      calls.push(['build', ref, version]);
      const idx = state.build(ref, version);
      if (state.buildTwiceDiffers && calls.filter((c) => c[0] === 'build').length > 1) idx.starters.alpha.sha384 = sha('DIFFERENT');
      return { index: idx, outDir, files: Object.fromEntries(Object.entries(state.tarball)) };
    },
    pack: async () => ({ tarball: '/tmp/snugprotocol-starters-0.1.1.tgz', ...state.pack }),
    readTarball: async () => state.tarball,
    scrub: state.scrub === null ? null : () => state.scrub,
  };
  return { deps, calls, lockWrites, logs, state };
}
const run = (argv, w) => runPublishStarters(parseArgs(argv), w.deps);
const published = (w) => w.calls.some((c) => c[0] === 'npm' && c[1] === 'publish');

// --- arguments --------------------------------------------------------------------------

test('parseArgs: dry by default; --stage, --publish, --version, --ref and --otp; unknown flags refused', () => {
  assert.deepEqual(parseArgs([]), { mode: 'dry' });
  assert.deepEqual(parseArgs(['--stage', `--ref=${OLD}`]), { mode: 'stage', ref: OLD });
  assert.deepEqual(parseArgs(['--publish', '--version=0.1.0', '--otp=123456']), { mode: 'publish', version: '0.1.0', otp: '123456' });
  assert.throws(() => parseArgs(['--publish', '--stage']), /one of/);
  assert.throws(() => parseArgs(['--force']), /unknown/);
  assert.throws(() => parseArgs(['--ref=abc']), /--ref only with --stage/);
  assert.throws(() => parseArgs(['--otp=1']), /--otp only with --publish/);
});

// --- the dry run: every preflight, nothing published ---------------------------------------

test('dry run: all preflights pass, prints the exact publish argv and a journal block, and NEVER publishes', async () => {
  const w = world();
  const r = await run([], w);
  assert.equal(r.status, 'ready', JSON.stringify(r));
  assert.equal(published(w), false);
  const out = w.logs.join('\n');
  assert.match(out, /npm publish \/tmp\/snugprotocol-starters-0\.1\.1\.tgz --access public --registry https:\/\/registry\.npmjs\.org\//);
  assert.match(out, /node 22\.13\.1/);
  assert.match(out, /npm 10\.9\.2/);
});

const REFUSALS = [
  ['a dirty tree', { porcelain: ' M examples/chess/app.html\n' }, /uncommitted/],
  ['HEAD ≠ origin/main', { head: 'c'.repeat(40) }, /origin\/main/],
  ['Node major ≠ 22', { node: '24.16.0' }, /Node 22/],
  ['a non-npmjs registry', { registryConfig: 'https://npm.pkg.github.com/' }, /registry/],
  ['a scoped registry override', { scopedRegistry: 'https://npm.pkg.github.com/' }, /@snugprotocol:registry/],
  ['npm whoami failing', { whoami: { status: 1, stdout: '', stderr: 'ENEEDAUTH' } }, /npm login/],
  ['the scope missing', { scope: 404 }, /org/],
  ['the version already published', { packument: { status: 200, body: { versions: { '0.1.1': {} } } } }, /already on the registry/],
  ['the registry unreachable', { packument: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }) }, /NOT VERIFIED/],
  ['two builds differing', { buildTwiceDiffers: true }, /reproducib/],
  ['build ≠ lock', { lock: { format: 'snug-starters-lock/1', name: NAME, versions: { '0.1.1': { published: false, starters: { alpha: sha('OLD'), beta: sha('BETA') } } } } }, /lock/],
  ['no lock entry for the version', { lock: { format: 'snug-starters-lock/1', name: NAME, versions: {} } }, /--stage/],
  ['a tarball file list ≠ the allowlist', { pack: { integrity: 'sha512-local', files: ['LICENSE', 'README.md', 'alpha.js', 'beta.js', 'index.json', 'package.json', '.env'] } }, /file list/],
  ['a tarball wrapper ≠ index.json', { tarball: { 'LICENSE': Buffer.from('l'), 'README.md': Buffer.from('r'), 'alpha.js': Buffer.from('TAMPERED'), 'beta.js': Buffer.from('BETA'), 'index.json': Buffer.from('{}'), 'package.json': Buffer.from('{}') } }, /alpha\.js/],
  ['a scrub violation in the tarball', { scrub: ['alpha.js:1: codename "x"'] }, /scrub/],
];
for (const [what, over, message] of REFUSALS) {
  test(`REFUSAL (dry and --publish): ${what} — named, and npm publish never runs`, async () => {
    for (const argv of [[], ['--publish']]) {
      const w = world(over);
      await assert.rejects(run(argv, w), message, `${argv.join(' ') || 'dry'}: ${what}`);
      assert.equal(published(w), false, `${what}: publish ran`);
      assert.equal(w.lockWrites.length, 0, `${what}: the lock was written`);
    }
  });
}

test('the scrub tool absent: the dry run reports NOT VERIFIED and continues; --publish REFUSES', async () => {
  const dry = world({ scrub: null });
  const r = await run([], dry);
  assert.equal(r.status, 'ready');
  assert.match(dry.logs.join('\n'), /scrub: NOT VERIFIED/);
  const pub = world({ scrub: null });
  await assert.rejects(run(['--publish'], pub), /check-public-scrub/);
  assert.equal(published(pub), false);
});

// --- publish -------------------------------------------------------------------------------

test('--publish: publishes THE VERIFIED TARBALL to the pinned registry, verifies registry + CDN, then marks the lock published', async () => {
  const w = world();
  const r = await run(['--publish', '--otp=654321'], w);
  assert.equal(r.status, 'published');
  const pub = w.calls.find((c) => c[0] === 'npm' && c[1] === 'publish');
  assert.deepEqual(pub, ['npm', 'publish', '/tmp/snugprotocol-starters-0.1.1.tgz', '--access', 'public', ...PUBLISH_REGISTRY_ARGS, '--otp=654321']);
  assert.equal(w.lockWrites.length, 1);
  assert.equal(w.lockWrites[0].versions['0.1.1'].published, true);
  assert.equal(w.lockWrites[0].versions['0.1.1'].integrity, 'sha512-local');
  assert.match(w.logs.join('\n'), /VERIFIED/);
});

test('--publish: a non-zero npm publish is a failure and the lock is untouched', async () => {
  const w = world({ publishStatus: 1 });
  await assert.rejects(run(['--publish'], w), /npm publish exited 1/);
  assert.equal(w.lockWrites.length, 0);
});

test('--publish: a registry integrity that differs from the packed tarball is FAILED and the lock is untouched', async () => {
  const w = world({ afterPublish: { integrity: 'sha512-someone-else', cdn: { 'alpha.js': 'ALPHA', 'beta.js': 'BETA' } } });
  await assert.rejects(run(['--publish'], w), /FAILED/);
  assert.equal(w.lockWrites.length, 0);
});

test('--publish: jsDelivr lag is NOT VERIFIED (published, lock marked, CDN to re-check) — never FAILED', async () => {
  const w = world({ afterPublish: { integrity: 'sha512-local', cdn: {} } });
  const r = await run(['--publish'], w);
  assert.equal(r.status, 'published');
  assert.equal(r.cdn, 'NOT VERIFIED');
  assert.equal(w.lockWrites[0].versions['0.1.1'].published, true);
});

test('--publish: CDN bytes that differ from the lock are FAILED', async () => {
  const w = world({ afterPublish: { integrity: 'sha512-local', cdn: { 'alpha.js': 'TAMPERED', 'beta.js': 'BETA' } } });
  await assert.rejects(run(['--publish'], w), /FAILED/);
});

test('--publish --version of an OLDER locked version builds from that entry\'s ref', async () => {
  const lock = { format: 'snug-starters-lock/1', name: NAME, versions: { '0.1.0': { ref: OLD, published: false, starters: { alpha: sha('ALPHA'), beta: sha('BETA') } }, '0.1.1': { published: false, starters: { alpha: sha('ALPHA'), beta: sha('BETA') } } } };
  const w = world({ lock, publishedVersion: '0.1.0', pack: { integrity: 'sha512-local', files: ['LICENSE', 'README.md', 'alpha.js', 'beta.js', 'index.json', 'package.json'] } });
  w.deps.pack = async () => ({ tarball: '/tmp/snugprotocol-starters-0.1.0.tgz', integrity: 'sha512-local', files: ['LICENSE', 'README.md', 'alpha.js', 'beta.js', 'index.json', 'package.json'] });
  const r = await run(['--publish', '--version=0.1.0'], w);
  assert.equal(r.status, 'published');
  assert.ok(w.calls.some((c) => c[0] === 'build' && c[1] === OLD && c[2] === '0.1.0'));
});

test('--publish --version of an older version WITHOUT a ref is refused (its bytes cannot be rebuilt from HEAD)', async () => {
  const lock = { format: 'snug-starters-lock/1', name: NAME, versions: { '0.1.0': { published: false, starters: { alpha: sha('ALPHA') } }, '0.1.1': { published: false, starters: {} } } };
  const w = world({ lock });
  await assert.rejects(run(['--publish', '--version=0.1.0'], w), /ref/);
});

// --- stage ---------------------------------------------------------------------------------

test('--stage: writes ONLY the lock entry, off main is fine, never publishes', async () => {
  const w = world({ head: 'c'.repeat(40), lock: { format: 'snug-starters-lock/1', name: NAME, versions: {} } });
  const r = await run(['--stage'], w);
  assert.equal(r.status, 'staged');
  assert.equal(published(w), false);
  assert.deepEqual(w.lockWrites[0].versions['0.1.1'], { published: false, starters: { alpha: sha('ALPHA'), beta: sha('BETA') } });
});

test('--stage --ref: records the resolved ref and builds the version the ref pins', async () => {
  const w = world({ lock: { format: 'snug-starters-lock/1', name: NAME, versions: {} }, build: (ref, version) => ({ format: 'snug-starters-index/1', name: NAME, version: '0.1.0', starters: { alpha: { file: 'alpha.js', sha384: sha('OLDALPHA'), bytes: 1, inline: {} } } }) });
  const r = await run(['--stage', '--ref=720b632'], w);
  assert.equal(r.status, 'staged');
  assert.deepEqual(w.lockWrites[0].versions['0.1.0'], { ref: OLD, published: false, starters: { alpha: sha('OLDALPHA') } });
});

test('--stage REFUSES when the version already exists on the registry, and when the registry cannot be reached', async () => {
  const exists = world({ packument: { status: 200, body: { versions: { '0.1.1': {} } } } });
  await assert.rejects(run(['--stage'], exists), /already on the registry/);
  const down = world({ packument: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }) });
  await assert.rejects(run(['--stage'], down), /NOT VERIFIED/);
  assert.equal(exists.lockWrites.length + down.lockWrites.length, 0);
});

test('--stage REFUSES to rewrite an entry the lock marks published', async () => {
  const w = world({ lock: { format: 'snug-starters-lock/1', name: NAME, versions: { '0.1.1': { published: true, starters: {} } } } });
  await assert.rejects(run(['--stage'], w), /published/);
});

test('--stage tolerates an uncommitted lock — its own output — so two versions stage back to back; anything else still refuses', async () => {
  const w = world({ porcelain: '?? examples/starters-lock.json\n', lock: { format: 'snug-starters-lock/1', name: NAME, versions: {} } });
  assert.equal((await run(['--stage'], w)).status, 'staged');
  const dirty = world({ porcelain: ' M examples/starters-lock.json\n M examples/chess/app.html\n' });
  await assert.rejects(run(['--stage'], dirty), /uncommitted/);
  const pub = world({ porcelain: ' M examples/starters-lock.json\n' });
  await assert.rejects(run([], pub), /uncommitted/, 'the dry run and --publish never tolerate it');
});

test('--stage REFUSES a dirty tree (the build reads HEAD, not the working tree)', async () => {
  const w = world({ porcelain: '?? examples/new/app.html\n' });
  await assert.rejects(run(['--stage'], w), /uncommitted/);
});

// --- the real build / pack / extract path, over a throwaway git repo -----------------------

test('INTEGRATION: realBuild builds from `git archive <ref>` with that commit\'s own builder (an ignored file never rides along); realPack + realReadTarball round-trip', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'snug-publish-int-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
  cpSync(path.join(REPO, 'scripts/build-starters-pkg.mjs'), path.join(dir, 'scripts/build-starters-pkg.mjs'));
  cpSync(path.join(REPO, 'scripts/lib'), path.join(dir, 'scripts/lib'), { recursive: true });
  mkdirSync(path.join(dir, 'examples', 'alpha'), { recursive: true });
  writeFileSync(path.join(dir, 'examples', 'alpha', 'app.html'), '<p>alpha</p>\n');
  writeFileSync(path.join(dir, 'examples', 'starters-package.json'), JSON.stringify({ name: NAME, version: '0.0.7' }));
  writeFileSync(path.join(dir, 'LICENSE'), 'MIT License\n');
  writeFileSync(path.join(dir, '.gitignore'), 'examples/alpha/authoring/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  // An IGNORED file the builder would read from a working tree: it must not reach the package.
  mkdirSync(path.join(dir, 'examples', 'alpha', 'authoring', 'docs'), { recursive: true });
  writeFileSync(path.join(dir, 'examples', 'alpha', 'authoring', 'docs', 'secret.md'), 'IGNORED-SECRET\n');
  const ref = git('rev-parse', 'HEAD').trim();
  const outDir = mkdtempSync(path.join(tmpdir(), 'snug-publish-int-out-'));
  const { index } = await realBuild({ root: dir, ref, version: '0.0.7', outDir, name: NAME });
  assert.equal(index.version, '0.0.7');
  assert.deepEqual(Object.keys(index.starters), ['alpha']);
  const wrapper = readFileSync(path.join(outDir, 'alpha.js'), 'utf8');
  assert.equal(wrapper.includes('IGNORED-SECRET'), false, 'an ignored file reached the wrapper');
  const pkg = JSON.parse(readFileSync(path.join(outDir, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.publishConfig, { access: 'public', registry: R });
  const packed = await realPack({ outDir, dest: mkdtempSync(path.join(tmpdir(), 'snug-publish-int-pack-')) });
  assert.match(packed.integrity, /^sha512-/);
  assert.deepEqual([...packed.files].sort(), ['LICENSE', 'README.md', 'alpha.js', 'index.json', 'package.json']);
  const files = await realReadTarball(packed.tarball);
  assert.equal(createHash('sha384').update(files['alpha.js']).digest('base64'), index.starters.alpha.sha384);
});
