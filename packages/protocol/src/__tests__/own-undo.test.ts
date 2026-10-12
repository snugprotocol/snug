/**
 * TASK-20261010-host-broker PR-4 — the OWN undo journal entry (contract v2 D-PR4-3, D-PR4-7;
 * AC31, AC32b). INTERNAL module `own-undo.ts` — NOT in `json-schemas.ts` SOURCES.
 *
 * An own write (the user's approval of a change to an app's own data, or an armed schedule's
 * change to its own app's data) is journaled host-internally in `ownUndo:<appId>:<bucket>` so
 * the user can put the rows back for seven days. The entry is the access journal's ROWS with
 * no grant and no reader — the per-cell credential walk, the 64 KiB cap and the step cap are
 * REUSED (extracted, not copied), so the same hand-edited row that `accessUndoEntrySchema`
 * refuses is refused here. No seat can carry statement text.
 */

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ACCESS_LOG_VIAS,
  ACCESS_MAX_COLUMNS,
  ACCESS_PARAM_STRING_MAX_CHARS,
  ACCESS_UNDO_MAX_BYTES,
  ACCESS_UNDO_MAX_STEPS,
  ACCESS_UNDO_TTL_MS,
  ACCESS_WRITE_AUTHORITIES,
  ACCESS_WRITE_MAX_ROWS,
  accessUndoEntrySchema,
} from '../access.js';
import { buildJsonSchemas } from '../json-schemas.js';
import * as protocolIndex from '../index.js';
import {
  OWN_UNDO_MAX_LIVE,
  OWN_UNDO_ROW_MAX_BYTES,
  OWN_UNDO_VIAS,
  OWN_WRITE_AUTHORITIES,
  ownUndoEntrySchema,
  type OwnUndoEntry,
  type OwnWriteAuthority,
} from '../own-undo.js';

const parses = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;
const utf8 = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const columnsOf = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);

const UNDO_ID = '3f2b8c1e-7a4d-4e5f-9b6a-1c2d3e4f5a6b';
const OPENAI_SHAPED_KEY = 'sk-Ab3dEf9hIjKl2MnOpQr5StUvWxYz01234567aBcD';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
/** A high-entropy, prefix-free string: refused ONLY when the walk sees it under a credential-ish key. */
const HIGH_ENTROPY = 'Zq8vL2pW9xR4kT7mN1bH6cJ3dF5gS0aY';

const step = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  table: 'transactions',
  op: 'update',
  columns: ['category', 'note'],
  rows: [{ rowid: 7, before: ['rent', 'march'], after: ['food', 'march'] }],
  ...over,
});

/** An approval entry: ONE update step of one row unless overridden. */
const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: UNDO_ID,
  at: '2026-10-11T09:00:00.000Z',
  expiresAt: '2026-10-18T09:00:00.000Z',
  authority: 'approval',
  via: 'chat',
  steps: [step()],
  ...over,
});
const taskEntry = (over: Record<string, unknown> = {}) => entry({ authority: 'task', via: 'schedule', runId: 'run-1', taskId: 'task-1', ...over });
const withSteps = (...steps: Record<string, unknown>[]) => entry({ steps });

describe('own-undo constants (D-PR4-3, D-PR4-7)', () => {
  it('OWN_WRITE_AUTHORITIES is exactly [approval, task] — a SUBSET of ACCESS_WRITE_AUTHORITIES, spelled once', () => {
    expect([...OWN_WRITE_AUTHORITIES]).toEqual(['approval', 'task']);
    for (const authority of OWN_WRITE_AUTHORITIES) expect(ACCESS_WRITE_AUTHORITIES).toContain(authority);
    expect(OWN_WRITE_AUTHORITIES).not.toContain('permission');
    const typed: OwnWriteAuthority = 'task';
    expect(typed).toBe('task');
  });

  it('OWN_UNDO_VIAS is exactly [chat, schedule, user] — a SUBSET of ACCESS_LOG_VIAS (never app: an app cannot write its own data through the broker)', () => {
    expect([...OWN_UNDO_VIAS]).toEqual(['chat', 'schedule', 'user']);
    for (const via of OWN_UNDO_VIAS) expect(ACCESS_LOG_VIAS).toContain(via);
    expect(OWN_UNDO_VIAS).not.toContain('app');
  });

  it('pins the bucket caps: 20 live entries, 256 KiB a row; the access journal\'s step cap is exported (64)', () => {
    expect(OWN_UNDO_MAX_LIVE).toBe(20);
    expect(OWN_UNDO_ROW_MAX_BYTES).toBe(256 * 1024);
    expect(ACCESS_UNDO_MAX_STEPS).toBe(64);
    expect(ACCESS_UNDO_MAX_BYTES).toBe(64 * 1024);
    expect(ACCESS_UNDO_TTL_MS).toBe(7 * 86_400_000);
  });

  it('own-undo stays OUT of json-schemas SOURCES (internal; pinned)', () => {
    const names = Object.keys(buildJsonSchemas());
    expect(names.some((name) => /undo|own/i.test(name))).toBe(false);
    expect(names).toHaveLength(16);
  });

  it('index.ts exports the module\'s names (the module contract)', () => {
    const exported = protocolIndex as Record<string, unknown>;
    for (const name of ['OWN_WRITE_AUTHORITIES', 'OWN_UNDO_VIAS', 'ownUndoEntrySchema', 'OWN_UNDO_MAX_LIVE', 'OWN_UNDO_ROW_MAX_BYTES', 'ACCESS_UNDO_MAX_STEPS']) {
      expect(exported[name], name).toBeDefined();
    }
    expect(exported.ownUndoEntrySchema).toBe(ownUndoEntrySchema);
  });
});

describe('ownUndoEntrySchema — the shape', () => {
  it('parses an approval entry, a task entry with runId and taskId, and an entry marked undone', () => {
    expect(parses(ownUndoEntrySchema, entry())).toBe(true);
    for (const via of OWN_UNDO_VIAS) expect(parses(ownUndoEntrySchema, entry({ via })), via).toBe(true);
    expect(parses(ownUndoEntrySchema, taskEntry())).toBe(true);
    expect(parses(ownUndoEntrySchema, entry({ undoneAt: '2026-10-12T09:00:00.000Z' }))).toBe(true);
    const parsed: OwnUndoEntry = ownUndoEntrySchema.parse(taskEntry());
    expect(parsed.taskId).toBe('task-1');
    expect(parsed.runId).toBe('run-1');
  });

  it('runId, taskId and undoneAt are omitted when absent', () => {
    const parsed = ownUndoEntrySchema.parse(entry());
    expect(Object.keys(parsed).sort()).toEqual(['at', 'authority', 'expiresAt', 'id', 'steps', 'via']);
  });

  it('authority is approval | task only — permission (a grant\'s) is refused; via is chat | schedule | user only', () => {
    // ADAPTED by PR-4 Gate-5 A1 (the refinement: authority task ⇔ taskId present) — a task entry now
    // carries its taskId. Was: `for (const authority of OWN_WRITE_AUTHORITIES) expect(parses(ownUndoEntrySchema, entry({ authority })), authority).toBe(true);`
    for (const authority of OWN_WRITE_AUTHORITIES) expect(parses(ownUndoEntrySchema, authority === 'task' ? taskEntry() : entry({ authority })), authority).toBe(true);
    expect(parses(ownUndoEntrySchema, entry({ authority: 'permission' }))).toBe(false);
    expect(parses(ownUndoEntrySchema, entry({ authority: 'cross' }))).toBe(false);
    expect(parses(ownUndoEntrySchema, entry({ via: 'app' }))).toBe(false);
    expect(parses(ownUndoEntrySchema, entry({ via: 'robot' }))).toBe(false);
  });

  it('has NO grant or reader seat — an own write names no other app', () => {
    expect(parses(ownUndoEntrySchema, entry({ grantId: UNDO_ID }))).toBe(false);
    expect(parses(ownUndoEntrySchema, entry({ readerAppId: 'budget' }))).toBe(false);
    expect(parses(ownUndoEntrySchema, entry({ readerName: 'Budget' }))).toBe(false);
    expect(parses(ownUndoEntrySchema, entry({ appId: 'budget' }))).toBe(false);
    // An access journal entry is not an own entry, and vice versa.
    expect(parses(accessUndoEntrySchema, entry())).toBe(false);
  });

  it('the seats around the rows: id a lowercase uuid v4, ISO instants, ids bounded 1..64', () => {
    expect(parses(ownUndoEntrySchema, entry({ id: 'undo-1' }))).toBe(false);
    expect(parses(ownUndoEntrySchema, entry({ id: UNDO_ID.toUpperCase() }))).toBe(false);
    expect(parses(ownUndoEntrySchema, entry({ id: undefined }))).toBe(false);
    expect(parses(ownUndoEntrySchema, entry({ at: 'now' }))).toBe(false);
    expect(parses(ownUndoEntrySchema, entry({ expiresAt: undefined }))).toBe(false);
    expect(parses(ownUndoEntrySchema, entry({ expiresAt: '2026-10-18' }))).toBe(false);
    expect(parses(ownUndoEntrySchema, entry({ undoneAt: 'later' }))).toBe(false);
    expect(parses(ownUndoEntrySchema, taskEntry({ taskId: 'x'.repeat(64), runId: 'y'.repeat(64) }))).toBe(true);
    expect(parses(ownUndoEntrySchema, taskEntry({ taskId: 'x'.repeat(65) }))).toBe(false);
    expect(parses(ownUndoEntrySchema, taskEntry({ runId: 'x'.repeat(65) }))).toBe(false);
    expect(parses(ownUndoEntrySchema, taskEntry({ taskId: '' }))).toBe(false);
  });
});

describe('ownUndoEntrySchema — ROWS, never SQL (no seat can carry statement text)', () => {
  it('strict at every level', () => {
    expect(parses(ownUndoEntrySchema, entry({ sql: 'DELETE FROM transactions WHERE 1' }))).toBe(false);
    expect(parses(ownUndoEntrySchema, entry({ statements: ['DELETE FROM transactions WHERE 1'] }))).toBe(false);
    expect(parses(ownUndoEntrySchema, withSteps(step({ sql: 'DELETE FROM transactions WHERE 1' })))).toBe(false);
    expect(parses(ownUndoEntrySchema, withSteps(step({ inverse: 'UPDATE transactions SET a = 1' })))).toBe(false);
    expect(parses(ownUndoEntrySchema, withSteps(step({ rows: [{ rowid: 7, before: ['a', 'b'], after: ['c', 'd'], where: 'id = 7' }] })))).toBe(false);
    expect(parses(ownUndoEntrySchema, withSteps(step({ op: 'replace' })))).toBe(false);
  });

  it('the op decides the row seats and the arity is the step\'s (the reused step schema)', () => {
    expect(parses(ownUndoEntrySchema, withSteps(step({ op: 'insert', columns: ['amount'], rows: [{ rowid: 1, after: [1] }] })))).toBe(true);
    expect(parses(ownUndoEntrySchema, withSteps(step({ op: 'insert', columns: ['amount'], rows: [{ rowid: 1, before: [1], after: [1] }] })))).toBe(false);
    expect(parses(ownUndoEntrySchema, withSteps(step({ op: 'delete', columns: ['amount'], rows: [{ rowid: 1, before: [1] }] })))).toBe(true);
    expect(parses(ownUndoEntrySchema, withSteps(step({ op: 'delete', columns: ['amount'], rows: [{ rowid: 1, after: [1] }] })))).toBe(false);
    expect(parses(ownUndoEntrySchema, withSteps(step({ columns: ['category', 'note'], rows: [{ rowid: 7, before: ['rent'], after: ['food', 'march'] }] })))).toBe(false);
    expect(parses(ownUndoEntrySchema, withSteps(step({ rows: [] })))).toBe(false);
  });
});

describe('ownUndoEntrySchema — what admit() catches (D-PR4-4: the engine safeParses the exact entry it will write)', () => {
  it('snug_kv, sqlite_ and reserved names are refused as a step table — the kv table is never captured', () => {
    for (const table of ['snug_kv', 'SNUG_KV', 'sqlite_master', 'app_x__t', '1t']) {
      expect(parses(ownUndoEntrySchema, withSteps(step({ table }))), table).toBe(false);
    }
    expect(parses(ownUndoEntrySchema, withSteps(step({ table: 'transactions' })))).toBe(true);
  });

  it('a column name longer than 64 is refused; 64 is the passing twin', () => {
    const named = (column: string) => withSteps(step({ op: 'insert', columns: [column], rows: [{ rowid: 1, after: [1] }] }));
    expect(parses(ownUndoEntrySchema, named('c'.repeat(64)))).toBe(true);
    expect(parses(ownUndoEntrySchema, named('c'.repeat(65)))).toBe(false);
  });

  it('more than 64 columns in a step is refused; 64 is the passing twin', () => {
    const wide = (n: number) => withSteps(step({ op: 'insert', columns: columnsOf(n), rows: [{ rowid: 1, after: columnsOf(n).map(() => 1) }] }));
    expect(ACCESS_MAX_COLUMNS).toBe(64);
    expect(parses(ownUndoEntrySchema, wide(ACCESS_MAX_COLUMNS))).toBe(true);
    expect(parses(ownUndoEntrySchema, wide(ACCESS_MAX_COLUMNS + 1))).toBe(false);
  });

  it('more than 200 rows in a step is refused; 200 is the passing twin', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ rowid: i + 1, after: [i] }));
    expect(parses(ownUndoEntrySchema, withSteps(step({ op: 'insert', columns: ['a'], rows: rows(ACCESS_WRITE_MAX_ROWS) })))).toBe(true);
    expect(parses(ownUndoEntrySchema, withSteps(step({ op: 'insert', columns: ['a'], rows: rows(ACCESS_WRITE_MAX_ROWS + 1) })))).toBe(false);
  });

  it('steps 1..ACCESS_UNDO_MAX_STEPS: none and 65 are refused; 64 is the passing twin', () => {
    const tiny = (i: number) => step({ op: 'insert', columns: ['a'], rows: [{ rowid: i, after: [i] }] });
    expect(parses(ownUndoEntrySchema, entry({ steps: [] }))).toBe(false);
    expect(parses(ownUndoEntrySchema, entry({ steps: Array.from({ length: ACCESS_UNDO_MAX_STEPS }, (_, i) => tiny(i)) }))).toBe(true);
    expect(parses(ownUndoEntrySchema, entry({ steps: Array.from({ length: ACCESS_UNDO_MAX_STEPS + 1 }, (_, i) => tiny(i)) }))).toBe(false);
  });

  it('a credential in ANY captured cell is a refusal — walked under its column (the extracted per-cell walk)', () => {
    const cell = (value: unknown, column = 'note', where: 'before' | 'after' = 'after') =>
      withSteps(
        step({
          columns: ['category', column],
          rows: [{ rowid: 7, before: ['rent', where === 'before' ? value : 'march'], after: ['food', where === 'after' ? value : 'march'] }],
        }),
      );
    expect(parses(ownUndoEntrySchema, cell('Bearer abcdef1234567890xyz'))).toBe(false);
    expect(parses(ownUndoEntrySchema, cell(JWT, 'note', 'before'))).toBe(false);
    expect(parses(ownUndoEntrySchema, cell(OPENAI_SHAPED_KEY))).toBe(false);
    expect(parses(ownUndoEntrySchema, cell('https://alice:hunter2@example.com/x'))).toBe(false);
    expect(parses(ownUndoEntrySchema, withSteps(step({ op: 'insert', columns: ['note'], rows: [{ rowid: 9, after: [OPENAI_SHAPED_KEY] }] })))).toBe(false);
    // The column is the key the walk judges by.
    expect(parses(ownUndoEntrySchema, cell(HIGH_ENTROPY, 'session_token'))).toBe(false);
    expect(parses(ownUndoEntrySchema, cell(HIGH_ENTROPY, 'note'))).toBe(true);
    // Passing twins.
    expect(parses(ownUndoEntrySchema, cell('pay the bearer'))).toBe(true);
    expect(parses(ownUndoEntrySchema, cell('lunch with Sam'))).toBe(true);
  });

  it('the serialised entry is capped at ACCESS_UNDO_MAX_BYTES: exactly 64 KiB passes, one byte more refuses', () => {
    const ofBytes = (target: number): Record<string, unknown> => {
      const rows: { rowid: number; before: string[]; after: string[] }[] = [];
      const make = (): Record<string, unknown> => withSteps(step({ columns: ['note'], rows }));
      const full = 'x'.repeat(ACCESS_PARAM_STRING_MAX_CHARS);
      while (utf8(make()) + 2 * ACCESS_PARAM_STRING_MAX_CHARS + 80 <= target) rows.push({ rowid: rows.length + 1, before: [full], after: [full] });
      rows.push({ rowid: rows.length + 1, before: [''], after: [''] });
      const room = target - utf8(make());
      expect(room).toBeGreaterThanOrEqual(0);
      expect(room).toBeLessThanOrEqual(2 * ACCESS_PARAM_STRING_MAX_CHARS);
      const last = rows[rows.length - 1]!;
      const first = Math.min(room, ACCESS_PARAM_STRING_MAX_CHARS);
      last.before = ['y'.repeat(first)];
      last.after = ['z'.repeat(room - first)];
      return make();
    };
    const atCap = ofBytes(ACCESS_UNDO_MAX_BYTES);
    expect(utf8(atCap)).toBe(ACCESS_UNDO_MAX_BYTES);
    expect(parses(ownUndoEntrySchema, atCap)).toBe(true);
    const over = ofBytes(ACCESS_UNDO_MAX_BYTES + 1);
    expect(utf8(over)).toBe(ACCESS_UNDO_MAX_BYTES + 1);
    expect(parses(ownUndoEntrySchema, over)).toBe(false);
  });

  it('cells are bound-parameter scalars: an object or an array cell is refused', () => {
    expect(parses(ownUndoEntrySchema, withSteps(step({ rows: [{ rowid: 7, before: [{ a: 1 }, 'b'], after: ['c', 'd'] }] })))).toBe(false);
    expect(parses(ownUndoEntrySchema, withSteps(step({ rows: [{ rowid: 7, before: [['a'], 'b'], after: ['c', 'd'] }] })))).toBe(false);
    expect(parses(ownUndoEntrySchema, withSteps(step({ rows: [{ rowid: '7', before: ['a', 'b'], after: ['c', 'd'] }] })))).toBe(false);
  });
});

// =================================================================================================
// PR-4 Gate-5 A1 [SEC-F1, AUTH-F4, AUTH-F10] — which bucket an entry belongs in is decidable from the
// entry alone (the schema ties `taskId` to the `task` authority), and each authority is exported by
// NAME so no caller picks one by its position in OWN_WRITE_AUTHORITIES.
// =================================================================================================

describe('PR-4 Gate-5 A1 — the authorities by name', () => {
  const exported = protocolIndex as Record<string, unknown>;

  it('TASK_WRITE_AUTHORITY is "task" and APPROVAL_WRITE_AUTHORITY is "approval" — both members of OWN_WRITE_AUTHORITIES', () => {
    expect(exported.TASK_WRITE_AUTHORITY).toBe('task');
    expect(exported.APPROVAL_WRITE_AUTHORITY).toBe('approval');
    expect(OWN_WRITE_AUTHORITIES as readonly unknown[]).toContain(exported.TASK_WRITE_AUTHORITY);
    expect(OWN_WRITE_AUTHORITIES as readonly unknown[]).toContain(exported.APPROVAL_WRITE_AUTHORITY);
  });

  it('they are exported from the module and the index alike', async () => {
    const module = (await import('../own-undo.js')) as Record<string, unknown>;
    expect(module.TASK_WRITE_AUTHORITY).toBe(exported.TASK_WRITE_AUTHORITY);
    expect(module.APPROVAL_WRITE_AUTHORITY).toBe(exported.APPROVAL_WRITE_AUTHORITY);
  });
});

describe('PR-4 Gate-5 A1 — the refinement: authority task ⇔ taskId present', () => {
  it('a task entry WITH its taskId parses; WITHOUT one it is refused', () => {
    expect(parses(ownUndoEntrySchema, taskEntry())).toBe(true);
    const { taskId: _gone, ...noTask } = taskEntry();
    expect(parses(ownUndoEntrySchema, noTask)).toBe(false);
    expect(parses(ownUndoEntrySchema, entry({ authority: 'task', via: 'schedule', runId: 'run-1' }))).toBe(false);
  });

  it('an approval entry WITHOUT a taskId parses; WITH one it is refused', () => {
    expect(parses(ownUndoEntrySchema, entry())).toBe(true);
    expect(parses(ownUndoEntrySchema, entry({ taskId: 'task-1' }))).toBe(false);
    expect(parses(ownUndoEntrySchema, entry({ taskId: 'approval' }))).toBe(false);
  });

  it('a task entry whose taskId spells the approval bucket still parses (the BUCKET rule is the accessor’s, the arming refusal the act’s)', () => {
    expect(parses(ownUndoEntrySchema, taskEntry({ taskId: 'approval' }))).toBe(true);
  });
});
