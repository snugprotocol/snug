/**
 * TASK-20261010-host-broker PR-4 — the OWN undo journal's entry (contract v2 D-PR4-3, D-PR4-7;
 * ADR-0076 §9). INTERNAL protocol surface: OUT of `json-schemas.ts` SOURCES, like `schedule.ts`.
 *
 * WHY THIS EXISTS. Since PR-4 an app's OWN data can change through the host on two authorities
 * the user gave: an *approval* (the user applied a change the chat or a result page offered) and
 * a *task* (a schedule the user let make its changes on its own). Both go through the Write
 * Broker's capture seat, and the rows each change touched are kept host-internally — in
 * `ownUndo:<appId>:<bucket>` settings rows, one per armed task and one for the user's approvals —
 * so the user can put them back for seven days. No access line is written: an own write names no
 * other app, so it has no history row to sit on (spec 1.2 §24.5's own-app sentence).
 *
 * THE ACCESS JOURNAL'S ROWS, NO GRANT, NO READER. An entry is `accessUndoEntrySchema` without the
 * grant and reader seats: the same step schema (the table rule that refuses `snug_kv`, the column
 * bounds, the 200-row step, the op's row seats), the same step cap (`ACCESS_UNDO_MAX_STEPS`) and
 * the same tail refinement (`refuseUndoOversizeOrCredential` — the 64 KiB cap and the per-cell
 * credential walk) — REUSED, never restated, so the hand-edited row one journal refuses the other
 * refuses too. Strict at every level: no seat can carry statement text, and the undo is built from
 * the structure at undo time (the Broker's `buildUndoStatement`). The engine `safeParse`s the exact
 * entry it is about to write as the capture seat's `admit` — so this schema decides, before COMMIT,
 * whether a change can be undone at all (D-PR4-4).
 *
 * THE TWO SPELLINGS. `'approval'` and `'task'` are spelled ONCE, here, as a subset of the access
 * journal's authorities (`satisfies` — a spelling the access record does not know is a type
 * error); the vias likewise over `AccessLogVia`, without `app` (an app never writes its own data
 * through the Broker — its own SQL is its own). The playground imports these; it never writes
 * the literal under `schedule/`.
 */

import { z } from 'zod';
import {
  ACCESS_UNDO_MAX_STEPS,
  accessUndoStepSchema,
  refuseUndoOversizeOrCredential,
  uuidV4Schema,
  type AccessLogVia,
  type AccessWriteAuthority,
} from './access.js';
import { SCHEDULE_ID_MAX_CHARS } from './schedule.js';

/** Who let an own write happen: the user's approval of one change, or a schedule's standing authority over its own app's data. */
export const OWN_WRITE_AUTHORITIES = ['approval', 'task'] as const satisfies readonly AccessWriteAuthority[];
export type OwnWriteAuthority = (typeof OWN_WRITE_AUTHORITIES)[number];

/** Which door the change came through — the chat's card, a schedule's run, or the user's act on a result page. */
export const OWN_UNDO_VIAS = ['chat', 'schedule', 'user'] as const satisfies readonly AccessLogVia[];
export type OwnUndoVia = (typeof OWN_UNDO_VIAS)[number];

/**
 * A task bucket holds at most this many LIVE entries — past it the engine holds the change
 * (`full`) rather than evict an undo the user may still want; the approval bucket gives its
 * oldest live entry way instead (the user was present for each).
 */
export const OWN_UNDO_MAX_LIVE = 20;
/** One `ownUndo:<appId>:<bucket>` row's serialised UTF-8 BYTES — enforced by the accessor, not the entry schema. */
export const OWN_UNDO_ROW_MAX_BYTES = 256 * 1024;

/** A run or task id, under the scheduler's own id bound. */
const scheduleIdSchema = z.string().min(1).max(SCHEDULE_ID_MAX_CHARS);
const isoInstant = z.iso.datetime();

/**
 * One entry of an `ownUndo:<appId>:<bucket>` row (D-PR4-3): when, until when, on whose authority
 * and through which door, the run and task a schedule's change came from, and the captured ROWS.
 * An undone entry is kept, marked `undoneAt`, until it expires; it is never offered again.
 */
export const ownUndoEntrySchema = z
  .strictObject({
    id: uuidV4Schema,
    at: isoInstant,
    expiresAt: isoInstant,
    authority: z.enum(OWN_WRITE_AUTHORITIES),
    via: z.enum(OWN_UNDO_VIAS),
    /** The run whose walk made the change — a task entry only. */
    runId: scheduleIdSchema.optional(),
    /** The task whose authority made the change — a task entry only (its bucket's name). */
    taskId: scheduleIdSchema.optional(),
    steps: z.array(accessUndoStepSchema).min(1).max(ACCESS_UNDO_MAX_STEPS),
    undoneAt: isoInstant.optional(),
  })
  .superRefine(refuseUndoOversizeOrCredential);
export type OwnUndoEntry = z.infer<typeof ownUndoEntrySchema>;
