// helper-tree.mjs — build a SELF-CONTAINED helper tree at a target directory.
//
// Shared by `install-helper.mjs` (the developer install into ~/Snug/helpers/) and
// `pack-helper.mjs` (the downloadable release archive, ADR-0060). One builder, so the two
// trees cannot drift: the shell spawns `<tree>/index.js` in both cases (sidecar.rs,
// `helper_entry`).

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const DIST = path.join(here, 'dist');
const PROTOCOL_SRC = path.join(ROOT, 'packages', 'protocol');

export const HELPER_NAME = 'whatsapp-sidecar';

function readJson(file) {
  return JSON.parse(execFileSync(process.execPath, ['-p', `JSON.stringify(require(${JSON.stringify(file)}))`]).toString());
}

/** The helper's own version — the one the shell pins (ADR-0060 §3). */
export function helperVersion() {
  return readJson(path.join(here, 'package.json')).version;
}

/**
 * The `npm install` argument list for the production tree.
 *
 * `--omit=peer` is what keeps sharp out (ADR-0060 §2): baileys declares `sharp` as a
 * NON-optional peer, so npm 7+ would auto-install it — 26 MB of libvips + a wasm twin for
 * media thumbnails the helper never makes. Its optional peers (jimp, link-preview-js,
 * audio-decode) ride out with it. Pure, so the test can pin the flag.
 */
export function npmInstallArgs({ baileysRange, zodRange, omitPeers }) {
  return [
    'install',
    '--omit=dev',
    ...(omitPeers ? ['--omit=peer', '--omit=optional'] : []),
    '--no-package-lock',
    '--no-audit',
    '--no-fund',
    `baileys@${baileysRange}`,
    `zod@${zodRange}`,
  ];
}

/**
 * Build the tree: dist/ at the root, an ESM package.json, a real production install, and
 * the workspace protocol package vendored in. See install-helper.mjs's history for why each
 * step exists (pnpm symlink farms, zod v3-vs-v4, the walking-up package.json).
 */
export function buildHelperTree(target, { omitPeers }) {
  if (!existsSync(DIST)) throw new Error('build first: pnpm --filter whatsapp-sidecar build');
  const protocolDist = path.join(PROTOCOL_SRC, 'dist');
  if (!existsSync(protocolDist)) {
    throw new Error('build the protocol package first: pnpm --filter @snugprotocol/protocol build');
  }
  const pkg = readJson(path.join(here, 'package.json'));
  const protocolPkg = readJson(path.join(PROTOCOL_SRC, 'package.json'));

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(DIST, target, { recursive: true });
  writeFileSync(
    path.join(target, 'package.json'),
    `${JSON.stringify({ name: 'snug-whatsapp-sidecar-helper', private: true, version: pkg.version, type: 'module', main: 'index.js' }, null, 2)}\n`,
  );
  execFileSync(
    'npm',
    npmInstallArgs({ baileysRange: pkg.dependencies.baileys, zodRange: protocolPkg.dependencies.zod, omitPeers }),
    { cwd: target, stdio: 'inherit' },
  );
  const protocolTarget = path.join(target, 'node_modules', '@snugprotocol', 'protocol');
  mkdirSync(protocolTarget, { recursive: true });
  cpSync(protocolDist, path.join(protocolTarget, 'dist'), { recursive: true });
  cpSync(path.join(PROTOCOL_SRC, 'package.json'), path.join(protocolTarget, 'package.json'));
  return { version: pkg.version };
}
