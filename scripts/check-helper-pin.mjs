#!/usr/bin/env node
// check-helper-pin.mjs — ADR-0060 §3: the shell's REQUIRED_HELPERS pin must agree with the
// helper it was cut from. Root `pnpm test` runs this so a helper bump without a pin bump
// (or the reverse) reds the gate without needing cargo. The Rust test of the same name
// pins it again from the other side.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rs = readFileSync(path.join(ROOT, 'apps/desktop/src-tauri/src/helper_install.rs'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'apps/whatsapp-sidecar/package.json'), 'utf8'));

const block = /REQUIRED_HELPERS[\s\S]*?name:\s*"whatsapp-sidecar"[\s\S]*?version:\s*"([^"]+)"[\s\S]*?tag:\s*"([^"]+)"[\s\S]*?aarch64:[^}]*sha256:\s*"([0-9a-f]{64})"[^}]*size:\s*(\d+)[^}]*unpacked_size:\s*(\d+)[\s\S]*?x86_64:[^}]*sha256:\s*"([0-9a-f]{64})"[^}]*size:\s*(\d+)[^}]*unpacked_size:\s*(\d+)/.exec(rs);
if (block === null) { console.error('check-helper-pin: could not parse REQUIRED_HELPERS in helper_install.rs'); process.exit(1); }
const [, version, tag, shaA, sizeA, unA, shaX, sizeX, unX] = block;
const problems = [];
if (version !== pkg.version) problems.push(`pin version ${version} ≠ apps/whatsapp-sidecar/package.json ${pkg.version}`);
if (tag !== `helper-whatsapp-sidecar-v${version}`) problems.push(`tag ${tag} does not match version ${version}`);

// When a staged helper.json exists (release-out is gitignored), the pin must match it byte-for-byte.
const staged = path.join(ROOT, 'apps/whatsapp-sidecar/release-out/helper.json');
if (existsSync(staged)) {
  const m = JSON.parse(readFileSync(staged, 'utf8'));
  if (m.version === version) {
    const want = { aarch64: [shaA, +sizeA, +unA], x86_64: [shaX, +sizeX, +unX] };
    for (const arch of ['aarch64', 'x86_64']) {
      const a = m.assets[arch];
      const [sha, size, un] = want[arch];
      if (a.sha256 !== sha || a.size !== size || a.unpackedSize !== un) problems.push(`${arch} pin ≠ staged helper.json (sha/size/unpacked)`);
    }
  }
}
if (problems.length > 0) { for (const p of problems) console.error(`check-helper-pin: ${p}`); process.exit(1); }
console.log(`check-helper-pin: ok (${tag})`);
