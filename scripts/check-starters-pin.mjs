#!/usr/bin/env node
// check-starters-pin.mjs — TASK-20261008-p0-clearance W1 (ADR-0073; ADR-0060's pin-gate
// pattern applied to the starters package).
//
//   node scripts/check-starters-pin.mjs            # offline: the merge gate (root check-host-kit)
//   node scripts/check-starters-pin.mjs --online   # + the registry and jsDelivr (manual / publish)
//
// OFFLINE: build the pinned version from `examples/` into a temp dir and compare every
// wrapper's sha384 with `examples/starters-lock.json`. A starter edit without a re-stage (or,
// once the version is published, without a version bump) reds here — before a kit bakes
// hashes the CDN will never serve.
//
// ONLINE: for every locked version, ask the registry whether it exists (and whether its
// integrity matches the lock), and fetch each wrapper from jsDelivr and hash it. Statuses:
// VERIFIED · NOT PUBLISHED · NOT VERIFIED <reason> (the network did not answer — this check
// learned nothing, lessons 2026-08-26) · FAILED (an answer that contradicts the lock).
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStartersPackage, NPM_REGISTRY } from './build-starters-pkg.mjs';
import { compareToLock, compareVersions, isNetworkError, lockEntryFromIndex, remedyFor, serializeLock, STARTERS_LOCK_FORMAT } from './lib/starters-lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOCK_FILE = path.join(ROOT, 'examples/starters-lock.json');
export const CDN_PREFIX = 'https://cdn.jsdelivr.net/npm/';

export const packumentUrl = (name) => `${NPM_REGISTRY}${name.replace('/', '%2f')}`;
export const cdnUrl = (name, version, file) => `${CDN_PREFIX}${name}@${version}/${file}`;

export function readLock(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}

/**
 * Offline gate. `stage: true` writes the built entry into the lock instead of comparing
 * (the fixture path for tests; the owner's path is `publish-starters --stage`, which builds
 * from a `git archive` so an ignored file can never ride into a staged hash).
 */
export function checkOffline({ examples, pinFile, lockFile, licenseFile, stage = false }) {
  const pin = JSON.parse(readFileSync(pinFile, 'utf8'));
  const out = mkdtempSync(path.join(tmpdir(), 'snug-starters-pin-'));
  try {
    const { index } = buildStartersPackage({ examplesDir: examples, outDir: out, name: pin.name, version: pin.version, licenseFile });
    const lock = readLock(lockFile) ?? { format: STARTERS_LOCK_FORMAT, name: pin.name, versions: {} };
    if (stage) {
      lock.versions[pin.version] = lockEntryFromIndex(index);
      writeFileSync(lockFile, serializeLock(lock));
      return { status: 'staged', version: pin.version };
    }
    const result = compareToLock({ index, lock });
    return { ...result, message: remedyFor(result) };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const sha384 = (buf) => createHash('sha384').update(buf).digest('base64');
async function bodyBytes(res) {
  return typeof res.arrayBuffer === 'function' ? Buffer.from(await res.arrayBuffer()) : Buffer.from(await res.text(), 'utf8');
}
const reason = (err) => err?.cause?.code ?? err?.code ?? err?.name ?? 'network error';

/** Online check of every locked version. Never throws on the network: NOT VERIFIED instead. */
export async function checkOnline({ lock, fetchImpl = globalThis.fetch }) {
  const versions = Object.keys(lock.versions).sort(compareVersions);
  let packument;
  try {
    const res = await fetchImpl(packumentUrl(lock.name));
    if (res.status === 404) packument = { versions: {} };
    else if (res.status !== 200) return versions.map((version) => ({ version, status: 'NOT VERIFIED', detail: `registry answered HTTP ${res.status}` }));
    else packument = await res.json();
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    return versions.map((version) => ({ version, status: 'NOT VERIFIED', detail: `registry unreachable (${reason(err)})` }));
  }
  const results = [];
  for (const version of versions) {
    const entry = lock.versions[version];
    const onRegistry = packument.versions?.[version];
    if (onRegistry === undefined) {
      results.push(entry.published
        ? { version, status: 'FAILED', detail: 'the lock says published, but the registry has no such version' }
        : { version, status: 'NOT PUBLISHED', detail: 'not on the registry (staged only)' });
      continue;
    }
    const registryIntegrity = onRegistry.dist?.integrity;
    if (entry.integrity !== undefined && registryIntegrity !== undefined && entry.integrity !== registryIntegrity) {
      results.push({ version, status: 'FAILED', detail: `registry integrity ${registryIntegrity} ≠ lock ${entry.integrity}` });
      continue;
    }
    let outcome = { version, status: 'VERIFIED', detail: `${Object.keys(entry.starters).length} wrappers hash to the lock on jsDelivr` };
    for (const [folder, expected] of Object.entries(entry.starters)) {
      let res;
      try {
        res = await fetchImpl(cdnUrl(lock.name, version, `${folder}.js`));
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        outcome = { version, status: 'NOT VERIFIED', detail: `jsDelivr unreachable for ${folder}.js (${reason(err)})` };
        break;
      }
      if (res.status !== 200) {
        outcome = { version, status: 'NOT VERIFIED', detail: `jsDelivr answered HTTP ${res.status} for ${folder}.js (a fresh publish can lag)` };
        break;
      }
      const got = sha384(await bodyBytes(res));
      if (got !== expected) {
        outcome = { version, status: 'FAILED', detail: `${folder}.js on jsDelivr hashes to ${got}, the lock says ${expected}` };
        break;
      }
    }
    if (outcome.status === 'VERIFIED' && !entry.published) outcome.detail += ' — the lock does not yet mark it published';
    results.push(outcome);
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const online = process.argv.includes('--online');
  const offline = checkOffline({
    examples: path.join(ROOT, 'examples'),
    pinFile: path.join(ROOT, 'examples/starters-package.json'),
    lockFile: LOCK_FILE,
    licenseFile: path.join(ROOT, 'LICENSE'),
  });
  if (offline.status !== 'ok') {
    console.error(`check-starters-pin: FAILED — ${offline.message}`);
    process.exit(1);
  }
  console.log(`check-starters-pin: ok — ${offline.message}`);
  if (online) {
    const results = await checkOnline({ lock: readLock(LOCK_FILE) });
    for (const r of results) console.log(`check-starters-pin --online: ${r.version} ${r.status} — ${r.detail}`);
    if (results.some((r) => r.status === 'FAILED')) process.exit(1);
  }
}
