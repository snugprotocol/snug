// check-starters-pin — TASK-20261008-p0-clearance W1 (ADR-0073). The committed lock
// (`examples/starters-lock.json`) records the sha384 of every wrapper of every version of
// `@snugprotocol/starters`; a published version's bytes are immutable on npm and baked into
// every kit built at that pin. These tests prove the offline gate fails — naming its remedy —
// the moment the wrappers built from `examples/` stop matching the lock, and that the online
// check can never read a network error as a pass or as a failure.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  compareToLock,
  isNetworkError,
  lockEntryFromIndex,
  remedyFor,
  serializeLock,
  STARTERS_LOCK_FORMAT,
} from './lib/starters-lock.mjs';
import { checkOffline, checkOnline } from './check-starters-pin.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (label) => mkdtempSync(path.join(tmpdir(), `snug-pin-${label}-`));
const NAME = '@snugprotocol/starters';

const index = (version, starters) => ({
  format: 'snug-starters-index/1',
  name: NAME,
  version,
  starters: Object.fromEntries(Object.entries(starters).map(([k, sha384]) => [k, { file: `${k}.js`, sha384, bytes: 1, inline: {} }])),
});
const lock = (versions) => ({ format: STARTERS_LOCK_FORMAT, name: NAME, versions });

/** A two-starter examples tree + a pin file + a license, in a temp dir. */
function fixtureRepo(version = '0.0.1') {
  const dir = tmp('repo');
  const examples = path.join(dir, 'examples');
  for (const folder of ['alpha', 'beta']) {
    mkdirSync(path.join(examples, folder), { recursive: true });
    writeFileSync(path.join(examples, folder, 'app.html'), `<p>${folder}</p>\n`);
  }
  const pinFile = path.join(examples, 'starters-package.json');
  writeFileSync(pinFile, JSON.stringify({ name: NAME, version }));
  const licenseFile = path.join(dir, 'LICENSE');
  writeFileSync(licenseFile, 'MIT License\n');
  return { dir, examples, pinFile, licenseFile, lockFile: path.join(examples, 'starters-lock.json') };
}

// --- the pure comparison -------------------------------------------------------------

test('compareToLock: the same hashes at a locked version are ok', () => {
  const r = compareToLock({ index: index('0.1.1', { a: 'A', b: 'B' }), lock: lock({ '0.1.1': { published: false, starters: { a: 'A', b: 'B' } } }) });
  assert.equal(r.status, 'ok');
});

test('compareToLock: a drifted wrapper at an UNPUBLISHED version names re-staging as the remedy', () => {
  const r = compareToLock({ index: index('0.1.1', { a: 'A2', b: 'B' }), lock: lock({ '0.1.1': { published: false, starters: { a: 'A', b: 'B' } } }) });
  assert.equal(r.status, 'drift');
  assert.equal(r.published, false);
  assert.deepEqual(r.changed, ['a']);
  assert.match(remedyFor(r), /publish-starters\.mjs --stage/);
  assert.doesNotMatch(remedyFor(r), /bump/);
});

test('compareToLock: a drifted wrapper at a PUBLISHED version names a pin bump — the published bytes are immutable', () => {
  const r = compareToLock({ index: index('0.1.0', { a: 'A', b: 'B2' }), lock: lock({ '0.1.0': { published: true, starters: { a: 'A', b: 'B' } } }) });
  assert.equal(r.status, 'drift');
  assert.equal(r.published, true);
  assert.match(remedyFor(r), /bump the version in examples\/starters-package\.json/);
});

test('compareToLock: an added or removed starter is drift, named', () => {
  const added = compareToLock({ index: index('0.1.1', { a: 'A', b: 'B', c: 'C' }), lock: lock({ '0.1.1': { published: false, starters: { a: 'A', b: 'B' } } }) });
  assert.equal(added.status, 'drift');
  assert.deepEqual(added.added, ['c']);
  const removed = compareToLock({ index: index('0.1.1', { a: 'A' }), lock: lock({ '0.1.1': { published: false, starters: { a: 'A', b: 'B' } } }) });
  assert.deepEqual(removed.removed, ['b']);
});

test('compareToLock: a pinned version with no lock entry fails with the stage remedy', () => {
  const r = compareToLock({ index: index('0.2.0', { a: 'A' }), lock: lock({ '0.1.0': { published: true, starters: { a: 'A' } } }) });
  assert.equal(r.status, 'missing-entry');
  assert.match(remedyFor(r), /--stage/);
});

test('compareToLock: a lock for another package name is refused', () => {
  const r = compareToLock({ index: index('0.1.0', { a: 'A' }), lock: { ...lock({ '0.1.0': { published: false, starters: { a: 'A' } } }), name: '@someone/else' } });
  assert.equal(r.status, 'name-mismatch');
});

test('serializeLock: stable bytes — versions and starters sorted, two-space JSON, LF', () => {
  const l = lock({ '0.1.1': { published: false, starters: { b: 'B', a: 'A' } }, '0.1.0': { ref: 'abc', published: true, integrity: 'sha512-x', starters: { b: 'B', a: 'A' } } });
  const text = serializeLock(l);
  assert.ok(text.endsWith('}\n'));
  assert.ok(text.indexOf('"0.1.0"') < text.indexOf('"0.1.1"'));
  assert.ok(text.indexOf('"a"') < text.indexOf('"b"'));
  assert.equal(serializeLock(JSON.parse(text)), text, 'idempotent');
});

test('lockEntryFromIndex: hashes per starter, the ref only when given, never published by default', () => {
  assert.deepEqual(lockEntryFromIndex(index('0.1.1', { a: 'A' })), { published: false, starters: { a: 'A' } });
  assert.deepEqual(lockEntryFromIndex(index('0.1.0', { a: 'A' }), { ref: 'f'.repeat(40) }), { ref: 'f'.repeat(40), published: false, starters: { a: 'A' } });
});

test('isNetworkError: resolver, timeout, refusal and abort are network errors; an HTTP answer is not', () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT']) {
    assert.equal(isNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code } })), true, code);
  }
  assert.equal(isNetworkError(Object.assign(new Error('aborted'), { name: 'AbortError' })), true);
  assert.equal(isNetworkError(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), true);
  assert.equal(isNetworkError(new Error('unexpected token in JSON')), false);
});

// --- the offline gate, end to end over a fixture tree -----------------------------------

test('checkOffline: passes when the lock matches the wrappers built from examples/', () => {
  const f = fixtureRepo();
  const first = checkOffline({ ...f, stage: true });
  assert.equal(first.status, 'staged');
  const r = checkOffline(f);
  assert.equal(r.status, 'ok', JSON.stringify(r));
});

test('MUTATION: editing one app.html at a locked, unpublished version reds the gate with the re-stage remedy', () => {
  const f = fixtureRepo();
  checkOffline({ ...f, stage: true });
  writeFileSync(path.join(f.examples, 'beta', 'app.html'), '<p>beta, edited</p>\n');
  const r = checkOffline(f);
  assert.equal(r.status, 'drift');
  assert.deepEqual(r.changed, ['beta']);
  assert.match(r.message, /--stage/);
});

test('MUTATION: editing one app.html at a PUBLISHED version reds the gate with the bump remedy', () => {
  const f = fixtureRepo();
  checkOffline({ ...f, stage: true });
  const l = JSON.parse(readFileSync(f.lockFile, 'utf8'));
  l.versions['0.0.1'].published = true;
  writeFileSync(f.lockFile, serializeLock(l));
  writeFileSync(path.join(f.examples, 'alpha', 'app.html'), '<p>alpha, edited</p>\n');
  const r = checkOffline(f);
  assert.equal(r.status, 'drift');
  assert.match(r.message, /bump/);
});

test('MUTATION: bumping the pin without a lock entry reds the gate', () => {
  const f = fixtureRepo();
  checkOffline({ ...f, stage: true });
  writeFileSync(f.pinFile, JSON.stringify({ name: NAME, version: '0.0.2' }));
  assert.equal(checkOffline(f).status, 'missing-entry');
});

test('the real repo: examples/starters-lock.json matches the wrappers built from examples/ at the pinned version', () => {
  const r = checkOffline({
    examples: path.join(REPO, 'examples'),
    pinFile: path.join(REPO, 'examples/starters-package.json'),
    lockFile: path.join(REPO, 'examples/starters-lock.json'),
    licenseFile: path.join(REPO, 'LICENSE'),
  });
  assert.equal(r.status, 'ok', r.message);
});

// --- the online check: registry + jsDelivr through an injected fetch --------------------

const sha = (text) => createHash('sha384').update(Buffer.from(text, 'utf8')).digest('base64');
function fakeFetch(routes) {
  return async (url) => {
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (route === undefined) return { status: 404, ok: false, text: async () => 'not found', json: async () => ({ error: 'Not found' }) };
    return { status: 200, ok: true, text: async () => route, json: async () => JSON.parse(route) };
  };
}
const PACKUMENT = 'https://registry.npmjs.org/@snugprotocol%2fstarters';
const cdn = (v, f) => `https://cdn.jsdelivr.net/npm/@snugprotocol/starters@${v}/${f}`;
const netError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });

test('checkOnline: a published version whose CDN bytes hash to the lock is VERIFIED', async () => {
  const l = lock({ '0.1.0': { published: true, integrity: 'sha512-i', starters: { a: sha('A') } } });
  const r = await checkOnline({ lock: l, fetchImpl: fakeFetch({ [PACKUMENT]: JSON.stringify({ versions: { '0.1.0': { dist: { integrity: 'sha512-i' } } } }), [cdn('0.1.0', 'a.js')]: 'A' }) });
  assert.deepEqual(r.map((x) => x.status), ['VERIFIED']);
});

test('checkOnline: a version absent from the registry is NOT PUBLISHED (and FAILED when the lock claims it is published)', async () => {
  const fetchImpl = fakeFetch({ [PACKUMENT]: JSON.stringify({ versions: {} }) });
  const [unpub] = await checkOnline({ lock: lock({ '0.1.1': { published: false, starters: { a: sha('A') } } }), fetchImpl });
  assert.equal(unpub.status, 'NOT PUBLISHED');
  const [claimed] = await checkOnline({ lock: lock({ '0.1.1': { published: true, starters: { a: sha('A') } } }), fetchImpl });
  assert.equal(claimed.status, 'FAILED');
});

test('checkOnline: a scope with no packages yet (registry 404) is NOT PUBLISHED, not FAILED', async () => {
  const [r] = await checkOnline({ lock: lock({ '0.1.0': { published: false, starters: { a: sha('A') } } }), fetchImpl: fakeFetch({}) });
  assert.equal(r.status, 'NOT PUBLISHED');
});

test('checkOnline: CDN bytes that differ from the lock are FAILED', async () => {
  const l = lock({ '0.1.0': { published: true, starters: { a: sha('A') } } });
  const [r] = await checkOnline({ lock: l, fetchImpl: fakeFetch({ [PACKUMENT]: JSON.stringify({ versions: { '0.1.0': {} } }), [cdn('0.1.0', 'a.js')]: 'TAMPERED' }) });
  assert.equal(r.status, 'FAILED');
});

test('checkOnline: a published version whose registry integrity differs from the lock is FAILED', async () => {
  const l = lock({ '0.1.0': { published: true, integrity: 'sha512-mine', starters: { a: sha('A') } } });
  const [r] = await checkOnline({ lock: l, fetchImpl: fakeFetch({ [PACKUMENT]: JSON.stringify({ versions: { '0.1.0': { dist: { integrity: 'sha512-theirs' } } } }), [cdn('0.1.0', 'a.js')]: 'A' }) });
  assert.equal(r.status, 'FAILED');
});

test('NEGATIVE: a network error is NOT VERIFIED — never a pass, never FAILED', async () => {
  const l = lock({ '0.1.0': { published: true, starters: { a: sha('A') } } });
  const [registryDown] = await checkOnline({ lock: l, fetchImpl: fakeFetch({ [PACKUMENT]: netError() }) });
  assert.equal(registryDown.status, 'NOT VERIFIED');
  const [cdnDown] = await checkOnline({ lock: l, fetchImpl: fakeFetch({ [PACKUMENT]: JSON.stringify({ versions: { '0.1.0': {} } }), [cdn('0.1.0', 'a.js')]: netError() }) });
  assert.equal(cdnDown.status, 'NOT VERIFIED');
});
