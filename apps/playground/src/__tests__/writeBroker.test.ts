// writeBroker.test.ts — the engine half of the Write Broker (TASK-20261010-host-broker PR-3;
// ADR-0076 §4–§5; contract v2 D-PR3-7 the journal holds rows never SQL · D-PR3-8 one broker, two
// modes · D-PR3-11 the driver seat · D-PR3-15 the engine half · D-PR3-20 (c) the broker's doorbells;
// §24.5 MUSTs 21–24; AC19, AC20).
//
// Written before `access/writeBroker.ts` existed (Gate 3): it is still reached through a VARIABLE
// specifier (`import(/* @vite-ignore */ spec)` — a literal dynamic import of a missing module fails
// the whole file at transform time, lesson 2026-10-11). The lane's local structural types — and its
// namespace reads of the wire's (I-W) and the db's (I-D) PR-3 names — were swapped for the real
// exports by the pins lane.
//
// THE STRICT PATH is driven through the frame — the real `createAccessHandlerFor` → the service's
// `write` → `brokeredWrite` — over the real in-memory user db and the INLINE worker (the real
// responder on node sql.js), so its ORDER is the production order: `stillWritable` at the plan job's
// dequeue and again after the plan answers; the reader's live-entry cap; the seat
// (`db.driver.brokeredWrite`); the journal entry; the `wrote` line; the source's read caches
// cleared; the doorbells; the answer. OWN MODE is `applyApprovedWrite` (the approved write of an
// app's OWN data): the seat's `{ own, expectChanges }` variant (no caps — Gate-5 W-2 — no capture), no journal, no line,
// `data-changed` to its own frame, today's outcome shapes. UNDO is the user's act from the source's
// history: rebuilt from the journal's ROWS (never statement text), reversed, guarded by the values
// the write left, every live reader rung — the writer too.
//
// The source in this suite is Journal, seeded with ONE row-modifying exec, so the doorbell's
// coalescing window (D-PR3-20 (b)) never has a trailing ring to add to the broker's.
//
// Mutation checks (to run by hand once I-E1 lands, each red then restored):
//  - read the grant once (no `stillWritable` after the plan) → the stop-while-planning row reds;
//  - write the line before the journal entry → the order row reds;
//  - clear the read caches after the doorbells → the order row's cache assertion reds;
//  - ring with `except: readerAppId` on an undo → the undo's every-reader row reds;
//  - apply the undo steps in forward order → the reverse-order row reds;
//  - splice a step's value into the statement text → the bound-parameter row reds (its builder half lives in
//    packages/db's brokered-write.test.ts since the Gate-5 W-5 fold).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import type { AccessHandlerResult } from '@snugprotocol/runner';
import {
  ACCESS_SOURCE_CHANGED_EVENT,
  ACCESS_UNDO_MAX_BYTES,
  ACCESS_WRITE_MAX_ROWS,
  DATA_CHANGED_EVENT,
  FRAME_TYPES,
  PROTOCOL_VERSION,
  type AccessRequestFrame,
  type AccessUndoEntry,
  type AccessUndoStep,
} from '@snugprotocol/protocol';

import { createAccessHandlerFor } from '../access/accessHandler.js';
import { NO_ACCESS_ASKS_KEY, collectSources } from '../access/consent.js';
import { ACCESS_APP_MESSAGES, ACCESS_SHEET, type UndoFailureReason } from '../access/copy.js';
import { __setAccessDepsForTests, accessRevisionStore, createGrantFromDecision, resetAccessSession, revokeAccess, type AnyAccessGrant, type CreateGrantInput } from '../access/grants.js';
import { __scopedReadCachedGrantsForTests, configureScopedRead, resetScopedReadForTests, type WorkerLike } from '../access/scopedRead.js';
import { createScopedReadResponder } from '../access/scopedRead.worker.js';
import { executeApprovedWrite, type ExecuteApprovedWriteOutcome, type PendingWriteProposal } from '../agent/dataTools.js';
import { registerAppHost } from '../state/appHosts.js';
import { installTestUserDb, locateWasm } from './userdbTestHelper.js';

// =========================================================================================
// The shapes — the real exports (the pins lane swapped the Gate-3 local types for them)
// =========================================================================================

/** The undo journal's accessors (I-D) — the UserDb's own. */
type UndoAccessors = Pick<UserDb, 'listAccessUndo' | 'listAllAccessUndo' | 'putAccessUndo' | 'markAccessUndone'>;
const undoFailed = (reason: UndoFailureReason, sourceName: string): string => ACCESS_SHEET.undoFailed(reason, sourceName);

/** The module stays behind a VARIABLE specifier (the Gate-3 isolation); its type is the module's own. */
type WriteBrokerModule = typeof import('../access/writeBroker.js');
const WRITE_BROKER_MODULE = '../access/writeBroker.js';
const writeBroker = (): Promise<WriteBrokerModule> => import(/* @vite-ignore */ WRITE_BROKER_MODULE) as Promise<WriteBrokerModule>;

// =========================================================================================
// The world
// =========================================================================================

const T0 = Date.parse('2026-10-11T09:00:00.000Z');
/** writeBroker.ts's module-private ACCESS_UNDO_ENTRY_RESERVE_BYTES (Gate-5 SEC-1): the entry's host-written seats around `steps`. */
const UNDO_ENTRY_RESERVE_BYTES = 1024;
const DAY = 86_400_000;
const iso = (at: number): string => new Date(at).toISOString();

let db: UserDb;
let budget: string;
let pantry: string;
let journal: string;
let clock: { now: number };
let seq = 0;
let rings: Array<{ appId: string; event: string; data: unknown }>;
let unregister: Array<() => void>;
/** Every job posted to any worker, in order. */
let posted: unknown[];
/** Jobs of these kinds wait for the matching gate before the responder runs. */
let gates: Map<string, Promise<void>>;

const undoJournal = (): UndoAccessors => db;
const seat = (): UserDb['driver'] => db.driver;

// ---- PR-4 (contract v2 D-PR4-3/4/5/6): the own journal and the own-write engine -------------
/** The own undo journal's accessors (D-PR4-3) — the UserDb's own once I-1 lands (until then the Pick is a tsc red). */
type OwnJournal = Pick<UserDb, 'listOwnUndo' | 'putOwnUndo' | 'markOwnUndone' | 'ownUndoRoom'>;
const ownJournal = (): OwnJournal => db;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** `applyApprovedWrite` / `executeApprovedWrite` with D-PR4-6's `{ via }` — called through this one shape so the PR-3 signature is a single tsc red, not one per row. */
type ApproveFn = (db: UserDb, proposal: PendingWriteProposal, options: { via: 'chat' | 'user' }) => Promise<Record<string, unknown>>;
const approve = (fn: unknown, proposal: PendingWriteProposal, via: 'chat' | 'user'): Promise<Record<string, unknown>> => (fn as ApproveFn)(db, proposal, { via });

const kindOf = (msg: unknown): string | undefined => (typeof msg === 'object' && msg !== null && 'id' in msg ? String((msg as { kind?: unknown }).kind ?? 'read') : undefined);

/** The inline worker — the real responder — recording every job; a job whose kind has a gate waits for it. */
function gatedWorkers(): () => WorkerLike {
  return () => {
    const respond = createScopedReadResponder();
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg) {
        const kind = kindOf(msg);
        if (kind !== undefined) posted.push(msg);
        void (async () => {
          const gate = kind === undefined ? undefined : gates.get(kind);
          if (gate !== undefined) await gate;
          const answer = await respond(msg);
          if (answer !== undefined) worker.onmessage?.({ data: answer });
        })();
      },
      terminate() {},
    };
    return worker;
  };
}

/** A gate on one job kind: the jobs of that kind wait until `open()`. */
function hold(kind: string): { open: () => void } {
  let open!: () => void;
  gates.set(
    kind,
    new Promise<void>((resolve) => {
      open = resolve;
    }),
  );
  return { open };
}

async function exec(appId: string, sql: string): Promise<void> {
  const result = await db.driver.handle(appId, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `x-${++seq}`, instanceId: 'frame', op: 'exec', sql });
  if (!result.ok) throw new Error(`exec failed: ${JSON.stringify(result)}`);
}

async function rowsOf(appId: string, sql: string): Promise<unknown> {
  const result = await db.driver.handle(appId, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `r-${++seq}`, instanceId: 'check', op: 'exec', sql });
  return result.ok ? result.rows : result;
}

const base = () => ({ v: PROTOCOL_VERSION, type: FRAME_TYPES.accessRequest, requestId: `req-${++seq}`, instanceId: 'inst-1' }) as const;
const writeFrame = (grantId: string, sql: string): AccessRequestFrame => ({ ...base(), op: 'write', grantId, sql }) as unknown as AccessRequestFrame;
const queryFrame = (grantId: string, sql: string): AccessRequestFrame => ({ ...base(), op: 'query', grantId, sql });
const refusal = (code: string, message: string, retryable: boolean): AccessHandlerResult => ({ ok: false, code, message, retryable });

/** A grant made through THE writer behind the user's allow; `write` ticks every named table (the v2 decision, D-PR3-23). */
async function grantOn(reader: string, source: string, tables: string[], write: boolean): Promise<AnyAccessGrant> {
  const ranked = await collectSources(db, reader);
  const offered = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === source);
  if (offered === undefined) throw new Error('no such candidate');
  const input = {
    readerAppId: reader,
    source: offered,
    tables: write ? tables.map((name) => ({ name, withheld: [], write: true })) : tables,
    duration: 'day',
    unattended: false,
    purpose: 'to keep a diary of spending',
    provenance: 'app',
    generation: 0,
    now: clock.now,
  };
  return createGrantFromDecision(db, input as unknown as CreateGrantInput);
}

const linesOf = (appId: string): Array<Record<string, unknown>> => db.listAccessLog(appId) as unknown as Array<Record<string, unknown>>;

/** Budget writes through its frame and answers the undo id its `wrote` line names. */
async function writeAsBudget(grantId: string, sql: string): Promise<{ answer: AccessHandlerResult; undoId: string | undefined }> {
  const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
  const answer = await handler.handle(budget, writeFrame(grantId, sql));
  const line = linesOf(journal).find((entry) => entry.kind === 'wrote');
  return { answer, undoId: line?.undoId as string | undefined };
}

/** A schema-valid journal entry, planted as if a write had left it. */
function plantedEntry(grantId: string, steps: AccessUndoStep[]): AccessUndoEntry {
  return {
    id: crypto.randomUUID(),
    at: iso(clock.now),
    expiresAt: iso(clock.now + 7 * DAY),
    authority: 'permission',
    via: 'app',
    grantId,
    readerAppId: budget,
    readerName: 'Budget',
    steps,
  };
}

function listen(...appIds: string[]): void {
  for (const appId of appIds) unregister.push(registerAppHost(appId, (event, data) => rings.push({ appId, event, data })));
}

const doorbells = () => rings.filter((ring) => ring.event === DATA_CHANGED_EVENT || ring.event === ACCESS_SOURCE_CHANGED_EVENT);

beforeEach(async () => {
  resetAccessSession();
  resetScopedReadForTests();
  localStorage.removeItem(NO_ACCESS_ASKS_KEY);
  clock = { now: T0 };
  rings = [];
  unregister = [];
  posted = [];
  gates = new Map();
  db = await installTestUserDb();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => clock.now });
  budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
  pantry = db.installApp({ displayName: 'Pantry', html: '<!doctype html><title>p</title>' }).appId;
  journal = db.installApp({ displayName: 'Journal', html: '<!doctype html><title>j</title>' }).appId;
  await db.applyAppDdl(journal, [
    'CREATE TABLE entries (id INTEGER PRIMARY KEY, title TEXT, amount INTEGER)',
    'CREATE TABLE sums (id INTEGER PRIMARY KEY, a INTEGER, doubled INTEGER GENERATED ALWAYS AS (a * 2))',
  ]);
  await exec(journal, "INSERT INTO entries (title, amount) VALUES ('tea', 3), ('cake', 5), ('bread', 2)");
  await db.applyAppDdl(pantry, ['CREATE TABLE items (name TEXT, qty INTEGER)']);
  await exec(pantry, "INSERT INTO items VALUES ('rice', 2)");
  configureScopedRead({ createWorker: gatedWorkers(), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
});

afterEach(() => {
  for (const off of unregister) off();
  resetAccessSession();
  resetScopedReadForTests();
  __setAccessDepsForTests();
  localStorage.removeItem(NO_ACCESS_ASKS_KEY);
  vi.restoreAllMocks();
});

const ENTRIES = 'SELECT id, title, amount FROM entries ORDER BY id';

// =========================================================================================
// The strict path — its order
// =========================================================================================

describe('the strict path — stillWritable twice, the cap, the seat, the entry, the line, the caches, the doorbells, the answer (D-PR3-15 (1)–(6))', () => {
  it('a write whose access was stopped while it waited in the queue never plans: ACCESS_REVOKED, no plan job posted, the seat never reached', async () => {
    const mine = await grantOn(budget, journal, ['entries'], true);
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    const reads = hold('read');
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const ahead = handler.handle(budget, queryFrame(mine.id, 'SELECT 1'));
    await expect.poll(() => posted.length, { timeout: 3000 }).toBe(1);
    const write = handler.handle(budget, writeFrame(mine.id, "UPDATE entries SET amount = 9 WHERE title = 'tea'"));
    await revokeAccess(mine.id);
    reads.open();
    await ahead;
    expect(await write).toEqual(refusal('ACCESS_REVOKED', ACCESS_APP_MESSAGES.revoked, false));
    expect(posted.map(kindOf), 'the queued plan job was never posted').toEqual(['read']);
    expect(seatSpy).not.toHaveBeenCalled();
    expect(await rowsOf(journal, ENTRIES)).toEqual([
      [1, 'tea', 3],
      [2, 'cake', 5],
      [3, 'bread', 2],
    ]);
  });

  it('an access stopped while the plan runs wins — stillWritable again after the plan answers: ACCESS_REVOKED, the seat never reached, no entry, no line', async () => {
    const mine = await grantOn(budget, journal, ['entries'], true);
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    const plans = hold('plan-write');
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const write = handler.handle(budget, writeFrame(mine.id, "UPDATE entries SET amount = 9 WHERE title = 'tea'"));
    await expect.poll(() => posted.map(kindOf), { timeout: 3000 }).toEqual(['plan-write']);
    await revokeAccess(mine.id);
    plans.open();
    expect(await write).toEqual(refusal('ACCESS_REVOKED', ACCESS_APP_MESSAGES.revoked, false));
    expect(seatSpy).not.toHaveBeenCalled();
    expect(undoJournal().listAllAccessUndo(journal)).toEqual([]);
    expect(linesOf(journal).map((entry) => entry.kind)).toEqual(['revoked', 'granted']);
  });

  it('the plan runs on a FRESH export, never on the read cache: the grant’s cached bytes are evicted first and the plan is not cached', async () => {
    const mine = await grantOn(budget, journal, ['entries'], true);
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await handler.handle(budget, queryFrame(mine.id, 'SELECT count(*) FROM entries'))).toMatchObject({ ok: true, rows: [[3]] });
    expect(__scopedReadCachedGrantsForTests()).toContain(mine.id);
    const exports = vi.spyOn(db, 'exportAppRuntime');
    expect(await handler.handle(budget, writeFrame(mine.id, "UPDATE entries SET amount = 9 WHERE title = 'tea'"))).toEqual({ ok: true, op: 'write', changes: 1 });
    expect(exports, 'the plan exported the source afresh').toHaveBeenCalledWith(journal);
    expect(__scopedReadCachedGrantsForTests(), 'nothing of the plan is cached').not.toContain(mine.id);
  });

  it('after the plan, in order: the seat, the journal entry, the wrote line, the source’s read caches cleared, the doorbells, then the answer', async () => {
    const mine = await grantOn(budget, journal, ['entries'], true);
    const theirs = await grantOn(pantry, journal, ['entries'], false);
    // Pantry's read caches the source's bytes under its grant — the write must clear them before anyone is rung.
    const pantryHandler = createAccessHandlerFor(pantry, { attended: true, generation: 0 });
    expect(await pantryHandler.handle(pantry, queryFrame(theirs.id, 'SELECT 1'))).toMatchObject({ ok: true });
    expect(__scopedReadCachedGrantsForTests()).toContain(theirs.id);

    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    const entrySpy = vi.spyOn(undoJournal(), 'putAccessUndo');
    const lineSpy = vi.spyOn(db, 'appendAccessLog');
    let cachedAtFirstRing: string[] | undefined;
    const ring = vi.fn((appId: string, event: string, data: unknown) => {
      cachedAtFirstRing ??= __scopedReadCachedGrantsForTests();
      rings.push({ appId, event, data });
    });
    for (const appId of [journal, budget, pantry]) unregister.push(registerAppHost(appId, (event, data) => ring(appId, event, data)));
    const answered = vi.fn();
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const answer = await handler.handle(budget, writeFrame(mine.id, "UPDATE entries SET amount = 9 WHERE title = 'tea'")).then((settled) => {
      answered();
      return settled;
    });

    expect(answer).toEqual({ ok: true, op: 'write', changes: 1 });
    const order = (spy: { mock: { invocationCallOrder: number[] } }, index = 0): number => spy.mock.invocationCallOrder[index] ?? Number.NaN;
    const wroteCall = lineSpy.mock.calls.findIndex((call) => (call[1] as { kind?: string }).kind === 'wrote');
    expect(seatSpy).toHaveBeenCalledTimes(1);
    expect(seatSpy.mock.calls[0]![0]).toBe(journal);
    // Gate-5 SEC-1: the undo bytes are the entry's cap LESS the 1 KiB reserve for the entry's host-written seats around `steps`.
    expect(seatSpy.mock.calls[0]![1], 'the plan, the caps, the previewed count; undo required, captured').toMatchObject({
      caps: { maxChanges: ACCESS_WRITE_MAX_ROWS, maxUndoBytes: ACCESS_UNDO_MAX_BYTES - UNDO_ENTRY_RESERVE_BYTES },
      expectChanges: [1],
      requireUndo: true,
      capture: true,
    });
    expect(entrySpy).toHaveBeenCalledTimes(1);
    expect(wroteCall).toBeGreaterThanOrEqual(0);
    expect(ring).toHaveBeenCalled();
    const sequence = [order(seatSpy), order(entrySpy), lineSpy.mock.invocationCallOrder[wroteCall]!, order(ring), order(answered)];
    expect(sequence, 'seat → entry → line → doorbell → answer').toEqual([...sequence].sort((a, b) => a - b));
    expect(cachedAtFirstRing, 'the caches of every grant reading the source are cleared before the first doorbell').not.toContain(theirs.id);
    expect(doorbells()).toContainEqual({ appId: journal, event: DATA_CHANGED_EVENT, data: { table: 'entries' } });
    expect(doorbells()).toContainEqual({ appId: pantry, event: ACCESS_SOURCE_CHANGED_EVENT, data: { grantId: theirs.id } });
    expect(doorbells().filter((entry) => entry.appId === budget), 'never the writer').toEqual([]);
  });

  it('the per-reader cap is asked after the plan and before the seat: 20 live entries of THIS reader on this target refuse the 21st — another reader’s 20 do not count', async () => {
    const mine = await grantOn(budget, journal, ['entries'], true);
    const theirs = await grantOn(pantry, journal, ['entries'], true);
    const step: AccessUndoStep = { table: 'entries', op: 'insert', columns: ['title'], rows: [{ rowid: 99, after: ['x'] }] };
    for (let i = 0; i < 20; i += 1) expect(undoJournal().putAccessUndo(journal, { ...plantedEntry(theirs.id, [step]), readerAppId: pantry, readerName: 'Pantry' })).toBe('ok');
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    expect((await writeAsBudget(mine.id, "UPDATE entries SET amount = 9 WHERE title = 'tea'")).answer, 'Pantry’s twenty are Pantry’s').toEqual({ ok: true, op: 'write', changes: 1 });
    expect(seatSpy).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 19; i += 1) expect(undoJournal().putAccessUndo(journal, plantedEntry(mine.id, [step]))).toBe('ok');
    expect(undoJournal().listAccessUndo(journal, budget)).toHaveLength(20);
    posted = [];
    const refused = await writeAsBudget(mine.id, "UPDATE entries SET amount = 8 WHERE title = 'cake'");
    expect(refused.answer).toEqual(refusal('ACCESS_WRITE_REFUSED', ACCESS_APP_MESSAGES.writeRefused('waiting'), false));
    expect(posted.map(kindOf), 'the plan ran').toEqual(['plan-write']);
    expect(seatSpy, 'the seat was never reached').toHaveBeenCalledTimes(1);
    expect(await rowsOf(journal, "SELECT amount FROM entries WHERE title = 'cake'")).toEqual([[5]]);
  });
});

// =========================================================================================
// Own mode — applyApprovedWrite
// =========================================================================================

// INVERTED by D-PR4-4/6 (PR-4 invert table): own mode's approval no longer runs the bare `{ own }`
// variant, unjournaled. It runs the CAPTURE variant (`requireUndo: false`, `caps.maxChanges =
// Infinity`, the engine's `admit`), journals the rows to `ownUndo:<appId>:approval` (authority
// `approval`, the caller's `via`; never the access journal, never a history line) and rings
// `data-changed` to its own frame AND `access-source-changed` to its live readers (D-PR4-5). The
// outcome gains `undoId` and `undoable`. The rows below are the PR-3 rows, inverted IN PLACE: the
// seat input, the journal, the rings. The drift row is unchanged by the contract.
describe('own mode — applyApprovedWrite: the app’s own approved write through the same seat, now CAPTURED and journaled to the approval bucket (D-PR3-8 → D-PR4-4/6; AC20, AC32b)', () => {

  // The own journal's liveness is read against the db's WALL clock (an entry is live while its
  // expiresAt is ahead of it); the engine stamps entries with the injected clock (T0). Only `Date`
  // is faked, at T0, so the two agree and no row turns red seven days after it was written.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const proposal = (statements: string[], previewed: number[]): PendingWriteProposal => ({ appId: journal, statements, params: statements.map(() => []), summary: 'a change the user approved', previewed });

  it('applies atomically through the seat’s CAPTURE variant ({ own, capture: true, caps.maxChanges Infinity, expectChanges: the previewed counts, requireUndo: false, admit }) — no BEGIN through the frame seat, an APPROVAL entry journaled (no access entry, no line) — answers executed with its undoId and rings data-changed to its own frame and access-source-changed to its readers', async () => {
    const { applyApprovedWrite } = await writeBroker();
    const theirs = await grantOn(pantry, journal, ['entries'], false);
    listen(journal, pantry);
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    const handleSpy = vi.spyOn(db.driver, 'handle');
    const outcome = await approve(applyApprovedWrite, proposal(["UPDATE entries SET amount = 9 WHERE title = 'tea'"], [1]), 'chat');
    expect(outcome).toEqual({ ok: true, executed: [1], undoId: expect.stringMatching(UUID_V4), undoable: true });
    expect(seatSpy).toHaveBeenCalledTimes(1);
    expect(seatSpy.mock.calls[0]![0]).toBe(journal);
    // The seat's CAPTURE variant (D-PR4-4): the approved statements with their params, the previewed counts as the halt, no undo REQUIRED (an approval is never refused for its journal).
    const input = seatSpy.mock.calls[0]![1] as unknown as Record<string, unknown>;
    expect(input).toMatchObject({
      own: [{ sql: "UPDATE entries SET amount = 9 WHERE title = 'tea'", params: [] }],
      capture: true,
      expectChanges: [1],
      requireUndo: false,
    });
    expect((input.caps as { maxChanges: number }).maxChanges, 'an approval is never refused for its size').toBe(Number.POSITIVE_INFINITY);
    expect(typeof input.admit, 'the engine’s ownUndoEntrySchema.safeParse of the exact entry').toBe('function');
    for (const strictSeat of ['plans', 'undo']) expect(input, strictSeat).not.toHaveProperty(strictSeat);
    const transactionControl = handleSpy.mock.calls.filter((call) => /^\s*(BEGIN|COMMIT|ROLLBACK|END)\b/i.test(String((call[1] as { sql?: unknown }).sql ?? '')));
    expect(transactionControl, 'no awaited BEGIN/COMMIT through the frame seat').toEqual([]);
    expect(await rowsOf(journal, "SELECT amount FROM entries WHERE title = 'tea'")).toEqual([[9]]);
    // The journal: the OWN approval bucket — never the access journal, never a history line.
    expect(undoJournal().listAllAccessUndo(journal)).toEqual([]);
    // sanctioned by PR-4 v2.2 note b — the journal holds the setup's grant line; the WRITE adds none.
    expect(linesOf(journal).map((l) => l.kind), 'no line from the write').toEqual(['granted']);
    const entries = ownJournal().listOwnUndo(journal, { bucket: 'approval' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: (outcome as { undoId?: string }).undoId, authority: 'approval', via: 'chat' });
    expect(entries[0]!.steps).toEqual([{ table: 'entries', op: 'update', columns: ['amount'], rows: [{ rowid: 1, before: [3], after: [9] }] }]);
    expect(JSON.stringify(entries[0]), 'no SQL text in the entry').not.toMatch(/UPDATE|WHERE/);
    // The rings (D-PR4-5): its own frame AND its live readers.
    expect(doorbells()).toContainEqual({ appId: journal, event: DATA_CHANGED_EVENT, data: { table: 'entries' } });
    expect(doorbells()).toContainEqual({ appId: pantry, event: ACCESS_SOURCE_CHANGED_EVENT, data: { grantId: theirs.id } });
    expect(doorbells()).toHaveLength(2);
  });

  it('a drift since approval keeps today’s outcome shape { ok: false, reason: drifted, previewed, current } — nothing applied, nothing rung', async () => {
    const { applyApprovedWrite } = await writeBroker();
    const approved = proposal(['UPDATE entries SET amount = 1 WHERE amount < 4'], [2]);
    await exec(journal, "INSERT INTO entries (title, amount) VALUES ('jam', 1)"); // the app wrote between preview and approval
    listen(journal);
    const before = await rowsOf(journal, ENTRIES);
    expect(await approve(applyApprovedWrite, approved, 'chat')).toEqual({ ok: false, reason: 'drifted', previewed: [2], current: [3] });
    expect(await rowsOf(journal, ENTRIES)).toEqual(before);
    expect(rings.filter((entry) => entry.event === DATA_CHANGED_EVENT)).toEqual([]);
  });

  it('executeApprovedWrite(db, proposal, { via }) is a thin caller of own mode — it reaches the capture seat and journals with the caller’s via (AC20; D-PR4-6)', async () => {
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    const outcome = await (executeApprovedWrite as unknown as ApproveFn)(db, proposal(["UPDATE entries SET amount = 9 WHERE title = 'tea'"], [1]), { via: 'user' });
    expect(outcome).toEqual({ ok: true, executed: [1], undoId: expect.stringMatching(UUID_V4), undoable: true });
    expect(seatSpy).toHaveBeenCalledTimes(1);
    expect(seatSpy.mock.calls[0]![1]).toMatchObject({ own: [{ sql: "UPDATE entries SET amount = 9 WHERE title = 'tea'", params: [] }], capture: true, expectChanges: [1], requireUndo: false });
    expect(seatSpy.mock.calls[0]![1]).not.toHaveProperty('plans');
    expect(ownJournal().listOwnUndo(journal, { bucket: 'approval' })[0]).toMatchObject({ authority: 'approval', via: 'user' });
  });
});

// =========================================================================================
// undoBrokeredWrite
// =========================================================================================

describe('undoBrokeredWrite — the user’s act from the source’s history, rebuilt from rows (D-PR3-7/15; §24.5 MUST 23)', () => {
  it('rebuilds the inverse from the journal’s rows and applies it; writes the undone line (via user, changes, the table); marks the entry; rings data-changed to the target and access-source-changed to EVERY live reader — the writer too', async () => {
    const { undoBrokeredWrite } = await writeBroker();
    const mine = await grantOn(budget, journal, ['entries'], true);
    const theirs = await grantOn(pantry, journal, ['entries'], false);
    const { answer, undoId } = await writeAsBudget(mine.id, 'UPDATE entries SET amount = 0 WHERE amount < 4');
    expect(answer).toEqual({ ok: true, op: 'write', changes: 2 });
    listen(journal, budget, pantry);

    expect(await undoBrokeredWrite(db, journal, undoId!, { via: 'user' })).toEqual({ ok: true });
    expect(await rowsOf(journal, ENTRIES)).toEqual([
      [1, 'tea', 3],
      [2, 'cake', 5],
      [3, 'bread', 2],
    ]);
    expect(linesOf(journal)[0]).toMatchObject({ kind: 'undone', via: 'user', changes: 2, tables: ['entries'], grantId: mine.id, readerAppId: budget, readerName: 'Budget' });
    expect(undoJournal().listAccessUndo(journal), 'no live entry is left').toEqual([]);
    const all = undoJournal().listAllAccessUndo(journal);
    expect(all, 'the undo is itself never journaled').toHaveLength(1);
    expect(all[0]).toMatchObject({ id: undoId });
    expect(all[0]?.undoneAt).toBeDefined();
    expect(doorbells()).toContainEqual({ appId: journal, event: DATA_CHANGED_EVENT, data: { table: 'entries' } });
    expect(doorbells()).toContainEqual({ appId: budget, event: ACCESS_SOURCE_CHANGED_EVENT, data: { grantId: mine.id } });
    expect(doorbells()).toContainEqual({ appId: pantry, event: ACCESS_SOURCE_CHANGED_EVENT, data: { grantId: theirs.id } });
  });

  it('is never undoable twice: the second undo of the same entry can no longer be done — nothing changes, no second line', async () => {
    const { undoBrokeredWrite } = await writeBroker();
    const mine = await grantOn(budget, journal, ['entries'], true);
    const { undoId } = await writeAsBudget(mine.id, "UPDATE entries SET amount = 0 WHERE title = 'tea'");
    expect(await undoBrokeredWrite(db, journal, undoId!, { via: 'user' })).toEqual({ ok: true });
    await exec(journal, "UPDATE entries SET amount = 0 WHERE title = 'tea'"); // the same value again — a second inverse would match it
    expect(await undoBrokeredWrite(db, journal, undoId!, { via: 'user' })).toMatchObject({ ok: false, reason: 'gone' });
    expect(await rowsOf(journal, "SELECT amount FROM entries WHERE title = 'tea'")).toEqual([[0]]);
    expect(linesOf(journal).filter((entry) => entry.kind === 'undone')).toHaveLength(1);
  });

  it('applies the steps in REVERSE order: a planted two-step entry (insert a row, then update it) undoes cleanly — forward order would fail its guard', async () => {
    const { undoBrokeredWrite } = await writeBroker();
    const mine = await grantOn(budget, journal, ['entries'], true);
    await exec(journal, "INSERT INTO entries (id, title, amount) VALUES (4, 'jam', 10)");
    await exec(journal, 'UPDATE entries SET amount = 50 WHERE id = 4');
    const entry = plantedEntry(mine.id, [
      { table: 'entries', op: 'insert', columns: ['id', 'title', 'amount'], rows: [{ rowid: 4, after: [4, 'jam', 10] }] },
      { table: 'entries', op: 'update', columns: ['amount'], rows: [{ rowid: 4, before: [10], after: [50] }] },
    ]);
    expect(undoJournal().putAccessUndo(journal, entry)).toBe('ok');
    expect(await undoBrokeredWrite(db, journal, entry.id, { via: 'user' })).toEqual({ ok: true });
    expect(await rowsOf(journal, 'SELECT count(*) FROM entries WHERE id = 4')).toEqual([[0]]);
    expect(linesOf(journal)[0]).toMatchObject({ kind: 'undone', via: 'user', changes: 2, tables: ['entries'] });
  });

  it('the other app in the middle of a change (its frame’s BEGIN) → busy: nothing undone, the entry still live, “try again in a moment”', async () => {
    const { undoBrokeredWrite } = await writeBroker();
    const mine = await grantOn(budget, journal, ['entries'], true);
    const { undoId } = await writeAsBudget(mine.id, "UPDATE entries SET amount = 0 WHERE title = 'tea'");
    await exec(journal, 'BEGIN');
    expect(await undoBrokeredWrite(db, journal, undoId!, { via: 'user' })).toEqual({ ok: false, reason: 'busy', message: undoFailed('busy', 'Journal') });
    expect(undoJournal().listAccessUndo(journal).map((entry) => entry.id)).toEqual([undoId]);
    expect(linesOf(journal).filter((entry) => entry.kind === 'undone')).toEqual([]);
  });

  it('a guard mismatch — the source changed ONE of the rows since — rolls the WHOLE undo back: nothing changes, “couldn’t undo — Journal changed these rows since”', async () => {
    const { undoBrokeredWrite } = await writeBroker();
    const mine = await grantOn(budget, journal, ['entries'], true);
    const { undoId } = await writeAsBudget(mine.id, 'UPDATE entries SET amount = 0 WHERE amount < 4');
    await exec(journal, "UPDATE entries SET amount = 7 WHERE title = 'bread'");
    expect(await undoBrokeredWrite(db, journal, undoId!, { via: 'user' })).toEqual({ ok: false, reason: 'changed', message: undoFailed('changed', 'Journal') });
    expect(await rowsOf(journal, ENTRIES), 'tea is NOT put back: all or nothing').toEqual([
      [1, 'tea', 0],
      [2, 'cake', 5],
      [3, 'bread', 7],
    ]);
    expect(linesOf(journal).filter((entry) => entry.kind === 'undone')).toEqual([]);
  });

  it('a planted entry naming a table or a column the source no longer has — or a computed one — can no longer be undone: refused before the seat, and the entry marked undone (failed)', async () => {
    const { undoBrokeredWrite } = await writeBroker();
    const mine = await grantOn(budget, journal, ['entries'], true);
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    const markSpy = vi.spyOn(undoJournal(), 'markAccessUndone');
    const planted = [
      plantedEntry(mine.id, [{ table: 'ghost', op: 'update', columns: ['amount'], rows: [{ rowid: 1, before: [3], after: [0] }] }]),
      plantedEntry(mine.id, [{ table: 'entries', op: 'update', columns: ['nope'], rows: [{ rowid: 1, before: [3], after: [0] }] }]),
      plantedEntry(mine.id, [{ table: 'sums', op: 'update', columns: ['doubled'], rows: [{ rowid: 1, before: [2], after: [4] }] }]),
    ];
    for (const entry of planted) {
      expect(undoJournal().putAccessUndo(journal, entry)).toBe('ok');
      expect(await undoBrokeredWrite(db, journal, entry.id, { via: 'user' }), entry.steps[0]!.table).toEqual({ ok: false, reason: 'gone', message: undoFailed('gone', 'Journal') });
      expect(markSpy).toHaveBeenLastCalledWith(journal, entry.id, expect.any(String));
    }
    expect(seatSpy, 'refused before the seat').not.toHaveBeenCalled();
    expect(undoJournal().listAccessUndo(journal), 'none of them is live any more').toEqual([]);
  });

  // The builder half of this pin (the built text carries no value, the params carry it) moved to
  // packages/db's brokered-write.test.ts with the Gate-5 W-5 fold: `buildUndoStatement` is reachable
  // only through the driver's seat now. Here the seat is handed the STRUCTURE — the value as data.
  it('a planted entry’s values ride ONLY as bound parameters: the seat is handed the structure, never statement text — a value shaped like SQL is matched as data, and nothing else runs', async () => {
    const { undoBrokeredWrite } = await writeBroker();
    const mine = await grantOn(budget, journal, ['entries'], true);
    const evil = "x'; DROP TABLE entries; --";
    const step: AccessUndoStep = { table: 'entries', op: 'insert', columns: ['title'], rows: [{ rowid: 1, after: [evil] }] };
    const entry = plantedEntry(mine.id, [step]);
    expect(undoJournal().putAccessUndo(journal, entry)).toBe('ok');
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    expect(await undoBrokeredWrite(db, journal, entry.id, { via: 'user' })).toMatchObject({ ok: false, reason: 'changed' });
    expect(seatSpy.mock.calls[0]![1], 'the undo variant carries the rows as data — no sql seat, no caps (W-2)').toEqual({ undo: [step] });
    expect(await rowsOf(journal, ENTRIES), 'the table and its rows are intact').toEqual([
      [1, 'tea', 3],
      [2, 'cake', 5],
      [3, 'bread', 2],
    ]);
  });
});

// =========================================================================================
// clearSourceReadCaches
// =========================================================================================

describe('clearSourceReadCaches — every grant whose source is the target, and only those (D-PR3-15)', () => {
  it('evicts the cached bytes of every grant reading the source — Budget’s and Pantry’s of Journal — and keeps a grant reading another source', async () => {
    const { clearSourceReadCaches } = await writeBroker();
    const mine = await grantOn(budget, journal, ['entries'], false);
    const theirs = await grantOn(pantry, journal, ['entries'], false);
    const other = await grantOn(budget, pantry, ['items'], false);
    const budgetFrame = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const pantryFrame = createAccessHandlerFor(pantry, { attended: true, generation: 0 });
    for (const [handler, appId, grantId] of [
      [budgetFrame, budget, mine.id],
      [pantryFrame, pantry, theirs.id],
      [budgetFrame, budget, other.id],
    ] as const) {
      expect(await handler.handle(appId, queryFrame(grantId, 'SELECT 1'))).toMatchObject({ ok: true });
    }
    expect([...__scopedReadCachedGrantsForTests()].sort()).toEqual([mine.id, theirs.id, other.id].sort());
    clearSourceReadCaches(db, journal);
    expect(__scopedReadCachedGrantsForTests()).toEqual([other.id]);
  });
});

// =========================================================================================
// The Gate-5 folds' pins (SEC-1, SEC-4, W-1, ENG-4)
// =========================================================================================

describe('Gate-5 SEC-1 — the undo cap is measured on the WHOLE entry: the steps run under the cap less the entry’s reserve', () => {
  /** A DELETE of `notes (id, body)` captures every column of every row — its journal bytes are the JSON of this step (the apply's own measure). */
  const ROWS = 16;
  const PROSE = 'note '.repeat(1000);
  const bodyOf = (length: number): string => PROSE.slice(0, length);
  const deleteStepOf = (length: number): AccessUndoStep => ({
    table: 'notes',
    op: 'delete',
    columns: ['id', 'body'],
    rows: Array.from({ length: ROWS }, (_, i) => ({ rowid: i + 1, before: [i + 1, bodyOf(length)] })),
  });
  const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
  /** The longest body (each ≤ the journal's 4096-character cell) whose step's journal bytes stay at or under `maxBytes`. */
  function bodyLengthUnder(maxBytes: number): number {
    for (let length = 4096; length > 0; length -= 1) if (bytesOf([deleteStepOf(length)]) <= maxBytes) return length;
    throw new Error('no body fits');
  }
  async function seedNotes(length: number): Promise<void> {
    await db.applyAppDdl(journal, ['CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)']);
    const values = Array.from({ length: ROWS }, (_, i) => `(${i + 1}, '${bodyOf(length)}')`).join(', ');
    await exec(journal, `INSERT INTO notes (id, body) VALUES ${values}`);
  }
  const DELETE_ALL = `DELETE FROM notes WHERE id <= ${ROWS}`;

  it('steps that fit ACCESS_UNDO_MAX_BYTES but not the entry around them (inside the 1 KiB reserve) are refused too-large at the DRY RUN — the seat never reached, nothing changed, no entry, no line', async () => {
    const length = bodyLengthUnder(ACCESS_UNDO_MAX_BYTES);
    const bytes = bytesOf([deleteStepOf(length)]);
    expect(bytes, 'the steps alone fit the schema’s cap').toBeLessThanOrEqual(ACCESS_UNDO_MAX_BYTES);
    expect(bytes, 'and sit inside the reserve the entry’s seats need').toBeGreaterThan(ACCESS_UNDO_MAX_BYTES - UNDO_ENTRY_RESERVE_BYTES);
    await seedNotes(length);
    const mine = await grantOn(budget, journal, ['notes'], true);
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    const entrySpy = vi.spyOn(undoJournal(), 'putAccessUndo');
    const { answer, undoId } = await writeAsBudget(mine.id, DELETE_ALL);
    expect(answer).toEqual(refusal('ACCESS_WRITE_REFUSED', ACCESS_APP_MESSAGES.writeRefused('too-large'), false));
    expect(posted.map(kindOf), 'the plan ran — and answered').toEqual(['plan-write']);
    expect(seatSpy, 'refused before any live handle').not.toHaveBeenCalled();
    expect(entrySpy).not.toHaveBeenCalled();
    expect(undoId).toBeUndefined();
    expect(linesOf(journal).filter((entry) => entry.kind === 'wrote')).toEqual([]);
    expect(await rowsOf(journal, 'SELECT count(*) FROM notes')).toEqual([[ROWS]]);
  });

  it('a write just under STRICT_CAPS.maxUndoBytes lands: the journal never refuses it — the wrote line carries its undoId, the entry fits the schema’s cap whole', async () => {
    const length = bodyLengthUnder(ACCESS_UNDO_MAX_BYTES - UNDO_ENTRY_RESERVE_BYTES);
    const bytes = bytesOf([deleteStepOf(length)]);
    expect(bytes).toBeLessThanOrEqual(ACCESS_UNDO_MAX_BYTES - UNDO_ENTRY_RESERVE_BYTES);
    expect(bytes, 'within a step of the steps’ cap').toBeGreaterThan(ACCESS_UNDO_MAX_BYTES - UNDO_ENTRY_RESERVE_BYTES - 2 * ROWS);
    await seedNotes(length);
    const mine = await grantOn(budget, journal, ['notes'], true);
    const warn = vi.spyOn(console, 'warn');
    const { answer, undoId } = await writeAsBudget(mine.id, DELETE_ALL);
    expect(answer).toEqual({ ok: true, op: 'write', changes: ROWS });
    expect(undoId, 'the wrote line carries the undo').toEqual(expect.any(String));
    const [entry] = undoJournal().listAccessUndo(journal);
    expect(entry?.id).toBe(undoId);
    expect(bytesOf(entry!.steps), 'the model of the measure is the apply’s own').toBe(bytes);
    expect(bytesOf(entry), 'the whole entry fits').toBeLessThanOrEqual(ACCESS_UNDO_MAX_BYTES);
    expect(warn.mock.calls.filter((call) => String(call[0]).startsWith('access:')), 'the schema’s refusal is unreachable').toEqual([]);
    expect(await rowsOf(journal, 'SELECT count(*) FROM notes')).toEqual([[0]]);
  });
});

describe('Gate-5 SEC-4 — a planted undo step naming a credential column is refused at the seat’s phase 1', () => {
  it('a step naming api_key on an otherwise shared table: the seat refuses it, the user hears gone, the entry is marked — nothing written', async () => {
    const { undoBrokeredWrite } = await writeBroker();
    await db.applyAppDdl(journal, ['CREATE TABLE vault (id INTEGER PRIMARY KEY, label TEXT, api_key TEXT)']);
    await exec(journal, "INSERT INTO vault (id, label, api_key) VALUES (1, 'home', 'kept')");
    const mine = await grantOn(budget, journal, ['entries'], true);
    const entry = plantedEntry(mine.id, [{ table: 'vault', op: 'update', columns: ['label', 'api_key'], rows: [{ rowid: 1, before: ['home', 'planted'], after: ['home', 'kept'] }] }]);
    expect(undoJournal().putAccessUndo(journal, entry)).toBe('ok');
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    const markSpy = vi.spyOn(undoJournal(), 'markAccessUndone');
    expect(await undoBrokeredWrite(db, journal, entry.id, { via: 'user' })).toEqual({ ok: false, reason: 'gone', message: undoFailed('gone', 'Journal') });
    expect(seatSpy, 'the live schema has the column — the seat’s phase 1 is what refuses it').toHaveBeenCalledTimes(1);
    expect(markSpy).toHaveBeenCalledWith(journal, entry.id, expect.any(String));
    expect(await rowsOf(journal, 'SELECT id, label, api_key FROM vault')).toEqual([[1, 'home', 'kept']]);
    expect(undoJournal().listAccessUndo(journal)).toEqual([]);
    expect(linesOf(journal).filter((line) => line.kind === 'undone')).toEqual([]);
  });
});

describe('Gate-5 W-1 — a brokered write matching NO row is not undoable', () => {
  for (const sql of ["UPDATE entries SET amount = 9 WHERE title = 'nothing'", 'DELETE FROM entries WHERE id = 99']) {
    it(`${sql.split(' ')[0]} matching no row: { changes: 0 }, NO undo entry written, the wrote line carries no undoId`, async () => {
      const mine = await grantOn(budget, journal, ['entries'], true);
      const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
      const entrySpy = vi.spyOn(undoJournal(), 'putAccessUndo');
      const { answer, undoId } = await writeAsBudget(mine.id, sql);
      expect(answer).toEqual({ ok: true, op: 'write', changes: 0 });
      const applied = await seatSpy.mock.results[0]!.value;
      expect(applied).toEqual({ ok: true, steps: [], changes: [0], undoable: false });
      expect(entrySpy, 'nothing to put back — no entry').not.toHaveBeenCalled();
      expect(undoJournal().listAllAccessUndo(journal)).toEqual([]);
      expect(undoId).toBeUndefined();
      const wrote = linesOf(journal).filter((line) => line.kind === 'wrote');
      expect(wrote).toHaveLength(1);
      expect(wrote[0]).toMatchObject({ changes: 0, tables: ['entries'] });
      expect(wrote[0]).not.toHaveProperty('undoId');
    });
  }
});

describe('Gate-5 ENG-4 — EVERY undo outcome bumps the access revision exactly once', () => {
  async function bumpsOf(run: () => Promise<unknown>): Promise<{ outcome: unknown; bumps: number }> {
    const before = accessRevisionStore.get();
    const outcome = await run();
    return { outcome, bumps: accessRevisionStore.get() - before };
  }

  it('ok · gone · busy · changed · failed — one bump each', async () => {
    const { undoBrokeredWrite } = await writeBroker();
    const mine = await grantOn(budget, journal, ['entries'], true);
    const undo = (undoId: string) => () => undoBrokeredWrite(db, journal, undoId, { via: 'user' });

    // ok
    const done = await writeAsBudget(mine.id, "UPDATE entries SET amount = 0 WHERE title = 'tea'");
    expect(await bumpsOf(undo(done.undoId!))).toEqual({ outcome: { ok: true }, bumps: 1 });

    // gone — an id the journal does not hold
    expect(await bumpsOf(undo(crypto.randomUUID()))).toEqual({ outcome: { ok: false, reason: 'gone', message: undoFailed('gone', 'Journal') }, bumps: 1 });

    // changed — the source changed the row since
    const changedEntry = plantedEntry(mine.id, [{ table: 'entries', op: 'update', columns: ['amount'], rows: [{ rowid: 2, before: [1], after: [77] }] }]);
    expect(undoJournal().putAccessUndo(journal, changedEntry)).toBe('ok');
    expect(await bumpsOf(undo(changedEntry.id))).toEqual({ outcome: { ok: false, reason: 'changed', message: undoFailed('changed', 'Journal') }, bumps: 1 });

    // failed — a DELETE-undo whose rowid is held by a row again (a SQL error, D-Q19)
    const failedEntry = plantedEntry(mine.id, [{ table: 'entries', op: 'delete', columns: ['id', 'title', 'amount'], rows: [{ rowid: 3, before: [3, 'bread', 2] }] }]);
    expect(undoJournal().putAccessUndo(journal, failedEntry)).toBe('ok');
    expect(await bumpsOf(undo(failedEntry.id))).toEqual({ outcome: { ok: false, reason: 'failed', message: undoFailed('failed', 'Journal') }, bumps: 1 });

    // busy — the source in the middle of a change
    const busyEntry = plantedEntry(mine.id, [{ table: 'entries', op: 'update', columns: ['amount'], rows: [{ rowid: 2, before: [1], after: [5] }] }]);
    expect(undoJournal().putAccessUndo(journal, busyEntry)).toBe('ok');
    await exec(journal, 'BEGIN');
    try {
      expect(await bumpsOf(undo(busyEntry.id))).toEqual({ outcome: { ok: false, reason: 'busy', message: undoFailed('busy', 'Journal') }, bumps: 1 });
    } finally {
      await exec(journal, 'ROLLBACK');
    }
  });
});

// =========================================================================================
// PR-4 — the approval's order and its paths (contract v2 D-PR4-4, D-PR4-5, D-PR4-6; AC32b)
// =========================================================================================

describe('PR-4 — applyApprovedWrite’s order: class guard → inTransaction → the scratchRun drift halt → the seat (D-PR4-5/6)', () => {

  // The own journal's liveness is read against the db's WALL clock (an entry is live while its
  // expiresAt is ahead of it); the engine stamps entries with the injected clock (T0). Only `Date`
  // is faked, at T0, so the two agree and no row turns red seven days after it was written.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const proposal = (statements: string[], previewed: number[]): PendingWriteProposal => ({ appId: journal, statements, params: statements.map(() => []), summary: 'a change the user approved', previewed });

  it('asks the driver’s transaction record FIRST — before the scratchRun export (which would discard the app’s open transaction) and before the seat', async () => {
    const { applyApprovedWrite } = await writeBroker();
    const asked = vi.spyOn(db.driver, 'inTransaction');
    const scratch = vi.spyOn(db, 'scratchRun');
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    expect(await approve(applyApprovedWrite, proposal(["UPDATE entries SET amount = 9 WHERE title = 'tea'"], [1]), 'chat')).toMatchObject({ ok: true });
    expect(asked).toHaveBeenCalledWith(journal);
    const first = (spy: { mock: { invocationCallOrder: number[] } }): number => spy.mock.invocationCallOrder[0] ?? Number.NaN;
    expect(first(asked)).toBeLessThan(first(scratch));
    expect(first(scratch)).toBeLessThan(first(seatSpy));
  });

  it('the app mid-change (its frame’s BEGIN) → failed with the busy sentence: no scratchRun, no seat, the app’s transaction left as it was', async () => {
    const { applyApprovedWrite } = await writeBroker();
    await exec(journal, 'BEGIN');
    await exec(journal, "UPDATE entries SET amount = 7 WHERE title = 'cake'");
    const scratch = vi.spyOn(db, 'scratchRun');
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    const outcome = await approve(applyApprovedWrite, proposal(["UPDATE entries SET amount = 9 WHERE title = 'tea'"], [1]), 'chat');
    expect(outcome).toMatchObject({ ok: false, reason: 'failed' });
    expect(String(outcome.message)).toMatch(/middle of a change/);
    expect(scratch, 'an export would have discarded the app’s transaction').not.toHaveBeenCalled();
    expect(seatSpy).not.toHaveBeenCalled();
    expect(await db.driver.inTransaction(journal)).toBe(true);
    await exec(journal, 'COMMIT');
    expect(await rowsOf(journal, ENTRIES)).toEqual([
      [1, 'tea', 3],
      [2, 'cake', 7],
      [3, 'bread', 2],
    ]);
  });

  it('the class guard answers before anything else: a DDL is failed with no transaction read, no export, no seat', async () => {
    const { applyApprovedWrite } = await writeBroker();
    const asked = vi.spyOn(db.driver, 'inTransaction');
    const scratch = vi.spyOn(db, 'scratchRun');
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    expect(await approve(applyApprovedWrite, proposal(['DROP TABLE entries'], [0]), 'chat')).toMatchObject({ ok: false, reason: 'failed' });
    expect(asked).not.toHaveBeenCalled();
    expect(scratch).not.toHaveBeenCalled();
    expect(seatSpy).not.toHaveBeenCalled();
  });

  it(`over ${ACCESS_WRITE_MAX_ROWS} previewed rows the engine asks for the BARE { own } up front — never refused for its size, applied whole, undoable false, no entry`, async () => {
    const { applyApprovedWrite } = await writeBroker();
    const values = Array.from({ length: ACCESS_WRITE_MAX_ROWS + 1 }, (_, i) => `('bulk-${i}', 1)`).join(', ');
    await exec(journal, `INSERT INTO entries (title, amount) VALUES ${values}`);
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    const outcome = await approve(applyApprovedWrite, proposal(['UPDATE entries SET amount = 0 WHERE amount = 1'], [ACCESS_WRITE_MAX_ROWS + 1]), 'chat');
    expect(outcome).toEqual({ ok: true, executed: [ACCESS_WRITE_MAX_ROWS + 1], undoable: false });
    expect(seatSpy).toHaveBeenCalledTimes(1);
    expect(seatSpy.mock.calls[0]![1]).toEqual({ own: [{ sql: 'UPDATE entries SET amount = 0 WHERE amount = 1', params: [] }], expectChanges: [ACCESS_WRITE_MAX_ROWS + 1] });
    expect(ownJournal().listOwnUndo(journal, { bucket: 'approval' })).toEqual([]);
  });

  it('a batch with ANY uncapturable statement runs the bare { own } path for the WHOLE batch — never a mixed batch: both apply, undoable false, no entry', async () => {
    const { applyApprovedWrite } = await writeBroker();
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    const outcome = await approve(
      applyApprovedWrite,
      proposal(["UPDATE entries SET amount = 9 WHERE title = 'tea'", "UPDATE entries SET amount = amount + 1 WHERE title = 'cake'"], [1, 1]),
      'chat',
    );
    expect(outcome).toEqual({ ok: true, executed: [1, 1], undoable: false });
    const last = seatSpy.mock.calls.at(-1)![1];
    expect(last, 'the batch that COMMITTED was the bare one').toEqual({
      own: [
        { sql: "UPDATE entries SET amount = 9 WHERE title = 'tea'", params: [] },
        { sql: "UPDATE entries SET amount = amount + 1 WHERE title = 'cake'", params: [] },
      ],
      expectChanges: [1, 1],
    });
    expect(await rowsOf(journal, ENTRIES)).toEqual([
      [1, 'tea', 9],
      [2, 'cake', 6],
      [3, 'bread', 2],
    ]);
    expect(ownJournal().listOwnUndo(journal, { bucket: 'approval' })).toEqual([]);
  });

  it('a captured cell the journal may not hold (a credential-shaped value) — admit says no: the approval COMMITS, undoable false, no entry; the value is in no journal', async () => {
    const { applyApprovedWrite } = await writeBroker();
    const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
    const outcome = await approve(applyApprovedWrite, proposal([`UPDATE entries SET title = '${KEY}' WHERE id = 1`], [1]), 'chat');
    expect(outcome).toEqual({ ok: true, executed: [1], undoable: false });
    expect(ownJournal().listOwnUndo(journal, { bucket: 'approval' })).toEqual([]);
    expect(JSON.stringify(db.getSetting(`ownUndo:${journal}:approval`) ?? null)).not.toContain(KEY);
  });
});

// =========================================================================================
// PR-4 — applyOwnWrite: the one own-write engine (D-PR4-3, D-PR4-4, D-PR4-5, D-PR4-11)
// =========================================================================================

/** A 20-live-entry bucket, planted through the accessor. */
function fillOwnBucket(bucket: string, live: number, authority: 'task' | 'approval' = 'task'): string[] {
  const ids: string[] = [];
  for (let i = 0; i < live; i += 1) {
    const id = crypto.randomUUID();
    ids.push(id);
    expect(
      ownJournal().putOwnUndo(journal, bucket, {
        id,
        at: iso(clock.now - (live - i) * 60_000),
        expiresAt: iso(clock.now + 7 * DAY),
        authority,
        via: authority === 'task' ? 'schedule' : 'chat',
        ...(authority === 'task' ? { runId: `run-${i}`, taskId: bucket } : {}),
        steps: [{ table: 'entries', op: 'update', columns: ['amount'], rows: [{ rowid: 2, before: [5], after: [5] }] }],
      } as never),
    ).toBe('ok');
  }
  return ids;
}

describe('PR-4 — applyOwnWrite (the module contract: {appId, bucket, statements, params, expectChanges, maxChanges, requireUndo, authority, via, runId?, taskId?, stillArmed?})', () => {

  // The own journal's liveness is read against the db's WALL clock (an entry is live while its
  // expiresAt is ahead of it); the engine stamps entries with the injected clock (T0). Only `Date`
  // is faked, at T0, so the two agree and no row turns red seven days after it was written.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  type OwnWriteInput = Parameters<WriteBrokerModule['applyOwnWrite']>[1];
  const taskWrite = (over: Partial<Record<string, unknown>> = {}): OwnWriteInput =>
    ({
      appId: journal,
      bucket: 'task-1',
      statements: ["UPDATE entries SET amount = 9 WHERE title = 'tea'"],
      params: [[]],
      expectChanges: [1],
      maxChanges: ACCESS_WRITE_MAX_ROWS,
      requireUndo: true,
      authority: 'task',
      via: 'schedule',
      runId: 'run-1',
      taskId: 'task-1',
      stillArmed: () => true,
      ...over,
    }) as unknown as OwnWriteInput;

  it('a task’s write: ONE capture seat call (requireUndo true, its maxChanges, admit), the entry in ITS bucket (authority task, via schedule, runId, taskId — no SQL), no access entry, no line', async () => {
    const { applyOwnWrite } = await writeBroker();
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    const outcome = await applyOwnWrite(db, taskWrite());
    expect(outcome).toEqual({ ok: true, changes: [1], undoId: expect.stringMatching(UUID_V4), undoable: true });
    expect(seatSpy).toHaveBeenCalledTimes(1);
    const input = seatSpy.mock.calls[0]![1] as unknown as Record<string, unknown>;
    expect(input).toMatchObject({ own: [{ sql: "UPDATE entries SET amount = 9 WHERE title = 'tea'", params: [] }], capture: true, expectChanges: [1], requireUndo: true });
    expect((input.caps as { maxChanges: number }).maxChanges).toBe(ACCESS_WRITE_MAX_ROWS);
    expect(typeof input.admit).toBe('function');
    const [entry] = ownJournal().listOwnUndo(journal, { taskId: 'task-1' });
    expect(entry).toMatchObject({ id: (outcome as { undoId: string }).undoId, authority: 'task', via: 'schedule', runId: 'run-1', taskId: 'task-1' });
    expect(entry!.steps).toEqual([{ table: 'entries', op: 'update', columns: ['amount'], rows: [{ rowid: 1, before: [3], after: [9] }] }]);
    expect(JSON.stringify(entry), 'no SQL text in the entry').not.toMatch(/UPDATE|WHERE/);
    expect(ownJournal().listOwnUndo(journal, { bucket: 'approval' })).toEqual([]);
    expect(undoJournal().listAllAccessUndo(journal)).toEqual([]);
    expect(db.listAccessLog(journal), 'authority task appears on no line').toEqual([]);
  });

  it('clears the namespace’s read caches and rings data-changed to its own frame and access-source-changed to every live reader', async () => {
    const { applyOwnWrite } = await writeBroker();
    const theirs = await grantOn(pantry, journal, ['entries'], false);
    const pantryFrame = createAccessHandlerFor(pantry, { attended: true, generation: 0 });
    expect(await pantryFrame.handle(pantry, queryFrame(theirs.id, 'SELECT 1'))).toMatchObject({ ok: true });
    expect(__scopedReadCachedGrantsForTests()).toContain(theirs.id);
    listen(journal, pantry, budget);
    expect(await applyOwnWrite(db, taskWrite())).toMatchObject({ ok: true });
    expect(__scopedReadCachedGrantsForTests()).not.toContain(theirs.id);
    expect(doorbells()).toContainEqual({ appId: journal, event: DATA_CHANGED_EVENT, data: { table: 'entries' } });
    expect(doorbells()).toContainEqual({ appId: pantry, event: ACCESS_SOURCE_CHANGED_EVENT, data: { grantId: theirs.id } });
    expect(doorbells().filter((ring) => ring.appId === budget)).toEqual([]);
  });

  it('room BEFORE the seat: a task bucket holding 20 live entries answers full — the seat never reached, nothing changed', async () => {
    const { applyOwnWrite } = await writeBroker();
    fillOwnBucket('task-1', 20);
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    expect(await applyOwnWrite(db, taskWrite())).toMatchObject({ ok: false, reason: 'full' });
    expect(seatSpy).not.toHaveBeenCalled();
    expect(await rowsOf(journal, "SELECT amount FROM entries WHERE title = 'tea'")).toEqual([[3]]);
    expect(ownJournal().listOwnUndo(journal, { taskId: 'task-1' })).toHaveLength(20);
    // Another task's bucket is its own.
    expect(await applyOwnWrite(db, taskWrite({ bucket: 'task-2', taskId: 'task-2' }))).toMatchObject({ ok: true });
  });

  it('the APPROVAL bucket never refuses: with 20 live entries the oldest gives way and the change is journaled', async () => {
    const { applyOwnWrite } = await writeBroker();
    const planted = fillOwnBucket('approval', 20, 'approval');
    const outcome = await applyOwnWrite(
      db,
      taskWrite({ bucket: 'approval', authority: 'approval', via: 'chat', runId: undefined, taskId: undefined, stillArmed: undefined, requireUndo: false, maxChanges: Number.POSITIVE_INFINITY }),
    );
    expect(outcome).toMatchObject({ ok: true, undoable: true });
    const ids = ownJournal().listOwnUndo(journal, { bucket: 'approval' }).map((entry) => entry.id);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe((outcome as { undoId: string }).undoId);
    expect(ids).not.toContain(planted[0]);
  });

  it('stillArmed false → stopped: the seat never reached, nothing changed, no entry', async () => {
    const { applyOwnWrite } = await writeBroker();
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    expect(await applyOwnWrite(db, taskWrite({ stillArmed: () => false }))).toMatchObject({ ok: false, reason: 'stopped' });
    expect(seatSpy).not.toHaveBeenCalled();
    expect(await rowsOf(journal, "SELECT amount FROM entries WHERE title = 'tea'")).toEqual([[3]]);
    expect(ownJournal().listOwnUndo(journal, { taskId: 'task-1' })).toEqual([]);
  });

  it('stillArmed is evaluated AFTER the last await and immediately before driver.brokeredWrite — every awaited db call comes before it, the seat right after', async () => {
    const { applyOwnWrite } = await writeBroker();
    const awaited = [vi.spyOn(db.driver, 'inTransaction'), vi.spyOn(db.driver, 'handle'), vi.spyOn(db, 'scratchRun'), vi.spyOn(db, 'exportAppRuntime')];
    const stillArmed = vi.fn(() => true);
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    expect(await applyOwnWrite(db, taskWrite({ stillArmed }))).toMatchObject({ ok: true });
    expect(stillArmed).toHaveBeenCalled();
    const armedAt = stillArmed.mock.invocationCallOrder.at(-1)!;
    const seatAt = seatSpy.mock.invocationCallOrder[0]!;
    expect(armedAt).toBeLessThan(seatAt);
    for (const spy of awaited) {
      for (const order of spy.mock.invocationCallOrder) expect(order < armedAt || order > seatAt, 'no awaited db call between the check and the seat').toBe(true);
    }
  });

  it('the app mid-change → busy, and the app’s transaction is left as it was', async () => {
    const { applyOwnWrite } = await writeBroker();
    await exec(journal, 'BEGIN');
    await exec(journal, "UPDATE entries SET amount = 7 WHERE title = 'cake'");
    expect(await applyOwnWrite(db, taskWrite())).toMatchObject({ ok: false, reason: 'busy' });
    expect(await db.driver.inTransaction(journal)).toBe(true);
    await exec(journal, 'ROLLBACK');
    expect(await rowsOf(journal, ENTRIES)).toEqual([
      [1, 'tea', 3],
      [2, 'cake', 5],
      [3, 'bread', 2],
    ]);
  });

  it('a count that moved since the dry run → changed: rolled back, no entry', async () => {
    const { applyOwnWrite } = await writeBroker();
    expect(await applyOwnWrite(db, taskWrite({ statements: ['UPDATE entries SET amount = 0 WHERE amount < 4'], params: [[]], expectChanges: [1] }))).toMatchObject({
      ok: false,
      reason: 'changed',
    });
    expect(await rowsOf(journal, ENTRIES)).toEqual([
      [1, 'tea', 3],
      [2, 'cake', 5],
      [3, 'bread', 2],
    ]);
    expect(ownJournal().listOwnUndo(journal, { taskId: 'task-1' })).toEqual([]);
  });

  it.each([
    ['arithmetic', "UPDATE entries SET amount = amount + 1 WHERE title = 'tea'"],
    ['a function', "UPDATE entries SET title = upper('tea') WHERE id = 1"],
    ['no WHERE', 'UPDATE entries SET amount = 0'],
    ['a conflict clause', "INSERT OR REPLACE INTO entries (id, title, amount) VALUES (1, 'tea', 1)"],
  ])('a task never applies what it cannot undo (%s) → cannot-undo: nothing changed, no entry', async (_label, sql) => {
    const { applyOwnWrite } = await writeBroker();
    expect(await applyOwnWrite(db, taskWrite({ statements: [sql], params: [[]], expectChanges: [1] }))).toMatchObject({ ok: false, reason: 'cannot-undo' });
    expect(await rowsOf(journal, ENTRIES)).toEqual([
      [1, 'tea', 3],
      [2, 'cake', 5],
      [3, 'bread', 2],
    ]);
    expect(ownJournal().listOwnUndo(journal, { taskId: 'task-1' })).toEqual([]);
  });

  it('a task never applies a change to a credential-named column, nor one whose captured cell holds a credential → cannot-undo, rolled back', async () => {
    const { applyOwnWrite } = await writeBroker();
    await db.applyAppDdl(journal, ['CREATE TABLE vault (id INTEGER PRIMARY KEY, label TEXT, api_key TEXT)']);
    await exec(journal, "INSERT INTO vault (id, label, api_key) VALUES (1, 'home', 'kept')");
    expect(await applyOwnWrite(db, taskWrite({ statements: ["UPDATE vault SET api_key = 'x' WHERE id = 1"], params: [[]], expectChanges: [1] }))).toMatchObject({
      ok: false,
      reason: 'cannot-undo',
    });
    const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
    expect(await applyOwnWrite(db, taskWrite({ statements: ['UPDATE vault SET label = ? WHERE id = 1'], params: [[KEY]], expectChanges: [1] }))).toMatchObject({
      ok: false,
      reason: 'cannot-undo',
    });
    expect(await rowsOf(journal, 'SELECT id, label, api_key FROM vault')).toEqual([[1, 'home', 'kept']]);
    expect(ownJournal().listOwnUndo(journal, { taskId: 'task-1' })).toEqual([]);
  });

  it('a step over 200 captured rows is never applied under a task’s authority (admit refuses it) → cannot-undo, rolled back', async () => {
    const { applyOwnWrite } = await writeBroker();
    const values = Array.from({ length: ACCESS_WRITE_MAX_ROWS + 1 }, (_, i) => `('bulk-${i}', 1)`).join(', ');
    await exec(journal, `INSERT INTO entries (title, amount) VALUES ${values}`);
    const outcome = await applyOwnWrite(
      db,
      taskWrite({ statements: ['UPDATE entries SET amount = 0 WHERE amount = 1'], params: [[]], expectChanges: [ACCESS_WRITE_MAX_ROWS + 1], maxChanges: Number.POSITIVE_INFINITY }),
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'cannot-undo' });
    expect(await rowsOf(journal, 'SELECT count(*) FROM entries WHERE amount = 0')).toEqual([[0]]);
  });
});

// =========================================================================================
// PR-4 — undoOwnWrite: the user's undo of an own change (D-PR4-19; AC32b)
// =========================================================================================

describe('PR-4 — undoOwnWrite(db, appId, bucket, undoId, { via: user }) → UndoOutcome', () => {

  // The own journal's liveness is read against the db's WALL clock (an entry is live while its
  // expiresAt is ahead of it); the engine stamps entries with the injected clock (T0). Only `Date`
  // is faked, at T0, so the two agree and no row turns red seven days after it was written.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  async function appliedApproval(sql: string, previewed: number[]): Promise<string> {
    const { applyApprovedWrite } = await writeBroker();
    const outcome = await approve(applyApprovedWrite, { appId: journal, statements: [sql], params: [[]], summary: 'x', previewed }, 'chat');
    const undoId = (outcome as { undoId?: string }).undoId;
    if (undoId === undefined) throw new Error(`expected an undoable approval, got ${JSON.stringify(outcome)}`);
    return undoId;
  }

  it('puts the rows back, marks the entry, writes NO access line, clears the caches and rings data-changed and access-source-changed to every live reader', async () => {
    const { undoOwnWrite } = await writeBroker();
    const theirs = await grantOn(pantry, journal, ['entries'], false);
    const undoId = await appliedApproval('UPDATE entries SET amount = 0 WHERE amount < 4', [2]);
    const pantryFrame = createAccessHandlerFor(pantry, { attended: true, generation: 0 });
    expect(await pantryFrame.handle(pantry, queryFrame(theirs.id, 'SELECT 1'))).toMatchObject({ ok: true });
    listen(journal, pantry);
    expect(await undoOwnWrite(db, journal, 'approval', undoId, { via: 'user' })).toEqual({ ok: true });
    expect(await rowsOf(journal, ENTRIES)).toEqual([
      [1, 'tea', 3],
      [2, 'cake', 5],
      [3, 'bread', 2],
    ]);
    expect(ownJournal().listOwnUndo(journal, { bucket: 'approval' }), 'no live entry is left').toEqual([]);
    // sanctioned by PR-4 v2.2 note c — the lines are exactly the setup's (the grant and the reader's query); the undo adds none.
    expect(linesOf(journal).map((l) => l.kind), 'undone without an access line').toEqual(['read', 'granted']);
    expect(__scopedReadCachedGrantsForTests()).not.toContain(theirs.id);
    expect(doorbells()).toContainEqual({ appId: journal, event: DATA_CHANGED_EVENT, data: { table: 'entries' } });
    expect(doorbells()).toContainEqual({ appId: pantry, event: ACCESS_SOURCE_CHANGED_EVENT, data: { grantId: theirs.id } });
  });

  it('a task bucket’s entry undoes from ITS bucket; the approval bucket does not hold it', async () => {
    const { applyOwnWrite, undoOwnWrite } = await writeBroker();
    const applied = await applyOwnWrite(db, {
      appId: journal,
      bucket: 'task-1',
      statements: ["UPDATE entries SET amount = 9 WHERE title = 'tea'"],
      params: [[]],
      expectChanges: [1],
      maxChanges: ACCESS_WRITE_MAX_ROWS,
      requireUndo: true,
      authority: 'task',
      via: 'schedule',
      runId: 'run-1',
      taskId: 'task-1',
      stillArmed: () => true,
    });
    const undoId = (applied as { undoId: string }).undoId;
    expect(await undoOwnWrite(db, journal, 'approval', undoId, { via: 'user' })).toMatchObject({ ok: false, reason: 'gone' });
    expect(await undoOwnWrite(db, journal, 'task-1', undoId, { via: 'user' })).toEqual({ ok: true });
    expect(await rowsOf(journal, "SELECT amount FROM entries WHERE title = 'tea'")).toEqual([[3]]);
  });

  it('an unknown or already-undone id is gone — the sheet’s sentence; nothing changes', async () => {
    const { undoOwnWrite } = await writeBroker();
    expect(await undoOwnWrite(db, journal, 'approval', crypto.randomUUID(), { via: 'user' })).toEqual({ ok: false, reason: 'gone', message: undoFailed('gone', 'Journal') });
    const undoId = await appliedApproval("UPDATE entries SET amount = 0 WHERE title = 'tea'", [1]);
    expect(await undoOwnWrite(db, journal, 'approval', undoId, { via: 'user' })).toEqual({ ok: true });
    await exec(journal, "UPDATE entries SET amount = 0 WHERE title = 'tea'");
    expect(await undoOwnWrite(db, journal, 'approval', undoId, { via: 'user' })).toMatchObject({ ok: false, reason: 'gone' });
    expect(await rowsOf(journal, "SELECT amount FROM entries WHERE title = 'tea'")).toEqual([[0]]);
  });

  it('LIVE re-validation: a step naming a column the app no longer has, or a computed one, is gone before the seat — and the entry stops being live', async () => {
    const { undoOwnWrite } = await writeBroker();
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    for (const step of [
      { table: 'entries', op: 'update', columns: ['nope'], rows: [{ rowid: 1, before: [3], after: [0] }] },
      { table: 'ghost', op: 'update', columns: ['amount'], rows: [{ rowid: 1, before: [3], after: [0] }] },
      { table: 'sums', op: 'update', columns: ['doubled'], rows: [{ rowid: 1, before: [2], after: [4] }] },
    ]) {
      const id = crypto.randomUUID();
      expect(ownJournal().putOwnUndo(journal, 'approval', { id, at: iso(clock.now), expiresAt: iso(clock.now + 7 * DAY), authority: 'approval', via: 'chat', steps: [step] } as never)).toBe('ok');
      expect(await undoOwnWrite(db, journal, 'approval', id, { via: 'user' }), step.table).toEqual({ ok: false, reason: 'gone', message: undoFailed('gone', 'Journal') });
      expect(ownJournal().listOwnUndo(journal, { bucket: 'approval' }).map((entry) => entry.id)).not.toContain(id);
    }
    expect(seatSpy, 'refused before the seat').not.toHaveBeenCalled();
  });

  it('a planted step naming a credential-named column is refused (the seat’s SEC-4 rule): gone, nothing written', async () => {
    const { undoOwnWrite } = await writeBroker();
    await db.applyAppDdl(journal, ['CREATE TABLE vault (id INTEGER PRIMARY KEY, label TEXT, api_key TEXT)']);
    await exec(journal, "INSERT INTO vault (id, label, api_key) VALUES (1, 'home', 'kept')");
    const id = crypto.randomUUID();
    const step = { table: 'vault', op: 'update', columns: ['label', 'api_key'], rows: [{ rowid: 1, before: ['home', 'planted'], after: ['home', 'kept'] }] };
    expect(ownJournal().putOwnUndo(journal, 'approval', { id, at: iso(clock.now), expiresAt: iso(clock.now + 7 * DAY), authority: 'approval', via: 'chat', steps: [step] } as never)).toBe('ok');
    expect(await undoOwnWrite(db, journal, 'approval', id, { via: 'user' })).toEqual({ ok: false, reason: 'gone', message: undoFailed('gone', 'Journal') });
    expect(await rowsOf(journal, 'SELECT id, label, api_key FROM vault')).toEqual([[1, 'home', 'kept']]);
  });

  it('a row changed since → changed: the WHOLE undo rolls back; busy under the app’s BEGIN — the entry still live', async () => {
    const { undoOwnWrite } = await writeBroker();
    const undoId = await appliedApproval('UPDATE entries SET amount = 0 WHERE amount < 4', [2]);
    await exec(journal, "UPDATE entries SET amount = 7 WHERE title = 'bread'");
    expect(await undoOwnWrite(db, journal, 'approval', undoId, { via: 'user' })).toEqual({ ok: false, reason: 'changed', message: undoFailed('changed', 'Journal') });
    expect(await rowsOf(journal, ENTRIES)).toEqual([
      [1, 'tea', 0],
      [2, 'cake', 5],
      [3, 'bread', 7],
    ]);
    const second = await appliedApproval("UPDATE entries SET amount = 1 WHERE title = 'cake'", [1]);
    await exec(journal, 'BEGIN');
    try {
      expect(await undoOwnWrite(db, journal, 'approval', second, { via: 'user' })).toEqual({ ok: false, reason: 'busy', message: undoFailed('busy', 'Journal') });
      expect(ownJournal().listOwnUndo(journal, { bucket: 'approval' }).map((entry) => entry.id)).toContain(second);
    } finally {
      await exec(journal, 'ROLLBACK');
    }
  });
});

// =========================================================================================
// PR-4 Gate-5 — A1 (the bucket rule FIRST in the seat) and A5 (nothing after the commit turns it
// into a refusal), on the own-write engine and the own undo.
// =========================================================================================

describe('PR-4 Gate-5 A1 — an entry that does not belong in its bucket never reaches the seat', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const write = (over: Record<string, unknown>) =>
    ({
      appId: journal,
      statements: ["UPDATE entries SET amount = 9 WHERE title = 'tea'"],
      params: [[]],
      expectChanges: [1],
      maxChanges: ACCESS_WRITE_MAX_ROWS,
      via: 'schedule',
      runId: 'run-1',
      stillArmed: () => true,
      ...over,
    }) as unknown as Parameters<WriteBrokerModule['applyOwnWrite']>[1];

  it('a TASK’s write into the approval bucket (a task whose id spells it) → cannot-undo under requireUndo: the seat never reached, the row unchanged, the approval bucket empty', async () => {
    const { applyOwnWrite } = await writeBroker();
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    const outcome = await applyOwnWrite(db, write({ bucket: 'approval', authority: 'task', taskId: 'approval', requireUndo: true }));
    expect(outcome).toMatchObject({ ok: false, reason: 'cannot-undo' });
    expect(seatSpy).not.toHaveBeenCalled();
    expect(await rowsOf(journal, "SELECT amount FROM entries WHERE title = 'tea'")).toEqual([[3]]);
    expect(ownJournal().listOwnUndo(journal, { bucket: 'approval' })).toEqual([]);
  });

  it('… and without requireUndo the same mismatch is failed — never a bare write that lands unjournaled', async () => {
    const { applyOwnWrite } = await writeBroker();
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    const outcome = await applyOwnWrite(db, write({ bucket: 'approval', authority: 'task', taskId: 'approval', requireUndo: false }));
    expect(outcome).toMatchObject({ ok: false, reason: 'failed' });
    expect(seatSpy).not.toHaveBeenCalled();
    expect(await rowsOf(journal, "SELECT amount FROM entries WHERE title = 'tea'")).toEqual([[3]]);
  });

  it.each([
    ['a task entry naming ANOTHER task’s bucket', { bucket: 'task-2', authority: 'task', taskId: 'task-1', requireUndo: true }],
    ['a task entry with no taskId', { bucket: 'task-1', authority: 'task', taskId: undefined, requireUndo: true }],
    ['an approval entry in a task bucket', { bucket: 'task-1', authority: 'approval', via: 'chat', runId: undefined, taskId: undefined, requireUndo: true }],
    ['an approval entry carrying a taskId', { bucket: 'approval', authority: 'approval', via: 'chat', taskId: 'task-1', requireUndo: true }],
  ])('%s → refused before any seat, nothing changed', async (_label, over) => {
    const { applyOwnWrite } = await writeBroker();
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    const outcome = await applyOwnWrite(db, write(over));
    expect(outcome.ok).toBe(false);
    expect(seatSpy).not.toHaveBeenCalled();
    expect(await rowsOf(journal, "SELECT amount FROM entries WHERE title = 'tea'")).toEqual([[3]]);
  });

  it('the passing twins: a task in its OWN bucket, and the user’s approval in the approval bucket, are both journaled', async () => {
    const { applyOwnWrite } = await writeBroker();
    expect(await applyOwnWrite(db, write({ bucket: 'task-1', authority: 'task', taskId: 'task-1', requireUndo: true }))).toMatchObject({ ok: true, undoable: true });
    expect(
      await applyOwnWrite(
        db,
        write({ bucket: 'approval', authority: 'approval', via: 'chat', runId: undefined, taskId: undefined, stillArmed: undefined, requireUndo: false, maxChanges: Number.POSITIVE_INFINITY, statements: ["UPDATE entries SET amount = 1 WHERE title = 'cake'"] }),
      ),
    ).toMatchObject({ ok: true, undoable: true });
    expect(ownJournal().listOwnUndo(journal, { taskId: 'task-1' })).toHaveLength(1);
    expect(ownJournal().listOwnUndo(journal, { bucket: 'approval' })).toHaveLength(1);
  });
});

describe('PR-4 Gate-5 A5 — once the seat answered ok, nothing after the commit turns the outcome into a refusal', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** How many grants reads threw — each row asserts the fault was really injected after the commit (never vacuous). */
  let thrown = 0;
  /** From the moment `armed()` says so, every grants read throws — the doorbells' and the caches' read. */
  function grantsThrowAfter(armed: () => boolean): void {
    thrown = 0;
    const listGrants = db.listAccessGrants.bind(db);
    vi.spyOn(db, 'listAccessGrants').mockImplementation(((...args: Parameters<UserDb['listAccessGrants']>) => {
      if (armed()) {
        thrown += 1;
        throw new Error('a grant row that will not parse');
      }
      return listGrants(...args);
    }) as UserDb['listAccessGrants']);
  }

  it('applyOwnWrite: a doorbell that throws after the entry is put → still {ok:true, undoId}; the entry is in its bucket; the change stands', async () => {
    const { applyOwnWrite } = await writeBroker();
    const journalPut = ownJournal().putOwnUndo.bind(db);
    let put = false;
    vi.spyOn(db as unknown as OwnJournal, 'putOwnUndo').mockImplementation(((...args: Parameters<OwnJournal['putOwnUndo']>) => {
      const answer = journalPut(...args);
      put = true;
      return answer;
    }) as OwnJournal['putOwnUndo']);
    grantsThrowAfter(() => put);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outcome = await applyOwnWrite(db, {
      appId: journal,
      bucket: 'task-1',
      statements: ["UPDATE entries SET amount = 9 WHERE title = 'tea'"],
      params: [[]],
      expectChanges: [1],
      maxChanges: ACCESS_WRITE_MAX_ROWS,
      requireUndo: true,
      authority: 'task',
      via: 'schedule',
      runId: 'run-1',
      taskId: 'task-1',
      stillArmed: () => true,
    });
    expect(put).toBe(true);
    expect(thrown, 'the fault landed after the commit').toBeGreaterThan(0);
    expect(outcome).toEqual({ ok: true, changes: [1], undoId: expect.stringMatching(UUID_V4), undoable: true });
    expect(ownJournal().listOwnUndo(journal, { taskId: 'task-1' }).map((entry) => entry.id)).toEqual([(outcome as { undoId: string }).undoId]);
    expect(await rowsOf(journal, "SELECT amount FROM entries WHERE title = 'tea'")).toEqual([[9]]);
    warn.mockRestore();
  });

  it('applyOwnWrite: a throwing onCommitted (the caller’s record) never turns the made change into a refusal', async () => {
    const { applyOwnWrite } = await writeBroker();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outcome = await applyOwnWrite(db, {
      appId: journal,
      bucket: 'task-1',
      statements: ["UPDATE entries SET amount = 9 WHERE title = 'tea'"],
      params: [[]],
      expectChanges: [1],
      maxChanges: ACCESS_WRITE_MAX_ROWS,
      requireUndo: true,
      authority: 'task',
      via: 'schedule',
      runId: 'run-1',
      taskId: 'task-1',
      stillArmed: () => true,
      onCommitted: () => {
        throw new Error('the claim row was refused');
      },
    } as Parameters<WriteBrokerModule['applyOwnWrite']>[1]);
    expect(outcome).toMatchObject({ ok: true, undoable: true });
    warn.mockRestore();
  });

  it('the approval: a doorbell that throws after the commit → still applied with its undo (never "nothing was changed")', async () => {
    const { applyApprovedWrite } = await writeBroker();
    const journalPut = ownJournal().putOwnUndo.bind(db);
    let put = false;
    vi.spyOn(db as unknown as OwnJournal, 'putOwnUndo').mockImplementation(((...args: Parameters<OwnJournal['putOwnUndo']>) => {
      const answer = journalPut(...args);
      put = true;
      return answer;
    }) as OwnJournal['putOwnUndo']);
    grantsThrowAfter(() => put);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outcome = await approve(applyApprovedWrite, { appId: journal, statements: ["UPDATE entries SET amount = 0 WHERE title = 'tea'"], params: [[]], summary: 'x', previewed: [1] }, 'chat');
    expect(thrown, 'the fault landed after the commit').toBeGreaterThan(0);
    expect(outcome).toMatchObject({ ok: true, executed: [1], undoable: true });
    expect(await rowsOf(journal, "SELECT amount FROM entries WHERE title = 'tea'")).toEqual([[0]]);
    warn.mockRestore();
  });

  it('undoOwnWrite: a retire() that throws after the undo landed → still {ok:true}; the rows are back', async () => {
    const { applyApprovedWrite, undoOwnWrite } = await writeBroker();
    const applied = await approve(applyApprovedWrite, { appId: journal, statements: ["UPDATE entries SET amount = 0 WHERE title = 'tea'"], params: [[]], summary: 'x', previewed: [1] }, 'chat');
    const undoId = (applied as { undoId?: string }).undoId!;
    const retire = vi.spyOn(db as unknown as OwnJournal, 'markOwnUndone').mockImplementation(() => {
      throw new Error('the journal row could not be written');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await undoOwnWrite(db, journal, 'approval', undoId, { via: 'user' })).toEqual({ ok: true });
    expect(retire, 'the fault landed after the undo').toHaveBeenCalled();
    expect(await rowsOf(journal, "SELECT amount FROM entries WHERE title = 'tea'")).toEqual([[3]]);
    warn.mockRestore();
  });

  it('undoOwnWrite: a doorbell that throws after the undo landed → still {ok:true}', async () => {
    const { applyApprovedWrite, undoOwnWrite } = await writeBroker();
    const applied = await approve(applyApprovedWrite, { appId: journal, statements: ["UPDATE entries SET amount = 0 WHERE title = 'tea'"], params: [[]], summary: 'x', previewed: [1] }, 'chat');
    const undoId = (applied as { undoId?: string }).undoId!;
    const markUndone = ownJournal().markOwnUndone.bind(db);
    let retired = false;
    vi.spyOn(db as unknown as OwnJournal, 'markOwnUndone').mockImplementation(((...args: Parameters<OwnJournal['markOwnUndone']>) => {
      markUndone(...args);
      retired = true;
    }) as OwnJournal['markOwnUndone']);
    grantsThrowAfter(() => retired);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await undoOwnWrite(db, journal, 'approval', undoId, { via: 'user' })).toEqual({ ok: true });
    expect(thrown, 'the fault landed after the undo').toBeGreaterThan(0);
    expect(await rowsOf(journal, "SELECT amount FROM entries WHERE title = 'tea'")).toEqual([[3]]);
    warn.mockRestore();
  });
});

// =========================================================================================
// TASK-20261010-host-broker PR-5 (contract v2 D-PR5-12; F5): ONE strict core under the frame's
// `write` and the chat's two verbs
// =========================================================================================
//
// `brokeredWriteCore(db, req, { mode: 'plan' | 'apply', expectChanges? })` is extracted from
// `brokeredWrite`: it answers `{ ok, phase: 'plan', changes, table }` (the plan alone — the seat is
// never reached), `{ ok, phase: 'applied', changes, undoable: true, undoId }`, or `{ ok: false,
// reason, rule? }` — its refusal effects (suspend on drift, timeout strikes, expiry marks) performed
// INSIDE. The frame's `write` op maps it through today's `refusePlan` / `refuseApply`, so its wire
// bytes are UNCHANGED for every refusal: the guard rows below pin today's bytes and stay green across
// the extraction; the core's rows are red until it is exported.

type CoreAnswer =
  | { ok: true; phase: 'plan'; changes: number; table: string }
  | { ok: true; phase: 'applied'; changes: number; undoable: true; undoId: string }
  | { ok: false; reason: string; rule?: string };
type CoreFn = (db: UserDb, req: Record<string, unknown>, options: { mode: 'plan' | 'apply'; expectChanges?: number }) => Promise<CoreAnswer>;

describe('PR-5 D-PR5-12 — brokeredWriteCore: the plan phase, the applied phase, the refusals with their effects performed inside', () => {
  const chatCaller = () => ({ kind: 'chat' as const, appId: budget, threadId: 'thread-1' });
  async function core(): Promise<CoreFn> {
    const mod = (await writeBroker()) as unknown as { brokeredWriteCore?: CoreFn };
    if (typeof mod.brokeredWriteCore !== 'function') throw new Error('access/writeBroker.ts exports no brokeredWriteCore yet (D-PR5-12)');
    return mod.brokeredWriteCore;
  }
  /** The request the chat's verbs hand the core: the found grant, the source, the table, the source-named statement, the approval's authority, the chat's door. */
  async function requestFor(grantId: string, sql: string, table = 'entries'): Promise<Record<string, unknown>> {
    const { findAccessGrant } = await import('../access/grants.js');
    const found = findAccessGrant(db, grantId);
    if (found === undefined) throw new Error('no such grant');
    return { targetAppId: journal, statement: { sql }, table, authority: 'approval', via: 'chat', grant: found, caller: chatCaller() };
  }

  it("mode 'plan' answers { ok, phase: plan, changes, table } — the plan ran in the Worker; the seat, the journal and the history never touched", async () => {
    const brokeredWriteCore = await core();
    const mine = await grantOn(budget, journal, ['entries'], true);
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    const answer = await brokeredWriteCore(db, await requestFor(mine.id, "UPDATE entries SET amount = 0 WHERE amount < 5"), { mode: 'plan' });
    expect(answer).toEqual({ ok: true, phase: 'plan', changes: 2, table: 'entries' });
    expect(posted.map(kindOf)).toEqual(['plan-write']);
    expect(seatSpy).not.toHaveBeenCalled();
    expect(undoJournal().listAllAccessUndo(journal)).toEqual([]);
    expect(linesOf(journal).map((entry) => entry.kind)).toEqual(['granted']);
    expect(await rowsOf(journal, ENTRIES)).toEqual([
      [1, 'tea', 3],
      [2, 'cake', 5],
      [3, 'bread', 2],
    ]);
  });

  it("mode 'apply' with the expected count answers { ok, phase: applied, changes, undoable: true, undoId } — the wrote line names that undo", async () => {
    const brokeredWriteCore = await core();
    const mine = await grantOn(budget, journal, ['entries'], true);
    const answer = await brokeredWriteCore(db, await requestFor(mine.id, "UPDATE entries SET amount = 0 WHERE amount < 5"), { mode: 'apply', expectChanges: 2 });
    expect(answer).toMatchObject({ ok: true, phase: 'applied', changes: 2, undoable: true });
    const undoId = (answer as { undoId?: string }).undoId;
    expect(undoId).toMatch(UUID_V4);
    expect(linesOf(journal).find((entry) => entry.kind === 'wrote')).toMatchObject({ undoId, via: 'chat', authority: 'approval', changes: 2 });
  });

  it("mode 'apply' whose fresh plan is not the expected count answers drifted BEFORE the room check and the seat", async () => {
    const brokeredWriteCore = await core();
    const mine = await grantOn(budget, journal, ['entries'], true);
    const seatSpy = vi.spyOn(seat(), 'brokeredWrite');
    const room = vi.spyOn(undoJournal(), 'listAccessUndo');
    expect(await brokeredWriteCore(db, await requestFor(mine.id, "UPDATE entries SET amount = 0 WHERE amount < 5"), { mode: 'apply', expectChanges: 1 })).toMatchObject({ ok: false, reason: 'drifted' });
    expect(seatSpy).not.toHaveBeenCalled();
    expect(room).not.toHaveBeenCalled();
  });

  it('a strict-rule refusal carries its rule: no WHERE → { ok: false, reason: refused, rule: no-where }', async () => {
    const brokeredWriteCore = await core();
    const mine = await grantOn(budget, journal, ['entries'], true);
    expect(await brokeredWriteCore(db, await requestFor(mine.id, 'UPDATE entries SET amount = 0'), { mode: 'plan' })).toMatchObject({ ok: false, reason: 'refused', rule: 'no-where' });
  });

  it('the target mid-change is busy — asked before any plan job', async () => {
    const brokeredWriteCore = await core();
    const mine = await grantOn(budget, journal, ['entries'], true);
    const request = await requestFor(mine.id, "UPDATE entries SET amount = 0 WHERE title = 'tea'");
    await exec(journal, 'BEGIN');
    try {
      expect(await brokeredWriteCore(db, request, { mode: 'plan' })).toMatchObject({ ok: false, reason: 'busy' });
      expect(posted.map(kindOf)).toEqual([]);
    } finally {
      await exec(journal, 'ROLLBACK');
    }
  });

  it('the expiry is MARKED inside the core (its effect performed there): an expired grant answers expired and the source’s history gains ONE expired line', async () => {
    const brokeredWriteCore = await core();
    const mine = await grantOn(budget, journal, ['entries'], true);
    const request = await requestFor(mine.id, "UPDATE entries SET amount = 0 WHERE title = 'tea'");
    clock.now += 2 * DAY;
    expect(await brokeredWriteCore(db, request, { mode: 'plan' })).toMatchObject({ ok: false, reason: 'expired' });
    expect(linesOf(journal).filter((entry) => entry.kind === 'expired')).toHaveLength(1);
  });
});

describe('PR-5 D-PR5-12 — the frame’s write op: wire bytes UNCHANGED for every refusal across the core’s extraction (guards — green today, green after)', () => {
  const write = async (grantId: string, sql: string): Promise<AccessHandlerResult> => createAccessHandlerFor(budget, { attended: true, generation: 0 }).handle(budget, writeFrame(grantId, sql));

  it('busy — the target’s open transaction: ACCESS_BUSY, retryable, the busy sentence', async () => {
    const mine = await grantOn(budget, journal, ['entries'], true);
    await exec(journal, 'BEGIN');
    try {
      expect(await write(mine.id, "UPDATE entries SET amount = 9 WHERE title = 'tea'")).toEqual(refusal('ACCESS_BUSY', ACCESS_APP_MESSAGES.busy, true));
    } finally {
      await exec(journal, 'ROLLBACK');
    }
  });

  it.each([
    ['no-where', 'UPDATE entries SET amount = 9'],
    ['statement', 'SELECT * FROM entries'],
    ['value', "UPDATE entries SET title = 'sk-Ab3dEf9hIjKl2MnOpQr5StUvWxYz01234567aBcD' WHERE id = 1"],
  ] as const)('%s — ACCESS_WRITE_REFUSED with the rule’s sentence, not retryable', async (rule, sql) => {
    const mine = await grantOn(budget, journal, ['entries'], true);
    expect(await write(mine.id, sql)).toEqual(refusal('ACCESS_WRITE_REFUSED', ACCESS_APP_MESSAGES.writeRefused(rule), false));
  });

  it(`too-many — over ${ACCESS_WRITE_MAX_ROWS} rows: ACCESS_WRITE_REFUSED with the too-many sentence`, async () => {
    await exec(journal, `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${ACCESS_WRITE_MAX_ROWS + 5}) INSERT INTO entries (title, amount) SELECT 'row', x FROM n`);
    const mine = await grantOn(budget, journal, ['entries'], true);
    expect(await write(mine.id, "UPDATE entries SET amount = 0 WHERE title = 'row'")).toEqual(refusal('ACCESS_WRITE_REFUSED', ACCESS_APP_MESSAGES.writeRefused('too-many'), false));
  });

  it('a table the grant only lets the reader READ — ACCESS_NOT_GRANTED with the read-only sentence', async () => {
    const mine = await grantOn(budget, journal, ['entries'], false);
    expect(await write(mine.id, "UPDATE entries SET amount = 9 WHERE title = 'tea'")).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.writeNotGranted, false));
  });

  it('an expired grant — ACCESS_EXPIRED', async () => {
    const mine = await grantOn(budget, journal, ['entries'], true);
    clock.now += 2 * DAY;
    expect(await write(mine.id, "UPDATE entries SET amount = 9 WHERE title = 'tea'")).toEqual(refusal('ACCESS_EXPIRED', ACCESS_APP_MESSAGES.expired, false));
  });

  it('no worker — ACCESS_QUERY_FAILED with the no-worker sentence', async () => {
    const mine = await grantOn(budget, journal, ['entries'], true);
    vi.stubGlobal('Worker', undefined);
    configureScopedRead({ createWorker: undefined, wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    try {
      expect(await write(mine.id, "UPDATE entries SET amount = 9 WHERE title = 'tea'")).toEqual(refusal('ACCESS_QUERY_FAILED', ACCESS_APP_MESSAGES.noWorker, false));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the success answer is still ONLY { ok, op: write, changes } — never the undo id (DS16)', async () => {
    const mine = await grantOn(budget, journal, ['entries'], true);
    expect(await write(mine.id, "UPDATE entries SET amount = 9 WHERE title = 'tea'")).toEqual({ ok: true, op: 'write', changes: 1 });
  });
});
