// proposalGate.test.ts — TASK-20261010-host-broker PR-4 (contract v2 D-PR4-16, D-PR4-5; security S13).
//
// ONE gate for every scheduled proposal, both executors: `schedule/proposalGate.ts`, extracted from
// `appThink.ts`'s `dryRunCandidates`. One candidate in, one verdict out, in the contract's order:
//
//   1. `scheduleProposalItemSchema.safeParse` — one INSERT/UPDATE/DELETE over literal values
//      (`isSingleDmlStatement`: no second statement, no DDL, no nested SELECT/FROM);
//   2. `findScheduleCredential` — a change carrying a credential is never proposed (the run row
//      would refuse to parse, and the value would sit in the user's file);
//   3. `db.driver.inTransaction(appId)` — the app mid-change is BUSY: no export, no dry run
//      (D-PR4-5: every seat PR-4 adds that exports a live namespace asks first);
//   4. the dry run on the scratch copy, never attaching another app's tables — its count is the
//      item's `counts.changes`.
//
// The app the item is FOR is the gate's argument, never the candidate's (Gate-5 S4 of PR-B).
// The ≤ 3-a-run cap stays with the callers (the tool counts what it staged; the tool-free step
// considers at most three candidates).
//
// Assumed seam (Q-T-A-3): `gateProposal(db, appId, candidate: {sql, summary?})` →
//   `{ok:true, item}` | `{ok:false, reason: 'invalid' | 'credential' | 'busy' | 'failed'}`.
//
// RED until `schedule/proposalGate.ts` exists (the static import below fails the file).

import type { UserDb } from '@snugprotocol/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gateProposal } from '../schedule/proposalGate.js';
import { execFrame, exportFrame } from './dbFrames.js';
import { installTestUserDb } from './userdbTestHelper.js';

let db: UserDb;
let appId: string;

async function realBytes(id: string): Promise<string> {
  const result = await db.driver.handle(id, exportFrame());
  return result.ok ? (result.bytesBase64 ?? '') : '';
}

beforeEach(async () => {
  db = await installTestUserDb();
  const app = db.installApp({ displayName: 'Ledger', html: '<html>v1</html>' });
  appId = app.appId;
  await db.applyAppDdl(appId, ['CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT NOT NULL, cents INTEGER NOT NULL)']);
  for (const [index, label] of ['coffee', 'tea', 'rent'].entries()) {
    const result = await db.driver.handle(appId, execFrame('INSERT INTO t (id, label, cents) VALUES (?, ?, ?)', [index + 1, label, (index + 1) * 100]));
    if (!result.ok) throw new Error('seed failed');
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gateProposal — a clean DML change passes with its dry-run count', () => {
  it('answers the item for THIS app with the scratch copy’s count; the real table is untouched', async () => {
    const before = await realBytes(appId);
    const verdict = await gateProposal(db, appId, { sql: 'DELETE FROM t WHERE id = 1', summary: 'stale' });
    expect(verdict).toEqual({ ok: true, item: { appId, sql: 'DELETE FROM t WHERE id = 1', summary: 'stale', counts: { changes: 1 } } });
    expect(await realBytes(appId)).toBe(before);
  });

  it('the summary is optional', async () => {
    const verdict = await gateProposal(db, appId, { sql: "UPDATE t SET label = 'chai' WHERE id = 2" });
    expect(verdict).toEqual({ ok: true, item: { appId, sql: "UPDATE t SET label = 'chai' WHERE id = 2", counts: { changes: 1 } } });
  });

  it('the app is the gate’s argument — a candidate naming another app is filed under THIS one', async () => {
    const verdict = await gateProposal(db, appId, { sql: 'DELETE FROM t WHERE id = 3', appId: 'someone-else' } as { sql: string });
    expect(verdict.ok && verdict.item.appId).toBe(appId);
  });

  it('asks inTransaction for the app BEFORE the dry run, and the dry run never attaches another app’s tables', async () => {
    const busy = vi.spyOn(db.driver, 'inTransaction');
    const scratch = vi.spyOn(db, 'scratchRun');
    await gateProposal(db, appId, { sql: 'DELETE FROM t WHERE id = 1' });
    expect(busy).toHaveBeenCalledWith(appId);
    expect(scratch).toHaveBeenCalledTimes(1);
    expect(busy.mock.invocationCallOrder[0]).toBeLessThan(scratch.mock.invocationCallOrder[0]!);
  });

  it('the dry run is called with no attach option', async () => {
    const scratch = vi.spyOn(db, 'scratchRun');
    await gateProposal(db, appId, { sql: 'DELETE FROM t WHERE id = 1' });
    expect(scratch).toHaveBeenCalledTimes(1);
    const options = (scratch.mock.calls[0] as unknown[])[2] as { attach?: readonly unknown[] } | undefined;
    expect(options?.attach ?? []).toEqual([]);
  });
});

describe('gateProposal — refusals, in the contract’s order (nothing past a refusal runs)', () => {
  const INVALID = [
    ['DDL', 'DROP TABLE t'],
    ['two statements', 'UPDATE t SET cents = 0 WHERE id = 2; DROP TABLE t'],
    ['a nested SELECT', 'UPDATE t SET cents = (SELECT MAX(cents) FROM t) WHERE id = 2'],
    ['INSERT … SELECT', 'INSERT INTO t (label, cents) SELECT label, cents FROM t WHERE id = 1'],
    ['a read', 'SELECT * FROM t'],
    ['empty', ''],
  ] as const;

  for (const [name, sql] of INVALID) {
    it(`${name} → invalid; neither inTransaction nor the dry run is asked`, async () => {
      const busy = vi.spyOn(db.driver, 'inTransaction');
      const scratch = vi.spyOn(db, 'scratchRun');
      const verdict = await gateProposal(db, appId, { sql });
      expect(verdict).toEqual({ ok: false, reason: 'invalid' });
      expect(busy).not.toHaveBeenCalled();
      expect(scratch).not.toHaveBeenCalled();
    });
  }

  it('a summary past the item cap is not a refusal of the change (the cap is the item schema’s; a caller trims first) — a 300-char summary passes', async () => {
    const verdict = await gateProposal(db, appId, { sql: 'DELETE FROM t WHERE id = 1', summary: 'r'.repeat(300) });
    expect(verdict.ok).toBe(true);
  });

  it('a credential in the statement → credential; inTransaction and the dry run are never asked; the value is not echoed', async () => {
    const busy = vi.spyOn(db.driver, 'inTransaction');
    const scratch = vi.spyOn(db, 'scratchRun');
    const verdict = await gateProposal(db, appId, { sql: "UPDATE t SET label = 'Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij.klmnopqrst' WHERE id = 1" });
    expect(verdict).toEqual({ ok: false, reason: 'credential' });
    expect(JSON.stringify(verdict)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(busy).not.toHaveBeenCalled();
    expect(scratch).not.toHaveBeenCalled();
  });

  it('a credential in the summary → credential too', async () => {
    const verdict = await gateProposal(db, appId, { sql: 'DELETE FROM t WHERE id = 1', summary: 'key ghp_0123456789abcdefghijABCDEFGHIJ' });
    expect(verdict).toEqual({ ok: false, reason: 'credential' });
  });

  it('the app mid-change → busy; nothing is exported and nothing dry-runs', async () => {
    vi.spyOn(db.driver, 'inTransaction').mockResolvedValue(true);
    const scratch = vi.spyOn(db, 'scratchRun');
    const verdict = await gateProposal(db, appId, { sql: 'DELETE FROM t WHERE id = 1' });
    expect(verdict).toEqual({ ok: false, reason: 'busy' });
    expect(scratch).not.toHaveBeenCalled();
  });

  it('a dry run that fails (an unknown column) → failed', async () => {
    const verdict = await gateProposal(db, appId, { sql: 'UPDATE t SET nope = 1 WHERE id = 1' });
    expect(verdict).toEqual({ ok: false, reason: 'failed' });
  });

  it('a statement naming a shared alias table is "no such table" on the copy → failed (the dry run never attaches)', async () => {
    const verdict = await gateProposal(db, appId, { sql: 'UPDATE ledger__transactions SET amount = 0 WHERE id = 1' });
    expect(verdict).toEqual({ ok: false, reason: 'failed' });
  });

  it('a scratch run that throws → failed, never a throw', async () => {
    vi.spyOn(db, 'scratchRun').mockRejectedValue(new Error('worker gone'));
    const verdict = await gateProposal(db, appId, { sql: 'DELETE FROM t WHERE id = 1' });
    expect(verdict).toEqual({ ok: false, reason: 'failed' });
  });
});
