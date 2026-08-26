#!/usr/bin/env node
// pack-helper.mjs — the DOWNLOADABLE helper archive (ADR-0060 §2).
//
//   node apps/whatsapp-sidecar/pack-helper.mjs --arch aarch64|x86_64 [--out <dir>]
//
// Produces `<out>/whatsapp-sidecar-darwin-<arch>.tar.gz` containing, at the root:
//   index.js …            the built helper (dist/)
//   package.json          ESM marker
//   node_modules/         production install WITHOUT sharp/peers (helper-tree.mjs)
//   bin/node              the official Node.js binary for <arch>, verified against the
//                         sha256 pinned in node-runtime.json (never the live SHASUMS file)
// The shell spawns `<tree>/bin/node <tree>/index.js` when bin/node exists (sidecar.rs).
// Signing (minisign, updater key) and helper.json are `scripts/release-helper.mjs`'s job.
//
// The pure parts are exported for pack-helper.test.mjs (root `check-pack-helper`).

import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HELPER_NAME, buildHelperTree } from './helper-tree.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ARCHES = ['aarch64', 'x86_64'];
const NODE_ARCH = { aarch64: 'arm64', x86_64: 'x64' };

export function helperArchiveName(name, arch) {
  if (!ARCHES.includes(arch)) throw new Error(`unknown arch ${arch} — one of ${ARCHES.join(', ')}`);
  return `${name}-darwin-${arch}.tar.gz`;
}

export function nodeTarballName(version, arch) {
  return `node-v${version}-darwin-${NODE_ARCH[arch]}.tar.gz`;
}

export function nodeDownloadUrl(version, arch) {
  return `https://nodejs.org/dist/v${version}/${nodeTarballName(version, arch)}`;
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Refuse a runtime whose bytes do not match the PINNED sum (ADR-0060 §2). */
export function checkNodeRuntime(bytes, pinned, arch) {
  const expected = pinned.sha256?.[arch];
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
    return { ok: false, reason: `node-runtime.json has no sha256 for ${arch}` };
  }
  const actual = sha256Hex(bytes);
  if (actual !== expected) {
    return { ok: false, reason: `Node ${pinned.version} ${arch} sha256 mismatch: pinned ${expected}, got ${actual}` };
  }
  return { ok: true };
}

/** Every path the archive MUST carry, and every path it MUST NOT (AC3). */
export const REQUIRED_PATHS = [
  'index.js',
  'package.json',
  'bin/node',
  'node_modules/baileys/package.json',
  'node_modules/zod/package.json',
  'node_modules/@snugprotocol/protocol/package.json',
];
export const FORBIDDEN_PREFIXES = ['node_modules/@img/', 'node_modules/sharp/', 'node_modules/jimp/', 'node_modules/.bin/'];

/**
 * `paths` is a list of `{ path, symlink }` (or bare strings for regular files). Symlinks are
 * refused OUTRIGHT: the shell's extractor admits none (ADR-0060 §7), and npm's only ones
 * are `node_modules/.bin/*`, which the helper never invokes — deleted at pack time.
 */
export function checkPackedTree(entries) {
  const paths = entries.map((e) => (typeof e === 'string' ? e : e.path));
  const symlinks = entries.filter((e) => typeof e !== 'string' && e.symlink).map((e) => e.path);
  const set = new Set(paths);
  const missing = REQUIRED_PATHS.filter((p) => !set.has(p));
  const forbidden = paths.filter((p) => FORBIDDEN_PREFIXES.some((f) => p.startsWith(f))).concat(symlinks);
  if (missing.length > 0 || forbidden.length > 0) {
    return { ok: false, missing, forbidden };
  }
  return { ok: true, missing: [], forbidden: [] };
}

export function pruneEmptyDirs(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) pruneEmptyDirs(path.join(dir, entry.name));
  }
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
}

/** Files AND directories (an empty forbidden dir must still be seen). */
function walk(dir, base = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    if (entry.isSymbolicLink()) out.push({ path: rel, symlink: true });
    else if (entry.isDirectory()) {
      out.push({ path: `${rel}/`, symlink: false, dir: true });
      out.push(...walk(path.join(dir, entry.name), rel));
    } else out.push({ path: rel, symlink: false });
  }
  return out;
}

/** Fetch the pinned Node tarball (cached under <out>/.node-cache) and return its `bin/node`. */
async function fetchNodeBinary(pinned, arch, cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const tarball = path.join(cacheDir, nodeTarballName(pinned.version, arch));
  if (!existsSync(tarball)) {
    const url = nodeDownloadUrl(pinned.version, arch);
    console.log(`· fetching ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Node download failed: ${res.status} ${url}`);
    writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  }
  const verdict = checkNodeRuntime(readFileSync(tarball), pinned, arch);
  if (!verdict.ok) {
    rmSync(tarball, { force: true });
    throw new Error(`REFUSED: ${verdict.reason}`);
  }
  const extractDir = mkdtempSync(path.join(tmpdir(), 'snug-node-'));
  execFileSync('/usr/bin/tar', ['-xzf', tarball, '-C', extractDir, '--strip-components=1', '*/bin/node', '*/LICENSE'], { stdio: 'inherit' });
  const bin = path.join(extractDir, 'bin', 'node');
  if (!existsSync(bin)) throw new Error(`Node tarball did not contain bin/node (${tarball})`);
  return { bin, license: path.join(extractDir, 'LICENSE') };
}

/**
 * Start the packed helper exactly as the shell would and require it to survive 600 ms —
 * the same survival window `start_helper` uses. Catches "peer omitted, first import dies".
 * Only the NATIVE arch is smoked; the other arch is verified by the owner under Rosetta.
 */
export async function smokePackedTree(tree) {
  const socket = path.join(mkdtempSync(path.join(tmpdir(), 'snug-smoke-')), 'h.sock');
  const child = spawn(path.join(tree, 'bin', 'node'), ['--enable-source-maps', path.join(tree, 'index.js')], {
    env: { ...process.env, SNUG_SIDECAR_SOCKET: socket, SNUG_SIDECAR_NONCE: 'smoke' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig })));
  const outcome = await Promise.race([exited, new Promise((r) => setTimeout(() => r('alive'), 600))]);
  child.kill('SIGTERM');
  if (outcome !== 'alive') throw new Error(`packed helper died at start (${JSON.stringify(outcome)}): ${stderr.slice(-400)}`);
}

/**
 * Build the arch-INDEPENDENT tree once. With peers omitted the install is pure JS, so both
 * arch archives share one resolution (review finding 16: `--no-package-lock` per arch could
 * otherwise resolve different transitive versions). Returns the staged tree path.
 */
export function buildSharedTree() {
  const stage = mkdtempSync(path.join(tmpdir(), 'snug-helper-pack-'));
  const tree = path.join(stage, HELPER_NAME);
  const { version } = buildHelperTree(tree, { omitPeers: true });
  // npm's `.bin/` is a symlink farm; the helper never invokes it and the extractor refuses symlinks.
  rmSync(path.join(tree, 'node_modules', '.bin'), { recursive: true, force: true });
  // Omitted peers leave empty scope dirs behind (`node_modules/@img/`); prune them so the
  // forbidden-prefix check sees the truth and the archive carries nothing it does not need.
  pruneEmptyDirs(path.join(tree, 'node_modules'));
  return { tree, version };
}

export async function pack({ arch, outDir, smoke, shared }) {
  const pinned = JSON.parse(readFileSync(path.join(here, 'node-runtime.json'), 'utf8'));
  const { tree: sharedTree, version } = shared ?? buildSharedTree();
  const stage = mkdtempSync(path.join(tmpdir(), 'snug-helper-pack-'));
  const tree = path.join(stage, HELPER_NAME);
  cpSync(sharedTree, tree, { recursive: true, verbatimSymlinks: true });
  const node = await fetchNodeBinary(pinned, arch, path.join(outDir, '.node-cache'));
  mkdirSync(path.join(tree, 'bin'), { recursive: true });
  execFileSync('cp', [node.bin, path.join(tree, 'bin', 'node')]);
  chmodSync(path.join(tree, 'bin', 'node'), 0o755);
  if (existsSync(node.license)) execFileSync('cp', [node.license, path.join(tree, 'bin', 'LICENSE-node')]);

  const verdict = checkPackedTree(walk(tree));
  if (!verdict.ok) {
    throw new Error(`REFUSED: packed tree missing ${JSON.stringify(verdict.missing)}, forbidden ${JSON.stringify(verdict.forbidden)}`);
  }
  if (smoke) await smokePackedTree(tree);

  mkdirSync(outDir, { recursive: true });
  const archive = path.join(outDir, helperArchiveName(HELPER_NAME, arch));
  rmSync(archive, { force: true });
  // Root-relative entries, no owner names, no xattrs: what the shell's extractor admits.
  execFileSync('/usr/bin/tar', ['--no-xattrs', '--uid', '0', '--gid', '0', '-czf', archive, '-C', tree, '.'], { stdio: 'inherit' });
  const bytes = readFileSync(archive);
  const unpackedSize = walk(tree).filter((e) => !e.dir).reduce((n, e) => n + statSync(path.join(tree, e.path)).size, 0);
  rmSync(stage, { recursive: true, force: true });
  return { archive, version, size: statSync(archive).size, unpackedSize, sha256: sha256Hex(bytes), nodeVersion: pinned.version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arch = args[args.indexOf('--arch') + 1];
  const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(here, 'release-out');
  const smoke = !args.includes('--no-smoke');
  pack({ arch, outDir, smoke })
    .then((r) => console.log(`packed → ${r.archive} (${(r.size / 1048576).toFixed(1)} MB, sha256 ${r.sha256})`))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
