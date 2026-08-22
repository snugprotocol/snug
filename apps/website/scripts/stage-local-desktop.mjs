// stage-local-desktop.mjs — AC12: copy the newest locally-built desktop DMG into
// public/local-artifacts/ so the download page serves it in local E2E mode
// (`PUBLIC_SITE_MODE=local`). The staging area is gitignored — a DMG must never ride
// into the repo.
//
// Build one first if the tree is empty:
//   pnpm --filter desktop tauri build   (or the release script — see ADR-0047)
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBSITE = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TARGET_ROOT = resolve(WEBSITE, '..', 'desktop', 'src-tauri', 'target');

function findDmgs(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      // node_modules-free tree, but skip incremental-build noise for speed
      if (name === 'build' || name === 'deps' || name === '.fingerprint' || name === 'incremental')
        continue;
      findDmgs(path, out);
    } else if (name.endsWith('.dmg') && !name.startsWith('rw.')) {
      // `rw.*.dmg` is create-dmg's intermediate read-write image, not the shippable one
      out.push({ path, mtime: stat.mtimeMs });
    }
  }
  return out;
}

const dmgs = findDmgs(TARGET_ROOT).sort((a, b) => b.mtime - a.mtime);
if (dmgs.length === 0) {
  console.error(`stage-local-desktop: no .dmg found under ${TARGET_ROOT}`);
  console.error('Build the shell first: pnpm --filter desktop tauri build');
  process.exit(1);
}

const newest = dmgs[0];
const outDir = join(WEBSITE, 'public', 'local-artifacts');
mkdirSync(outDir, { recursive: true });
const dest = join(outDir, 'Snug.dmg');
copyFileSync(newest.path, dest);
console.log(`stage-local-desktop: staged ${newest.path}`);
console.log(`  → ${dest}`);
console.log('Serve it with: pnpm --filter website dev:local (then /download)');
