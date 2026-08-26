#!/usr/bin/env node
// release-helper.mjs — cut a HELPER release (ADR-0060). Mirrors release-desktop.mjs.
//
//   node scripts/release-helper.mjs            (helper = whatsapp-sidecar, version from its package.json)
//
//   1. REFUSE without TAURI_SIGNING_PRIVATE_KEY[_PATH] — archives are minisign-signed with
//      the SAME updater key (ADR-0060 §5), verified by the shell against tauri.conf.json's pubkey.
//   2. Build protocol + helper; pack BOTH arches (pack-helper.mjs; the native arch is smoked).
//   3. Sign each archive (`tauri signer sign`, .sig beside it) and write helper.json.
//   4. PRINT the `gh release create --prerelease` command and STOP. Creating the release is an
//      explicit human ask (PROCESS.md release rules; ADR-0047 §13). PRE-RELEASE is load-bearing:
//      GitHub's `releases/latest` — the desktop updater's endpoint — ignores pre-releases.
//
// Pure parts are exported for release-helper.test.mjs (root `check-release-helper`).

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR = path.join(ROOT, 'apps', 'whatsapp-sidecar');
const OUT_DIR = path.join(SIDECAR, 'release-out');

export const SEMVER = /^\d+\.\d+\.\d+$/;
export const ARCHES = ['aarch64', 'x86_64'];

/** The release tag. `helper-` prefix keeps helper tags apart from desktop `vX.Y.Z` tags. */
export function helperTag(name, version) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`helper name ${JSON.stringify(name)} is not a lowercase slug`);
  if (!SEMVER.test(version)) throw new Error(`helper version ${JSON.stringify(version)} is not semver`);
  return `helper-${name}-v${version}`;
}

export function helperAssets(name) {
  return ARCHES.flatMap((arch) => [`${name}-darwin-${arch}.tar.gz`, `${name}-darwin-${arch}.tar.gz.sig`]).concat(['helper.json']);
}

/** helper.json — what the shell reads first: sizes for the consent card, sums as belt beneath minisign. */
export function buildHelperJson({ name, version, nodeVersion, archives }) {
  const tag = helperTag(name, version);
  const assets = {};
  for (const arch of ARCHES) {
    const a = archives[arch];
    if (a === undefined) throw new Error(`no archive for ${arch}`);
    if (!/^[0-9a-f]{64}$/.test(a.sha256)) throw new Error(`bad sha256 for ${arch}`);
    if (!Number.isInteger(a.size) || a.size <= 0) throw new Error(`bad size for ${arch}`);
    if (!Number.isInteger(a.unpackedSize) || a.unpackedSize <= 0) throw new Error(`bad unpackedSize for ${arch}`);
    assets[arch] = { file: `${name}-darwin-${arch}.tar.gz`, sha256: a.sha256, size: a.size, unpackedSize: a.unpackedSize };
  }
  return { name, version, tag, nodeVersion, assets };
}

/**
 * The Rust pin the shell must carry for this release (ADR-0060 §3, review finding 2: the
 * signature binds bytes, not identity, so the shell pins CONTENT — per-arch sha256 + sizes —
 * and `helper.json` is display data). Printed so the owner pastes it into sidecar's
 * `REQUIRED_HELPERS`; `check-helper-pin` fails if the two ever disagree.
 */
export function rustPinSnippet(manifest) {
  const a = manifest.assets;
  return [
    `RequiredHelper {`,
    `    name: "${manifest.name}",`,
    `    version: "${manifest.version}",`,
    `    tag: "${manifest.tag}",`,
    `    aarch64: HelperAsset { sha256: "${a.aarch64.sha256}", size: ${a.aarch64.size}, unpacked_size: ${a.aarch64.unpackedSize} },`,
    `    x86_64: HelperAsset { sha256: "${a.x86_64.sha256}", size: ${a.x86_64.size}, unpacked_size: ${a.x86_64.unpackedSize} },`,
    `}`,
  ].join('\n');
}

/** PRINTED for the owner — never executed here. `--prerelease --latest=false` is what keeps releases/latest for the desktop (review finding 9). */
export function ghReleaseCommand(name, version) {
  const tag = helperTag(name, version);
  const files = helperAssets(name).map((f) => `apps/whatsapp-sidecar/release-out/${f}`).join(' ');
  return (
    `gh release create ${tag} --repo snugprotocol/snug --prerelease --latest=false ` +
    `--title "Snug helper: ${name} v${version}" ` +
    `--notes "On-demand helper for the Snug desktop app (ADR-0060). Downloaded by the app when an app needs it; not for manual install." ` +
    files
  );
}

export function signingKeyPlan(env) {
  if (!env.TAURI_SIGNING_PRIVATE_KEY && !env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    return { ok: false, reason: 'no TAURI_SIGNING_PRIVATE_KEY[_PATH] in the environment — helper archives must be minisign-signed with the updater key (ADR-0060 §5).' };
  }
  return { ok: true };
}

async function main() {
  const plan = signingKeyPlan(process.env);
  if (!plan.ok) {
    console.error(`REFUSED: ${plan.reason}`);
    process.exit(1);
  }
  const keyPath = (process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ?? '').replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
  if (keyPath !== '' && !existsSync(keyPath)) {
    console.error(`REFUSED: TAURI_SIGNING_PRIVATE_KEY_PATH points at ${keyPath}, which does not exist.`);
    process.exit(1);
  }
  const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '';

  console.log('· building protocol + helper');
  execSync('pnpm --filter @snugprotocol/protocol build && pnpm --filter whatsapp-sidecar build', { cwd: ROOT, stdio: 'inherit' });

  const { HELPER_NAME, helperVersion } = await import(path.join(SIDECAR, 'helper-tree.mjs'));
  const { pack } = await import(path.join(SIDECAR, 'pack-helper.mjs'));
  const name = HELPER_NAME;
  const version = helperVersion();
  const nativeArch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';

  const tag = helperTag(name, version);
  const existing = execSync(`gh release view ${tag} --repo snugprotocol/snug --json tagName 2>/dev/null || true`, { cwd: ROOT }).toString();
  if (existing.includes(tag)) {
    console.error(`REFUSED: release ${tag} already exists — bump apps/whatsapp-sidecar/package.json (a helper release is immutable; the shell pins its sha256).`);
    process.exit(1);
  }

  const { buildSharedTree } = await import(path.join(SIDECAR, 'pack-helper.mjs'));
  const shared = buildSharedTree();
  const archives = {};
  let nodeVersion;
  for (const arch of ARCHES) {
    console.log(`· packing ${arch}${arch === nativeArch ? ' (smoke-tested)' : ' (cross — verify under Rosetta)'}`);
    const r = await pack({ arch, outDir: OUT_DIR, smoke: arch === nativeArch, shared });
    archives[arch] = { sha256: r.sha256, size: r.size, unpackedSize: r.unpackedSize };
    nodeVersion = r.nodeVersion;
    console.log(`· signing ${path.basename(r.archive)}`);
    const keyArg = keyPath !== '' ? `-f "${keyPath}"` : `-k "${process.env.TAURI_SIGNING_PRIVATE_KEY}"`;
    execSync(`pnpm --filter desktop exec tauri signer sign ${keyArg} -p "${password}" "${r.archive}"`, { cwd: ROOT, stdio: 'inherit' });
    if (!existsSync(`${r.archive}.sig`)) throw new Error(`signing produced no ${r.archive}.sig`);
  }
  const manifest = buildHelperJson({ name, version, nodeVersion, archives });
  writeFileSync(path.join(OUT_DIR, 'helper.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const f of helperAssets(name)) {
    if (!existsSync(path.join(OUT_DIR, f))) throw new Error(`asset missing: ${f}`);
  }
  console.log(`\nstaged → ${OUT_DIR}`);
  console.log('\nPIN for apps/desktop/src-tauri/src/helper_install.rs REQUIRED_HELPERS (then run pnpm check-helper-pin):\n');
  console.log(rustPinSnippet(manifest));
  console.log('\nNEXT (explicit human ask required — PROCESS.md release rules):\n');
  console.log(`  ${ghReleaseCommand(name, version)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
