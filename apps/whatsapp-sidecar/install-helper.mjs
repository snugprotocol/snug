#!/usr/bin/env node
// install-helper.mjs — put the built helper where the desktop shell spawns it (DEVELOPER install).
//
//   pnpm --filter whatsapp-sidecar install:helper
//
// `sidecar_ctl` runs `<~/Snug>/helpers/whatsapp-sidecar/index.js` and never accepts that path
// from anywhere else (sidecar.rs, `helper_entry`). Public users get the same tree from the
// on-demand download (ADR-0060, `pack-helper.mjs`); this script is the developer's shortcut
// past the release. It writes NO `helper.json` stamp — a stamp-less tree is a dev install,
// which the shell never version-checks or overwrites (ADR-0060 §4) — and ships no `bin/node`,
// so the shell spawns the system `node` for it (the Node 20+ preflight applies).
//
// Peers (sharp & co) are kept here, exactly as before, so a developer's tree matches a plain
// `npm install` of baileys; the RELEASE archive omits them.

import { homedir } from 'node:os';
import path from 'node:path';

import { buildHelperTree } from './helper-tree.mjs';

// The SAME rule the Rust side applies (`userfile::snug_dir` → `~/Snug`).
const target = path.join(homedir(), 'Snug', 'helpers', 'whatsapp-sidecar');

try {
  buildHelperTree(target, { omitPeers: false });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
console.log(`installed → ${target}`);
console.log('the desktop shell will spawn: node ' + path.join(target, 'index.js'));
