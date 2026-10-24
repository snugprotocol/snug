// @vitest-environment node
//
// The gate driver's expected-id list must equal the harness's IPC_CHECK_IDS.
//
// WHY THIS EXISTS: P5 added `ipc-lan-fetch-refused` to the harness (amendment 16) and the
// driver kept its own hand-typed twin of that list. Every local suite was green, the
// harness RAN the new check and PASSED it — and the macOS CI gate failed with
// "unexpected check id" at 39/39 checks green. Nothing on a developer machine executes
// `run-gate.mjs`, so the drift was only observable in CI, on a leg that costs ~4 minutes
// to discover.
//
// The driver now DERIVES the list from the TS source rather than restating it, and this
// test pins that derivation: if the export moves, is renamed, or stops parsing, this
// fails in the fast local suite instead of on a CI runner.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GATE_HOME_MARKER_NAME, IPC_CHECK_IDS } from '../gate/ipc.js';
import { NET_SCOPE_CHECK_IDS } from '../gate/netScope.js';

const driverSource = readFileSync(fileURLToPath(new URL('../../gate/run-gate.mjs', import.meta.url)), 'utf8');

describe('gate driver expectations track the harness (no hand-typed twin)', () => {
  it('derives the IPC ids from src/gate/ipc.ts rather than restating them', () => {
    // The literal ids must NOT appear as a driver-side array: a retyped copy is exactly
    // what went stale. (The ids may appear inside the explanatory comment — that is prose,
    // not a contract, so we assert on the absence of a *literal list assignment*.)
    expect(
      /const EXPECTED_IPC_IDS = \[\s*'/.test(driverSource),
      'the driver must not hand-maintain a literal id list — derive it from the harness',
    ).toBe(false);
    expect(driverSource).toContain('IPC_CHECK_IDS');
  });

  it('the driver\'s extraction regex actually recovers every current id', () => {
    // Run the driver's own parse against the real source: this is the check that would
    // have caught the CI failure locally.
    const harnessSource = readFileSync(fileURLToPath(new URL('../gate/ipc.ts', import.meta.url)), 'utf8');
    const block = /export const IPC_CHECK_IDS = \[([\s\S]*?)\] as const;/.exec(harnessSource);
    expect(block, 'the driver looks for this exact shape — keep the export parseable').not.toBeNull();
    const parsed = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(parsed).toEqual([...IPC_CHECK_IDS]);
  });

  it('includes the per-command lan_fetch check that exposed the drift', () => {
    expect(IPC_CHECK_IDS).toContain('ipc-lan-fetch-refused');
  });

  it('expects the six ChatGPT-session rows (TASK-20261023-siwc-chatgpt-plan AC13) — refused ×3 from the frame, effect-sensor twins ×3', () => {
    // The driver derives its list from IPC_CHECK_IDS (pinned above), so this is what makes a
    // shell run WITHOUT these rows fail as "missing check id" rather than pass quietly.
    const harnessSource = readFileSync(fileURLToPath(new URL('../gate/ipc.ts', import.meta.url)), 'utf8');
    const block = /export const IPC_CHECK_IDS = \[([\s\S]*?)\] as const;/.exec(harnessSource)!;
    const parsed = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    for (const which of ['read', 'write', 'clear']) {
      for (const kind of ['refused', 'dispatchable']) {
        const id = `ipc-chatgpt-session-${which}-${kind}`;
        expect(parsed, `the driver must expect ${id}`).toContain(id);
      }
    }
  });

  it('expects the gate-home marker row (G5-A10) — a shell that skipped the effect sensors cannot pass quietly', () => {
    const harnessSource = readFileSync(fileURLToPath(new URL('../gate/ipc.ts', import.meta.url)), 'utf8');
    const block = /export const IPC_CHECK_IDS = \[([\s\S]*?)\] as const;/.exec(harnessSource)!;
    const parsed = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(parsed).toContain('ipc-chatgpt-session-gate-home');
  });
});

describe('the gate shell runs under a THROWAWAY HOME (TASK-20261023-siwc-chatgpt-plan F3/S6)', () => {
  // The ChatGPT-session effect sensors WRITE and CLEAR `~/Snug/.chatgpt-plan/session.json`, and
  // `userfile::snug_dir()` resolves `~` from HOME. If the driver ever launched the gate shell
  // with the developer's own HOME, a gate run would sign them out of ChatGPT (and the sentinel
  // probe would litter their real ~/Snug). Pin the isolation the sensors depend on.
  it('the debug shell is spawned with HOME pointed at a fresh mkdtemp directory', () => {
    expect(driverSource).toMatch(/const workDir = fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), 'snug-shell-gate-'\)\);/);
    expect(driverSource).toMatch(/const fakeHome = path\.join\(workDir, 'home'\);/);
    const launch = /const app = spawn\(binaryPath, \[\], \{\s*env: \{([\s\S]*?)\},/.exec(driverSource);
    expect(launch, 'the full-gate launch site must stay parseable').not.toBeNull();
    expect(launch![1]).toMatch(/\.\.\.process\.env,\s*HOME: fakeHome,/);
  });

  // G5-A10: the throwaway HOME is only known to BE throwaway because the driver marks it. The
  // harness asks the debug-only Rust command for `<home>/.snug-shell-gate-home` before any
  // effect sensor writes or clears, so the three spellings must agree — the driver's (what it
  // writes), the harness's (what the row names) and the Rust side's (what it stats).
  it('the driver writes the gate-home MARKER into BOTH homes it creates — the main leg’s and the persist legs’', () => {
    expect(driverSource).toMatch(/const GATE_HOME_MARKER = '\.snug-shell-gate-home';/);
    const markHome = /function markGateHome\(home\) \{([\s\S]*?)\n\}/.exec(driverSource);
    expect(markHome, 'one helper that mkdirs and marks a gate home').not.toBeNull();
    expect(markHome![1]).toMatch(/fs\.writeFileSync\(path\.join\(home, GATE_HOME_MARKER\), ''\)/);
    expect(driverSource).toMatch(/const fakeHome = path\.join\(workDir, 'home'\);\s*markGateHome\(fakeHome\);/);
    expect(driverSource).toMatch(/const home = path\.join\(workDir, 'persist-home'\);\s*markGateHome\(home\);/);
  });

  it('the marker name is ONE spelling across the driver, the harness and gate.rs', () => {
    expect(GATE_HOME_MARKER_NAME).toBe('.snug-shell-gate-home');
    const gateRs = readFileSync(fileURLToPath(new URL('../../src-tauri/src/gate.rs', import.meta.url)), 'utf8');
    expect(gateRs).toMatch(/pub const GATE_HOME_MARKER: &str = "\.snug-shell-gate-home";/);
    expect(gateRs, 'the debug-only command the harness calls').toContain('pub fn gate_chatgpt_session_marker_present(');
  });
});

describe('the net-scope ids are derived the same way (TASK-20261008-p0-clearance W3)', () => {
  it('the driver names NET_SCOPE_CHECK_IDS and keeps no literal twin', () => {
    expect(driverSource).toContain('NET_SCOPE_CHECK_IDS');
    expect(/const EXPECTED_NET_SCOPE_IDS = \[\s*'/.test(driverSource)).toBe(false);
  });

  it('the driver\'s extraction recovers every current net-scope id', () => {
    const source = readFileSync(fileURLToPath(new URL('../gate/netScope.ts', import.meta.url)), 'utf8');
    const block = /export const NET_SCOPE_CHECK_IDS = \[([\s\S]*?)\] as const;/.exec(source);
    expect(block).not.toBeNull();
    expect([...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([...NET_SCOPE_CHECK_IDS]);
    expect(NET_SCOPE_CHECK_IDS.length).toBeGreaterThan(0);
  });
});

