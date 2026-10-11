// accessPolicy.test.ts — ONE policy, one verdict (TASK-20261010-host-broker PR-2 AC9; contract v2
// D-PR2-1 one verdict whose effects are NAMED, never performed · D-PR2-2 three callers, no `user`
// caller · D-PR2-3 session grants per door, an UNBOUND entry is never readable · D-PR2-4 attendance
// per door, rule 4 = D30 as a rule · D-PR2-14 `ask`).
//
// RED UNTIL `access/policy.ts` EXISTS. Every row reaches the module through `policy()` (a dynamic
// import inside the row), so each row is red on its own and the count is exact; the purity rows read
// the source files and are red while they are absent.
//
// THE TABLE. Every cell of `accessPolicyTable.ts` — eight callers × ten grants × six acts, plus the
// ordering rows — is driven through `authorise(ctx, caller, act)` over the SAME world the handler
// driver stands in (accessHandlerTable.test.ts, green today), with the context the service binds
// (`findAccessGrant(db, ·)`, `appHasSidecarFact(db, ·)`, the world's clock). Each cell pins the
// verdict's `{ ok, code, message, retryable, effect }` (or `{ ok, attended }`) and that `authorise`
// is PURE: whatever effect it names, the file and the engine are unchanged after the call. The one
// named invert ({frame during a delegated run} × {session g0, also while I'm away}) is ASSERTED here.
//
// BESIDE THE TABLE: `attendedFor`, `callerGeneration`, `ownsGrant` on hand-built grants (the
// `undefined === undefined` blocker), the rule-1 byte-identity of another reader's grant, an unknown
// id and an unbound session grant, the binding of an unbound grant by the next frame, and the
// purity of the module's imports (protocol, `./grantFacts.js`, `./copy.js`, grants.ts TYPES only).
//
// Mutation checks (run by hand on the reference policy before it was deleted, each red then restored):
//  - `ownsGrant` comparing `found.generation === callerGen` without the `!== undefined` guards →
//    the chat-none × session-unbound cells and the hand-built unbound rows red;
//  - rule 4 as `!attended && !grant.unattended` (today's handler) → the invert cells red;
//  - name `refused-line` for every caller → the schedule × persisted cells red;
//  - check the WhatsApp fact before attendance → the order rows red.
//
// PR-3 (contract v2 D-PR3-13): the SECOND table — `write {grantId, table}`, `refresh {grantId}` and
// `discover` over the same eight callers × the ten grants and PR-3's three fixtures — through
// `authorise`, each cell pure and carrying the grant it admits; `stillWritable` = `stillReadable` ∧
// the named table's `write`. Red until the policy gains the three acts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_ERROR_CODES } from '@snugprotocol/protocol';

import { ACCESS_APP_MESSAGES } from '../access/copy.js';
import { createAccessHandlerFor } from '../access/accessHandler.js';
import { findAccessGrant, revokeAccess, type AnyAccessGrant, type FoundAccessGrant } from '../access/grants.js';
import {
  CALLER_KEYS,
  actOf,
  actOfV2,
  tableCellsV2,
  type CellV2,
  makeGrant,
  observe,
  orderCells,
  pickVerdict,
  policyContext,
  prepare,
  setupWorld,
  tableCells,
  teardownWorld,
  world,
  type CallerShape,
  type Cell,
} from './accessPolicyTable.js';

type PolicyModule = typeof import('../access/policy.js');

/**
 * The module under test — imported inside each row so each row is red on its own until it exists
 * (a variable specifier: Vite resolves a literal one at transform time and would fail the whole file).
 */
const POLICY_MODULE = '../access/policy.js';
const policy = (): Promise<PolicyModule> => import(/* @vite-ignore */ POLICY_MODULE) as Promise<PolicyModule>;

beforeEach(async () => {
  await setupWorld();
});

afterEach(() => {
  teardownWorld();
  vi.restoreAllMocks();
});

async function drivePolicyCell(cell: Cell): Promise<void> {
  const { authorise } = await policy();
  const { grantId, caller } = await prepare(cell);
  const before = observe(grantId);
  const verdict = authorise(policyContext(), caller, actOf(cell.act, grantId)) as unknown as Record<string, unknown>;
  expect(pickVerdict(verdict, cell.verdict)).toEqual(cell.verdict.ok ? { ok: true, ...(cell.verdict.attended !== undefined ? { attended: cell.verdict.attended } : {}) } : cell.verdict);
  if (cell.verdict.ok && (cell.act === 'read-select' || cell.act === 'read-delete' || cell.act === 'materialise')) {
    expect((verdict.grant as FoundAccessGrant | undefined)?.grant.id, 'the verdict carries the grant it admitted').toBe(grantId);
  }
  expect(observe(grantId), 'authorise is pure: it NAMES an effect, the service performs it').toEqual(before);
}

// =========================================================================================
// The table, every cell
// =========================================================================================

describe('AC9 — every cell of the characterisation table through authorise', () => {
  const cells = tableCells();
  for (const caller of CALLER_KEYS) {
    describe(caller, () => {
      for (const cell of cells.filter((entry) => entry.caller === caller)) {
        it(cell.invert ? `${cell.name} — THE NAMED INVERT (D-PR2-4 rule 4: today admitted, refused by the policy)` : cell.name, async () => {
          await drivePolicyCell(cell);
        });
      }
    });
  }
});

describe('AC9 — the rule order is today’s query order (attendance before the WhatsApp fact)', () => {
  for (const cell of orderCells()) {
    it(cell.name, async () => {
      await drivePolicyCell(cell);
    });
  }
});

// =========================================================================================
// The caller facts
// =========================================================================================

const APP = 'budget-app';
const OTHER = 'pantry-app';
const frame = (over: Partial<Extract<CallerShape, { kind: 'frame' }>> = {}): CallerShape => ({ kind: 'frame', appId: APP, generation: 0, present: true, ...over });
const chat = (liveGeneration?: number): CallerShape => ({ kind: 'chat', appId: APP, threadId: 't-1', ...(liveGeneration !== undefined ? { liveGeneration } : {}) });
const schedule = (): CallerShape => ({ kind: 'schedule', appId: APP, taskId: 'task-1', runId: 'run-1' });
const hidden = (): CallerShape => ({ kind: 'frame', appId: APP, present: false });

/** A grant as the engine finds it — `ownsGrant` reads the reader, whether it is a session grant, and its generation. */
const found = (over: { readerAppId?: string; session: boolean; generation?: number }): FoundAccessGrant => ({
  grant: { id: '11111111-1111-4111-8111-111111111111', readerAppId: over.readerAppId ?? APP, sourceAppId: 'ledger-app' } as unknown as AnyAccessGrant,
  session: over.session,
  ...(over.generation !== undefined ? { generation: over.generation } : {}),
});

describe('D-PR2-4 attendedFor — attendance per door', () => {
  it('a frame is attended exactly when someone is present; the chat always (the user typed); the schedule never, whatever the trigger', async () => {
    const { attendedFor } = await policy();
    expect(attendedFor(frame({ present: true }))).toBe(true);
    expect(attendedFor(frame({ present: false }))).toBe(false);
    expect(attendedFor(hidden())).toBe(false);
    expect(attendedFor(chat(0))).toBe(true);
    expect(attendedFor(chat())).toBe(true);
    expect(attendedFor(schedule())).toBe(false);
  });
});

describe('D-PR2-3 callerGeneration — the generation each door may own a session grant at', () => {
  it('frame → its generation (none for the hidden frame) · chat → the reader’s live generation (none when closed) · schedule → none', async () => {
    const { callerGeneration } = await policy();
    expect(callerGeneration(frame({ generation: 3 }))).toBe(3);
    expect(callerGeneration(hidden())).toBeUndefined();
    expect(callerGeneration(chat(2))).toBe(2);
    expect(callerGeneration(chat())).toBeUndefined();
    expect(callerGeneration(schedule())).toBeUndefined();
  });
});

describe('D-PR2-3 ownsGrant — session grants per door; an UNBOUND entry is never readable', () => {
  it('a persisted grant is owned by its reader at every door, and by no other app', async () => {
    const { ownsGrant } = await policy();
    for (const caller of [frame(), frame({ present: false }), hidden(), chat(0), chat(), schedule()]) {
      expect(ownsGrant(caller, found({ session: false })), JSON.stringify(caller)).toBe(true);
      expect(ownsGrant(caller, found({ session: false, readerAppId: OTHER })), JSON.stringify(caller)).toBe(false);
    }
  });

  it('a session grant of generation 0 is owned by the frame at 0 and the chat whose reader is open at 0 — not g1, not the hidden frame, not a closed app’s chat, never the schedule', async () => {
    const { ownsGrant } = await policy();
    const session = found({ session: true, generation: 0 });
    expect(ownsGrant(frame({ generation: 0 }), session)).toBe(true);
    expect(ownsGrant(frame({ generation: 0, present: false }), session), 'ownership is not attendance').toBe(true);
    expect(ownsGrant(chat(0), session)).toBe(true);
    expect(ownsGrant(frame({ generation: 1 }), session)).toBe(false);
    expect(ownsGrant(chat(1), session)).toBe(false);
    expect(ownsGrant(hidden(), session)).toBe(false);
    expect(ownsGrant(chat(), session)).toBe(false);
    expect(ownsGrant(schedule(), session)).toBe(false);
    expect(ownsGrant(frame({ generation: 0, appId: OTHER }), session), 'another app’s frame at the same generation').toBe(false);
  });

  it('THE SHARED BLOCKER: an UNBOUND session grant (generation undefined) is owned by NOBODY — `undefined === undefined` never admits it', async () => {
    const { ownsGrant } = await policy();
    const unbound = found({ session: true });
    for (const caller of [hidden(), chat(), schedule(), frame({ generation: 0 }), chat(0)]) {
      expect(ownsGrant(caller, unbound), JSON.stringify(caller)).toBe(false);
    }
  });
});

// =========================================================================================
// Rule 1 — byte-identical refusals; the next frame binds
// =========================================================================================

describe('D-PR2-3 rule 1 — another reader’s grant, an unknown id and an unbound session grant are byte-identical', () => {
  it('for a closed app’s chat, the hidden frame and the schedule: one spelling, no effect, no grant carried', async () => {
    const { authorise } = await policy();
    const { db, budget, ledger, pantry } = world();
    const unbound = await makeGrant('session-unbound');
    // Pantry reads Ledger: a real grant that is simply not Budget's.
    const { collectSources } = await import('../access/consent.js');
    const { createGrantFromDecision } = await import('../access/grants.js');
    const ranked = await collectSources(db, pantry);
    const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === ledger)!;
    const theirs = await createGrantFromDecision(db, { readerAppId: pantry, source, tables: ['transactions'], duration: 'day', unattended: true, purpose: 'to plan meals', provenance: 'app', now: world().clock.now });
    const unknown = '00000000-0000-4000-8000-000000000000';
    for (const caller of [chat(), hidden(), schedule()].map((shape) => ({ ...shape, appId: budget }) as CallerShape)) {
      for (const act of ['read-select', 'materialise', 'release'] as const) {
        const answers = [unbound, theirs.id, unknown].map((id) => JSON.stringify(authorise(policyContext(), caller, actOf(act, id))));
        expect(new Set(answers).size, `${caller.kind} × ${act}`).toBe(1);
        expect(JSON.parse(answers[0]!)).toEqual({ ok: false, code: ACCESS_ERROR_CODES.ACCESS_NOT_GRANTED, message: ACCESS_APP_MESSAGES.notGranted, retryable: false });
      }
    }
  });

  it('an unbound grant is readable by nobody — not even a caller claiming generation 0 — until the next frame composes and binds it; then that frame and the chat at its generation own it', async () => {
    const { authorise } = await policy();
    const { budget } = world();
    const id = await makeGrant('session-unbound');
    const claimingZero: CallerShape = { kind: 'chat', appId: budget, threadId: 't-1', liveGeneration: 0 };
    const frameZero: CallerShape = { kind: 'frame', appId: budget, generation: 0, present: true };
    for (const caller of [claimingZero, frameZero]) {
      expect(authorise(policyContext(), caller, actOf('read-select', id)), `${caller.kind} before the frame binds`).toMatchObject({ ok: false, code: ACCESS_ERROR_CODES.ACCESS_NOT_GRANTED });
    }
    createAccessHandlerFor(budget, { attended: true, generation: 0 }); // the run view composes g0: the grant binds to it
    expect(findAccessGrant(world().db, id)).toMatchObject({ session: true, generation: 0 });
    for (const caller of [claimingZero, frameZero]) {
      expect(authorise(policyContext(), caller, actOf('read-select', id)), `${caller.kind} once bound`).toMatchObject({ ok: true, attended: true });
    }
  });
});

// =========================================================================================
// Purity — the module's own imports
// =========================================================================================

describe('D-PR2-1 policy.ts is PURE — protocol, the leaf grantFacts.ts, copy.ts and grants.ts TYPES only', () => {
  const source = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  const importsOf = (text: string): Array<{ typeOnly: boolean; from: string }> =>
    [...text.matchAll(/^\s*import\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((match) => ({ typeOnly: match[1] !== undefined, from: match[2]! }));

  it('policy.ts imports values only from @snugprotocol/protocol, ./grantFacts.js and ./copy.js — grants.ts as types', () => {
    const imports = importsOf(source('../access/policy.ts'));
    expect(imports.length).toBeGreaterThan(0);
    for (const { typeOnly, from } of imports) {
      if (from === './grants.js') expect(typeOnly, 'grants.ts is reached for TYPES only').toBe(true);
      else expect(['@snugprotocol/protocol', './grantFacts.js', './copy.js'], from).toContain(from);
    }
    expect(source('../access/policy.ts')).not.toMatch(/\bimport\(/); // no lazy edge either
  });

  it('grantFacts.ts is a LEAF: protocol imports only', () => {
    for (const { from } of importsOf(source('../access/grantFacts.ts'))) expect(from).toBe('@snugprotocol/protocol');
  });
});

// =========================================================================================
// PR-3 — the second table: write · refresh · discover (contract v2 D-PR3-13)
// =========================================================================================

// `authorise` over the v2 acts and `stillWritable` (D-PR3-13) — the real exports (the pins lane
// dropped the Gate-3 local widenings); the verdict is read as a record, as the first table's driver reads it.
async function drivePolicyCellV2(cell: CellV2): Promise<void> {
  const { authorise } = await policy();
  const { grantId, caller } = await prepare(cell);
  const before = observe(grantId);
  const verdict = authorise(policyContext(), caller, actOfV2(cell.act, grantId)) as unknown as Record<string, unknown>;
  expect(pickVerdict(verdict, cell.verdict)).toEqual(cell.verdict.ok ? { ok: true, ...(cell.verdict.attended !== undefined ? { attended: cell.verdict.attended } : {}) } : cell.verdict);
  if (cell.verdict.ok && cell.act !== 'discover') {
    expect((verdict.grant as FoundAccessGrant | undefined)?.grant.id, 'the verdict carries the grant it admitted').toBe(grantId);
  }
  expect(observe(grantId), 'authorise is pure: it NAMES an effect, the service performs it').toEqual(before);
}

describe('PR-3 D-PR3-13 — every cell of the second table (write · refresh · discover) through authorise', () => {
  const cells = tableCellsV2();
  for (const caller of CALLER_KEYS) {
    describe(caller, () => {
      for (const cell of cells.filter((entry) => entry.caller === caller)) {
        it(cell.why !== undefined ? `${cell.name} (the verdict; the frame then meets the engine: ${cell.why})` : cell.name, async () => {
          await drivePolicyCellV2(cell);
        });
      }
    });
  }
});

describe('PR-3 D-PR3-13 stillWritable — stillReadable ∧ the named table’s write', () => {
  const stillWritableOf = async (): Promise<PolicyModule['stillWritable']> => (await policy()).stillWritable;

  it('a write grant is still writable for its ticked table only — not for its read-only table, not for a table outside it', async () => {
    const stillWritable = await stillWritableOf();
    const { budget, clock } = world();
    const id = await makeGrant('persisted-write');
    const here: CallerShape = { kind: 'frame', appId: budget, generation: 0, present: true };
    expect(stillWritable(policyContext().find, here, id, 'transactions', clock.now)?.grant.id).toBe(id);
    expect(stillWritable(policyContext().find, here, id, 'accounts', clock.now)).toBeUndefined();
    expect(stillWritable(policyContext().find, here, id, 'nope', clock.now)).toBeUndefined();
  });

  it('whatever stops a read stops a write: stopped, expired by the clock, another reader, an unknown id', async () => {
    const stillWritable = await stillWritableOf();
    const { budget, pantry, clock } = world();
    const id = await makeGrant('persisted-write');
    const here: CallerShape = { kind: 'frame', appId: budget, generation: 0, present: true };
    const other: CallerShape = { kind: 'frame', appId: pantry, generation: 0, present: true };
    expect(stillWritable(policyContext().find, other, id, 'transactions', clock.now), 'another reader').toBeUndefined();
    expect(stillWritable(policyContext().find, here, '00000000-0000-4000-8000-000000000000', 'transactions', clock.now), 'an unknown id').toBeUndefined();
    expect(stillWritable(policyContext().find, here, id, 'transactions', clock.now + 86_400_000), 'expired by the clock').toBeUndefined();
    await revokeAccess(id);
    expect(stillWritable(policyContext().find, here, id, 'transactions', clock.now), 'stopped').toBeUndefined();
  });

  it('a read-only grant is never writable, though it is still readable', async () => {
    const { stillReadable } = await policy();
    const stillWritable = await stillWritableOf();
    const { budget, clock } = world();
    const id = await makeGrant('persisted');
    const here: CallerShape = { kind: 'frame', appId: budget, generation: 0, present: true };
    expect(stillReadable(policyContext().find, here, id, clock.now)?.grant.id).toBe(id);
    expect(stillWritable(policyContext().find, here, id, 'transactions', clock.now)).toBeUndefined();
  });

  it('a session grant with write is writable by the frame of its generation only', async () => {
    const stillWritable = await stillWritableOf();
    const { budget, clock } = world();
    const id = await makeGrant('session-g0-write');
    createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(stillWritable(policyContext().find, { kind: 'frame', appId: budget, generation: 0, present: true }, id, 'transactions', clock.now)?.grant.id).toBe(id);
    expect(stillWritable(policyContext().find, { kind: 'frame', appId: budget, present: false }, id, 'transactions', clock.now), 'the hidden frame').toBeUndefined();
  });
});
