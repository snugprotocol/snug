#!/usr/bin/env node
// release-desktop.mjs — TASK-20260821-hardening-polish AC11 (ADR-0047 §§6-8).
//
// The desktop release pipeline, run BY THE OWNER on a Mac:
//
//   node scripts/release-desktop.mjs <semver>          # e.g. 0.1.0
//   node scripts/release-desktop.mjs <semver> --dry    # everything except gate+build
//
// Steps, in order — each refusal is loud and names its fix:
//   1. refuse unless <semver> has a matching NEWEST entry in
//      apps/playground/src/desktop/desktop-releases.json (release notes are part of a
//      release, not an afterthought — the ADR-0045 doctrine applied to the shell);
//   2. bump the THREE version declarations together (package.json, tauri.conf.json,
//      Cargo.toml — pinned in agreement by versionSync.test.ts);
//   3. run the desktop release gate (gate:release: debug surfaces absent from the
//      release binary) and then `tauri build --target universal-apple-darwin` with
//      updater artifacts; minisign signing rides TAURI_SIGNING_PRIVATE_KEY[_PATH]
//      (custody: ~/.tauri, ADR-0047 §4). Apple signing/notarization are ENV-GATED:
//      with APPLE_SIGNING_IDENTITY absent the build is unsigned and this script says
//      so loudly (the /download page carries the matching Gatekeeper disclosure);
//   4. stage release-out/ with the STABLE asset names the single-homed URLs expect
//      (Snug.dmg, Snug.app.tar.gz(.sig), latest.json, desktop-releases.json) — both
//      darwin platform keys point at the ONE universal artifact;
//   5. PRINT the `gh release create` command and STOP. Publishing needs an explicit
//      human ask in that session (PROCESS.md release rules; ADR-0047 §13) — this
//      script never talks to GitHub.
//
// The pure parts (validation, bumping, latest.json assembly, the asset plan) are
// exported for scripts/release-desktop.test.mjs, which root `pnpm test` runs via
// `check-release-desktop` (a node:test file with no runner is dead coverage —
// plan-review finding 15).

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const RELEASES_JSON = path.join(ROOT, 'apps', 'playground', 'src', 'desktop', 'desktop-releases.json');
const OUT_DIR = path.join(DESKTOP, 'release-out');
const UNIVERSAL_BUNDLE = path.join(DESKTOP, 'src-tauri', 'target', 'universal-apple-darwin', 'release', 'bundle');

export const SEMVER = /^\d+\.\d+\.\d+$/;

/** The stable asset names the playground's single-homed URLs expect (releaseChannel.ts). */
export const STABLE_ASSETS = ['Snug.dmg', 'Snug.app.tar.gz', 'Snug.app.tar.gz.sig', 'latest.json', 'desktop-releases.json'];

/** Refuse a release without a matching NEWEST notes entry. Returns the entry. */
export function changelogEntryFor(releasesRaw, version) {
  let data;
  try {
    data = JSON.parse(releasesRaw);
  } catch (err) {
    throw new Error(`desktop-releases.json is not valid JSON: ${err}`);
  }
  const releases = Array.isArray(data?.releases) ? data.releases : [];
  const newest = releases[0];
  if (newest === undefined) {
    throw new Error('desktop-releases.json has no releases — author the notes entry first');
  }
  if (newest.version !== version) {
    throw new Error(
      `desktop-releases.json's newest entry is v${newest.version}, not v${version} — ` +
        'author this release\'s notes (newest-first) before releasing it',
    );
  }
  return newest;
}

/** package.json / tauri.conf.json: parse, set version, re-serialize (2-space, trailing \n). */
export function bumpedJsonConfig(raw, version) {
  const data = JSON.parse(raw);
  data.version = version;
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** Cargo.toml: replace ONLY the [package] version line (the first in the file). */
export function bumpedCargoToml(raw, version) {
  let done = false;
  const out = raw.replace(/^version\s*=\s*"[^"]+"/m, () => {
    done = true;
    return `version = "${version}"`;
  });
  if (!done) throw new Error('Cargo.toml has no version line to bump');
  return out;
}

/**
 * latest.json for the Tauri updater. BOTH darwin keys point at the ONE universal
 * artifact (ADR-0047 §6); the url is the VERSIONED asset path, so a cached manifest
 * can never pair one release's signature with another's bytes.
 */
export function buildLatestJson({ version, pubDate, signature }) {
  if (!SEMVER.test(version)) throw new Error(`not a semver version: ${version}`);
  if (typeof signature !== 'string' || signature.length === 0) {
    throw new Error('missing updater signature (.sig contents)');
  }
  const url = `https://github.com/snugprotocol/snug/releases/download/v${version}/Snug.app.tar.gz`;
  const platform = { signature, url };
  return {
    version,
    pub_date: pubDate,
    platforms: { 'darwin-aarch64': platform, 'darwin-x86_64': platform },
  };
}

/** The gh command PRINTED for the owner — never executed here (PROCESS.md release rules). */
export function ghReleaseCommand(version) {
  const files = STABLE_ASSETS.map((name) => `release-out/${name}`).join(' ');
  return (
    `gh release create v${version} --repo snugprotocol/snug ` +
    `--title "Snug desktop v${version}" --notes "See desktop-releases.json / the in-app release notes." ` +
    files
  );
}

function findOne(dir, suffix) {
  const hits = readdirSync(dir).filter((f) => f.endsWith(suffix));
  if (hits.length !== 1) throw new Error(`expected exactly one *${suffix} in ${dir}, found ${hits.length}`);
  return path.join(dir, hits[0]);
}

async function main() {
  const [version, ...flags] = process.argv.slice(2);
  const dry = flags.includes('--dry');
  if (!version || !SEMVER.test(version)) {
    console.error('usage: node scripts/release-desktop.mjs <major.minor.patch> [--dry]');
    process.exit(2);
  }

  const entry = changelogEntryFor(readFileSync(RELEASES_JSON, 'utf8'), version);
  console.log(`✔ release notes present: v${entry.version} — ${entry.title ?? '(untitled)'} (${entry.date})`);

  const pkgPath = path.join(DESKTOP, 'package.json');
  const confPath = path.join(DESKTOP, 'src-tauri', 'tauri.conf.json');
  const cargoPath = path.join(DESKTOP, 'src-tauri', 'Cargo.toml');
  writeFileSync(pkgPath, bumpedJsonConfig(readFileSync(pkgPath, 'utf8'), version));
  writeFileSync(confPath, bumpedJsonConfig(readFileSync(confPath, 'utf8'), version));
  writeFileSync(cargoPath, bumpedCargoToml(readFileSync(cargoPath, 'utf8'), version));
  console.log(`✔ version ${version} written to package.json, tauri.conf.json, Cargo.toml`);

  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    console.error(
      'REFUSED: no TAURI_SIGNING_PRIVATE_KEY[_PATH] in the environment — updater artifacts ' +
        'must be minisign-signed (ADR-0047 §4; key custody ~/.tauri/snug-updater.key).',
    );
    process.exit(2);
  }
  const appleSigned = Boolean(process.env.APPLE_SIGNING_IDENTITY);
  if (!appleSigned) {
    console.warn(
      '⚠ APPLE_SIGNING_IDENTITY absent — building UNSIGNED (Gatekeeper right-click-open; ' +
        'the /download page must keep saying so). Wire the Developer ID env vars when available.',
    );
  }

  if (dry) {
    console.log('--dry: skipping gate:release, build, and staging.');
    console.log(`next (needs an explicit ask): ${ghReleaseCommand(version)}`);
    return;
  }

  console.log('running the desktop release gate…');
  execSync('pnpm --filter desktop gate:release', { cwd: ROOT, stdio: 'inherit' });
  console.log('building (universal-apple-darwin, updater artifacts)…');
  execSync('pnpm --filter desktop exec tauri build --target universal-apple-darwin', {
    cwd: ROOT,
    stdio: 'inherit',
  });

  const dmg = findOne(path.join(UNIVERSAL_BUNDLE, 'dmg'), '.dmg');
  const tarGz = findOne(path.join(UNIVERSAL_BUNDLE, 'macos'), '.app.tar.gz');
  const sig = `${tarGz}.sig`;
  if (!existsSync(sig)) throw new Error(`missing updater signature beside the artifact: ${sig}`);

  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(dmg, path.join(OUT_DIR, 'Snug.dmg'));
  copyFileSync(tarGz, path.join(OUT_DIR, 'Snug.app.tar.gz'));
  copyFileSync(sig, path.join(OUT_DIR, 'Snug.app.tar.gz.sig'));
  copyFileSync(RELEASES_JSON, path.join(OUT_DIR, 'desktop-releases.json'));
  const latest = buildLatestJson({
    version,
    pubDate: new Date().toISOString(),
    signature: readFileSync(sig, 'utf8'),
  });
  writeFileSync(path.join(OUT_DIR, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`✔ staged ${OUT_DIR} (${STABLE_ASSETS.join(', ')})${appleSigned ? '' : ' — UNSIGNED build'}`);

  console.log('\nThis script never publishes. When (and only when) the owner asks, run:');
  console.log(`  cd apps/desktop && ${ghReleaseCommand(version)}`);
  console.log('…and record the publish in the task journal (PROCESS.md release rules).');
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(String(err?.stack ?? err));
    process.exit(1);
  });
}
