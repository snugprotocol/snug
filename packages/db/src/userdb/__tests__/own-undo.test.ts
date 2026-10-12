// own-undo.test.ts — TASK-20261010-host-broker PR-4 (contract v2 D-PR4-3; AC31, AC32b): the OWN
// undo journal — `ownUndo:<appId>:<taskId>` (one row per armed task) and `ownUndo:<appId>:approval`
// (the user's own approvals), each ONE JSON array row of `ownUndoEntrySchema` entries, newest first.
//
//  - WRITES FAIL CLOSED: a put parses strictly first; a refused put leaves the file byte-identical.
//  - A TASK bucket holds ≤ OWN_UNDO_MAX_LIVE (20) live entries and ≤ OWN_UNDO_ROW_MAX_BYTES a row:
//    past either it answers 'full' and writes nothing — a live entry is never evicted.
//  - The APPROVAL bucket NEVER refuses: the oldest LIVE entry gives way (the user was present for each).
//  - Undone entries give way FIRST in both; expired entries (7 days) never list and are pruned.
//  - Swept with the app (`deleteApp`, the `ownUndo:<appId>:` prefix) and with the task
//    (`deleteScheduledTask`, its bucket); dropped on an UNTRUSTED import, kept on a trusted pull.
//
// Fixtures are RELATIVE to the wall clock (the accessors read it): an instant is "now ± n", never a
// fixed date compared against a live clock (the 2026-10-11 lesson).

import { beforeEach, describe, expect, it } from 'vitest';
import { OWN_UNDO_MAX_LIVE, OWN_UNDO_ROW_MAX_BYTES, scheduledTaskSchema, type OwnUndoEntry, type ScheduledTask } from '@snugprotocol/protocol';

import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import { ownUndoKey } from '../app-settings-keys.js';
import * as ownUndoModule from '../own-undo.js';
import { UserDbError, openUserDb, type UserDb } from '../userdb.js';

let backend: MemoryBackend;
let db: UserDb;

const LEDGER = '0b1c7e3a-5f2d-4c8e-9a61-2d3e4f5a6b7c';
const PANTRY = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const DAY = 86_400_000;
const TTL = 7 * DAY;
/** The contract's caps (D-PR4-3), spelled here so a fixture never sizes itself by a constant that does not exist yet; pinned equal to the protocol's below. */
const LIVE = 20;
const ROW_BYTES = 256 * 1024;

async function openDb(store: MemoryBackend = createMemoryBackend()): Promise<UserDb> {
  const result = await openUserDb({ backend: store, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  return result.userDb;
}

beforeEach(async () => {
  backend = createMemoryBackend();
  db = await openDb(backend);
  db.installApp({ appId: LEDGER, displayName: 'Ledger', html: '<html>ledger</html>' });
  db.installApp({ appId: PANTRY, displayName: 'Pantry', html: '<html>pantry</html>' });
});

const iso = (ms: number): string => new Date(ms).toISOString();
const utf8Bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const fileBytes = (): Promise<Uint8Array> => db.exportUserDb({ includeSecrets: true });
const idsIn = (raw: unknown): string[] => (Array.isArray(raw) ? raw.map((e) => (e as { id?: string }).id ?? '?') : []);

type OwnUndoAccessors = Pick<UserDb, 'listOwnUndo' | 'putOwnUndo' | 'markOwnUndone' | 'ownUndoRoom'>;
const own = (target: UserDb = db): OwnUndoAccessors => target;

/** One task-bucket entry: one updated row unless overridden; `at` is now. */
function ownEntry(over: Partial<OwnUndoEntry> = {}): OwnUndoEntry {
  const at = over.at ?? iso(Date.now());
  return {
    id: crypto.randomUUID(),
    at,
    expiresAt: iso(Date.parse(at) + TTL),
    authority: 'task',
    via: 'schedule',
    runId: 'run-1',
    taskId: 'task-1',
    steps: [{ table: 'transactions', op: 'update', columns: ['note'], rows: [{ rowid: 1, before: ['coffee'], after: ['snack'] }] }],
    ...over,
  } as OwnUndoEntry;
}

/** An approval-bucket entry (no run, no task). */
function approvalEntry(over: Partial<OwnUndoEntry> = {}): OwnUndoEntry {
  const { runId: _r, taskId: _t, ...rest } = ownEntry({ authority: 'approval', via: 'chat', ...over });
  return { ...rest, ...over } as OwnUndoEntry;
}

/** An entry just under 64 KiB of JSON: 100 updated rows of prose, before and after. */
function heavy(make: (over: Partial<OwnUndoEntry>) => OwnUndoEntry = ownEntry, over: Partial<OwnUndoEntry> = {}): OwnUndoEntry {
  const prose = (i: number): string => `${i} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor `.repeat(4).slice(0, 280);
  const rows = Array.from({ length: 100 }, (_, i) => ({ rowid: i + 1, before: [prose(i)], after: [prose(i + 1000)] }));
  return make({ steps: [{ table: 'transactions', op: 'update', columns: ['note'], rows }], ...over });
}

function armedTask(id: string, appId: string = LEDGER): ScheduledTask {
  return scheduledTaskSchema.parse({
    id,
    title: `Task ${id}`,
    enabled: true,
    provenance: 'user',
    steps: [{ kind: 'app-think', appId, prompt: 'tidy the notes', context: { maxRows: 50 } }],
    spec: { kind: 'daily', time: '08:00', tz: 'device' },
    cron: '0 8 * * *',
    missedPolicy: 'run-once',
    staleAfterMs: 86_400_000,
    alert: 'inbox',
    appVersions: { [appId]: 1 },
    createdAt: iso(Date.now() - DAY),
    updatedAt: iso(Date.now() - DAY),
    writeAuthority: { rowsPerRun: 200, armedAt: iso(Date.now() - DAY), armedVersion: 1 },
  });
}

describe('ownUndoKey — one row per bucket (D-PR4-3; single-homed in app-settings-keys.ts)', () => {
  it('ownUndo:<appId>:<taskId> for a task, ownUndo:<appId>:approval for the user’s approvals', () => {
    expect(ownUndoKey(LEDGER, 'task-1')).toBe(`ownUndo:${LEDGER}:task-1`);
    expect(ownUndoKey(LEDGER, 'approval')).toBe(`ownUndo:${LEDGER}:approval`);
    expect(ownUndoKey(PANTRY, 'task-1')).not.toBe(ownUndoKey(LEDGER, 'task-1'));
  });

  it('pins the bucket caps the accessors enforce', () => {
    expect(OWN_UNDO_MAX_LIVE).toBe(LIVE);
    expect(OWN_UNDO_ROW_MAX_BYTES).toBe(ROW_BYTES);
  });
});

describe('putOwnUndo / listOwnUndo / markOwnUndone', () => {
  it('stores ONE JSON array row per bucket, newest first; lists the live entries of the asked bucket only', () => {
    const first = ownEntry();
    const second = ownEntry({ runId: 'run-2' });
    const other = ownEntry({ taskId: 'task-2' });
    const approved = approvalEntry();
    expect(own().putOwnUndo(LEDGER, 'task-1', first)).toBe('ok');
    expect(own().putOwnUndo(LEDGER, 'task-1', second)).toBe('ok');
    expect(own().putOwnUndo(LEDGER, 'task-2', other)).toBe('ok');
    expect(own().putOwnUndo(LEDGER, 'approval', approved)).toBe('ok');
    expect(idsIn(db.getSetting(ownUndoKey(LEDGER, 'task-1')))).toEqual([second.id, first.id]);
    expect(own().listOwnUndo(LEDGER, { taskId: 'task-1' })).toEqual([second, first]);
    expect(own().listOwnUndo(LEDGER, { taskId: 'task-2' })).toEqual([other]);
    expect(own().listOwnUndo(LEDGER, { bucket: 'approval' })).toEqual([approved]);
    expect(own().listOwnUndo(PANTRY, { bucket: 'approval' })).toEqual([]);
    expect(own().listOwnUndo(PANTRY, { taskId: 'task-1' })).toEqual([]);
  });

  it('parses STRICTLY before it writes: statement text, a credential cell, no steps, a non-uuid id, a grant’s authority, snug_kv → a UserDbError, file byte-identical', async () => {
    own().putOwnUndo(LEDGER, 'task-1', ownEntry());
    const before = await fileBytes();
    const bad: Array<[string, unknown]> = [
      ['a statement-text seat', { ...ownEntry(), sql: 'DELETE FROM transactions WHERE 1 = 1' }],
      ['a credential in a captured cell', ownEntry({ steps: [{ table: 'transactions', op: 'update', columns: ['note'], rows: [{ rowid: 1, before: ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD'], after: ['b'] }] }] })],
      ['no steps', ownEntry({ steps: [] })],
      ['an id that is not a uuid v4', ownEntry({ id: 'undo-1' })],
      ['the grant authority', { ...ownEntry(), authority: 'permission' }],
      ['a reader seat', { ...ownEntry(), readerAppId: PANTRY }],
      ['the kv table', ownEntry({ steps: [{ table: 'snug_kv', op: 'update', columns: ['v'], rows: [{ rowid: 1, before: ['a'], after: ['b'] }] }] })],
    ];
    for (const [label, entry] of bad) {
      expect(() => own().putOwnUndo(LEDGER, 'task-1', entry as OwnUndoEntry), label).toThrow(UserDbError);
    }
    expect(await fileBytes()).toEqual(before);
  });

  it('markOwnUndone stamps undoneAt: the entry leaves listOwnUndo; an unknown id is a no-op', () => {
    const done = ownEntry();
    const kept = ownEntry();
    own().putOwnUndo(LEDGER, 'task-1', done);
    own().putOwnUndo(LEDGER, 'task-1', kept);
    own().markOwnUndone(LEDGER, 'task-1', done.id, iso(Date.now()));
    expect(own().listOwnUndo(LEDGER, { taskId: 'task-1' }).map((e) => e.id)).toEqual([kept.id]);
    const stored = db.getSetting(ownUndoKey(LEDGER, 'task-1')) as Array<{ id: string; undoneAt?: string }>;
    expect(stored.find((e) => e.id === done.id)?.undoneAt).toBeDefined(); // kept, marked
    expect(() => own().markOwnUndone(LEDGER, 'task-1', crypto.randomUUID(), iso(Date.now()))).not.toThrow();
    // Marking in one bucket never touches another's.
    const approved = approvalEntry();
    own().putOwnUndo(LEDGER, 'approval', approved);
    own().markOwnUndone(LEDGER, 'task-1', approved.id, iso(Date.now()));
    expect(own().listOwnUndo(LEDGER, { bucket: 'approval' }).map((e) => e.id)).toEqual([approved.id]);
  });

  it('kept seven days: an expired entry never lists, never counts toward the twenty, and is pruned by the next put', () => {
    const expired = Array.from({ length: LIVE }, () => ownEntry({ at: iso(Date.now() - 8 * DAY), expiresAt: iso(Date.now() - DAY) }));
    const live = ownEntry();
    db.setSetting(ownUndoKey(LEDGER, 'task-1'), [live, ...expired]); // planted, so no put has pruned them yet
    expect(own().listOwnUndo(LEDGER, { taskId: 'task-1' })).toEqual([live]);
    const next = ownEntry();
    expect(own().putOwnUndo(LEDGER, 'task-1', next)).toBe('ok');
    expect(idsIn(db.getSetting(ownUndoKey(LEDGER, 'task-1')))).toEqual([next.id, live.id]);
  });

  it('a row or an element that does not parse is skipped on read — never a throw', () => {
    const good = ownEntry();
    db.setSetting(ownUndoKey(LEDGER, 'task-1'), [good, { id: 'junk' }, { ...ownEntry(), sql: 'DELETE FROM t' }, 'nonsense']);
    expect(own().listOwnUndo(LEDGER, { taskId: 'task-1' })).toEqual([good]);
    db.setSetting(ownUndoKey(LEDGER, 'approval'), { not: 'an array' });
    expect(own().listOwnUndo(LEDGER, { bucket: 'approval' })).toEqual([]);
  });
});

describe('the TASK bucket refuses — never evicts a live entry (D-PR4-3)', () => {
  it('the 21st live entry answers \'full\' and writes nothing; another task’s bucket and the approval bucket still write', async () => {
    const mine: OwnUndoEntry[] = [];
    for (let i = 0; i < LIVE; i += 1) {
      const e = ownEntry({ runId: `run-${i}` });
      mine.push(e);
      expect(own().putOwnUndo(LEDGER, 'task-1', e)).toBe('ok');
    }
    const before = await fileBytes();
    expect(own().putOwnUndo(LEDGER, 'task-1', ownEntry())).toBe('full');
    expect(await fileBytes()).toEqual(before);
    expect(own().listOwnUndo(LEDGER, { taskId: 'task-1' })).toHaveLength(LIVE);
    expect(own().listOwnUndo(LEDGER, { taskId: 'task-1' }).at(-1)?.id).toBe(mine[0]!.id); // the oldest is still undoable

    expect(own().putOwnUndo(LEDGER, 'task-2', ownEntry({ taskId: 'task-2' }))).toBe('ok');
    expect(own().putOwnUndo(LEDGER, 'approval', approvalEntry())).toBe('ok');
  });

  it('an UNDONE entry gives way first: once one of the twenty is undone the next put is ok', () => {
    const mine = Array.from({ length: LIVE }, (_, i) => ownEntry({ runId: `run-${i}` }));
    for (const e of mine) own().putOwnUndo(LEDGER, 'task-1', e);
    expect(own().putOwnUndo(LEDGER, 'task-1', ownEntry())).toBe('full');
    own().markOwnUndone(LEDGER, 'task-1', mine[3]!.id, iso(Date.now()));
    const next = ownEntry();
    expect(own().putOwnUndo(LEDGER, 'task-1', next)).toBe('ok');
    expect(own().listOwnUndo(LEDGER, { taskId: 'task-1' })).toHaveLength(LIVE);
    expect(own().listOwnUndo(LEDGER, { taskId: 'task-1' })[0]?.id).toBe(next.id);
  });

  it('a row at 256 KiB: a put that would cross it answers \'full\' (nothing evicted); an undone entry gives way first', async () => {
    expect(utf8Bytes(heavy())).toBeLessThan(64 * 1024);
    expect(utf8Bytes(heavy())).toBeGreaterThan(ROW_BYTES / 5);
    const four = Array.from({ length: 4 }, () => heavy());
    for (const e of four) expect(own().putOwnUndo(LEDGER, 'task-1', e)).toBe('ok');
    const before = await fileBytes();
    expect(own().putOwnUndo(LEDGER, 'task-1', heavy())).toBe('full');
    expect(await fileBytes()).toEqual(before);

    own().markOwnUndone(LEDGER, 'task-1', four[2]!.id, iso(Date.now()));
    const fifth = heavy();
    expect(own().putOwnUndo(LEDGER, 'task-1', fifth)).toBe('ok');
    const ids = idsIn(db.getSetting(ownUndoKey(LEDGER, 'task-1')));
    expect(ids).not.toContain(four[2]!.id);
    expect(ids[0]).toBe(fifth.id);
    expect(utf8Bytes(db.getSetting(ownUndoKey(LEDGER, 'task-1')))).toBeLessThanOrEqual(ROW_BYTES);
  });
});

describe('the APPROVAL bucket never refuses — its oldest live entry gives way (D-PR4-3; D3)', () => {
  it('the 21st approval is ok: the OLDEST live approval is evicted, the newest twenty stay', () => {
    const mine = Array.from({ length: LIVE }, () => approvalEntry());
    for (const e of mine) expect(own().putOwnUndo(LEDGER, 'approval', e)).toBe('ok');
    const next = approvalEntry();
    expect(own().putOwnUndo(LEDGER, 'approval', next)).toBe('ok');
    const listed = own().listOwnUndo(LEDGER, { bucket: 'approval' }).map((e) => e.id);
    expect(listed).toHaveLength(LIVE);
    expect(listed[0]).toBe(next.id);
    expect(listed).not.toContain(mine[0]!.id);
    expect(listed).toContain(mine[1]!.id);
  });

  it('past the row bytes the oldest live entry gives way; the row stays ≤ 256 KiB', () => {
    const four = Array.from({ length: 4 }, () => heavy(approvalEntry));
    for (const e of four) own().putOwnUndo(LEDGER, 'approval', e);
    const fifth = heavy(approvalEntry);
    expect(own().putOwnUndo(LEDGER, 'approval', fifth)).toBe('ok');
    const ids = idsIn(db.getSetting(ownUndoKey(LEDGER, 'approval')));
    expect(ids[0]).toBe(fifth.id);
    expect(ids).not.toContain(four[0]!.id);
    expect(utf8Bytes(db.getSetting(ownUndoKey(LEDGER, 'approval')))).toBeLessThanOrEqual(ROW_BYTES);
  });

  it('an UNDONE entry gives way before any live one — the oldest live approval survives when an undone one can make the room', () => {
    const four = Array.from({ length: 4 }, () => heavy(approvalEntry));
    for (const e of four) own().putOwnUndo(LEDGER, 'approval', e);
    own().markOwnUndone(LEDGER, 'approval', four[3]!.id, iso(Date.now())); // the NEWEST is the undone one
    const fifth = heavy(approvalEntry);
    expect(own().putOwnUndo(LEDGER, 'approval', fifth)).toBe('ok');
    const ids = idsIn(db.getSetting(ownUndoKey(LEDGER, 'approval')));
    expect(ids).not.toContain(four[3]!.id);
    expect(ids).toContain(four[0]!.id);
  });
});

describe('ownUndoRoom — the room check the engine makes BEFORE the seat (D-PR4-3)', () => {
  it('a task bucket has room until twenty live entries; an undone entry frees its seat', () => {
    expect(own().ownUndoRoom(LEDGER, 'task-1')).toBe(true);
    const mine = Array.from({ length: LIVE }, () => ownEntry());
    for (const [i, e] of mine.entries()) {
      expect(own().ownUndoRoom(LEDGER, 'task-1'), `before entry ${i + 1}`).toBe(true);
      own().putOwnUndo(LEDGER, 'task-1', e);
    }
    expect(own().ownUndoRoom(LEDGER, 'task-1')).toBe(false);
    expect(own().ownUndoRoom(LEDGER, 'task-2')).toBe(true);
    own().markOwnUndone(LEDGER, 'task-1', mine[0]!.id, iso(Date.now()));
    expect(own().ownUndoRoom(LEDGER, 'task-1')).toBe(true);
  });

  it('… and until one more FULL entry no longer fits the row: three near-64-KiB live entries leave room, four do not', () => {
    for (let i = 0; i < 3; i += 1) own().putOwnUndo(LEDGER, 'task-1', heavy());
    expect(own().ownUndoRoom(LEDGER, 'task-1')).toBe(true);
    own().putOwnUndo(LEDGER, 'task-1', heavy());
    expect(own().ownUndoRoom(LEDGER, 'task-1')).toBe(false);
  });

  it('an expired entry takes no room', () => {
    db.setSetting(
      ownUndoKey(LEDGER, 'task-1'),
      Array.from({ length: LIVE }, () => ownEntry({ at: iso(Date.now() - 8 * DAY), expiresAt: iso(Date.now() - DAY) })),
    );
    expect(own().ownUndoRoom(LEDGER, 'task-1')).toBe(true);
  });
});

describe('sweeps — deleteApp the prefix, deleteScheduledTask its bucket (D-PR4-3)', () => {
  it('deleteApp removes every ownUndo:<appId>: row — task buckets and the approval bucket; another app’s rows stay', async () => {
    own().putOwnUndo(LEDGER, 'task-1', ownEntry());
    own().putOwnUndo(LEDGER, 'task-2', ownEntry({ taskId: 'task-2' }));
    own().putOwnUndo(LEDGER, 'approval', approvalEntry());
    own().putOwnUndo(PANTRY, 'approval', approvalEntry());
    own().putOwnUndo(PANTRY, 'task-1', ownEntry());

    await db.deleteApp(LEDGER);

    const keys = db.listSettingKeys();
    expect(keys.filter((key) => key.startsWith(`ownUndo:${LEDGER}:`))).toEqual([]);
    expect(keys).toContain(ownUndoKey(PANTRY, 'approval'));
    expect(keys).toContain(ownUndoKey(PANTRY, 'task-1'));
  });

  it('deleteScheduledTask removes its own bucket; the app’s other buckets stay', () => {
    db.putScheduledTask(armedTask('task-1'));
    db.putScheduledTask(armedTask('task-2'));
    own().putOwnUndo(LEDGER, 'task-1', ownEntry());
    own().putOwnUndo(LEDGER, 'task-2', ownEntry({ taskId: 'task-2' }));
    own().putOwnUndo(LEDGER, 'approval', approvalEntry());

    db.deleteScheduledTask('task-1');

    const keys = db.listSettingKeys();
    expect(keys).not.toContain(ownUndoKey(LEDGER, 'task-1'));
    expect(keys).toContain(ownUndoKey(LEDGER, 'task-2'));
    expect(keys).toContain(ownUndoKey(LEDGER, 'approval'));
    expect(own().listOwnUndo(LEDGER, { taskId: 'task-1' })).toEqual([]);
  });
});

describe('import — an UNTRUSTED file drops every ownUndo:* row; a TRUSTED pull keeps them (D-PR4-3)', () => {
  async function donorWithJournal(): Promise<{ bytes: Uint8Array; task: OwnUndoEntry; approved: OwnUndoEntry }> {
    const donor = await openDb();
    donor.installApp({ appId: LEDGER, displayName: 'Ledger', html: '<html>ledger</html>' });
    const task = ownEntry();
    const approved = approvalEntry();
    own(donor).putOwnUndo(LEDGER, 'task-1', task);
    own(donor).putOwnUndo(LEDGER, 'approval', approved);
    const bytes = await donor.exportUserDb({ includeSecrets: true });
    await donor.close();
    return { bytes, task, approved };
  }

  it('untrusted: no ownUndo:* key survives — a foreign file never plants an undo the user did not make', async () => {
    const { bytes } = await donorWithJournal();
    const target = await openDb();
    await target.importUserDb(bytes);
    expect(target.listSettingKeys().filter((key) => key.startsWith('ownUndo:'))).toEqual([]);
    expect(own(target).listOwnUndo(LEDGER, { taskId: 'task-1' })).toEqual([]);
    expect(own(target).listOwnUndo(LEDGER, { bucket: 'approval' })).toEqual([]);
    await target.close();
  });

  it('trusted: both buckets arrive as they were (the user’s own device state)', async () => {
    const { bytes, task, approved } = await donorWithJournal();
    const target = await openDb();
    await target.importUserDb(bytes, { trustedOrigin: true });
    expect(own(target).listOwnUndo(LEDGER, { taskId: 'task-1' })).toEqual([task]);
    expect(own(target).listOwnUndo(LEDGER, { bucket: 'approval' })).toEqual([approved]);
    await target.close();
  });
});

// =================================================================================================
// PR-4 Gate-5 A1 (the bucket rule, one predicate), A12 (undone-but-unexpired entries on request),
// A13 (the room check stays the gate; the live count is the listing's).
// =================================================================================================

type Belongs = (bucket: string, entry: { authority: 'task' | 'approval'; taskId?: string }) => boolean;
const belongs = (): Belongs => {
  const fn = (ownUndoModule as Record<string, unknown>).ownUndoBelongsIn;
  if (typeof fn !== 'function') throw new Error('ownUndoBelongsIn is not exported from own-undo.ts yet');
  return fn as Belongs;
};

describe('PR-4 Gate-5 A1 — ownUndoBelongsIn(bucket, {authority, taskId}): ONE rule for the put, every read and the seat', () => {
  it('approval ⇔ the approval bucket and no taskId', () => {
    expect(belongs()('approval', { authority: 'approval' })).toBe(true);
    expect(belongs()('approval', { authority: 'approval', taskId: 'task-1' })).toBe(false);
    expect(belongs()('task-1', { authority: 'approval' })).toBe(false);
  });

  it('task ⇔ taskId === bucket, and the bucket is never approval (a task whose id spells it included)', () => {
    expect(belongs()('task-1', { authority: 'task', taskId: 'task-1' })).toBe(true);
    expect(belongs()('task-2', { authority: 'task', taskId: 'task-1' })).toBe(false);
    expect(belongs()('task-1', { authority: 'task' })).toBe(false);
    expect(belongs()('approval', { authority: 'task', taskId: 'approval' })).toBe(false);
  });

  it('it is exported from @snugprotocol/db (the engine asks it before any seat)', async () => {
    const db = (await import('../../index.js')) as Record<string, unknown>;
    expect(db.ownUndoBelongsIn).toBe((ownUndoModule as Record<string, unknown>).ownUndoBelongsIn);
  });

  it('putOwnUndo refuses a task entry into the approval bucket — the file byte-identical', async () => {
    const before = await fileBytes();
    expect(() => own().putOwnUndo(LEDGER, 'approval', ownEntry({ taskId: 'approval' }))).toThrow(UserDbError);
    expect(await fileBytes()).toEqual(before);
  });

  it('listOwnUndo FILTERS by the rule: a planted element from another bucket is never listed (nor counted as live, nor kept on the next put)', () => {
    const mine = ownEntry();
    const otherTask = ownEntry({ taskId: 'task-2' });
    const anApproval = approvalEntry();
    db.setSetting(ownUndoKey(LEDGER, 'task-1'), [mine, otherTask, anApproval]); // planted: no put has filtered them
    expect(own().listOwnUndo(LEDGER, { taskId: 'task-1' })).toEqual([mine]);

    const aTasksChange = ownEntry({ taskId: 'approval' });
    const approved = approvalEntry();
    db.setSetting(ownUndoKey(LEDGER, 'approval'), [aTasksChange, approved]);
    expect(own().listOwnUndo(LEDGER, { bucket: 'approval' })).toEqual([approved]);

    const next = ownEntry();
    expect(own().putOwnUndo(LEDGER, 'task-1', next)).toBe('ok');
    expect(idsIn(db.getSetting(ownUndoKey(LEDGER, 'task-1')))).toEqual([next.id, mine.id]);
  });

  it('a planted out-of-bucket element takes no room (the twenty count only what belongs)', () => {
    db.setSetting(
      ownUndoKey(LEDGER, 'task-1'),
      Array.from({ length: LIVE }, () => ownEntry({ taskId: 'task-2' })),
    );
    expect(own().ownUndoRoom(LEDGER, 'task-1')).toBe(true);
  });
});

describe('PR-4 Gate-5 A12 — listOwnUndo(appId, which, {includeUndone}) reports undone-but-unexpired entries with their undoneAt', () => {
  type ListWith = (appId: string, which: { taskId: string } | { bucket: 'approval' }, options?: { includeUndone?: boolean }) => OwnUndoEntry[];
  const list = (): ListWith => (own().listOwnUndo as unknown as ListWith).bind(db);

  it('without the option, only LIVE entries (as before); with it, the undone one too — carrying its undoneAt — newest first', () => {
    const done = ownEntry({ at: iso(Date.now() - 60_000) });
    const kept = ownEntry();
    own().putOwnUndo(LEDGER, 'task-1', done);
    own().putOwnUndo(LEDGER, 'task-1', kept);
    const at = iso(Date.now());
    own().markOwnUndone(LEDGER, 'task-1', done.id, at);
    expect(list()(LEDGER, { taskId: 'task-1' }).map((e) => e.id)).toEqual([kept.id]);
    expect(list()(LEDGER, { taskId: 'task-1' }, { includeUndone: false }).map((e) => e.id)).toEqual([kept.id]);
    const all = list()(LEDGER, { taskId: 'task-1' }, { includeUndone: true });
    expect(all.map((e) => e.id)).toEqual([kept.id, done.id]);
    expect(all.find((e) => e.id === done.id)?.undoneAt).toBe(at);
    expect(all.find((e) => e.id === kept.id)?.undoneAt).toBeUndefined();
  });

  it('an EXPIRED entry is never reported, undone or not', () => {
    const expiredUndone = { ...ownEntry({ at: iso(Date.now() - 8 * DAY), expiresAt: iso(Date.now() - DAY) }), undoneAt: iso(Date.now() - 2 * DAY) };
    db.setSetting(ownUndoKey(LEDGER, 'task-1'), [expiredUndone]);
    expect(list()(LEDGER, { taskId: 'task-1' }, { includeUndone: true })).toEqual([]);
  });

  it('the approval bucket answers the same way', () => {
    const approved = approvalEntry();
    own().putOwnUndo(LEDGER, 'approval', approved);
    own().markOwnUndone(LEDGER, 'approval', approved.id, iso(Date.now()));
    expect(list()(LEDGER, { bucket: 'approval' })).toEqual([]);
    expect(list()(LEDGER, { bucket: 'approval' }, { includeUndone: true }).map((e) => e.id)).toEqual([approved.id]);
  });
});

describe('PR-4 Gate-5 A13 — ownUndoRoom stays the gate (a boolean); the live count the page words is the listing’s', () => {
  it('four near-64-KiB live entries: no room, and the bucket’s real live count is 4 — not twenty', () => {
    for (let i = 0; i < 4; i += 1) own().putOwnUndo(LEDGER, 'task-1', heavy());
    expect(own().ownUndoRoom(LEDGER, 'task-1')).toBe(false);
    expect(typeof own().ownUndoRoom(LEDGER, 'task-1')).toBe('boolean');
    expect(own().listOwnUndo(LEDGER, { taskId: 'task-1' })).toHaveLength(4);
  });
});
