#!/usr/bin/env node
// publish-starters.mjs — TASK-20261008-p0-clearance W1 (ADR-0073). Publish
// `@snugprotocol/starters` to npm — an OWNER ACT that needs an explicit ask in the session
// (CLAUDE.md rule 4): a version can never be republished, and every kit bakes the published
// wrappers' sha384 as SRI, so a wrong byte is permanent.
//
//   node scripts/publish-starters.mjs                         # dry run: every preflight, PRINT the publish line
//   node scripts/publish-starters.mjs --stage [--ref=<sha>]   # write examples/starters-lock.json's entry (on a branch)
//   node scripts/publish-starters.mjs --publish [--version=<v>] [--otp=<code>]   # publish + verify + mark the lock
//
// Dry run and --publish, in order — each refusal names its fix and fires BEFORE npm publish:
//   1. Node 22 (the gates' Node; the tarball's gzip bytes depend on npm's version);
//   2. a clean tree whose HEAD equals a freshly fetched origin/main (a detached HEAD in a
//      worktree qualifies — the shared checkout is not required);
//   3. the registry is https://registry.npmjs.org/ for npm AND for the @snugprotocol scope;
//      `npm whoami` answers; the org exists; the version is NOT already on the registry
//      (an unreachable registry refuses as NOT VERIFIED — it is never read as "absent");
//   4. the version has a lock entry; a version other than the pin's carries a `ref`;
//   5. built TWICE from `git archive <ref>` with that commit's own builder (a wrapper embeds
//      its version string; an ignored file can never ride in) — byte-identical, and equal
//      to the lock;
//   6. `npm pack` → the tarball's file list equals the package's allowlist, and every
//      wrapper in it hashes to index.json;
//   7. the public scrub over the tarball's files (the gitignored check-public-scrub tool:
//      absent → NOT VERIFIED on a dry run, a REFUSAL under --publish).
// --publish then publishes THAT tarball, verifies the registry integrity and every wrapper
// on jsDelivr (lag → NOT VERIFIED, never FAILED), and only then marks the lock published.
//
// Subprocesses run through ONE injected exec seam (argv arrays, never a shell string);
// scripts/publish-starters.test.mjs drives every path with a faked world.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NPM_REGISTRY, writePackageFiles } from './build-starters-pkg.mjs';
import { cdnUrl, LOCK_FILE, packumentUrl } from './check-starters-pin.mjs';
import { compareToLock, isNetworkError, lockEntryFromIndex, serializeLock } from './lib/starters-lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLISH_REGISTRY_ARGS = Object.freeze(['--registry', NPM_REGISTRY]);
const ORG = 'snugprotocol';
const REQUIRED_NODE_MAJOR = 22;
/** Post-publish polling: the registry answers within seconds; jsDelivr can take minutes. */
const REGISTRY_TRIES = 12;
const CDN_TRIES = 10;
const POLL_MS = 15_000;

export class UsageError extends Error {}
class Refusal extends Error {}

const USAGE = 'usage: node scripts/publish-starters.mjs [--stage [--ref=<sha>]] [--publish [--version=<v>] [--otp=<code>]] [--version=<v>]';

export function parseArgs(argv) {
  const out = { mode: 'dry' };
  for (const arg of argv) {
    if (arg === '--stage' || arg === '--publish') {
      if (out.mode !== 'dry') throw new UsageError(`choose one of --stage / --publish\n${USAGE}`);
      out.mode = arg.slice(2);
    } else if (arg.startsWith('--ref=')) out.ref = arg.slice('--ref='.length);
    else if (arg.startsWith('--version=')) out.version = arg.slice('--version='.length);
    else if (arg.startsWith('--otp=')) out.otp = arg.slice('--otp='.length);
    else throw new UsageError(`unknown flag ${arg}\n${USAGE}`);
  }
  if (out.ref !== undefined && out.mode !== 'stage') throw new UsageError(`--ref only with --stage\n${USAGE}`);
  if (out.otp !== undefined && out.mode !== 'publish') throw new UsageError(`--otp only with --publish\n${USAGE}`);
  if (out.version !== undefined && out.mode === 'stage') throw new UsageError(`--stage takes the version from the pin at the ref; drop --version\n${USAGE}`);
  return out;
}

const sha384 = (buf) => createHash('sha384').update(buf).digest('base64');
const netReason = (err) => err?.cause?.code ?? err?.code ?? err?.name ?? 'network error';
const normalizeRegistry = (r) => (r.endsWith('/') ? r : `${r}/`);

function nodePreflight(deps) {
  const major = Number(String(deps.nodeVersion).split('.')[0]);
  if (major !== REQUIRED_NODE_MAJOR) {
    throw new Refusal(`Node ${REQUIRED_NODE_MAJOR} is required (this is ${deps.nodeVersion}) — the gates run on Node 22 and the tarball's bytes depend on its npm. Run: PATH="$HOME/.nvm/versions/node/v22.13.1/bin:$PATH" node scripts/publish-starters.mjs …`);
  }
}

function cleanTreePreflight(deps) {
  const status = deps.exec('git', ['status', '--porcelain']);
  if (status.status !== 0) throw new Refusal(`git status failed: ${status.stderr ?? ''}`.trim());
  if (status.stdout.trim() !== '') {
    throw new Refusal(`the tree has uncommitted changes — publish and stage build from a commit, so commit or remove them first:\n${status.stdout.trimEnd()}`);
  }
}

function headSha(deps) {
  const r = deps.exec('git', ['rev-parse', 'HEAD']);
  if (r.status !== 0) throw new Refusal('git rev-parse HEAD failed');
  return r.stdout.trim();
}

function originMainPreflight(deps) {
  const fetch = deps.exec('git', ['fetch', '--quiet', 'origin', 'main']);
  if (fetch.status !== 0) throw new Refusal(`git fetch origin main failed — NOT VERIFIED that HEAD is the merged main: ${fetch.stderr ?? ''}`.trim());
  const head = headSha(deps);
  const origin = deps.exec('git', ['rev-parse', 'origin/main']).stdout.trim();
  if (head !== origin) {
    throw new Refusal(`HEAD ${head.slice(0, 7)} is not origin/main ${origin.slice(0, 7)} — publish only what main carries. In a worktree: git switch --detach origin/main`);
  }
  return head;
}

function registryPreflight(deps) {
  const registry = deps.exec('npm', ['config', 'get', 'registry']).stdout.trim();
  if (normalizeRegistry(registry) !== NPM_REGISTRY) {
    throw new Refusal(`npm's registry is ${registry}, not ${NPM_REGISTRY} — unset NPM_CONFIG_REGISTRY / the registry line in your .npmrc`);
  }
  const scoped = deps.exec('npm', ['config', 'get', `@${ORG}:registry`]).stdout.trim();
  if (scoped !== 'undefined' && scoped !== '' && normalizeRegistry(scoped) !== NPM_REGISTRY) {
    throw new Refusal(`@${ORG}:registry is ${scoped} — the package must go to ${NPM_REGISTRY}; remove that .npmrc line`);
  }
  const who = deps.exec('npm', ['whoami', ...PUBLISH_REGISTRY_ARGS]);
  if (who.status !== 0) throw new Refusal(`npm whoami failed (${(who.stderr ?? '').trim() || 'not logged in'}) — run: npm login (with 2FA), on Node 22`);
  return who.stdout.trim();
}

async function orgPreflight(deps) {
  let res;
  try {
    res = await deps.fetchImpl(`${NPM_REGISTRY}-/org/${ORG}/package`);
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    throw new Refusal(`NOT VERIFIED: the registry is unreachable (${netReason(err)}) — cannot confirm the @${ORG} org exists`);
  }
  if (res.status === 404) throw new Refusal(`the npm org "${ORG}" does not exist — create it (free, public packages) at https://www.npmjs.com/org/create, then re-run`);
  if (res.status !== 200) throw new Refusal(`NOT VERIFIED: the org lookup answered HTTP ${res.status}`);
}

/** The versions on the registry. An unreachable registry REFUSES — never "nothing published". */
async function registryVersions(deps, name) {
  let res;
  try {
    res = await deps.fetchImpl(packumentUrl(name));
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    throw new Refusal(`NOT VERIFIED: the registry is unreachable (${netReason(err)}) — cannot tell whether ${name} is already published`);
  }
  if (res.status === 404) return {};
  if (res.status !== 200) throw new Refusal(`NOT VERIFIED: the registry answered HTTP ${res.status} for ${name}`);
  return (await res.json()).versions ?? {};
}

function expectedFiles(index) {
  return [...Object.values(index.starters).map((s) => s.file), 'index.json', 'README.md', 'LICENSE', 'package.json'].sort();
}

async function stage(opts, deps) {
  nodePreflight(deps);
  cleanTreePreflight(deps);
  const pin = deps.readPin();
  let ref;
  if (opts.ref !== undefined) {
    const r = deps.exec('git', ['rev-parse', '--verify', `${opts.ref}^{commit}`]);
    if (r.status !== 0) throw new Refusal(`--ref ${opts.ref} is not a commit`);
    ref = r.stdout.trim();
  }
  const built = await deps.build({ ref: ref ?? headSha(deps), version: opts.ref ? undefined : pin.version });
  const version = built.index.version;
  const versions = await registryVersions(deps, pin.name);
  if (version in versions) throw new Refusal(`${pin.name}@${version} is already on the registry — its bytes are fixed; stage a new version instead`);
  const lock = deps.readLock() ?? { format: 'snug-starters-lock/1', name: pin.name, versions: {} };
  if (lock.versions[version]?.published) throw new Refusal(`the lock marks ${version} published — its bytes are immutable; bump the pin instead`);
  lock.versions[version] = lockEntryFromIndex(built.index, { ref });
  deps.writeLock(lock);
  deps.log(`publish-starters --stage: ${pin.name}@${version} → examples/starters-lock.json (${Object.keys(built.index.starters).length} starters${ref ? `, built from ${ref.slice(0, 7)}` : ''}) — commit it`);
  return { status: 'staged', version };
}

async function verifyAfterPublish(deps, { name, version, integrity, entry }) {
  let registry = 'NOT VERIFIED';
  for (let i = 0; i < REGISTRY_TRIES; i++) {
    let versions;
    try {
      versions = await registryVersions(deps, name);
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      versions = {};
    }
    const got = versions[version];
    if (got !== undefined) {
      const theirs = got.dist?.integrity;
      if (theirs !== undefined && theirs !== integrity) throw new Error(`FAILED: the registry's ${name}@${version} integrity ${theirs} ≠ the tarball we published ${integrity}`);
      registry = 'VERIFIED';
      break;
    }
    await deps.sleep(POLL_MS);
  }
  let cdn = 'VERIFIED';
  for (const [folder, expected] of Object.entries(entry.starters)) {
    let ok = false;
    for (let i = 0; i < CDN_TRIES && !ok; i++) {
      try {
        const res = await deps.fetchImpl(cdnUrl(name, version, `${folder}.js`));
        if (res.status === 200) {
          const body = typeof res.arrayBuffer === 'function' ? Buffer.from(await res.arrayBuffer()) : Buffer.from(await res.text(), 'utf8');
          const got = sha384(body);
          if (got !== expected) throw new Error(`FAILED: jsDelivr serves ${folder}.js@${version} hashing to ${got}; the lock says ${expected}`);
          ok = true;
          break;
        }
      } catch (err) {
        if (!isNetworkError(err)) throw err;
      }
      await deps.sleep(POLL_MS);
    }
    if (!ok) { cdn = 'NOT VERIFIED'; break; }
  }
  return { registry, cdn };
}

async function dryOrPublish(opts, deps) {
  nodePreflight(deps);
  cleanTreePreflight(deps);
  const head = originMainPreflight(deps);
  const user = registryPreflight(deps);
  await orgPreflight(deps);
  const pin = deps.readPin();
  const version = opts.version ?? pin.version;
  const versions = await registryVersions(deps, pin.name);
  if (version in versions) throw new Refusal(`${pin.name}@${version} is already on the registry — nothing to publish (an npm version can never be republished)`);
  const lock = deps.readLock();
  const entry = lock?.versions?.[version];
  if (entry === undefined) throw new Refusal(`examples/starters-lock.json has no entry for ${version} — stage it first: node scripts/publish-starters.mjs --stage`);
  if (version !== pin.version && entry.ref === undefined) {
    throw new Refusal(`${version} is not the pinned version (${pin.version}) and its lock entry has no ref — its bytes cannot be rebuilt from HEAD`);
  }
  const ref = entry.ref ?? head;
  const first = await deps.build({ ref, version });
  const second = await deps.build({ ref, version });
  if (first.index.version !== version) throw new Refusal(`the build at ${ref.slice(0, 7)} produced ${first.index.version}, not ${version}`);
  if (JSON.stringify(first.index) !== JSON.stringify(second.index)) throw new Refusal(`the build is not reproducible — two builds at ${ref.slice(0, 7)} differ`);
  const cmp = compareToLock({ index: first.index, lock: { ...lock, versions: { [version]: entry } } });
  if (cmp.status !== 'ok') throw new Refusal(`the build at ${ref.slice(0, 7)} does not match the lock for ${version} (${[...cmp.changed, ...cmp.added, ...cmp.removed].join(', ')}) — re-stage or fix the lock`);

  const packed = await deps.pack({ outDir: first.outDir });
  const want = expectedFiles(first.index);
  const got = [...packed.files].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Refusal(`the tarball's file list differs from the package allowlist:\n  packed:   ${got.join(', ')}\n  expected: ${want.join(', ')}`);
  const files = await deps.readTarball(packed.tarball);
  for (const s of Object.values(first.index.starters)) {
    const bytes = files[s.file];
    if (bytes === undefined || sha384(bytes) !== s.sha384) throw new Refusal(`${s.file} in the tarball does not hash to index.json's ${s.sha384}`);
  }
  let scrub;
  if (deps.scrub === null) {
    if (opts.mode === 'publish') throw new Refusal('the public scrub cannot run: scripts/check-public-scrub.mjs is absent here (it is gitignored — copy it and scrub-tokens.json into this checkout). An irreversible publish never skips it.');
    scrub = 'NOT VERIFIED (check-public-scrub absent)';
  } else {
    const violations = deps.scrub(files);
    if (violations.length > 0) throw new Refusal(`public scrub FAILED over the tarball:\n  ${violations.join('\n  ')}`);
    scrub = 'OK';
  }
  const npmVersion = deps.exec('npm', ['--version']).stdout.trim();
  const argv = ['npm', 'publish', packed.tarball, '--access', 'public', ...PUBLISH_REGISTRY_ARGS];
  deps.log(`publish-starters: ${pin.name}@${version} — every preflight passed`);
  deps.log(`  ref ${ref} · node ${deps.nodeVersion} · npm ${npmVersion} · npm user ${user}`);
  deps.log(`  tarball ${packed.tarball} · integrity ${packed.integrity} · ${got.length} files`);
  deps.log(`  scrub: ${scrub}`);
  deps.log(`  publish line: ${argv.join(' ')}${opts.mode === 'publish' ? '' : '   (dry run — re-run with --publish)'}`);
  if (opts.mode !== 'publish') return { status: 'ready', version, tarball: packed.tarball };

  const result = deps.exec('npm', [...argv.slice(1), ...(opts.otp ? [`--otp=${opts.otp}`] : [])], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`npm publish exited ${result.status} — nothing is marked published; check the registry before retrying`);
  const verified = await verifyAfterPublish(deps, { name: pin.name, version, integrity: packed.integrity, entry });
  lock.versions[version] = { ...entry, published: true, integrity: packed.integrity };
  deps.writeLock(lock);
  deps.log(`publish-starters: PUBLISHED ${pin.name}@${version} — registry ${verified.registry}, jsDelivr ${verified.cdn}${verified.cdn === 'VERIFIED' ? '' : ' (re-check: node scripts/check-starters-pin.mjs --online)'}`);
  deps.log('  journal: what, the UTC time, the integrity above, both verification results; commit examples/starters-lock.json');
  return { status: 'published', version, ...verified };
}

export async function runPublishStarters(opts, deps) {
  return opts.mode === 'stage' ? stage(opts, deps) : dryOrPublish(opts, deps);
}

// ---------------------------------------------------------------------------
// The real world
// ---------------------------------------------------------------------------

function run(cmd, args, { cwd = ROOT, stdio } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function must(r, what) {
  if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr.trim()}`);
  return r;
}

/** Build the package at `ref` with THAT commit's builder, then write today's publish metadata beside it. */
export async function realBuild({ root = ROOT, ref, version, outDir, name }) {
  // realpath: macOS's tmpdir is a symlink (/var → /private/var), and a builder whose argv[1]
  // spelling differs from its own import.meta.url skips its main block — silently, exit 0.
  const work = realpathSync(mkdtempSync(path.join(tmpdir(), 'snug-starters-src-')));
  const src = path.join(work, 'src');
  mkdirSync(src);
  must(run('git', ['-C', root, 'archive', '--format=tar', '-o', path.join(work, 'src.tar'), ref, 'examples', 'scripts/build-starters-pkg.mjs', 'scripts/lib', 'LICENSE']), `git archive ${ref}`);
  must(run('tar', ['-xf', path.join(work, 'src.tar'), '-C', src]), 'tar -x');
  const out = outDir ?? mkdtempSync(path.join(tmpdir(), 'snug-starters-out-'));
  must(run(process.execPath, [path.join(src, 'scripts/build-starters-pkg.mjs'), `--out=${out}`], { cwd: src }), `the builder at ${ref}`);
  if (!existsSync(path.join(out, 'index.json'))) throw new Error(`the builder at ${ref} wrote no index.json into ${out}`);
  const index = JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8'));
  if (version !== undefined && index.version !== version) throw new Refusal(`the pin at ${ref.slice(0, 7)} names ${index.version}, not ${version}`);
  if (name !== undefined && index.name !== name) throw new Refusal(`the pin at ${ref.slice(0, 7)} names ${index.name}, not ${name}`);
  writePackageFiles(out, { name: index.name, version: index.version, wrapperFiles: Object.values(index.starters).map((s) => s.file), licenseFile: path.join(root, 'LICENSE') });
  return { index, outDir: out };
}

export async function realPack({ outDir, dest = mkdtempSync(path.join(tmpdir(), 'snug-starters-pack-')) }) {
  const r = must(run('npm', ['pack', outDir, '--pack-destination', dest, '--json', '--ignore-scripts']), 'npm pack');
  const [info] = JSON.parse(r.stdout);
  return { tarball: path.join(dest, info.filename), integrity: info.integrity, files: info.files.map((f) => f.path) };
}

export async function realReadTarball(tarball) {
  const dir = mkdtempSync(path.join(tmpdir(), 'snug-starters-tgz-'));
  must(run('tar', ['-xzf', tarball, '-C', dir]), 'tar -xz');
  const base = path.join(dir, 'package');
  const files = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[path.relative(base, p)] = readFileSync(p);
    }
  };
  walk(base);
  return files;
}

async function loadScrub() {
  const tool = path.join(ROOT, 'scripts/check-public-scrub.mjs');
  if (!existsSync(tool)) return null;
  const { scanRepo } = await import(pathToFileURL(tool).href);
  return (files) => {
    const out = [];
    for (const [file, bytes] of Object.entries(files)) {
      bytes.toString('utf8').split('\n').forEach((line, i) => {
        for (const v of scanRepo.__scanText(line)) out.push(`${file}:${i + 1}: ${v.replace(/^<text>: /, '')}`);
      });
    }
    return out;
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const pinFile = path.join(ROOT, 'examples/starters-package.json');
    const result = await runPublishStarters(opts, {
      root: ROOT,
      nodeVersion: process.versions.node,
      exec: (cmd, args, o) => run(cmd, args, o),
      fetchImpl: (url) => fetch(url, { signal: AbortSignal.timeout(20_000) }),
      readPin: () => JSON.parse(readFileSync(pinFile, 'utf8')),
      readLock: () => (existsSync(LOCK_FILE) ? JSON.parse(readFileSync(LOCK_FILE, 'utf8')) : undefined),
      writeLock: (lock) => writeFileSync(LOCK_FILE, serializeLock(lock)),
      build: ({ ref, version }) => realBuild({ ref, version }),
      pack: realPack,
      readTarball: realReadTarball,
      scrub: await loadScrub(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (line) => console.log(line),
    });
    if (result.status === 'published' && result.cdn !== 'VERIFIED') process.exitCode = 0;
  } catch (err) {
    if (err instanceof UsageError) { console.error(err.message); process.exit(2); }
    if (err instanceof Refusal) { console.error(`publish-starters: REFUSED — ${err.message}`); process.exit(1); }
    console.error(`publish-starters: ${err.message}`);
    process.exit(1);
  }
}
