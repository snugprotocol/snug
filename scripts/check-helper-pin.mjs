#!/usr/bin/env node
// check-helper-pin.mjs — ADR-0060 §3: the shell's pin (apps/desktop/src-tauri/helpers.json,
// include_str!'d by helper_install.rs) must agree with the helper it was cut from, and —
// when a staged helper.json exists (release-out is gitignored) — with it byte-for-byte.
// Root `pnpm test` runs this so a helper bump without a pin bump (or the reverse) reds the
// gate without cargo. The Rust test `the_pin_file_parses_and_names_a_published_shape` and
// release-desktop.mjs (which fetches the PUBLISHED helper.json) read the same file.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PIN_PATH = path.join(ROOT, 'apps/desktop/src-tauri/helpers.json');

export function readPin(file = PIN_PATH) {
  const pin = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(pin.helpers) || pin.helpers.length === 0) throw new Error('helpers.json has no helpers');
  return pin.helpers;
}

/** Pure: compare one pinned helper with a helper.json manifest (staged or published). */
export function pinMatchesManifest(pinned, manifest) {
  const problems = [];
  if (manifest.version !== pinned.version) problems.push(`version ${manifest.version} ≠ pin ${pinned.version}`);
  if (manifest.tag !== pinned.tag) problems.push(`tag ${manifest.tag} ≠ pin ${pinned.tag}`);
  for (const arch of ['aarch64', 'x86_64']) {
    const a = manifest.assets?.[arch];
    const p = pinned.assets?.[arch];
    if (a === undefined || p === undefined) { problems.push(`${arch} missing`); continue; }
    if (a.sha256 !== p.sha256 || a.size !== p.size || a.unpackedSize !== p.unpackedSize) problems.push(`${arch} sha/size/unpacked differ from the pin`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'apps/whatsapp-sidecar/package.json'), 'utf8'));
  const problems = [];
  const [pinned] = readPin();
  if (pinned.version !== pkg.version) problems.push(`pin version ${pinned.version} ≠ apps/whatsapp-sidecar/package.json ${pkg.version}`);
  if (pinned.tag !== `helper-whatsapp-sidecar-v${pinned.version}`) problems.push(`tag ${pinned.tag} does not match version ${pinned.version}`);
  const staged = path.join(ROOT, 'apps/whatsapp-sidecar/release-out/helper.json');
  if (existsSync(staged)) problems.push(...pinMatchesManifest(pinned, JSON.parse(readFileSync(staged, 'utf8'))).map((p) => `staged helper.json: ${p}`));
  if (problems.length > 0) { for (const p of problems) console.error(`check-helper-pin: ${p}`); process.exit(1); }
  console.log(`check-helper-pin: ok (${pinned.tag})`);
}
