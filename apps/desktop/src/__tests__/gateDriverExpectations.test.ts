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

import { IPC_CHECK_IDS } from '../gate/ipc.js';

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
});
