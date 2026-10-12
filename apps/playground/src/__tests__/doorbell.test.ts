// doorbell.test.ts — TASK-20261010-host-broker PR-3 (ADR-0076 §8; contract v2 D-PR3-20, D-PR3-14,
// D-PR3-15; the spec's §24.7 (29) and §24.5 (24); AC24). RED-FIRST: `access/doorbell.ts` does not
// exist yet, so it is loaded through a VARIABLE specifier (a literal dynamic import would fail the
// whole file at transform time — lesson 2026-10-11). Two further reds sit under it by design: the
// driver's write signal and the facade's `subscribeWrites` are I-D's (`packages/db`), and a grant
// with `kv: true` is a v2 seat of the RECORD (D-PR3-2) that the 1.1 strict schema refuses.
//
// WHAT A DOORBELL IS. Three hints, ids only, to LIVE frames (R7: hints, never content):
//   · `access-source-changed { grantId }` — to every live reader of a source whose data just
//     changed: raised by the DRIVER (`handle()`'s exec with rows modified · a frame's kvSet · an
//     import) through the facade's `subscribeWrites`, coalesced per source (2 s: the first at
//     once, later ones inside the window ONCE more at its end); a kv change rings only grants
//     that carry `kv`; the host's OWN kv writes (the `snug:schedule:<runId>` handshake) ring
//     nothing; a `brokered` signal is the broker's to ring, not the doorbell's.
//   · `access-read { grantId }` — to the SOURCE's live frame after a read: a frame's `query` and
//     each grant a chat turn's `recordRead` recorded.
//   · `data-changed { table }` — to a brokered write's TARGET; and the broker's own
//     `access-source-changed` to the target's other live readers — the writer EXCLUDED after a
//     write, INCLUDED after an undo (the reader whose write was reversed holds the stalest view).
// NEGATIVE (AC24): no event carries a row, a value, a name or a count — exactly `{ grantId }` or
// `{ table }`, nothing else.
//
// The signal is driven through the REAL path wherever one exists: a frame's db request through
// `db.driver.handle` on the source's namespace, the host's kv through the facade's `kvSet`, a read
// through the REAL access handler (inline Workers) and the REAL service's `recordRead`. Live frames
// are registered in the REAL `state/appHosts.ts` registry, each with a recording notify.
import {
  ACCESS_DOORBELL_COALESCE_MS,
  ACCESS_READ_EVENT,
  ACCESS_SOURCE_CHANGED_EVENT,
  DATA_CHANGED_EVENT,
  FRAME_TYPES,
  PROTOCOL_VERSION,
  accessGrantSchema,
  type AccessGrant,
  type AccessRequestFrame,
  type DbRequestFrame,
} from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NamespaceWriteEvent, UserDb } from '@snugprotocol/db';

import { createAccessHandlerFor } from '../access/accessHandler.js';
import { __setAccessDepsForTests, durationOf, resetAccessSession } from '../access/grants.js';
import { configureScopedRead, resetScopedReadForTests, type WorkerLike } from '../access/scopedRead.js';
import { createScopedReadResponder } from '../access/scopedRead.worker.js';
import { accessService, type MaterialisedSet } from '../access/service.js';
import { __resetAppHostsForTest, registerAppHost, setAppHostGeneration } from '../state/appHosts.js';
import { installTestUserDb, locateWasm } from './userdbTestHelper.js';

// ---------------------------------------------------------------- the module under test

/** `access/doorbell.ts` (D-PR3-20) — its own type (the pins lane swapped the Gate-3 local types for the real exports); still loaded through the variable specifier. */
type DoorbellModule = typeof import('../access/doorbell.js');
const DOORBELL_MODULE = '../access/doorbell.js';
const loadDoorbell = (): Promise<DoorbellModule> => import(/* @vite-ignore */ DOORBELL_MODULE) as Promise<DoorbellModule>;

// ------------------------------------------------------------------------------------- fixtures

const NOW = '2026-10-11T15:00:00.000Z';
const COALESCE_MS = 2_000; // ACCESS_DOORBELL_COALESCE_MS — pinned below against the protocol constant
const LIVE_GENERATION = 1;
const ROW_SECRET = 'LEDGER-ROW-VALUE-7731';

let db: UserDb;
let doorbell: DoorbellModule;
let disarm: (() => void) | void;
/** Ledger — the SOURCE whose data changes. */
let source: string;
/** Budget — a live reader whose grant carries `kv`. */
let budget: string;
/** Pantry — a live reader whose grant does not. */
let pantry: string;
let budgetGrant: AccessGrant;
let pantryGrant: AccessGrant;

interface Rung {
  appId: string;
  event: string;
  data: unknown;
}
/** Every hint any registered frame received, in order. */
let rung: Rung[];
const unregisters: Array<() => void> = [];

/** RunView mounting `appId`: registered in the REAL registry with a recording notify. Answers the unregister (a retraction). */
function open(appId: string, generation = LIVE_GENERATION): () => void {
  const unregister = registerAppHost(appId, (event, data) => {
    rung.push({ appId, event, data });
  });
  setAppHostGeneration(appId, generation);
  unregisters.push(unregister);
  return unregister;
}

const ringsTo = (appId: string, event?: string): Rung[] => rung.filter((entry) => entry.appId === appId && (event === undefined || entry.event === event));
const sourceChanged = (appId: string): unknown[] => ringsTo(appId, ACCESS_SOURCE_CHANGED_EVENT).map((entry) => entry.data);

/** A grant persisted through the db's own accessor (its strict parse included). */
function grantOn(readerAppId: string, over: { kv?: true; revoked?: true } = {}): AccessGrant {
  const at = new Date(Date.now()).toISOString();
  const grant = accessGrantSchema.parse({
    id: crypto.randomUUID(),
    readerAppId,
    sourceAppId: source,
    scope: { tables: [{ name: 'transactions', columns: ['id', 'amount', 'category'] }] },
    access: 'read',
    purpose: 'to show spending by category',
    duration: { kind: 'always' },
    unattended: false,
    status: over.revoked === true ? 'revoked' : 'active',
    ...(over.revoked === true ? { revokedAt: at } : {}),
    provenance: 'app',
    readerVersion: 1,
    grantedAt: at,
    updatedAt: at,
    reads: 0,
    timeouts: 0,
    // D-PR3-2: `kv` is a v2 seat. Until the protocol lands the strict record REFUSES it — red by design.
    ...(over.kv === true ? { kv: true } : {}),
  });
  db.putAccessGrant(grant);
  return grant;
}

let seq = 0;
const dbFrame = (over: Record<string, unknown>): DbRequestFrame =>
  ({ v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `db-${++seq}`, instanceId: 'live-1', ...over }) as DbRequestFrame;
/** A frame's statement on the source's namespace — the path the driver's write signal rides. */
const frameExec = async (sql: string, params?: unknown[]): Promise<void> => {
  const answer = await db.driver.handle(source, dbFrame({ op: 'exec', sql, ...(params !== undefined ? { params } : {}) }));
  expect(answer.ok, sql).toBe(true);
};
const insertRow = () => frameExec('INSERT INTO transactions (amount, category) VALUES (?, ?)', [12, ROW_SECRET]);

/** Fake timers for the coalescing window: timers and `Date` only (sql.js and promises keep running). */
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date(NOW));
}

/** Let the driver's signal and the doorbell's ring settle (microtasks and the db's own promises). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(async () => {
  __resetAppHostsForTest();
  rung = [];
  db = await installTestUserDb();
  source = db.installApp({ displayName: 'Ledger', html: '<html>ledger</html>' }).appId;
  budget = db.installApp({ displayName: 'Budget', html: '<html>budget</html>' }).appId;
  pantry = db.installApp({ displayName: 'Pantry', html: '<html>pantry</html>' }).appId;
  await db.applyAppDdl(source, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, category TEXT)']);
  await db.driver.handle(source, dbFrame({ op: 'exec', sql: "INSERT INTO transactions (amount, category) VALUES (450, 'food')" }));
  doorbell = await loadDoorbell();
  budgetGrant = grantOn(budget, { kv: true });
  pantryGrant = grantOn(pantry);
});

afterEach(() => {
  if (typeof disarm === 'function') disarm();
  disarm = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const unregister of unregisters.splice(0).reverse()) unregister();
  resetAccessSession();
  resetScopedReadForTests();
  __setAccessDepsForTests();
  __resetAppHostsForTest();
});

// ============================================================================================

describe('the protocol’s three events and the window (D-PR3-20; §24.7 (29))', () => {
  it('the event names and the coalescing window are the contract’s', () => {
    expect(ACCESS_SOURCE_CHANGED_EVENT).toBe('access-source-changed');
    expect(ACCESS_READ_EVENT).toBe('access-read');
    expect(DATA_CHANGED_EVENT).toBe('data-changed');
    expect(ACCESS_DOORBELL_COALESCE_MS).toBe(COALESCE_MS);
  });
});

describe('`access-source-changed` — the driver’s signal rings the source’s LIVE readers (D-PR3-20 (a), (b); AC24)', () => {
  it('a frame’s exec that modified rows on the source rings every LIVE reader `{ grantId }` — its own grant’s id — at once', async () => {
    open(source);
    open(budget);
    open(pantry);
    disarm = doorbell.armDoorbell(db);
    await insertRow();
    await settle();
    expect(sourceChanged(budget)).toEqual([{ grantId: budgetGrant.id }]);
    expect(sourceChanged(pantry)).toEqual([{ grantId: pantryGrant.id }]);
    expect(sourceChanged(source), 'the source is not its own reader').toEqual([]);
  });

  it('a CLOSED reader is not rung (registered, then retracted); a reader whose access was STOPPED is not rung', async () => {
    open(source);
    open(budget);
    const closePantry = open(pantry);
    const notes = db.installApp({ displayName: 'Notes', html: '<html>notes</html>' }).appId;
    grantOn(notes, { revoked: true });
    open(notes);
    closePantry();
    disarm = doorbell.armDoorbell(db);
    await insertRow();
    await settle();
    expect(sourceChanged(budget)).toEqual([{ grantId: budgetGrant.id }]);
    expect(ringsTo(pantry)).toEqual([]);
    expect(ringsTo(notes)).toEqual([]);
  });

  it('NOT a read, NOT a statement that modified nothing, NOT a schema change: none rings', async () => {
    open(budget);
    open(pantry);
    disarm = doorbell.armDoorbell(db);
    await frameExec('SELECT amount, category FROM transactions');
    await frameExec('UPDATE transactions SET amount = 1 WHERE id = -1'); // a DML that changed 0 rows
    await frameExec('CREATE TABLE notes (body TEXT)'); // DDL rings nothing (the next read's drift check pauses the grant)
    await settle();
    expect(rung).toEqual([]);
  });

  it('nothing rings before the doorbell is armed', async () => {
    open(budget);
    await insertRow();
    await settle();
    expect(rung).toEqual([]);
  });

  it('a frame’s kvSet on the source rings ONLY the readers whose grant carries `kv`', async () => {
    open(budget);
    open(pantry);
    disarm = doorbell.armDoorbell(db);
    const answer = await db.driver.handle(source, dbFrame({ op: 'kvSet', key: 'theme', value: 'dark' }));
    expect(answer.ok).toBe(true);
    await settle();
    expect(sourceChanged(budget)).toEqual([{ grantId: budgetGrant.id }]);
    expect(ringsTo(pantry)).toEqual([]);
  });

  it('a frame’s whole-database import on the source rings EVERY live reader, `kv` or not', async () => {
    const exported = await db.driver.handle(source, dbFrame({ op: 'export' }));
    if (!exported.ok || exported.bytesBase64 === undefined) throw new Error('export failed');
    open(budget);
    open(pantry);
    disarm = doorbell.armDoorbell(db);
    expect((await db.driver.handle(source, dbFrame({ op: 'import', bytesBase64: exported.bytesBase64 }))).ok).toBe(true);
    await settle();
    expect(sourceChanged(budget)).toEqual([{ grantId: budgetGrant.id }]);
    expect(sourceChanged(pantry)).toEqual([{ grantId: pantryGrant.id }]);
  });

  it('the HOST’s own kv writes ring nothing — the `snug:schedule:<runId>` handshake and its clear (the facade’s `kvSet`)', async () => {
    open(budget);
    open(pantry);
    disarm = doorbell.armDoorbell(db);
    expect((await db.driver.kvSet(source, 'snug:schedule:x', { taskId: 't', runId: 'x' })).ok).toBe(true);
    expect((await db.driver.kvSet(source, 'snug:schedule:x', null)).ok).toBe(true);
    await settle();
    expect(rung).toEqual([]);
  });

  it('a `brokered` signal is the BROKER’s to ring — the doorbell rings nothing for it', async () => {
    open(budget);
    open(pantry);
    const subscribe = vi.spyOn(db.driver, 'subscribeWrites');
    disarm = doorbell.armDoorbell(db);
    expect(subscribe, 'armed through the facade’s `subscribeWrites`').toHaveBeenCalledTimes(1);
    const listener = subscribe.mock.calls[0]![0];
    listener({ namespace: source, kind: 'brokered', table: 'transactions', changes: 3 });
    await settle();
    expect(rung).toEqual([]);
  });

  it('a brokered signal rings nothing from the doorbell — the broker rings (a REAL seat write: the signal fires, no `access-source-changed`, and no window is opened)', async () => {
    open(source);
    open(budget);
    open(pantry);
    disarm = doorbell.armDoorbell(db);
    const heard: NamespaceWriteEvent[] = [];
    const off = db.driver.subscribeWrites((event) => heard.push(event));
    // The app's own approved change through the seat (D-PR3-8's own variant): the driver rings `kind: 'brokered'`.
    const applied = await db.driver.brokeredWrite(source, {
      own: [{ sql: 'UPDATE transactions SET amount = 5 WHERE amount = 450' }],
      caps: { maxChanges: 1, maxUndoBytes: 64 * 1024 },
      expectChanges: [1],
    });
    off();
    expect(applied).toMatchObject({ ok: true, changes: [1] });
    expect(heard, 'the signal really fired').toEqual([expect.objectContaining({ namespace: source, kind: 'brokered', table: 'transactions' })]);
    await settle();
    expect(rung.filter((entry) => entry.event === ACCESS_SOURCE_CHANGED_EVENT)).toEqual([]);
    expect(rung, 'the doorbell rang nothing at all — the broker rings data-changed itself').toEqual([]);
    // No coalescing window was opened by it: the next frame change rings at once.
    await insertRow();
    await settle();
    expect(sourceChanged(budget)).toEqual([{ grantId: budgetGrant.id }]);
    expect(sourceChanged(pantry)).toEqual([{ grantId: pantryGrant.id }]);
  });

  it('coalesced PER SOURCE over 2 s: the first change rings at once; later ones inside the window ring ONCE more at its end; then quiet', async () => {
    fakeClock();
    open(budget);
    open(pantry);
    disarm = doorbell.armDoorbell(db);
    await insertRow();
    await settle();
    expect(sourceChanged(budget), 'leading: at once').toHaveLength(1);
    for (const at of [100, 600, 1_500]) {
      await vi.advanceTimersByTimeAsync(at - (Date.now() - Date.parse(NOW)));
      await insertRow();
    }
    await settle();
    expect(sourceChanged(budget), 'nothing more inside the window').toHaveLength(1);
    expect(sourceChanged(pantry)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(COALESCE_MS - (Date.now() - Date.parse(NOW)));
    expect(sourceChanged(budget), 'trailing: once at the window’s end').toEqual([{ grantId: budgetGrant.id }, { grantId: budgetGrant.id }]);
    expect(sourceChanged(pantry)).toEqual([{ grantId: pantryGrant.id }, { grantId: pantryGrant.id }]);
    await vi.advanceTimersByTimeAsync(5 * COALESCE_MS);
    expect(sourceChanged(budget), 'no further ring without a change').toHaveLength(2);
  });

  it('a single change rings once — no trailing ring when nothing followed it', async () => {
    fakeClock();
    open(budget);
    disarm = doorbell.armDoorbell(db);
    await insertRow();
    await settle();
    await vi.advanceTimersByTimeAsync(5 * COALESCE_MS);
    expect(sourceChanged(budget)).toEqual([{ grantId: budgetGrant.id }]);
  });

  it('the window is per source: a change on ANOTHER source inside it rings that source’s readers at once', async () => {
    fakeClock();
    const pantrySource = db.installApp({ displayName: 'Shop', html: '<html>shop</html>' }).appId;
    await db.applyAppDdl(pantrySource, ['CREATE TABLE items (name TEXT)']);
    const shopper = db.installApp({ displayName: 'Shopper', html: '<html>shopper</html>' }).appId;
    const at = new Date(Date.now()).toISOString();
    const shopperGrant = accessGrantSchema.parse({
      id: crypto.randomUUID(),
      readerAppId: shopper,
      sourceAppId: pantrySource,
      scope: { tables: [{ name: 'items', columns: ['name'] }] },
      access: 'read',
      purpose: 'to plan the shopping',
      duration: { kind: 'always' },
      unattended: false,
      status: 'active',
      provenance: 'app',
      readerVersion: 1,
      grantedAt: at,
      updatedAt: at,
      reads: 0,
      timeouts: 0,
    });
    db.putAccessGrant(shopperGrant);
    open(budget);
    open(shopper);
    disarm = doorbell.armDoorbell(db);
    await insertRow();
    await vi.advanceTimersByTimeAsync(300);
    expect((await db.driver.handle(pantrySource, dbFrame({ op: 'exec', sql: "INSERT INTO items (name) VALUES ('rice')" }))).ok).toBe(true);
    await settle();
    expect(sourceChanged(budget)).toEqual([{ grantId: budgetGrant.id }]);
    expect(sourceChanged(shopper)).toEqual([{ grantId: shopperGrant.id }]);
  });
});

describe('`access-read` — the source learns it was read (D-PR3-20 (d); D-PR3-14)', () => {
  function inlineWorkers(): () => WorkerLike {
    return () => {
      const respond = createScopedReadResponder();
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage(msg) {
          void respond(msg).then((answer) => {
            if (answer !== undefined) worker.onmessage?.({ data: answer });
          });
        },
        terminate() {},
      };
      return worker;
    };
  }

  beforeEach(() => {
    const at = Date.now();
    __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => at });
    configureScopedRead({ createWorker: inlineWorkers(), wasm: { wasmUrl: locateWasm() }, now: () => at });
  });

  it('a FRAME read (the reader’s `query`) rings the SOURCE’s live frame `access-read { grantId }` — and nothing else: the reader is not rung, no reader hears `access-source-changed`', async () => {
    open(source);
    open(pantry);
    disarm = doorbell.armDoorbell(db);
    const access = createAccessHandlerFor(pantry, { attended: true, generation: LIVE_GENERATION });
    const query: AccessRequestFrame = { v: PROTOCOL_VERSION, type: FRAME_TYPES.accessRequest, requestId: 'acc-1', instanceId: 'live-1', op: 'query', grantId: pantryGrant.id, sql: 'SELECT amount FROM transactions' };
    expect((await access.handle(pantry, query)).ok).toBe(true);
    await settle();
    expect(ringsTo(source)).toEqual([{ appId: source, event: ACCESS_READ_EVENT, data: { grantId: pantryGrant.id } }]);
    expect(ringsTo(pantry)).toEqual([]);
  });

  it('a CHAT turn’s `recordRead` rings the source’s live frame once per recorded grant', async () => {
    open(source);
    disarm = doorbell.armDoorbell(db);
    const set: MaterialisedSet = {
      tables: [
        {
          grantId: pantryGrant.id,
          sourceAppId: source,
          sourceName: 'Ledger',
          alias: 'ledger',
          name: 'ledger__transactions',
          table: 'transactions',
          columns: ['amount'],
          types: ['INTEGER'],
          rows: [[450]],
          truncated: false,
          duration: durationOf(pantryGrant),
        },
      ],
      skipped: [],
      readOnlyTables: ['ledger__transactions'],
    };
    const outcome = await accessService().recordRead({ kind: 'chat', appId: pantry, threadId: 'thread-1' }, set, { grantIds: [pantryGrant.id], sql: 'SELECT amount FROM ledger__transactions' });
    expect(outcome.recorded).toEqual([pantryGrant.id]);
    await settle();
    expect(ringsTo(source)).toEqual([{ appId: source, event: ACCESS_READ_EVENT, data: { grantId: pantryGrant.id } }]);
  });

  it('a read of a CLOSED source rings nothing (only live frames are rung)', async () => {
    open(pantry);
    disarm = doorbell.armDoorbell(db);
    const access = createAccessHandlerFor(pantry, { attended: true, generation: LIVE_GENERATION });
    const query: AccessRequestFrame = { v: PROTOCOL_VERSION, type: FRAME_TYPES.accessRequest, requestId: 'acc-2', instanceId: 'live-1', op: 'query', grantId: pantryGrant.id, sql: 'SELECT amount FROM transactions' };
    expect((await access.handle(pantry, query)).ok).toBe(true);
    await settle();
    expect(rung).toEqual([]);
  });
});

describe('the broker’s rings — `data-changed` to the target, `access-source-changed` to its readers (D-PR3-20 (c); §24.5 (24); S19)', () => {
  it('`ringDataChanged(target, table)` rings the TARGET’s live frame `data-changed { table }` — and nobody else', async () => {
    open(source);
    open(budget);
    doorbell.ringDataChanged(source, 'transactions');
    await settle();
    expect(rung).toEqual([{ appId: source, event: DATA_CHANGED_EVENT, data: { table: 'transactions' } }]);
  });

  it('after a WRITE the writing reader is EXCLUDED (`except`): every OTHER live reader hears `access-source-changed { grantId }`', async () => {
    open(source);
    open(budget);
    open(pantry);
    doorbell.ringSourceChanged(db, source, { except: budget });
    await settle();
    expect(ringsTo(budget), 'the writer knows what it wrote').toEqual([]);
    expect(sourceChanged(pantry)).toEqual([{ grantId: pantryGrant.id }]);
    expect(ringsTo(source)).toEqual([]);
  });

  it('after an UNDO nobody is excluded: EVERY live reader — the one whose write was reversed included — hears it', async () => {
    open(source);
    open(budget);
    open(pantry);
    doorbell.ringSourceChanged(db, source);
    await settle();
    expect(sourceChanged(budget)).toEqual([{ grantId: budgetGrant.id }]);
    expect(sourceChanged(pantry)).toEqual([{ grantId: pantryGrant.id }]);
  });

  it('a closed target hears nothing; a closed reader hears nothing', async () => {
    doorbell.ringDataChanged(source, 'transactions');
    doorbell.ringSourceChanged(db, source);
    await settle();
    expect(rung).toEqual([]);
  });
});

describe('NEGATIVE — ids only: no event carries a row, a value, a name or a count (AC24; §24.7 (29))', () => {
  it('over EVERY hint the three doorbells post, the data is exactly `{ grantId }` or `{ table }` — no other key, no array, no number, no string longer than an id, and none of the row’s value or an app’s name', async () => {
    fakeClock();
    const at = Date.now();
    __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => at });
    open(source);
    open(budget);
    open(pantry);
    disarm = doorbell.armDoorbell(db);
    const pastTheWindow = async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(2 * COALESCE_MS);
    };
    await insertRow(); // exec: Budget + Pantry
    await pastTheWindow();
    expect((await db.driver.handle(source, dbFrame({ op: 'kvSet', key: 'note', value: ROW_SECRET }))).ok).toBe(true); // kv: Budget
    await pastTheWindow();
    const set: MaterialisedSet = {
      tables: [
        {
          grantId: pantryGrant.id,
          sourceAppId: source,
          sourceName: 'Ledger',
          alias: 'ledger',
          name: 'ledger__transactions',
          table: 'transactions',
          columns: ['amount', 'category'],
          types: ['INTEGER', 'TEXT'],
          rows: [[12, ROW_SECRET]],
          truncated: false,
          duration: durationOf(pantryGrant),
        },
      ],
      skipped: [],
      readOnlyTables: ['ledger__transactions'],
    };
    expect((await accessService().recordRead({ kind: 'chat', appId: pantry, threadId: 'thread-1' }, set, { grantIds: [pantryGrant.id] })).recorded).toEqual([pantryGrant.id]); // read: Ledger
    doorbell.ringDataChanged(source, 'transactions'); // Ledger
    await pastTheWindow();
    doorbell.ringSourceChanged(db, source, { except: budget }); // Pantry
    await pastTheWindow();
    doorbell.ringSourceChanged(db, source); // Budget + Pantry
    await pastTheWindow();

    const ours = rung.filter((entry) => [ACCESS_SOURCE_CHANGED_EVENT, ACCESS_READ_EVENT, DATA_CHANGED_EVENT].includes(entry.event));
    expect(new Set(ours.map((entry) => entry.event)), 'all three doorbells rang').toEqual(new Set([ACCESS_SOURCE_CHANGED_EVENT, ACCESS_READ_EVENT, DATA_CHANGED_EVENT]));
    expect(ours.length).toBeGreaterThanOrEqual(8);
    const ID_MAX = 36; // a uuid
    for (const { event, data } of ours) {
      expect(data !== null && typeof data === 'object' && !Array.isArray(data), event).toBe(true);
      const keys = Object.keys(data as object);
      expect([['grantId'], ['table']], `${event}: ${JSON.stringify(data)}`).toContainEqual(keys);
      for (const value of Object.values(data as object)) {
        expect(typeof value, `${event}: a string, never a count or a structure`).toBe('string');
        expect((value as string).length, `${event}: no string longer than an id`).toBeLessThanOrEqual(ID_MAX);
      }
    }
    // Ids are hex: none of these words can occur inside one by chance.
    const everything = JSON.stringify(ours);
    for (const secret of [ROW_SECRET, 'Ledger', 'Budget', 'Pantry', 'food', 'note', 'rows', 'count', 'changes']) expect(everything, secret).not.toContain(secret);
  });
});

// ============================================================================================
// TASK-20261010-host-broker PR-4 (contract v2 D-PR4-5; §24.7 item 29; AC32b): OWN writes ring.
// Every own write — the user's approval and an armed task's change — clears the namespace's read
// caches and rings `access-source-changed` to its live readers and `data-changed` to its own frame.
// The driver's `brokered` signal under it still rings nothing from the doorbell: each reader hears
// the change EXACTLY once (the broker's ring), never twice. The engine is reached through a
// VARIABLE specifier (the file's own idiom; `applyOwnWrite`/`undoOwnWrite` are new exports).
// ============================================================================================

type WriteBrokerModule = typeof import('../access/writeBroker.js');
const WRITE_BROKER_MODULE = '../access/writeBroker.js';
const loadWriteBroker = (): Promise<WriteBrokerModule> => import(/* @vite-ignore */ WRITE_BROKER_MODULE) as Promise<WriteBrokerModule>;

describe('PR-4 — own writes ring: data-changed to the app’s own frame, access-source-changed to its live readers (D-PR4-5)', () => {
  beforeEach(() => {
    __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => Date.now() });
  });

  it('the user’s APPROVAL of the app’s own change: the own frame hears data-changed { table } once; EVERY live reader hears access-source-changed { grantId } once — the doorbell adds nothing for the brokered signal', async () => {
    const { applyApprovedWrite } = await loadWriteBroker();
    open(source);
    open(budget);
    open(pantry);
    disarm = doorbell.armDoorbell(db);
    const outcome = await (applyApprovedWrite as unknown as (db: UserDb, proposal: unknown, options: { via: 'chat' | 'user' }) => Promise<Record<string, unknown>>)(
      db,
      { appId: source, statements: ['UPDATE transactions SET amount = 5 WHERE amount = 450'], params: [[]], summary: 'fix the amount', previewed: [1] },
      { via: 'chat' },
    );
    expect(outcome).toMatchObject({ ok: true, executed: [1] });
    await settle();
    expect(ringsTo(source)).toEqual([{ appId: source, event: DATA_CHANGED_EVENT, data: { table: 'transactions' } }]);
    expect(sourceChanged(budget)).toEqual([{ grantId: budgetGrant.id }]);
    expect(sourceChanged(pantry)).toEqual([{ grantId: pantryGrant.id }]);
  });

  it('an armed TASK’s own change (applyOwnWrite, authority task) rings the same way — the own frame once, every live reader once', async () => {
    const { applyOwnWrite } = await loadWriteBroker();
    open(source);
    open(budget);
    open(pantry);
    disarm = doorbell.armDoorbell(db);
    const outcome = await applyOwnWrite(db, {
      appId: source,
      bucket: 'task-1',
      statements: ['UPDATE transactions SET amount = 5 WHERE amount = 450'],
      params: [[]],
      expectChanges: [1],
      maxChanges: 200,
      requireUndo: true,
      authority: 'task',
      via: 'schedule',
      runId: 'run-1',
      taskId: 'task-1',
      stillArmed: () => true,
    });
    expect(outcome).toMatchObject({ ok: true, undoable: true });
    await settle();
    expect(ringsTo(source)).toEqual([{ appId: source, event: DATA_CHANGED_EVENT, data: { table: 'transactions' } }]);
    expect(sourceChanged(budget)).toEqual([{ grantId: budgetGrant.id }]);
    expect(sourceChanged(pantry)).toEqual([{ grantId: pantryGrant.id }]);
  });

  it('the own UNDO rings the same way, and its rings carry ids only — never a row, a value or a count', async () => {
    const { applyOwnWrite, undoOwnWrite } = await loadWriteBroker();
    const applied = await applyOwnWrite(db, {
      appId: source,
      bucket: 'approval',
      statements: ['UPDATE transactions SET category = ? WHERE amount = 450'],
      params: [[ROW_SECRET]],
      expectChanges: [1],
      maxChanges: Number.POSITIVE_INFINITY,
      requireUndo: false,
      authority: 'approval',
      via: 'user',
    });
    if (!applied.ok || applied.undoId === undefined) throw new Error(`expected an undoable apply, got ${JSON.stringify(applied)}`);
    open(source);
    open(budget);
    open(pantry);
    disarm = doorbell.armDoorbell(db);
    expect(await undoOwnWrite(db, source, 'approval', applied.undoId, { via: 'user' })).toEqual({ ok: true });
    await settle();
    expect(ringsTo(source)).toEqual([{ appId: source, event: DATA_CHANGED_EVENT, data: { table: 'transactions' } }]);
    expect(sourceChanged(budget)).toEqual([{ grantId: budgetGrant.id }]);
    expect(sourceChanged(pantry)).toEqual([{ grantId: pantryGrant.id }]);
    const everything = JSON.stringify(rung);
    for (const secret of [ROW_SECRET, 'Ledger', 'changes', 'rows']) expect(everything, secret).not.toContain(secret);
  });

  it('a refused own write rings nothing (a full task bucket — nothing committed)', async () => {
    const { applyOwnWrite } = await loadWriteBroker();
    const journal = db as unknown as { putOwnUndo(appId: string, bucket: string, entry: unknown): string };
    for (let i = 0; i < 20; i += 1) {
      const at = new Date(Date.now()).toISOString();
      journal.putOwnUndo(source, 'task-1', {
        id: crypto.randomUUID(),
        at,
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        authority: 'task',
        via: 'schedule',
        runId: `run-${i}`,
        taskId: 'task-1',
        steps: [{ table: 'transactions', op: 'update', columns: ['amount'], rows: [{ rowid: 1, before: [1], after: [2] }] }],
      });
    }
    open(source);
    open(budget);
    open(pantry);
    disarm = doorbell.armDoorbell(db);
    const outcome = await applyOwnWrite(db, {
      appId: source,
      bucket: 'task-1',
      statements: ['UPDATE transactions SET amount = 5 WHERE amount = 450'],
      params: [[]],
      expectChanges: [1],
      maxChanges: 200,
      requireUndo: true,
      authority: 'task',
      via: 'schedule',
      runId: 'run-x',
      taskId: 'task-1',
      stillArmed: () => true,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'full' });
    await settle();
    expect(rung).toEqual([]);
  });
});
