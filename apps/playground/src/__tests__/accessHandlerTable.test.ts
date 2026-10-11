// accessHandlerTable.test.ts — the characterisation table's FRAME cells through TODAY's handler
// (TASK-20261010-host-broker PR-2 AC9, amended; contract v2 "Characterisation").
//
// GREEN ON MAIN, BY DESIGN. This suite is the proof that the hand-written table in
// `accessPolicyTable.ts` is right: every frame cell — the visible frame at g0, the same frame during
// a delegated run, the visible frame at g1, the hidden frame — is driven through the REAL
// `createAccessHandlerFor`, each in a fresh file, and the answer, the read line's posture and the
// effect the verdict names (a `refused` line, an `expired` line, a `source-restricted` pause — or
// none) are read back from the file. The same table drives `authorise` in accessPolicy.test.ts; when
// the engine moves behind the policy (D-PR2-1), this suite must stay green unchanged.
//
// The `materialise` column is today's `list` admission (in the frame's list iff admitted, and
// nothing written). The ONE named invert — {frame during a delegated run} × {session g0, also while
// I'm away} — is SKIPPED here with the contract's reason: today's handler admits it, the policy
// refuses it (D-PR2-4 rule 4); accessPolicy.test.ts asserts the refusal.
//
// Mutation checks (run by hand against today's handler, each red then restored):
//  - let `ownsSession` match the generation alone (drop `attended &&`) → the hidden-frame session
//    cells red;
//  - drop the `refused` line for an unattended read → the NOT_GRANTED + refused-line cells red;
//  - move the WhatsApp check above the attendance check → the order rows red.

import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { FRAME_CALLERS, INVERT, driveHandlerCell, orderCells, setupWorld, tableCells, teardownWorld } from './accessPolicyTable.js';

beforeEach(async () => {
  await setupWorld();
});

afterEach(() => {
  teardownWorld();
  vi.restoreAllMocks();
});

const frameCells = tableCells().filter((cell) => FRAME_CALLERS.includes(cell.caller));

describe('AC9 characterisation — the table’s frame cells through today’s createAccessHandlerFor', () => {
  for (const caller of FRAME_CALLERS) {
    describe(caller, () => {
      for (const cell of frameCells.filter((entry) => entry.caller === caller)) {
        if (cell.invert) {
          it.skip(`${cell.name} — SKIPPED: ${INVERT.reason}`, () => undefined);
          continue;
        }
        it(cell.why !== undefined ? `${cell.name} (answered ${cell.answer.ok ? 'ok' : cell.answer.code}: ${cell.why})` : cell.name, async () => {
          await driveHandlerCell(cell);
        });
      }
    });
  }
});

describe('AC9 characterisation — the rule order is today’s query order (attendance before the WhatsApp fact)', () => {
  for (const cell of orderCells().filter((entry) => FRAME_CALLERS.includes(entry.caller))) {
    it(cell.name, async () => {
      await driveHandlerCell(cell);
    });
  }
});
