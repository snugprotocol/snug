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
// Cargo appends .exe on Windows (see run-gate.mjs — the same hardcoded Unix
// name failed the CI windows leg with the binary built and present).
const exe = process.platform === 'win32' ? 'snug-desktop.exe' : 'snug-desktop';
const debugBinary = path.join(tauriDir, 'target', 'debug', exe);
const releaseBinary = path.join(tauriDir, 'target', 'release', exe);

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

/**
 * ADR-0047 §11 (TASK-20260821): strings that MUST be present in the release binary.
 * The production updater endpoint is baked in from tauri.conf.json; a release built
 * with the dev `--config` endpoint overlay (updater-dev.json) REPLACES it, so this
 * must-appear check is simultaneously the "no dev endpoint shipped" check — one
 * mechanism, self-controlling (a broken scan fails loudly instead of passing). Keep
 * byte-identical to `plugins.updater.endpoints[0]` / the playground releaseChannel
 * constant; updaterConfig.test.ts pins those two against each other.
 */
const MUST_APPEAR = [
  'https://github.com/snugprotocol/snug/releases/latest/download/latest.json',
  // ADR-0060: the helper download base, single-homed in helper_install.rs (HELPER_RELEASE_BASE).
  'https://github.com/snugprotocol/snug/releases/download/',
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
  // See run-gate.mjs: `.cmd` shims (pnpm/npm) need a shell on Windows or spawn
  // exits with a NULL status.
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
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

  // 4. MUST-APPEAR (ADR-0047 §11): the shipped client points at the PRODUCTION
  //    update channel. Absence means either the config lost its endpoint or the
  //    binary was built with the dev overlay — both unshippable.
  const releaseBuffer = fs.readFileSync(releaseBinary);
  const missingMustAppear = MUST_APPEAR.filter((n) => !containsNeedle(releaseBuffer, n));
  if (missingMustAppear.length > 0) {
    failures.push(
      `RELEASE BINARY LACKS THE PRODUCTION UPDATE ENDPOINT: ${missingMustAppear.join(', ')} — ` +
        'built with a dev endpoint overlay, or plugins.updater.endpoints was dropped (ADR-0047 §11).',
    );
  }
  console.log('\n═══ release inertness ═══');
  for (const needle of MUST_APPEAR) {
    const ok = !missingMustAppear.includes(needle);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  must-appear release=${ok ? 'present' : 'ABSENT'}  ${needle}`);
  }
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
