#!/usr/bin/env node
// install-helper.mjs — put the built helper where the desktop shell spawns it (DEVELOPER install).
//
//   pnpm --filter whatsapp-sidecar install:helper
//
// `sidecar_ctl` runs `<~/Snug>/helpers/whatsapp-sidecar/index.js` and never accepts that path
// from anywhere else (sidecar.rs, `helper_entry`). Public users get the same tree from the
// on-demand download (ADR-0060, `pack-helper.mjs`); this script is the developer's shortcut
// past the release. It writes a `kind: "dev"` helper.json stamp (a stamp-less tree counts as dev too),
// which the shell never overwrites and only reports against the pin (ADR-0060 §4) — and ships no `bin/node`,
// so the shell spawns the system `node` for it (the Node 20+ preflight applies).
//
// Peers (sharp & co) are kept here, exactly as before, so a developer's tree matches a plain
// `npm install` of baileys; the RELEASE archive omits them.

import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildHelperTree } from './helper-tree.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// The SAME rule the Rust side applies (`userfile::snug_dir` → `~/Snug`).
const target = path.join(homedir(), 'Snug', 'helpers', 'whatsapp-sidecar');

try {
  if (!existsSync(path.join(here, 'node_modules'))) throw new Error('dependencies missing: pnpm install');
  // Build BESIDE the target and swap only on success: a failing dev install (offline npm)
  // must not wipe a working downloaded tree and leave a stamp-less husk the downloader
  // refuses to touch (review: removed-behaviour 6).
  const staging = `${target}.dev-partial`;
  const { version } = buildHelperTree(staging, { omitPeers: false });
  // THE DEV STAMP (ADR-0060 §4): the downloader never overwrites a `dev` tree, and the
  // shell only reports (never blocks on) its version against the pin.
  writeFileSync(
    path.join(staging, 'helper.json'),
    `${JSON.stringify({ kind: 'dev', name: 'whatsapp-sidecar', version }, null, 2)}\n`,
  );
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
console.log(`installed → ${target}`);
console.log('the desktop shell will spawn: node ' + path.join(target, 'index.js'));
