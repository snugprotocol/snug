#!/usr/bin/env node
// install-helper.mjs — put the built helper where the desktop shell spawns it.
//
//   pnpm --filter whatsapp-sidecar install:helper
//
// `sidecar_ctl` runs `node <~/Snug>/helpers/whatsapp-sidecar/index.js` and never accepts that
// path from anywhere else (sidecar.rs, `helper_entry`). This script is the other half of that
// contract: it copies `dist/` plus a production `node_modules` to exactly that location.
//
// DELIBERATELY A DEV/OWNER STEP, NOT A BUILD STEP. Packaging the helper into the app bundle is
// explicitly out of scope for TASK-20260816-whatsapp-twin (the task's own out-of-scope list),
// and v1 spawns the system `node`. This script exists so the pairing journey can be run and
// verified on real hardware without pretending the packaging question is answered.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
const modules = path.join(here, 'node_modules');

// The SAME rule the Rust side applies (`userfile::snug_dir` → `~/Snug`). Restated here rather
// than imported because this script runs outside the shell; the two are one line each and the
// target is asserted below by the shell's own failure if they ever disagree.
const target = path.join(homedir(), 'Snug', 'helpers', 'whatsapp-sidecar');

if (!existsSync(dist)) {
  console.error('build first: pnpm --filter whatsapp-sidecar build');
  process.exit(1);
}
if (!existsSync(modules)) {
  console.error('dependencies missing: pnpm install');
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

// `dist/` at the ROOT of the target: the shell spawns `<target>/index.js`, not `<target>/dist/index.js`.
cpSync(dist, target, { recursive: true });

// A `package.json` declaring ESM. WITHOUT IT node walks UP from the target looking for one,
// finds the user's home directory (or nothing), and either warns about reparsing or fails
// outright — caught by running the installed helper from its real location, which the
// in-workspace run could never surface because the workspace has its own package.json.
const pkg = JSON.parse(
  execFileSync(process.execPath, ['-p', 'JSON.stringify(require("./package.json"))'], { cwd: here }).toString(),
);
writeFileSync(
  path.join(target, 'package.json'),
  `${JSON.stringify({ name: 'snug-whatsapp-sidecar-helper', private: true, version: pkg.version, type: 'module', main: 'index.js' }, null, 2)}\n`,
);

// THE DEPENDENCIES, installed rather than copied.
//
// Copying pnpm's `node_modules` does not work and the failure is not obvious: pnpm's top level
// is a symlink farm holding only DIRECT dependencies, with transitive ones reachable through
// the store. Dereferencing that copy yields a tree where `baileys` is present and its own
// `protobufjs` is not — the helper starts, resolves its entry, and dies on the first import.
// So this runs a real production install into the target, which is the only way to get a
// self-contained tree.
// `zod` is installed EXPLICITLY, at the protocol package's own range, because the vendored
// `@snugprotocol/protocol` below needs it and npm cannot learn that from a workspace link. Left
// implicit, npm resolves whatever older zod some transitive dependency asks for, and the helper
// dies on `z.url is not a function` — a v4 API against a v3 install. Caught by running the
// INSTALLED helper; the in-workspace run resolves zod from the workspace and never sees it.
const protocolPkg = JSON.parse(
  execFileSync(process.execPath, ['-p', 'JSON.stringify(require("./package.json"))'], {
    cwd: path.join(here, '..', '..', 'packages', 'protocol'),
  }).toString(),
);

console.log('installing helper dependencies (production only)…');
execFileSync(
  'npm',
  [
    'install',
    '--omit=dev',
    '--no-package-lock',
    '--no-audit',
    '--no-fund',
    `baileys@${pkg.dependencies.baileys}`,
    `zod@${protocolPkg.dependencies.zod}`,
  ],
  { cwd: target, stdio: 'inherit' },
);

// `@snugprotocol/protocol` is a WORKSPACE package — npm cannot fetch it from a registry, and
// `router.js` imports `isAppReachableSidecarRoute` from it (the app-reachable route set, which
// this helper must not restate). So vendor the built package in beside the registry deps.
const protocolSrc = path.join(here, '..', '..', 'packages', 'protocol');
const protocolDist = path.join(protocolSrc, 'dist');
if (!existsSync(protocolDist)) {
  console.error('build the protocol package first: pnpm --filter @snugprotocol/protocol build');
  process.exit(1);
}
const protocolTarget = path.join(target, 'node_modules', '@snugprotocol', 'protocol');
mkdirSync(protocolTarget, { recursive: true });
cpSync(protocolDist, path.join(protocolTarget, 'dist'), { recursive: true });
cpSync(path.join(protocolSrc, 'package.json'), path.join(protocolTarget, 'package.json'));

console.log(`installed → ${target}`);
console.log('the desktop shell will spawn: node ' + path.join(target, 'index.js'));
