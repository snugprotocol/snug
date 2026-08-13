#!/usr/bin/env node
// run-release-gate.mjs — release-inertness proof (TASK-20260812 P0 amendment 4,
// whole-surface review finding 3).
//
// WHY THIS EXISTS SEPARATELY. Amendment 4 promises that the debug host-remap and
// the gate commands are PHYSICALLY ABSENT from a release artifact — "no runtime
// strictness knob to leave off". Until now that promise was a journal assertion:
// the in-shell driver never built a release binary and never ran `strings`, so a
// refactor that dropped a `#[cfg(debug_assertions)]` would ship the gate surface
// into production and every check would still be green.
//
// THE POSITIVE CONTROL IS LOAD-BEARING. A grep that finds nothing proves nothing
// on its own — a typo'd needle, a stripped binary, or a `strings` that silently
// fails all look identical to success. So this leg asserts BOTH directions:
//   - the DEBUG binary CONTAINS every needle (the grep demonstrably works here);
//   - the RELEASE binary contains NONE of them (the actual claim).
// A needle missing from the debug binary fails the run as a broken control.
//
// It is deliberately NOT part of `pnpm --filter desktop gate`: a release build is
// slow, and the default gate must stay fast enough to run often. CI runs both.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tauriDir = path.join(desktopDir, 'src-tauri');
const manifest = path.join(tauriDir, 'Cargo.toml');
const debugBinary = path.join(tauriDir, 'target', 'debug', 'snug-desktop');
const releaseBinary = path.join(tauriDir, 'target', 'release', 'snug-desktop');

/**
 * The gate surface that must not exist in a shipped binary: the two original
 * command names, the env var that arms them, and the sentinel probe added by
 * finding 2. Command names appear in a release binary only if the
 * `#[cfg(debug_assertions)]` guard on gate.rs or on the handler list is lost.
 */
const NEEDLES = [
  'shell_gate_config',
  'write_gate_results',
  'gate_ipc_sentinel_exists',
  'SNUG_SHELL_GATE',
];

function log(msg) {
  console.log(`[release-gate] ${msg}`);
}

function fail(msg) {
  console.error(`[release-gate] FATAL: ${msg}`);
  process.exit(1);
}

function sh(cmd, args) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.status !== 0) fail(`${cmd} exited ${res.status}`);
}

/**
 * Byte-level search over the whole binary. Deliberately NOT `strings(1)`: it is
 * absent on Windows runners and its minimum-run heuristics could hide a needle.
 * Reading the file and scanning for the ASCII bytes has neither problem.
 */
function containsNeedle(buffer, needle) {
  return buffer.includes(Buffer.from(needle, 'ascii'));
}

function scan(label, binaryPath) {
  if (!fs.existsSync(binaryPath)) fail(`${label} binary missing at ${binaryPath}`);
  const buffer = fs.readFileSync(binaryPath);
  const found = NEEDLES.filter((n) => containsNeedle(buffer, n));
  log(`${label}: ${found.length}/${NEEDLES.length} needles present (${(buffer.length / 1e6).toFixed(1)} MB)`);
  return found;
}

function main() {
  // 1. Both artifacts, from the same sources. The debug build uses the same
  //    feature set the in-shell gate uses, so this scans exactly what that runs.
  sh('cargo', ['build', '--manifest-path', manifest, '--features', 'tauri/custom-protocol']);
  sh('cargo', ['build', '--manifest-path', manifest, '--release']);

  const inDebug = scan('debug  ', debugBinary);
  const inRelease = scan('release', releaseBinary);

  const failures = [];

  // 2. POSITIVE CONTROL: the search must demonstrably work on this platform.
  const missingFromDebug = NEEDLES.filter((n) => !inDebug.includes(n));
  if (missingFromDebug.length > 0) {
    failures.push(
      `BROKEN POSITIVE CONTROL — the debug binary does not contain ${missingFromDebug.join(', ')}. ` +
        'Either the needle is stale or the scan does not work here; a clean release scan would be meaningless.',
    );
  }

  // 3. THE CLAIM: none of it ships.
  if (inRelease.length > 0) {
    failures.push(
      `RELEASE BINARY CARRIES THE GATE SURFACE: ${inRelease.join(', ')} — ` +
        'a #[cfg(debug_assertions)] guard has been lost (P0 amendment 4).',
    );
  }

  console.log('\n═══ release inertness ═══');
  for (const needle of NEEDLES) {
    const d = inDebug.includes(needle) ? 'present' : 'ABSENT';
    const r = inRelease.includes(needle) ? 'PRESENT' : 'absent';
    const ok = inDebug.includes(needle) && !inRelease.includes(needle);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${needle.padEnd(26)} debug=${d.padEnd(8)} release=${r}`);
  }

  if (failures.length > 0) {
    console.error(`\n✗ RELEASE GATE FAILED — ${failures.length} problem(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n✓ RELEASE GATE GREEN — gate surface present in debug, absent from release');
  process.exit(0);
}

main();
