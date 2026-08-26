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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARCHES, helperArchiveName } from '../apps/whatsapp-sidecar/pack-helper.mjs';
import { SEMVER } from './release-desktop.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR = path.join(ROOT, 'apps', 'whatsapp-sidecar');
const OUT_DIR = path.join(SIDECAR, 'release-out');
/** THE PIN the shell include_str!s — written here, never by hand. */
const PIN_PATH = path.join(ROOT, 'apps', 'desktop', 'src-tauri', 'helpers.json');
export { ARCHES, SEMVER };

/** The release tag. `helper-` prefix keeps helper tags apart from desktop `vX.Y.Z` tags. */
export function helperTag(name, version) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`helper name ${JSON.stringify(name)} is not a lowercase slug`);
  if (!SEMVER.test(version)) throw new Error(`helper version ${JSON.stringify(version)} is not semver`);
  return `helper-${name}-v${version}`;
}

export function helperAssets(name) {
  return ARCHES.flatMap((arch) => [helperArchiveName(name, arch), `${helperArchiveName(name, arch)}.sig`]).concat(['helper.json']);
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
    assets[arch] = { file: helperArchiveName(name, arch), sha256: a.sha256, size: a.size, unpackedSize: a.unpackedSize };
  }
  return { name, version, tag, nodeVersion, assets };
}

/**
 * The pin file the shell include_str!s (ADR-0060 §3; review finding 2: the signature binds
 * bytes, not identity, so the shell pins CONTENT). Written by this script from the staged
 * manifest — the same object, minus the file names — so no human pastes hashes.
 */
export function buildPinFile(manifest) {
  const assets = {};
  for (const arch of ARCHES) {
    const a = manifest.assets[arch];
    assets[arch] = { sha256: a.sha256, size: a.size, unpackedSize: a.unpackedSize };
  }
  return {
    _comment:
      "THE HELPER PIN (ADR-0060 §3). Written by scripts/release-helper.mjs from the staged helper.json; include_str!'d by helper_install.rs; read by check-helper-pin.mjs and release-desktop.mjs (which also fetches the PUBLISHED helper.json for the tag and requires byte-equal sha256/sizes). Never edit by hand.",
    helpers: [{ name: manifest.name, version: manifest.version, tag: manifest.tag, nodeVersion: manifest.nodeVersion, assets }],
  };
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

/**
 * `tauri signer sign` takes the key by FILE (`-f`); the alternative, `-k <contents>`, puts
 * the private key on the command line (ps, shell history) and is never used here (review
 * finding). A contents-only environment is materialised into a 0600 temp file.
 */
export function signingKeyPlan(env) {
  if (!env.TAURI_SIGNING_PRIVATE_KEY && !env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    return { ok: false, reason: 'no TAURI_SIGNING_PRIVATE_KEY[_PATH] in the environment — helper archives must be minisign-signed with the updater key (ADR-0060 §5).' };
  }
  return { ok: true, viaFile: Boolean(env.TAURI_SIGNING_PRIVATE_KEY_PATH) };
}

async function main() {
  const plan = signingKeyPlan(process.env);
  if (!plan.ok) {
    console.error(`REFUSED: ${plan.reason}`);
    process.exit(1);
  }
  let keyPath = (process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ?? '').replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
  if (keyPath !== '' && !existsSync(keyPath)) {
    console.error(`REFUSED: TAURI_SIGNING_PRIVATE_KEY_PATH points at ${keyPath}, which does not exist.`);
    process.exit(1);
  }
  let tempKey;
  if (keyPath === '') {
    // contents-only: materialise to a 0600 file so the key never rides on argv
    tempKey = path.join(mkdtempSync(path.join(tmpdir(), 'snug-sign-')), 'key');
    writeFileSync(tempKey, process.env.TAURI_SIGNING_PRIVATE_KEY, { mode: 0o600 });
    keyPath = tempKey;
  }
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';

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
    // password via env (TAURI_SIGNING_PRIVATE_KEY_PASSWORD), never on argv
    execSync(`pnpm --filter desktop exec tauri signer sign -f "${keyPath}" "${r.archive}"`, { cwd: ROOT, stdio: 'inherit' });
    if (!existsSync(`${r.archive}.sig`)) throw new Error(`signing produced no ${r.archive}.sig`);
  }
  const manifest = buildHelperJson({ name, version, nodeVersion, archives });
  writeFileSync(path.join(OUT_DIR, 'helper.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const f of helperAssets(name)) {
    if (!existsSync(path.join(OUT_DIR, f))) throw new Error(`asset missing: ${f}`);
  }
  if (tempKey !== undefined) rmSync(path.dirname(tempKey), { recursive: true, force: true });
  writeFileSync(PIN_PATH, `${JSON.stringify(buildPinFile(manifest), null, 2)}\n`);
  console.log(`\nstaged → ${OUT_DIR}`);
  console.log(`pin written → ${PIN_PATH} (commit it with the release; check-helper-pin verifies it)`);
  console.log('\nNEXT (explicit human ask required — PROCESS.md release rules):\n');
  console.log(`  ${ghReleaseCommand(name, version)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
