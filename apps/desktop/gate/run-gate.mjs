#!/usr/bin/env node
// run-gate.mjs — the in-shell hard-gate driver (TASK-20260812 P4, AC7/AC8).
//
// WHAT IT RUNS AND WHY THIS SHAPE. `tauri-driver` has no macOS support, so the
// gate is self-driving: the DEBUG shell binary is launched with the gate env,
// the webview harness (src/gate/**) executes every check inside the real
// WKWebView, and the Rust `write_gate_results` command (debug builds only)
// drops one JSON verdict file this driver awaits.
//
// DEBUG SHELL + BUILT BUNDLE: `cargo build --features tauri/custom-protocol`.
// The debug profile keeps `debug_assertions` (gate commands exist), while the
// `custom-protocol` feature makes Tauri serve the PREBUILT ../dist over
// tauri:// exactly as a release build would (`tauri::is_dev()` is
// `!cfg!(feature = "custom-protocol")` — verified against tauri 2.11.5). So the
// gate exercises the shipping bundle and the shipping origin posture, with the
// only delta being the debug-only gate/remap commands.
//
// STUBS: exactly ONE — net-stub.mjs (P0 amendment 3), in its env-gated http
// mode (the shell's reqwest fetch has deliberately no self-signed-cert trust
// knob). The journey's provider host resolves to it via the debug host remap
// passed through SNUG_SHELL_GATE_REMAP — this driver is the ONLY place the
// host→stub mapping exists (the Node twin of Playwright's
// --host-resolver-rules; the TS bundle carries no remap strings).
//
// FAIL-LOUD CONTRACT: every expected check id and journey step must be present
// and passing; a missing verdict, a fatal harness report, a dead app process,
// or a timeout all exit nonzero. There is no app-absent silent skip.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(desktopDir, '..', '..');
const distDir = path.join(desktopDir, 'dist');
const tauriDir = path.join(desktopDir, 'src-tauri');
const binaryPath = path.join(tauriDir, 'target', 'debug', 'snug-desktop');
const stubScript = path.join(repoRoot, 'apps', 'playground', 'e2e', 'fixtures', 'net-stub.mjs');

const STUB_PORT = Number(process.env.SNUG_GATE_STUB_PORT ?? 43120);
/** The journey host (driver-owned, NEVER in the bundle): the demo brain's
 *  `?demoreq=coinbase` app dials this declared provider host. */
const JOURNEY_HOST = 'api.meridian-exchange.example';
const RESULTS_TIMEOUT_MS = 10 * 60 * 1000;

const EXPECTED_IPC_IDS = [
  'ipc-tauri-internals-absent',
  'ipc-tauri-global-absent',
  'ipc-chrome-webview-absent',
  'ipc-invoke-refused',
];
const EXPECTED_HARNESS_IDS_STATIC = [
  'env-sqljs-loads',
  'env-crypto-usable',
  'remap-armed-from-config',
  'remap-inert-without-config',
  'csp-check-count',
];
/** The close-flush proof (review finding 4) — see runPersistLegs. */
const EXPECTED_PERSIST_IDS = ['persist-write-staged', 'persist-survives-window-close'];
const EXPECTED_JOURNEY_STEPS = [
  'boot-app',
  'build-app',
  'open-wizard',
  'approve-connection',
  'register-continue',
  'fill-credentials-and-save',
  'wizard-done',
  'no-secrets-in-dom-after-wizard',
  'run-app',
  'iframe-net-request-observed',
  'stub-saw-signed-headers',
  'sandboxed-reply-rendered',
  'no-secrets-in-dom-final',
];

function log(msg) {
  console.log(`[gate] ${msg}`);
}

function fail(msg) {
  console.error(`[gate] FATAL: ${msg}`);
  process.exit(1);
}

function sh(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) fail(`${cmd} exited ${res.status}`);
}

/** The 14 check ids straight from the runner's shipped dist — the same source
 *  of truth the harness imports, so a template drift fails HERE, not silently. */
async function loadCspCheckIds() {
  const { JSDOM } = await import('jsdom');
  if (typeof globalThis.DOMParser === 'undefined') {
    globalThis.DOMParser = new JSDOM('').window.DOMParser;
  }
  const { BROWSER_CSP_CHECKS } = await import('@snugprotocol/runner');
  if (BROWSER_CSP_CHECKS.length !== 14) {
    fail(`runner template carries ${BROWSER_CSP_CHECKS.length} checks — the C2 gate is pinned at 14`);
  }
  return BROWSER_CSP_CHECKS.map((c) => c.id);
}

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * remap-absent-from-release-bundle (P0 amendment 4). Two assertions:
 *   1. no dist asset contains the remap TARGET string (http://127.0.0.1:<port>)
 *      — the mapping exists only in this driver's env, never in the bundle;
 *   2. no desktop source (TS or Rust) contains the journey host literal — the
 *      remap table is populated exclusively from the debug-only Rust config.
 * The provider HOSTNAME does appear in the dist via the playground's
 * `?demoreq=` demo-brain seam — a pre-existing e2e seam shipped in every web
 * build by design, which maps nothing to loopback — so the hostname alone is
 * deliberately not the assertion.
 */
function checkRemapAbsentFromBundle() {
  const problems = [];
  const target = `http://127.0.0.1:${STUB_PORT}`;
  for (const file of walkFiles(distDir)) {
    if (!/\.(js|mjs|css|html)$/.test(file)) continue;
    if (fs.readFileSync(file, 'utf8').includes(target)) {
      problems.push(`dist asset ${path.relative(desktopDir, file)} contains remap target ${target}`);
    }
  }
  const srcRoots = [path.join(desktopDir, 'src'), path.join(tauriDir, 'src')];
  for (const root of srcRoots) {
    for (const file of walkFiles(root)) {
      if (!/\.(ts|tsx|rs)$/.test(file)) continue;
      if (fs.readFileSync(file, 'utf8').toLowerCase().includes('meridian')) {
        problems.push(`desktop source ${path.relative(desktopDir, file)} carries the journey host literal`);
      }
    }
  }
  return {
    id: 'remap-absent-from-release-bundle',
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? 'no remap target string in dist; no journey-host literal in desktop TS/Rust sources'
        : problems.join('; '),
  };
}

/**
 * THE CLOSE-FLUSH PROOF (ADR-0021 §5, whole-surface review finding 4).
 *
 * Two shell processes over ONE `~/Snug/user.sqlite` in a fresh throwaway home:
 *
 *   persist-write   mutates the db and leaves the write in the 250ms debounce
 *                   (never calls flush), then closes the window — which fires
 *                   CloseRequested and the flush handshake. The driver waits for
 *                   the PROCESS TO EXIT, so a window that refuses to close is a
 *                   failure here rather than a hang.
 *   persist-verify  reopens the same file and asserts the row survived.
 *
 * Delete the Rust CloseRequested handler (or the webview half) and persist-verify
 * goes red — which is exactly what makes this a proof and not a restatement.
 */
async function runPersistLegs(workDir, children) {
  const home = path.join(workDir, 'persist-home');
  fs.mkdirSync(home, { recursive: true });
  const checks = [];

  for (const phase of ['persist-write', 'persist-verify']) {
    const out = path.join(workDir, `${phase}.json`);
    log(`persist leg: ${phase}…`);
    const proc = spawn(binaryPath, [], {
      env: {
        ...process.env,
        HOME: home,
        SNUG_SHELL_GATE: '1',
        SNUG_SHELL_GATE_OUT: out,
        SNUG_SHELL_GATE_PHASE: phase,
      },
      stdio: 'inherit',
    });
    children.push(proc);

    // persist-write must EXIT on its own (that is the close working). For
    // persist-verify the results file is enough; it is killed after.
    const exited = new Promise((resolve) => proc.on('exit', resolve));
    const legDeadline = Date.now() + 120_000;
    let timedOut = false;
    while (!fs.existsSync(out)) {
      if (proc.exitCode !== null) break;
      if (Date.now() > legDeadline) {
        timedOut = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (timedOut) {
      checks.push({
        id: phase === 'persist-write' ? 'persist-write-staged' : 'persist-survives-window-close',
        pass: false,
        detail: `${phase} produced no results within 120s`,
      });
      proc.kill('SIGKILL');
      continue;
    }
    await new Promise((r) => setTimeout(r, 500));

    if (phase === 'persist-write') {
      // Let the close handshake run to completion before killing the process.
      // Deliberately NOT asserted here: on macOS an app outlives its last
      // window by design, so "did the process exit?" would test platform
      // convention rather than the flush. The claim is proven on DISK by
      // `persist-survives-window-close` — the canary row only gets there if
      // CloseRequested → flush → close_flush_done actually ran, and the Rust
      // deadline guarantees the window goes away even if the webview wedges.
      await Promise.race([exited, new Promise((r) => setTimeout(r, 8_000))]);
      proc.kill('SIGTERM');
    } else {
      proc.kill('SIGTERM');
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
      if (typeof parsed.fatal === 'string') {
        checks.push({ id: `${phase}-fatal`, pass: false, detail: parsed.fatal });
      }
      for (const c of parsed.checks ?? []) checks.push(c);
    } catch (err) {
      checks.push({ id: `${phase}-results`, pass: false, detail: `unreadable results: ${err}` });
    }
  }
  return checks;
}

async function waitForStub() {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${STUB_PORT}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) fail('net stub never answered /healthz');
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  const cspIds = await loadCspCheckIds();

  // 1. Web bundle — build only if missing (SNUG_GATE_REBUILD_WEB=1 forces).
  if (!fs.existsSync(path.join(distDir, 'index.html')) || process.env.SNUG_GATE_REBUILD_WEB === '1') {
    log('building web bundle (pnpm --filter desktop build:web)…');
    sh('pnpm', ['--filter', 'desktop', 'build:web'], { cwd: repoRoot });
  } else {
    log('dist/ present — skipping web build (SNUG_GATE_REBUILD_WEB=1 to force)');
  }

  // 2. Debug shell with the built bundle embedded (see header).
  sh('cargo', ['build', '--manifest-path', path.join(tauriDir, 'Cargo.toml'), '--features', 'tauri/custom-protocol'], {
    cwd: desktopDir,
  });
  if (!fs.existsSync(binaryPath)) fail(`debug binary missing at ${binaryPath}`);

  // 3. The ONE stub, http mode (env-gated; https e2e behavior untouched).
  log(`starting net stub (http mode) on 127.0.0.1:${STUB_PORT}…`);
  const stub = spawn('node', [stubScript], {
    env: { ...process.env, SNUG_NET_STUB_HTTP: '1', SNUG_E2E_NET_STUB_PORT: String(STUB_PORT) },
    stdio: 'inherit',
  });
  const children = [stub];
  const cleanup = () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  await waitForStub();

  // 4. Launch the shell in gate mode, isolated: a throwaway HOME so the
  // journey's user.sqlite never touches the real ~/Snug.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snug-shell-gate-'));
  const resultsPath = path.join(workDir, 'gate-results.json');
  const fakeHome = path.join(workDir, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  log(`launching debug shell (results → ${resultsPath})…`);
  const app = spawn(binaryPath, [], {
    env: {
      ...process.env,
      HOME: fakeHome,
      SNUG_SHELL_GATE: '1',
      SNUG_SHELL_GATE_OUT: resultsPath,
      SNUG_SHELL_GATE_REMAP: JSON.stringify({ [JOURNEY_HOST]: `http://127.0.0.1:${STUB_PORT}` }),
    },
    stdio: 'inherit',
  });
  children.push(app);
  let appExited = false;
  app.on('exit', (code) => {
    appExited = true;
    log(`shell exited (${code})`);
  });

  // 5. Await the verdict file (missing = FAIL by timeout; dead app = FAIL now).
  const deadline = Date.now() + RESULTS_TIMEOUT_MS;
  while (!fs.existsSync(resultsPath)) {
    if (appExited) fail('shell process exited before writing results');
    if (Date.now() > deadline) fail(`no results file within ${RESULTS_TIMEOUT_MS / 1000}s`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  // Give the write a beat to complete, then read + kill.
  await new Promise((r) => setTimeout(r, 500));
  const raw = fs.readFileSync(resultsPath, 'utf8');
  app.kill('SIGTERM');
  stub.kill('SIGTERM');

  // 5b. THE CLOSE-FLUSH PROOF (review finding 4), two more processes over ONE
  // user file in a FRESH home — see runPersistLegs.
  const persistChecks = await runPersistLegs(workDir, children);

  let results;
  try {
    results = JSON.parse(raw);
  } catch (err) {
    fail(`results file is not valid JSON (${err}): ${raw.slice(0, 400)}`);
  }
  results.timestamp = new Date().toISOString();

  // 6. Driver-side bundle check + the persist legs join the table.
  const checks = Array.isArray(results.checks) ? results.checks : [];
  checks.push(checkRemapAbsentFromBundle());
  checks.push(...persistChecks);

  // 7. Verdict: every expected id present exactly once, every one passing.
  const failures = [];
  if (typeof results.fatal === 'string') failures.push(`harness fatal: ${results.fatal}`);

  const expectedIds = [
    ...EXPECTED_HARNESS_IDS_STATIC,
    ...cspIds,
    ...EXPECTED_IPC_IDS,
    'remap-absent-from-release-bundle',
    ...EXPECTED_PERSIST_IDS,
  ];
  const byId = new Map();
  for (const check of checks) {
    if (byId.has(check.id)) failures.push(`duplicate check id: ${check.id}`);
    byId.set(check.id, check);
  }
  for (const id of expectedIds) {
    const check = byId.get(id);
    if (check === undefined) failures.push(`MISSING VERDICT for check "${id}" — treated as FAIL`);
    else if (check.pass !== true) failures.push(`check "${id}" FAILED: ${check.detail}`);
  }
  for (const id of byId.keys()) {
    if (!expectedIds.includes(id)) failures.push(`unexpected check id "${id}" (driver expectations stale?)`);
  }

  const journeySteps = results.journey?.steps ?? [];
  const stepByName = new Map(journeySteps.map((s) => [s.step, s]));
  for (const name of EXPECTED_JOURNEY_STEPS) {
    const step = stepByName.get(name);
    if (step === undefined) failures.push(`MISSING JOURNEY STEP "${name}" — treated as FAIL`);
    else if (step.ok !== true) failures.push(`journey step "${name}" FAILED: ${step.detail}`);
  }
  if (results.journey?.pass !== true) failures.push('journey.pass is not true');

  // 8. Table.
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n═══ in-shell hard gate — environment ═══');
  for (const [k, v] of Object.entries(results.env ?? {})) console.log(`  ${pad(k, 22)} ${v}`);
  console.log('\n═══ checks ═══');
  for (const id of expectedIds) {
    const check = byId.get(id);
    const status = check === undefined ? 'MISSING' : check.pass ? 'PASS' : 'FAIL';
    const net = check?.networkDependent ? ' [network-dependent]' : '';
    console.log(`  ${pad(status, 8)} ${pad(id, 40)}${net} ${check?.detail ?? ''}`);
  }
  console.log('\n═══ wizard journey 1 (api_key multi-field) ═══');
  for (const name of EXPECTED_JOURNEY_STEPS) {
    const step = stepByName.get(name);
    const status = step === undefined ? 'MISSING' : step.ok ? 'PASS' : 'FAIL';
    console.log(`  ${pad(status, 8)} ${pad(name, 34)} ${step?.detail ?? ''}`);
  }

  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`\nfull results: ${resultsPath}`);
  if (failures.length > 0) {
    console.error(`\n✗ GATE FAILED — ${failures.length} problem(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n✓ GATE GREEN — all verdicts present and passing');
  process.exit(0);
}

main().catch((err) => fail(String(err?.stack ?? err)));
