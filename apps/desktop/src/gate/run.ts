// In-shell hard-gate orchestrator (TASK-20260812 P4, AC7/AC8).
//
// Entered from main.tsx ONLY when the debug-only `shell_gate_config` command
// answered Some — i.e. a debug shell launched with SNUG_SHELL_GATE=1. Runs:
//   a. ENVIRONMENT probes (secure context, NATIVE crypto.subtle before the
//      fallback installs, sql.js wasm round trip, origin);
//   b. the 14 BROWSER_CSP_CHECKS (csp.ts);
//   c. the shell IPC-unreachability checks (ipc.ts);
//   d. wizard journey 1 through the real App (journey.tsx);
//   e. the debug host-remap arming/inertness checks (net-remap.ts);
// then writes ONE JSON verdict file through `write_gate_results`. Every check
// id is always present — a missing verdict is an explicit FAIL row, and a
// harness crash still writes a `fatal` report so the driver fails loudly
// instead of timing out silently (the SNUG_E2E_HAS_APP silent-skip trap is the
// named anti-pattern here).

import initSqlJs from 'sql.js';
import { invoke } from '@tauri-apps/api/core';

import { locateWasm } from '@playground/run/wasm.js';
import { setPlatform } from '@playground/platform/platform';

import { createDesktopPlatform } from '../platform-desktop.js';
import { buildRemapTable, installGateRemap, remapTableSize, remapUrl } from '../net-remap.js';
import { installSubtleFallbackIfNeeded } from '../subtle-fallback.js';
import type { ShellGateConfig } from './config.js';
import type { CheckResult, GateEnvReport, GateResults } from './types.js';
import { runCspChecks } from './csp.js';
import { runIpcChecks } from './ipc.js';
import { runJourney } from './journey.js';

async function probeSqlJs(): Promise<CheckResult> {
  try {
    const SQL = await initSqlJs({ locateFile: () => locateWasm() });
    const db = new SQL.Database();
    db.run('CREATE TABLE gate_probe (x TEXT)');
    db.run('INSERT INTO gate_probe VALUES (?)', ['round-trip']);
    const rows = db.exec('SELECT x FROM gate_probe');
    db.close();
    const value = rows[0]?.values[0]?.[0];
    return value === 'round-trip'
      ? { id: 'env-sqljs-loads', pass: true, detail: 'wasm loaded; insert/select round trip ok' }
      : { id: 'env-sqljs-loads', pass: false, detail: `round trip returned ${String(value)}` };
  } catch (err) {
    return { id: 'env-sqljs-loads', pass: false, detail: `sql.js failed: ${String(err)}` };
  }
}

function remapChecks(config: ShellGateConfig): CheckResult[] {
  const results: CheckResult[] = [];
  const entries = Object.entries(config.remap);
  const armedOk =
    remapTableSize() === entries.length &&
    entries.every(([host, target]) => {
      const mapped = remapUrl(`https://${host}:43120/v2/accounts`);
      return mapped.startsWith(target) && mapped.endsWith('/v2/accounts');
    }) &&
    remapUrl('https://unrelated-host.invalid/path') === 'https://unrelated-host.invalid/path';
  results.push({
    id: 'remap-armed-from-config',
    pass: armedOk,
    detail: armedOk
      ? `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} from gate config; unrelated hosts untouched`
      : `table size ${remapTableSize()} vs config ${entries.length}, or rewrite mismatch`,
  });
  // The None path of the SAME code the production boot runs: config absent ⇒
  // empty table. (The process-level case — a debug shell WITHOUT the env —
  // cannot write a results file at all, by design; this pins the code path.)
  const inert = buildRemapTable(null).size === 0 && buildRemapTable(undefined).size === 0;
  results.push({
    id: 'remap-inert-without-config',
    pass: inert,
    detail: inert
      ? 'buildRemapTable(null/undefined) is empty — without gate config the fetch path is identity'
      : 'a null/undefined config produced a NON-EMPTY remap table',
  });
  return results;
}

/**
 * The close-flush persistence legs (review finding 4). Each is a whole process:
 * it reports its own single check and then ends, so the driver can close the
 * window (phase 1) and reopen the same file (phase 2). Neither runs the CSP/IPC/
 * journey work — they exist only to observe a write across a process boundary.
 */
async function runPersistPhase(
  config: ShellGateConfig,
  phase: 'persist-write' | 'persist-verify',
  env: GateEnvReport,
): Promise<void> {
  const { runPersistWrite, runPersistVerify } = await import('./persist.js');
  let results: GateResults;
  let mutate: (() => void) | undefined;
  try {
    if (phase === 'persist-write') {
      const plan = await runPersistWrite();
      mutate = plan.mutate;
      results = { env, checks: plan.checks, journey: { steps: [], pass: true } };
    } else {
      results = { env, checks: await runPersistVerify(), journey: { steps: [], pass: true } };
    }
  } catch (err) {
    results = {
      env,
      checks: [],
      journey: { steps: [], pass: false },
      fatal: `${phase} phase died: ${String(err)}`,
    };
  }
  await invoke('write_gate_results', { json: JSON.stringify(results, null, 2) });

  if (phase === 'persist-write') {
    // ORDER IS THE PROOF. The mutation happens HERE — after the results file is
    // written and with nothing awaited before the close — so the 250ms write-back
    // debounce cannot elapse on its own. Mutating earlier let the debounce fire
    // during the results write, and the check then passed even with the Rust
    // close handler deleted (found by mutation testing). The only remaining route
    // to disk is CloseRequested → flush → close_flush_done.
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const window = getCurrentWindow();
    mutate?.();
    await window.close();
  }
}

export async function runShellGate(config: ShellGateConfig): Promise<void> {
  const checks: CheckResult[] = [];
  // Env facts FIRST — nativeCryptoSubtle must be read before the fallback runs.
  const env: GateEnvReport = {
    origin: location.origin,
    isSecureContext: window.isSecureContext === true,
    nativeCryptoSubtle: globalThis.crypto?.subtle !== undefined,
    userAgent: navigator.userAgent,
  };

  // The persist legs are separate processes with their own single-check reports.
  if (config.phase === 'persist-write' || config.phase === 'persist-verify') {
    await runPersistPhase(config, config.phase, env);
    return;
  }

  let results: GateResults;
  try {
    checks.push(await probeSqlJs());

    // Same boot order as the production path (main.tsx): fallback, then remap
    // (gate-armed here), then the platform.
    await installSubtleFallbackIfNeeded();
    checks.push({
      id: 'env-crypto-usable',
      pass: globalThis.crypto?.subtle !== undefined,
      detail: env.nativeCryptoSubtle
        ? 'native crypto.subtle present'
        : 'native crypto.subtle ABSENT — pure-JS fallback installed (plan decision 12)',
    });
    installGateRemap(config);
    setPlatform(createDesktopPlatform());

    checks.push(...remapChecks(config));
    checks.push(...(await runCspChecks()));
    checks.push(...(await runIpcChecks()));
    const journey = await runJourney(config);
    results = { env, checks, journey };
  } catch (err) {
    results = {
      env,
      checks,
      journey: { steps: [], pass: false },
      fatal: `gate harness died: ${String(err)}`,
    };
  }
  await invoke('write_gate_results', { json: JSON.stringify(results, null, 2) });
}
