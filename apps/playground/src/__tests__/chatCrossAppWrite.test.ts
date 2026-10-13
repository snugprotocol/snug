// chatCrossAppWrite.test.ts — TASK-20261010-host-broker PR-5, lane T-C (AC39a; contract v2
// D-PR5-11 the tool's chat path · D-PR5-12 the chat's write verbs outside the kit graph ·
// D-PR5-13 the DDL mark the tool reads; ADR-0076).
//
// THREE ALTITUDES, each where its rule is decided:
//
//  A. THE TOOL'S ORDER (`agent/dataTools.ts`, `data_propose_write` on the chat, not scheduled) over a
//     FAKE seat — `set` (hand-built `MaterialisedTable`s, `write: true` on the writable one),
//     `recordRead` and `planWrite` spies — so every refusal is seen by name and every "nothing
//     recorded, nothing planned, nothing staged" is a spy that was never called:
//       (1) the SCHEDULED variant's shared-name refusal stays first (D-PR4-2);
//       (2) WRITABLE-FIRST — a batch on a READ-ONLY grant answers today's `CHAT_DOOR.readOnly(source)`
//           byte-identical (every AC11 pin unchanged); then > 1 statement → `oneChange`; `params` →
//           `valuesIn`; the DML target must be the ONE alias named (`INSERT … SELECT`, a second shared
//           name → `readOnly`); a read-only table of a write grant → `readOnlyTable(source, table)`;
//           `<alias>__snug_kv` never writable;
//       (3) `accessSqlSchema` + no `\p{Cf}` on the RAW statement → `unsafeText`, nothing recorded
//           (a bidi isolate at character 250, inside a literal — past the log's 200-character cut);
//       (4) `renameDmlTarget` — every refusal → `plainChange(source)`, nothing recorded;
//       (5) `inTransaction(source)` → `busy(source)`;
//       (6) the counting line: `recordRead([grantId], renamed, { counting: true })` BEFORE the plan;
//       (7) `planWrite(grantId, renamed)` — its refusal in `ACCESS_APP_MESSAGES` words; 0 rows →
//           `noRows(source)`; too large to undo → refused here, no card;
//       (8) ONE card through `onAccessWriteProposal(card)` (`false` → NOT staged);
//       (9) the brain hears the ALIAS statement it wrote and *Proposed — it would change N rows in
//           <Source>; it waits for the user’s OK on the card*.
//  B. THE SAME TOOL OVER THE REAL ENGINE — the real grant, `accessService().materialise`, the real
//     `recordRead` (the counting line: `tables` = the one table, `attended`, NO `sql`, NO `rows`) and
//     the real `planChatWrite` (`access/chatWrite.ts`), which never reaches `driver.brokeredWrite`.
//  C. `writeChatApproved` — ONE case per row of D-PR5-12's why table, over the real user db and the
//     INLINE worker (the real responder): busy · drifted (before the seat AND at it) · ended
//     (revoked, expired, paused, and a renewal in place — the id kept, `grantedAt` moved) ·
//     not-allowed · refused (no WHERE, a credential-shaped value, a plan with nothing to undo) ·
//     waiting · gone (source or table mismatch) · failed (no worker); ok ⇒ `undoable: true` + `undoId`.
//
// `access/chatWrite.ts` does not exist at Gate 3: it is reached through a VARIABLE specifier
// (`import(/* @vite-ignore */ spec)`) so this file transforms and its guard rows run green — a
// literal dynamic import of a missing module fails the whole file at transform time (lesson
// 2026-10-11). Section A's guards (rows that pin what the chat door already says) are green today;
// every other row is red for a contract reason: a missing module, export, seat or behaviour.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { ACCESS_SQL_MAX_CHARS, FRAME_TYPES, PROTOCOL_VERSION, type AccessUndoEntry, type AccessUndoStep } from '@snugprotocol/protocol';

import { NO_ACCESS_ASKS_KEY, collectSources } from '../access/consent.js';
import { ACCESS_APP_MESSAGES, CHAT_DOOR, rowsWord } from '../access/copy.js';
import {
  __setAccessDepsForTests,
  createGrantFromDecision,
  findAccessGrant,
  noteReaderGeneration,
  resetAccessSession,
  revokeAccess,
  suspendAccess,
  type AnyAccessGrant,
  type CreateGrantInput,
} from '../access/grants.js';
import type { AccessCaller } from '../access/policy.js';
import { configureScopedRead, resetScopedReadForTests, type WorkerLike } from '../access/scopedRead.js';
import { createScopedReadResponder } from '../access/scopedRead.worker.js';
import { accessService, type MaterialisedSet, type MaterialisedTable } from '../access/service.js';
import { DATA_PROPOSE_WRITE_TOOL_NAME, buildDataTools, type PendingWriteProposal } from '../agent/dataTools.js';
import { installTestUserDb, locateWasm } from './userdbTestHelper.js';

// =========================================================================================
// The contract's shapes (D-PR5-10/11/12) — local until the modules export them
// =========================================================================================

/** D-PR5-12's why table, by its words. */
type AccessWriteFailedWhy = 'busy' | 'drifted' | 'ended' | 'not-allowed' | 'refused' | 'waiting' | 'gone' | 'failed';

/** D-PR5-10 `AccessWriteCardState` — what `onAccessWriteProposal` is handed at staging. */
interface StagedAccessWrite {
  appId: string;
  target: { grantId: string; grantedAt: string; sourceAppId: string; table: string };
  sql: string;
  summary?: string;
  previewed: number;
}

/** A frame-shaped refusal (`AccessHandlerResult`'s failure) — what `planChatWrite` answers when it refuses. */
type WireRefusal = { ok: false; code: string; message: string; retryable: boolean };
/** G5-16 (ii-7, SB-8): the plan answers the `grantedAt` of the access it planned under — staging binds the card to it. */
type PlanAnswer = { ok: true; changes: number; table: string; grantedAt?: string } | WireRefusal;

/** The seat as D-PR5-11 widens it: `recordRead(grantIds, sql, opts?)` and `planWrite(grantId, sql)`. */
interface WritableSeat {
  set: MaterialisedSet;
  recordRead(grantIds: readonly string[], sql: string, opts?: { counting?: true }): Promise<{ recorded: string[]; refused: Array<{ grantId: string; sourceAppId: string; sourceName: string; reason: string }> }>;
  planWrite(grantId: string, sql: string): Promise<PlanAnswer>;
}

type WriteChatApprovedInput = { grantId: string; grantedAt: string; sourceAppId: string; table: string; sql: string; expectChanges: number };
type WriteChatApprovedOutcome = ({ ok: true; executed: number[]; undoable: boolean; undoId?: string } | { ok: false; reason: string; [seat: string]: unknown }) & { why?: AccessWriteFailedWhy };

interface ChatWriteModule {
  planChatWrite(db: UserDb, caller: AccessCaller, input: { grantId: string; sql: string }): Promise<PlanAnswer>;
  writeChatApproved(db: UserDb, caller: AccessCaller, input: WriteChatApprovedInput): Promise<WriteChatApprovedOutcome>;
}

/** `access/chatWrite.ts` behind a VARIABLE specifier — the module is NEW (D-PR5-12). */
const CHAT_WRITE_MODULE = '../access/chatWrite.js';
const chatWrite = (): Promise<ChatWriteModule> => import(/* @vite-ignore */ CHAT_WRITE_MODULE) as Promise<ChatWriteModule>;

/** The CHAT_DOOR keys D-PR5-11 adds — read through a widened view so a missing key is `undefined` (a red row), never a tsc break. */
interface ChatDoorPr5 {
  oneChange: string;
  valuesIn: string;
  readOnlyTable: (sourceName: string, table: string) => string;
  unsafeText: string;
  plainChange: (sourceName: string) => string;
  busy: (sourceName: string) => string;
  noRows: (sourceName: string) => string;
}
const DOOR = CHAT_DOOR as unknown as typeof CHAT_DOOR & ChatDoorPr5;

/** A word the contract has not got yet must never make a row pass by matching `undefined`. */
const said = (text: string | undefined): string => {
  if (typeof text !== 'string' || text === '') throw new Error('the contract’s sentence is not in access/copy.ts yet');
  return text;
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// =========================================================================================
// The world — Budget (the reader, its own `envelopes`) and Ledger (the source)
// =========================================================================================

const T0 = Date.parse('2026-10-12T09:00:00.000Z');
const DAY = 86_400_000;
const iso = (at: number): string => new Date(at).toISOString();

let db: UserDb;
let budget: string;
let ledger: string;
let pantry: string;
let clock: { now: number };
let seq = 0;
let posted: unknown[];
let gates: Map<string, Promise<void>>;

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

/** A grant through THE writer behind the user's allow; `write` names the tables the user let Budget change. */
async function grantOn(tables: string[], write: readonly string[], over: { source?: string; duration?: 'day' | 'week' | 'always' } = {}): Promise<AnyAccessGrant> {
  const source = over.source ?? ledger;
  const ranked = await collectSources(db, budget);
  const offered = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === source);
  if (offered === undefined) throw new Error('no such candidate');
  const input = {
    readerAppId: budget,
    source: offered,
    tables: tables.map((name) => ({ name, withheld: [], write: write.includes(name) })),
    duration: over.duration ?? 'day',
    unattended: false,
    purpose: 'to tidy my spending',
    provenance: 'chat',
    now: clock.now,
  };
  return createGrantFromDecision(db, input as unknown as CreateGrantInput);
}

/** The chat caller as the door builds it — Budget's view closed (a persisted grant needs no generation). */
const chat = (): AccessCaller => ({ kind: 'chat', appId: budget, threadId: 'thread-1' });

const linesOf = (appId: string): Array<Record<string, unknown>> => db.listAccessLog(appId) as unknown as Array<Record<string, unknown>>;
const kindsOf = (appId: string): string[] => linesOf(appId).map((line) => String(line.kind));

const LEDGER_ROWS = 'SELECT id, amount, category FROM transactions ORDER BY id';
const SEEDED = [
  [1, 1200, 'food'],
  [2, 800, 'food'],
  [3, 5000, 'rent'],
];

beforeEach(async () => {
  resetAccessSession();
  resetScopedReadForTests();
  localStorage.removeItem(NO_ACCESS_ASKS_KEY);
  // The access journal's liveness is read against the db's wall clock; the engine stamps on the injected one.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  clock = { now: T0 };
  posted = [];
  gates = new Map();
  db = await installTestUserDb();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => clock.now });
  budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>', usesDb: true }).appId;
  ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>', usesDb: true }).appId;
  pantry = db.installApp({ displayName: 'Pantry', html: '<!doctype html><title>p</title>', usesDb: true }).appId;
  await db.applyAppDdl(budget, ['CREATE TABLE envelopes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL)']);
  await exec(budget, "INSERT INTO envelopes (id, name, category) VALUES (1, 'Groceries', 'food')");
  await db.applyAppDdl(ledger, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, category TEXT)', 'CREATE TABLE accounts (name TEXT, balance INTEGER)']);
  await exec(ledger, "INSERT INTO transactions (id, amount, category) VALUES (1, 1200, 'food'), (2, 800, 'food'), (3, 5000, 'rent')");
  await exec(ledger, "INSERT INTO accounts VALUES ('main', 9000)");
  await db.applyAppDdl(pantry, ['CREATE TABLE items (name TEXT, qty INTEGER)']);
  await exec(pantry, "INSERT INTO items VALUES ('rice', 2)");
  configureScopedRead({ createWorker: gatedWorkers(), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
});

afterEach(() => {
  resetAccessSession();
  resetScopedReadForTests();
  __setAccessDepsForTests();
  localStorage.removeItem(NO_ACCESS_ASKS_KEY);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// =========================================================================================
// A. The tool's order, over a fake seat
// =========================================================================================

const G_LEDGER = '11111111-1111-4111-8111-111111111111';
const G_PANTRY = '22222222-2222-4222-8222-222222222222';

/** One shared table as the service hands it over — `write: true` only where D-PR5-13 marks it. */
function sharedTable(over: Partial<MaterialisedTable> & Pick<MaterialisedTable, 'table' | 'columns'> & { write?: true }): MaterialisedTable {
  const alias = over.alias ?? 'ledger';
  return {
    grantId: G_LEDGER,
    sourceAppId: ledger,
    sourceName: 'Ledger',
    alias,
    name: `${alias}__${over.table}`,
    types: over.columns.map(() => ''),
    rows: [],
    truncated: false,
    duration: 'day',
    expiresAt: iso(T0 + DAY),
    ...over,
  } as MaterialisedTable;
}

/** Ledger's writable `transactions`, its read-only `accounts` and its `snug_kv` — one grant; Pantry's read-only `items` — another. */
function fakeSet(): MaterialisedSet {
  const tables = [
    sharedTable({ table: 'transactions', columns: ['id', 'amount', 'category'], write: true }),
    sharedTable({ table: 'accounts', columns: ['name', 'balance'] }),
    sharedTable({ table: 'snug_kv', columns: ['key', 'value'] }),
    sharedTable({ grantId: G_PANTRY, sourceAppId: pantry, sourceName: 'Pantry', alias: 'pantry', table: 'items', columns: ['name', 'qty'] }),
  ];
  return { tables, skipped: [], readOnlyTables: tables.map((table) => table.name).sort() };
}

interface FakeHarness {
  tools: ReturnType<typeof buildDataTools>;
  recordRead: ReturnType<typeof vi.fn>;
  planWrite: ReturnType<typeof vi.fn>;
  staged: StagedAccessWrite[];
  own: PendingWriteProposal[];
  scratch: MockInstance<UserDb['scratchRun']>;
  events: string[];
}

/**
 * G5-16 (ii-7, SB-8): a REAL persisted access behind the fake seat's G_LEDGER — staging now checks the
 * access is still there and binds the card to the plan's `grantedAt` (before the fold a card staged
 * with `grantedAt: ''` when the id was unknown, and vanished on reload).
 */
const FAKE_GRANTED_AT = '2026-10-12T08:00:00.000Z';
function putFakeLedgerGrant(): void {
  if (db.getAccessGrant(G_LEDGER) !== undefined) return;
  db.putAccessGrant({
    id: G_LEDGER,
    readerAppId: budget,
    sourceAppId: ledger,
    scope: { tables: [{ name: 'transactions', columns: ['id', 'amount', 'category'], write: true }, { name: 'accounts', columns: ['name', 'balance'] }] },
    access: 'write',
    purpose: 'to tidy my spending',
    duration: { kind: 'always' },
    unattended: false,
    status: 'active',
    provenance: 'chat',
    readerVersion: 1,
    grantedAt: FAKE_GRANTED_AT,
    updatedAt: FAKE_GRANTED_AT,
    reads: 0,
    timeouts: 0,
  } as unknown as Parameters<UserDb['putAccessGrant']>[0]);
}

function fakeHarness(options: { plan?: PlanAnswer; stage?: boolean; scheduled?: boolean; recordRefused?: boolean; set?: MaterialisedSet; onPlan?: () => Promise<void> } = {}): FakeHarness {
  putFakeLedgerGrant();
  const events: string[] = [];
  const staged: StagedAccessWrite[] = [];
  const own: PendingWriteProposal[] = [];
  const set = options.set ?? fakeSet();
  const recordRead = vi.fn(async (grantIds: readonly string[]) => {
    events.push('record');
    return options.recordRefused === true
      ? { recorded: [], refused: grantIds.map((grantId) => ({ grantId, sourceAppId: ledger, sourceName: 'Ledger', reason: 'ended' })) }
      : { recorded: [...grantIds], refused: [] };
  });
  const planWrite = vi.fn(async () => {
    events.push('plan');
    await options.onPlan?.();
    return options.plan ?? { ok: true as const, changes: 1, table: 'transactions', grantedAt: FAKE_GRANTED_AT };
  });
  const scratch = vi.spyOn(db, 'scratchRun');
  const seat: WritableSeat = { set, recordRead, planWrite };
  const tools = buildDataTools({
    appId: budget,
    getDb: () => Promise.resolve(db),
    allowWrites: true,
    onProposal: (proposal: PendingWriteProposal) => {
      own.push(proposal);
      return true;
    },
    onAccessWriteProposal: (card: StagedAccessWrite) => {
      events.push('stage');
      if (options.stage === false) return false;
      staged.push(card);
      return true;
    },
    shared: seat,
    ...(options.scheduled === true ? { scheduled: { armed: false, onProposal: () => true } } : {}),
  } as unknown as Parameters<typeof buildDataTools>[0]);
  return { tools, recordRead, planWrite, staged, own, scratch, events };
}

const propose = async (h: FakeHarness, input: Record<string, unknown>): Promise<string> =>
  String(await h.tools.find((tool) => tool.def.name === DATA_PROPOSE_WRITE_TOOL_NAME)!.run({ summary: 'fix the coffee amount', ...input }));

/** Nothing recorded, nothing planned, nothing staged, no dry run — the refusal's whole footprint. */
function nothingHappened(h: FakeHarness): void {
  expect(h.recordRead, 'nothing recorded').not.toHaveBeenCalled();
  expect(h.planWrite, 'nothing planned').not.toHaveBeenCalled();
  expect(h.staged, 'no card').toEqual([]);
  expect(h.own, 'no own card either').toEqual([]);
  expect(h.scratch, 'no dry run of the reader').not.toHaveBeenCalled();
}

const UPDATE_TX = 'UPDATE ledger__transactions SET amount = 1250 WHERE id = 1';
const RENAMED_TX = 'UPDATE "transactions" SET amount = 1250 WHERE id = 1';

describe('D-PR5-11 (1) — the SCHEDULED variant’s shared-name refusal stays FIRST (D-PR4-2), even on a writable table', () => {
  it('a scheduled seat refuses ledger__transactions with CHAT_DOOR.readOnly — before any check of the chat path; nothing recorded, planned or staged', async () => {
    const h = fakeHarness({ scheduled: true });
    expect(await propose(h, { statements: [UPDATE_TX] })).toBe(`Error: ${CHAT_DOOR.readOnly('Ledger')}`);
    nothingHappened(h);
  });
});

describe('D-PR5-11 (2) — writable-first: a batch on a READ-ONLY grant answers today’s CHAT_DOOR.readOnly byte-identical (AC11 unchanged)', () => {
  it('a READ-ONLY grant’s table — even in a batch of two with params — is today’s readOnly(source), never oneChange or valuesIn', async () => {
    const h = fakeHarness();
    const out = await propose(h, { statements: ["UPDATE pantry__items SET qty = 3 WHERE name = 'rice'", 'DELETE FROM pantry__items WHERE qty = 0'], params: [['x'], []] });
    expect(out).toBe(`Error: ${CHAT_DOOR.readOnly('Pantry')}`);
    nothingHappened(h);
  });

  it('an INSERT INTO the reader’s own table SELECTing FROM a writable shared table: the DML target is not the alias → readOnly(source)', async () => {
    const h = fakeHarness();
    const out = await propose(h, { statements: ['INSERT INTO envelopes (name, category) SELECT category, category FROM ledger__transactions'] });
    expect(out).toBe(`Error: ${CHAT_DOOR.readOnly('Ledger')}`);
    nothingHappened(h);
  });

  it('a statement on the writable alias that ALSO names another shared table (namedBy names two) → readOnly(source)', async () => {
    const h = fakeHarness();
    const out = await propose(h, { statements: ["UPDATE ledger__transactions SET amount = (SELECT balance FROM ledger__accounts WHERE name = 'main') WHERE id = 1"] });
    expect(out).toBe(`Error: ${CHAT_DOOR.readOnly('Ledger')}`);
    nothingHappened(h);
  });

  it('a batch of two on a writable table → CHAT_DOOR.oneChange; nothing recorded, planned or staged', async () => {
    const h = fakeHarness();
    const out = await propose(h, { statements: [UPDATE_TX, 'UPDATE ledger__transactions SET amount = 900 WHERE id = 2'] });
    expect(out).toContain(said(DOOR.oneChange));
    expect(out).not.toContain(CHAT_DOOR.readOnly('Ledger'));
    nothingHappened(h);
  });

  it('params on a writable table → CHAT_DOOR.valuesIn (the values are written into the one statement); nothing recorded', async () => {
    const h = fakeHarness();
    const out = await propose(h, { statements: ['UPDATE ledger__transactions SET amount = ? WHERE id = 1'], params: [[1250]] });
    expect(out).toContain(said(DOOR.valuesIn));
    nothingHappened(h);
  });

  it('the READ-ONLY table of a write grant → CHAT_DOOR.readOnlyTable(source, table)', async () => {
    const h = fakeHarness();
    const out = await propose(h, { statements: ["UPDATE ledger__accounts SET balance = 1 WHERE name = 'main'"] });
    expect(out).toContain(said(DOOR.readOnlyTable?.('Ledger', 'accounts')));
    nothingHappened(h);
  });

  it('<alias>__snug_kv is never writable — readOnlyTable(source, snug_kv), whatever the grant allows', async () => {
    const h = fakeHarness();
    const out = await propose(h, { statements: ["UPDATE ledger__snug_kv SET value = 'x' WHERE key = 'theme'"] });
    expect(out).toContain(said(DOOR.readOnlyTable?.('Ledger', 'snug_kv')));
    nothingHappened(h);
  });
});

describe('D-PR5-11 (3) — the RAW statement passes accessSqlSchema and holds no \\p{Cf}, or unsafeText — nothing recorded (S7)', () => {
  const HEAD = "UPDATE ledger__transactions SET category = '";

  it('a bidi isolate at character 250 — inside a literal, past the history’s 200-character cut — is refused unsafeText', async () => {
    const sql = `${HEAD}${'x'.repeat(250 - HEAD.length)}⁦y' WHERE id = 1`;
    expect(sql.indexOf('⁦')).toBe(250);
    const h = fakeHarness();
    expect(await propose(h, { statements: [sql] })).toContain(said(DOOR.unsafeText));
    nothingHappened(h);
  });

  it('a format character accessSqlSchema alone admits (U+200B, U+00AD, U+FEFF — all \\p{Cf}) is refused unsafeText too', async () => {
    for (const cf of ['​', '­', '﻿']) {
      expect(/\p{Cf}/u.test(cf)).toBe(true);
      const h = fakeHarness();
      expect(await propose(h, { statements: [`${HEAD}co${cf}ffee' WHERE id = 1`] }), JSON.stringify(cf)).toContain(said(DOOR.unsafeText));
      nothingHappened(h);
    }
  });

  it('a statement over ACCESS_SQL_MAX_CHARS fails accessSqlSchema → unsafeText', async () => {
    const h = fakeHarness();
    const sql = `${HEAD}${'x'.repeat(ACCESS_SQL_MAX_CHARS)}' WHERE id = 1`;
    expect(await propose(h, { statements: [sql] })).toContain(said(DOOR.unsafeText));
    nothingHappened(h);
  });
});

describe('D-PR5-11 (4) — renameDmlTarget: every refusal → CHAT_DOOR.plainChange(source), nothing recorded (S8, F18)', () => {
  it.each([
    ['a comment before the head', '/* tidy */ UPDATE ledger__transactions SET amount = 1250 WHERE id = 1'],
    ['INSERT OR REPLACE', 'INSERT OR REPLACE INTO ledger__transactions (id, amount, category) VALUES (1, 1250, \'food\')'],
    ['REPLACE INTO', 'REPLACE INTO ledger__transactions (id, amount, category) VALUES (1, 1250, \'food\')'],
    ['the alias qualified outside the head', 'UPDATE ledger__transactions SET amount = 1250 WHERE ledger__transactions.id = 1'],
    ['a non-ASCII code point outside a string literal', 'UPDATE ledger__transactions SET amount = 1250 WHERE id = 1 AND categoríe IS NULL'],
  ])('%s → plainChange', async (_label, sql) => {
    const h = fakeHarness();
    expect(await propose(h, { statements: [sql] })).toContain(said(DOOR.plainChange?.('Ledger')));
    nothingHappened(h);
  });
});

describe('D-PR5-11 (5)–(9) — busy, the counting line, the plan, the one card, the brain’s answer', () => {
  it('(5) the source in the middle of a change → CHAT_DOOR.busy(source): nothing recorded, nothing planned', async () => {
    const h = fakeHarness();
    vi.spyOn(db.driver, 'inTransaction').mockImplementation(async (appId: string) => appId === ledger);
    expect(await propose(h, { statements: [UPDATE_TX] })).toContain(said(DOOR.busy?.('Ledger')));
    nothingHappened(h);
  });

  it('(6) the counting line BEFORE the plan: recordRead([grantId], the RENAMED statement, { counting: true }), then planWrite(grantId, the renamed statement)', async () => {
    const h = fakeHarness();
    await propose(h, { statements: [UPDATE_TX] });
    expect(h.recordRead).toHaveBeenCalledTimes(1);
    expect(h.recordRead).toHaveBeenCalledWith([G_LEDGER], RENAMED_TX, { counting: true });
    expect(h.planWrite).toHaveBeenCalledTimes(1);
    expect(h.planWrite).toHaveBeenCalledWith(G_LEDGER, RENAMED_TX);
    expect(h.events.slice(0, 3)).toEqual(['record', 'plan', 'stage']);
  });

  it('(6) a counting line the history refuses → CHAT_DOOR.ended(source); nothing planned, nothing staged', async () => {
    const h = fakeHarness({ recordRefused: true });
    expect(await propose(h, { statements: [UPDATE_TX] })).toContain(CHAT_DOOR.ended('Ledger'));
    expect(h.recordRead).toHaveBeenCalledTimes(1);
    expect(h.planWrite).not.toHaveBeenCalled();
    expect(h.staged).toEqual([]);
  });

  it('(7) the plan’s refusal answers in ACCESS_APP_MESSAGES words — and stages nothing', async () => {
    const refusal = { ok: false as const, code: 'ACCESS_WRITE_REFUSED', message: ACCESS_APP_MESSAGES.writeRefused('no-where'), retryable: false };
    const h = fakeHarness({ plan: refusal });
    const out = await propose(h, { statements: ['UPDATE ledger__transactions SET amount = 1250 WHERE id = 1'] });
    expect(out).toMatch(/^Error:/);
    expect(out).toContain(ACCESS_APP_MESSAGES.writeRefused('no-where'));
    expect(h.staged).toEqual([]);
    expect(h.own).toEqual([]);
  });

  it('(7) a plan of 0 rows → CHAT_DOOR.noRows(source) — no card for a change that changes nothing', async () => {
    const h = fakeHarness({ plan: { ok: true, changes: 0, table: 'transactions' } });
    expect(await propose(h, { statements: ['UPDATE ledger__transactions SET amount = 1250 WHERE id = 99'] })).toContain(said(DOOR.noRows?.('Ledger')));
    expect(h.staged).toEqual([]);
  });

  it('(7) a plan too large to undo is refused HERE, at propose — no card ever offers a change strict mode would refuse (S17)', async () => {
    const h = fakeHarness({ plan: { ok: false, code: 'ACCESS_WRITE_REFUSED', message: ACCESS_APP_MESSAGES.writeRefused('too-large'), retryable: false } });
    const out = await propose(h, { statements: ['DELETE FROM ledger__transactions WHERE id > 0'] });
    expect(out).toContain(ACCESS_APP_MESSAGES.writeRefused('too-large'));
    expect(h.staged).toEqual([]);
  });

  it('(8)(9) ONE card through onAccessWriteProposal — the source-named statement, its count, the summary; the brain hears the ALIAS statement and the host’s proposed sentence', async () => {
    // G5-16 (ii-7): the fake plan answers the grantedAt it planned under, as planChatWrite now does.
    const h = fakeHarness({ plan: { ok: true, changes: 3, table: 'transactions', grantedAt: FAKE_GRANTED_AT } });
    const out = await propose(h, { statements: ['UPDATE ledger__transactions SET category = \'groceries\' WHERE amount > 0'], summary: 'call every purchase groceries' });
    expect(h.staged).toHaveLength(1);
    expect(h.staged[0]).toMatchObject({
      appId: budget,
      target: { grantId: G_LEDGER, sourceAppId: ledger, table: 'transactions' },
      sql: 'UPDATE "transactions" SET category = \'groceries\' WHERE amount > 0',
      summary: 'call every purchase groceries',
      previewed: 3,
    });
    expect(h.own, 'never the own card').toEqual([]);
    expect(h.scratch, 'never the reader’s own dry run').not.toHaveBeenCalled();
    expect(out).toContain('UPDATE ledger__transactions SET category = \'groceries\' WHERE amount > 0');
    expect(out).not.toContain('"transactions"');
    expect(out).toContain(`Proposed — it would change ${rowsWord(3)} in Ledger; it waits for the user’s OK on the card`);
    expect(out).not.toMatch(/^Error:/);
  });

  it('(8) the host declined to stage (one card per turn, own or cross-app) → NOT staged, and the brain is told', async () => {
    const h = fakeHarness({ stage: false });
    const out = await propose(h, { statements: [UPDATE_TX] });
    expect(h.events).toContain('stage');
    expect(out).toContain('NOT staged');
    expect(out).not.toContain('Proposed — it would change');
  });

  it('a change naming NO shared table is today’s own path — dry run, the own card, no seat call (guard)', async () => {
    const h = fakeHarness();
    const out = await propose(h, { statements: ["UPDATE envelopes SET name = 'Food' WHERE id = 1"] });
    expect(out).not.toMatch(/^Error:/);
    expect(h.own).toHaveLength(1);
    expect(h.recordRead).not.toHaveBeenCalled();
    expect(h.planWrite).not.toHaveBeenCalled();
    expect(h.staged).toEqual([]);
  });
});

// =========================================================================================
// B. The same tool over the real engine
// =========================================================================================

describe('D-PR5-11/12 — the tool over the REAL engine: the counting line, planChatWrite, the staged card', () => {
  async function realTools(): Promise<{ tools: ReturnType<typeof buildDataTools>; staged: StagedAccessWrite[]; set: MaterialisedSet }> {
    const { planChatWrite } = await chatWrite();
    const svc = accessService();
    const set = await svc.materialise(chat());
    const staged: StagedAccessWrite[] = [];
    const recordRead = (svc.recordRead as unknown as (caller: AccessCaller, set: MaterialisedSet, input: { grantIds: readonly string[]; sql?: string; counting?: true }) => ReturnType<WritableSeat['recordRead']>).bind(svc);
    const seat: WritableSeat = {
      set,
      recordRead: (grantIds, sql, opts) => recordRead(chat(), set, { grantIds, sql, ...(opts?.counting === true ? { counting: true as const } : {}) }),
      planWrite: (grantId, sql) => planChatWrite(db, chat(), { grantId, sql }),
    };
    const tools = buildDataTools({
      appId: budget,
      getDb: () => Promise.resolve(db),
      allowWrites: true,
      onProposal: () => true,
      onAccessWriteProposal: (card: StagedAccessWrite) => {
        staged.push(card);
        return true;
      },
      shared: seat,
    } as unknown as Parameters<typeof buildDataTools>[0]);
    return { tools, staged, set };
  }

  it('stages ONE card naming the grant AND its grantedAt, the renamed statement and the plan’s real count — and changes nothing in Ledger', async () => {
    const grant = await grantOn(['transactions', 'accounts'], ['transactions']);
    const { tools, staged } = await realTools();
    const seatSpy = vi.spyOn(db.driver, 'brokeredWrite');
    const out = String(await tools.find((tool) => tool.def.name === DATA_PROPOSE_WRITE_TOOL_NAME)!.run({ statements: ["UPDATE ledger__transactions SET category = 'groceries' WHERE category = 'food'"], summary: 'call food groceries' }));
    expect(out).toContain(`Proposed — it would change ${rowsWord(2)} in Ledger; it waits for the user’s OK on the card`);
    expect(staged).toEqual([
      {
        appId: budget,
        target: { grantId: grant.id, grantedAt: findAccessGrant(db, grant.id)!.grant.grantedAt, sourceAppId: ledger, table: 'transactions' },
        sql: `UPDATE "transactions" SET category = 'groceries' WHERE category = 'food'`,
        summary: 'call food groceries',
        previewed: 2,
      },
    ]);
    expect(seatSpy, 'a proposal never reaches the seat').not.toHaveBeenCalled();
    expect(await rowsOf(ledger, LEDGER_ROWS)).toEqual(SEEDED);
    expect(kindsOf(ledger).filter((kind) => kind === 'wrote')).toEqual([]);
    expect(db.listAllAccessUndo(ledger)).toEqual([]);
  });

  it('S18 — the counting line: ONE `read` line on Ledger’s history — tables = the one table, attended, NO sql, NO rows (no DML ever sits on a read line)', async () => {
    const grant = await grantOn(['transactions', 'accounts'], ['transactions']);
    const { tools } = await realTools();
    await tools.find((tool) => tool.def.name === DATA_PROPOSE_WRITE_TOOL_NAME)!.run({ statements: [UPDATE_TX], summary: 'fix the coffee amount' });
    const reads = linesOf(ledger).filter((line) => line.kind === 'read');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ kind: 'read', grantId: grant.id, readerAppId: budget, readerName: 'Budget', tables: ['transactions'], attended: true });
    expect(reads[0]).not.toHaveProperty('sql');
    expect(reads[0]).not.toHaveProperty('rows');
  });

  it('planChatWrite NEVER reaches driver.brokeredWrite — the plan answers { ok, changes, table } and the seat is never called', async () => {
    const { planChatWrite } = await chatWrite();
    const grant = await grantOn(['transactions'], ['transactions']);
    const seatSpy = vi.spyOn(db.driver, 'brokeredWrite');
    // G5-16 (ii-7, SB-8): RE-PINNED — the plan answers the grantedAt of the access it planned under.
    expect(await planChatWrite(db, chat(), { grantId: grant.id, sql: `UPDATE "transactions" SET amount = 0 WHERE category = 'food'` })).toEqual({
      ok: true,
      changes: 2,
      table: 'transactions',
      grantedAt: findAccessGrant(db, grant.id)!.grant.grantedAt,
    });
    expect(seatSpy).not.toHaveBeenCalled();
    expect(posted.map(kindOf)).toEqual(['plan-write']);
    expect(await rowsOf(ledger, LEDGER_ROWS)).toEqual(SEEDED);
  });

  it('planChatWrite refuses in the frame’s words: a table the grant reads only → writeNotGranted; no WHERE → the no-where rule', async () => {
    const { planChatWrite } = await chatWrite();
    const grant = await grantOn(['transactions', 'accounts'], ['transactions']);
    expect(await planChatWrite(db, chat(), { grantId: grant.id, sql: `UPDATE "accounts" SET balance = 1 WHERE name = 'main'` })).toMatchObject({ ok: false, message: ACCESS_APP_MESSAGES.writeNotGranted });
    expect(await planChatWrite(db, chat(), { grantId: grant.id, sql: 'UPDATE "transactions" SET amount = 0' })).toMatchObject({ ok: false, code: 'ACCESS_WRITE_REFUSED', message: ACCESS_APP_MESSAGES.writeRefused('no-where') });
  });
});

// =========================================================================================
// C. writeChatApproved — one case per row of the why table
// =========================================================================================

describe('D-PR5-12 writeChatApproved — authority approval, via chat; ok ⇒ undoable with an undoId', () => {
  /** The approval as the card would hand it over: the grant's id AND its grantedAt, the source, the table, the source-named statement, the count shown. */
  function approval(grant: AnyAccessGrant, over: Partial<WriteChatApprovedInput> = {}): WriteChatApprovedInput {
    return {
      grantId: grant.id,
      grantedAt: findAccessGrant(db, grant.id)!.grant.grantedAt,
      sourceAppId: ledger,
      table: 'transactions',
      sql: `UPDATE "transactions" SET amount = 1250 WHERE id = 1`,
      expectChanges: 1,
      ...over,
    };
  }
  const approve = async (input: WriteChatApprovedInput): Promise<WriteChatApprovedOutcome> => (await chatWrite()).writeChatApproved(db, chat(), input);
  const unchanged = async (): Promise<void> => {
    expect(await rowsOf(ledger, LEDGER_ROWS), 'nothing was changed').toEqual(SEEDED);
    expect(kindsOf(ledger).filter((kind) => kind === 'wrote')).toEqual([]);
  };

  it('ok → { ok, executed, undoable: true, undoId }; the wrote line says via chat, authority approval, and names the undo; the journal entry is the approval’s', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    const outcome = await approve(approval(grant));
    expect(outcome).toMatchObject({ ok: true, executed: [1], undoable: true });
    const undoId = (outcome as { undoId?: string }).undoId;
    expect(undoId).toMatch(UUID_V4);
    expect(await rowsOf(ledger, 'SELECT amount FROM transactions WHERE id = 1')).toEqual([[1250]]);
    const wrote = linesOf(ledger).filter((line) => line.kind === 'wrote');
    expect(wrote).toHaveLength(1);
    expect(wrote[0]).toMatchObject({ grantId: grant.id, readerAppId: budget, via: 'chat', authority: 'approval', changes: 1, undoId, tables: ['transactions'] });
    const [entry] = db.listAccessUndo(ledger) as AccessUndoEntry[];
    expect(entry).toMatchObject({ id: undoId, authority: 'approval', via: 'chat', grantId: grant.id, readerAppId: budget });
  });

  it('busy — Ledger mid-change (its frame’s BEGIN), asked FIRST: why busy, the seat never reached, nothing changed', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    // Loaded BEFORE the BEGIN: the driver's debounced save exports the namespace, which ends an open transaction.
    const { writeChatApproved } = await chatWrite();
    const seatSpy = vi.spyOn(db.driver, 'brokeredWrite');
    await exec(ledger, 'BEGIN');
    try {
      expect(await writeChatApproved(db, chat(), approval(grant))).toMatchObject({ ok: false, why: 'busy' });
      expect(posted.map(kindOf), 'asked before any plan').toEqual([]);
    } finally {
      await db.driver.handle(ledger, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `rb-${++seq}`, instanceId: 'frame', op: 'exec', sql: 'ROLLBACK' });
    }
    expect(seatSpy).not.toHaveBeenCalled();
    await unchanged();
  });

  it('drifted BEFORE the seat — the fresh plan’s count is not the one the user saw: reason drifted, why drifted; no room check, no seat', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    const seatSpy = vi.spyOn(db.driver, 'brokeredWrite');
    const room = vi.spyOn(db, 'listAccessUndo');
    const outcome = await approve(approval(grant, { sql: `UPDATE "transactions" SET amount = 0 WHERE category = 'food'`, expectChanges: 1 }));
    expect(outcome).toMatchObject({ ok: false, reason: 'drifted', why: 'drifted' });
    expect(seatSpy).not.toHaveBeenCalled();
    expect(room, 'the drift halts before the journal’s room is asked').not.toHaveBeenCalled();
    await unchanged();
  });

  it('drifted AT the seat — a row that started matching between the plan and the seat: why drifted, rolled back', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    const plans = hold('plan-write');
    const { writeChatApproved } = await chatWrite();
    const pending = writeChatApproved(db, chat(), approval(grant, { sql: `UPDATE "transactions" SET amount = 0 WHERE category = 'food'`, expectChanges: 2 }));
    void pending.catch(() => undefined); // awaited below; never an unhandled rejection while the gate is shut
    await expect.poll(() => posted.map(kindOf), { timeout: 3000 }).toEqual(['plan-write']);
    await exec(ledger, "INSERT INTO transactions (id, amount, category) VALUES (4, 300, 'food')");
    plans.open();
    expect(await pending).toMatchObject({ ok: false, why: 'drifted' });
    expect(await rowsOf(ledger, "SELECT count(*) FROM transactions WHERE amount = 0")).toEqual([[0]]);
  });

  it('ended — a revoked grant', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    const input = approval(grant);
    await revokeAccess(grant.id);
    expect(await approve(input)).toMatchObject({ ok: false, why: 'ended' });
    await unchanged();
  });

  it('ended — an expired grant', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    const input = approval(grant);
    clock.now += 2 * DAY;
    vi.setSystemTime(clock.now);
    expect(await approve(input)).toMatchObject({ ok: false, why: 'ended' });
    await unchanged();
  });

  it('ended — a paused grant', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    const input = approval(grant);
    await suspendAccess(db, grant.id, 'imported', iso(clock.now));
    expect(await approve(input)).toMatchObject({ ok: false, why: 'ended' });
    await unchanged();
  });

  it('S9 — ended after a renewal IN PLACE: the grant keeps its id but its grantedAt moved — the card’s approval is not this grant’s', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    const input = approval(grant);
    await suspendAccess(db, grant.id, 'imported', iso(clock.now));
    clock.now += 60_000;
    vi.setSystemTime(clock.now);
    const ranked = await collectSources(db, budget);
    const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === ledger)!;
    const renewed = await createGrantFromDecision(db, {
      readerAppId: budget,
      source,
      tables: [{ name: 'transactions', withheld: [], write: true }],
      duration: 'day',
      unattended: false,
      purpose: 'to tidy my spending',
      provenance: 'user',
      now: clock.now,
      renew: grant.id,
    } as unknown as CreateGrantInput);
    expect(renewed.id, 'a renewal after a pause keeps the id').toBe(grant.id);
    expect(findAccessGrant(db, grant.id)!.grant.grantedAt).not.toBe(input.grantedAt);
    expect(await approve(input)).toMatchObject({ ok: false, why: 'ended' });
    await unchanged();
  });

  it('not-allowed — the card’s table is one the grant only lets Budget READ', async () => {
    const grant = await grantOn(['transactions', 'accounts'], ['transactions']);
    const outcome = await approve(approval(grant, { table: 'accounts', sql: `UPDATE "accounts" SET balance = 1 WHERE name = 'main'` }));
    expect(outcome).toMatchObject({ ok: false, why: 'not-allowed' });
    expect(await rowsOf(ledger, 'SELECT balance FROM accounts')).toEqual([[9000]]);
  });

  it('refused — a statement with no WHERE (the strict rules)', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    expect(await approve(approval(grant, { sql: 'UPDATE "transactions" SET amount = 0', expectChanges: 3 }))).toMatchObject({ ok: false, why: 'refused' });
    await unchanged();
  });

  it('refused — a credential-shaped value', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    const sql = `UPDATE "transactions" SET category = 'sk-Ab3dEf9hIjKl2MnOpQr5StUvWxYz01234567aBcD' WHERE id = 1`;
    expect(await approve(approval(grant, { sql }))).toMatchObject({ ok: false, why: 'refused' });
    await unchanged();
  });

  it('refused — a plan with nothing to undo: strict mode refuses an unjournalable plan BEFORE the seat (ok is always undoable)', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    const seatSpy = vi.spyOn(db.driver, 'brokeredWrite');
    expect(await approve(approval(grant, { sql: 'UPDATE "transactions" SET amount = 0 WHERE id = 99', expectChanges: 0 }))).toMatchObject({ ok: false, why: 'refused' });
    expect(seatSpy).not.toHaveBeenCalled();
    await unchanged();
  });

  it('waiting — twenty of Budget’s changes to Ledger are waiting to be undone', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    const step: AccessUndoStep = { table: 'transactions', op: 'insert', columns: ['category'], rows: [{ rowid: 99, after: ['x'] }] };
    for (let i = 0; i < 20; i += 1) {
      const entry: AccessUndoEntry = { id: crypto.randomUUID(), at: iso(clock.now), expiresAt: iso(clock.now + 7 * DAY), authority: 'approval', via: 'chat', grantId: grant.id, readerAppId: budget, readerName: 'Budget', steps: [step] };
      expect(db.putAccessUndo(ledger, entry)).toBe('ok');
    }
    expect(await approve(approval(grant))).toMatchObject({ ok: false, why: 'waiting' });
    await unchanged();
  });

  it('gone — the card names another source than the grant’s', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    expect(await approve(approval(grant, { sourceAppId: pantry }))).toMatchObject({ ok: false, why: 'gone' });
    await unchanged();
  });

  it('gone — the statement’s table is not the card’s table', async () => {
    const grant = await grantOn(['transactions', 'accounts'], ['transactions', 'accounts']);
    expect(await approve(approval(grant, { table: 'accounts' }))).toMatchObject({ ok: false, why: 'gone' });
    await unchanged();
  });

  it('failed — no worker can plan here', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    vi.stubGlobal('Worker', undefined);
    configureScopedRead({ createWorker: undefined, wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    expect(await approve(approval(grant))).toMatchObject({ ok: false, why: 'failed' });
    await unchanged();
  });
});

// =========================================================================================
// TASK-20261010-host-broker PR-5 — Gate-5 fold G5-16 on the chat's write.
//
// ii-1  a statement the RENAME admits but the strict parser refuses (`renameDmlTarget` answers
//       `{ok: false, rule: 'parse', parseRule}` — G5-10) answers `ACCESS_APP_MESSAGES.writeRefused
//       (parseRule)`: arithmetic, a function, ON CONFLICT → the parser's `statement` words; no WHERE →
//       the `no-where` words. Never `plainChange` (whose words point at a fault the statement does not
//       have). `plainChange` stays for the rename's OWN rules (pinned above). Nothing recorded.
// ii-2  a missing access is `gone` ONLY when the source app is gone; else `ended` (a "while it's
//       open" access dropped with its frame, a reload, another generation's).
// ii-7, SB-8  the card binds to the plan's `grantedAt`; an access gone before staging → `ended`,
//       nothing staged (before the fold: staged with `grantedAt: ''`, dropped on reload).
// ii-9  the real unjournalable case: the journal refuses after the commit → `ok`, `undoable: false`,
//       no `undoId`.
// ii-10 a chat seat without `planWrite` naming a writable table → `readOnly(source)`, nothing
//       recorded (the defensive belt — guard).
// SB-6  `isPlainSqlText` refuses the line/paragraph separators and the blank fillers the summary
//       rule refuses (U+2028, U+2029, U+3164, U+115F, U+2800, …) → `unsafeText`, nothing recorded.
// =========================================================================================

describe('G5-16 (ii-1) a parser rule from the rename answers writeRefused(parseRule) — never plainChange', () => {
  it.each([
    ['arithmetic', 'UPDATE ledger__transactions SET amount = amount + 5 WHERE id = 1', 'statement'],
    ['a function', "UPDATE ledger__transactions SET category = upper('food') WHERE id = 1", 'statement'],
    ['ON CONFLICT', "INSERT INTO ledger__transactions (id, amount, category) VALUES (9, 1, 'x') ON CONFLICT DO NOTHING", 'statement'],
    ['an UPDATE with no WHERE', 'UPDATE ledger__transactions SET amount = 1', 'no-where'],
    ['a DELETE with no WHERE', 'DELETE FROM ledger__transactions', 'no-where'],
  ] as const)('G5-16 %s (%s) → ACCESS_APP_MESSAGES.writeRefused(%s); nothing recorded, planned or staged', async (_label, sql, rule) => {
    const h = fakeHarness();
    const out = await propose(h, { statements: [sql] });
    expect(out).toBe(`Error: ${ACCESS_APP_MESSAGES.writeRefused(rule)}`);
    expect(out).not.toContain(said(DOOR.plainChange?.('Ledger')));
    nothingHappened(h);
  });
});

describe('G5-16 (ii-2) a missing access is gone only when its source is gone — else ended', () => {
  async function sessionGrant(generation: number): Promise<AnyAccessGrant> {
    const ranked = await collectSources(db, budget);
    const offered = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === ledger)!;
    return createGrantFromDecision(db, {
      readerAppId: budget,
      source: offered,
      tables: [{ name: 'transactions', withheld: [], write: true }],
      duration: 'session',
      unattended: false,
      purpose: 'to tidy my spending',
      provenance: 'chat',
      generation,
      now: clock.now,
    } as unknown as CreateGrantInput);
  }
  const approvalOf = (grant: AnyAccessGrant): WriteChatApprovedInput => ({
    grantId: grant.id,
    grantedAt: findAccessGrant(db, grant.id)!.grant.grantedAt,
    sourceAppId: ledger,
    table: 'transactions',
    sql: 'UPDATE "transactions" SET amount = 1250 WHERE id = 1',
    expectChanges: 1,
  });
  const chatAt = (liveGeneration: number): AccessCaller => ({ kind: 'chat', appId: budget, threadId: 'thread-1', liveGeneration } as AccessCaller);

  it('G5-16 a "while it’s open" access dropped with its reader’s view (another generation noted) → why ended, nothing changed', async () => {
    noteReaderGeneration(budget, 1);
    const grant = await sessionGrant(1);
    const input = approvalOf(grant);
    noteReaderGeneration(budget, 2); // the reader's frame of generation 1 ended: its session access went with it
    expect(findAccessGrant(db, grant.id), 'the session access is gone from memory').toBeUndefined();
    expect(await (await chatWrite()).writeChatApproved(db, chatAt(2), input)).toMatchObject({ ok: false, why: 'ended' });
    expect(await rowsOf(ledger, LEDGER_ROWS)).toEqual(SEEDED);
  });

  it('G5-16 a session access of ANOTHER generation (still in memory, not the caller’s) → why ended', async () => {
    noteReaderGeneration(budget, 1);
    const grant = await sessionGrant(1);
    expect(await (await chatWrite()).writeChatApproved(db, chatAt(7), approvalOf(grant))).toMatchObject({ ok: false, why: 'ended' });
    expect(await rowsOf(ledger, LEDGER_ROWS)).toEqual(SEEDED);
  });

  it('G5-16 a persisted access whose id is no longer in the file, its source still there → why ended', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    const input = { ...approvalOf(grant), grantId: crypto.randomUUID() };
    expect(await (await chatWrite()).writeChatApproved(db, chat(), input)).toMatchObject({ ok: false, why: 'ended' });
  });

  it('G5-16 guard: the SOURCE app deleted → why gone', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    const input = approvalOf(grant);
    await db.deleteApp(ledger);
    expect(await (await chatWrite()).writeChatApproved(db, chat(), input)).toMatchObject({ ok: false, why: 'gone' });
  });
});

describe('G5-16 (ii-7, SB-8) the card binds to the plan’s grantedAt; an access gone before staging stages nothing', () => {
  it('G5-16 the staged card carries the grantedAt the plan answered', async () => {
    const h = fakeHarness({ plan: { ok: true, changes: 1, table: 'transactions', grantedAt: FAKE_GRANTED_AT } });
    await propose(h, { statements: [UPDATE_TX] });
    expect(h.staged).toHaveLength(1);
    expect(h.staged[0]!.target.grantedAt).toBe(FAKE_GRANTED_AT);
  });

  it('G5-16 the access revoked INSIDE the plan → Error: …ended…; onAccessWriteProposal never called, nothing staged', async () => {
    const h = fakeHarness({
      onPlan: async () => {
        await revokeAccess(G_LEDGER);
      },
    });
    const out = await propose(h, { statements: [UPDATE_TX] });
    expect(out).toBe(`Error: ${CHAT_DOOR.ended('Ledger')}`);
    expect(h.events).not.toContain('stage');
    expect(h.staged).toEqual([]);
  });

  it('G5-16 a plan answering no grantedAt (or not an instant) stages nothing → Error: …ended…', async () => {
    for (const plan of [{ ok: true as const, changes: 1, table: 'transactions' }, { ok: true as const, changes: 1, table: 'transactions', grantedAt: '' }]) {
      const h = fakeHarness({ plan });
      expect(await propose(h, { statements: [UPDATE_TX] }), JSON.stringify(plan)).toBe(`Error: ${CHAT_DOOR.ended('Ledger')}`);
      expect(h.staged).toEqual([]);
    }
  });

  it('G5-16 over the REAL engine: the access stopped between the plan and staging → ended, no card', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    const { planChatWrite } = await chatWrite();
    const svc = accessService();
    const set = await svc.materialise(chat());
    const staged: StagedAccessWrite[] = [];
    const recordRead = (svc.recordRead as unknown as (caller: AccessCaller, set: MaterialisedSet, input: { grantIds: readonly string[]; sql?: string; counting?: true }) => ReturnType<WritableSeat['recordRead']>).bind(svc);
    const seat: WritableSeat = {
      set,
      recordRead: (grantIds, sql, opts) => recordRead(chat(), set, { grantIds, sql, ...(opts?.counting === true ? { counting: true as const } : {}) }),
      planWrite: async (grantId, sql) => {
        const answer = await planChatWrite(db, chat(), { grantId, sql });
        await revokeAccess(grant.id);
        return answer;
      },
    };
    const tools = buildDataTools({
      appId: budget,
      getDb: () => Promise.resolve(db),
      allowWrites: true,
      onProposal: () => true,
      onAccessWriteProposal: (card: StagedAccessWrite) => {
        staged.push(card);
        return true;
      },
      shared: seat,
    } as unknown as Parameters<typeof buildDataTools>[0]);
    const out = String(await tools.find((tool) => tool.def.name === DATA_PROPOSE_WRITE_TOOL_NAME)!.run({ statements: [UPDATE_TX], summary: 'fix the coffee amount' }));
    expect(out).toBe(`Error: ${CHAT_DOOR.ended('Ledger')}`);
    expect(staged).toEqual([]);
  });
});

describe('G5-16 (ii-9) the real unjournalable case: ok, undoable false, no undoId', () => {
  it('G5-16 the journal refuses after the commit → { ok: true, undoable: false } with no undoId', async () => {
    const grant = await grantOn(['transactions'], ['transactions']);
    vi.spyOn(db, 'putAccessUndo').mockImplementation(() => 'full' as ReturnType<UserDb['putAccessUndo']>);
    const outcome = await (await chatWrite()).writeChatApproved(db, chat(), {
      grantId: grant.id,
      grantedAt: findAccessGrant(db, grant.id)!.grant.grantedAt,
      sourceAppId: ledger,
      table: 'transactions',
      sql: 'UPDATE "transactions" SET amount = 1250 WHERE id = 1',
      expectChanges: 1,
    });
    expect(outcome).toMatchObject({ ok: true, undoable: false });
    expect((outcome as { undoId?: string }).undoId).toBeUndefined();
  });
});

describe('G5-16 (ii-10) a chat seat built without planWrite: the defensive belt', () => {
  it('G5-16 a data_write seat without planWrite naming a writable table → readOnly(source), nothing recorded (guard)', async () => {
    const set = fakeSet();
    const recordRead = vi.fn(async () => ({ recorded: [], refused: [] }));
    const staged: StagedAccessWrite[] = [];
    const tools = buildDataTools({
      appId: budget,
      getDb: () => Promise.resolve(db),
      allowWrites: true,
      onProposal: () => true,
      onAccessWriteProposal: (card: StagedAccessWrite) => {
        staged.push(card);
        return true;
      },
      shared: { set, recordRead },
    } as unknown as Parameters<typeof buildDataTools>[0]);
    const out = String(await tools.find((tool) => tool.def.name === DATA_PROPOSE_WRITE_TOOL_NAME)!.run({ statements: [UPDATE_TX], summary: 'fix the coffee amount' }));
    expect(out).toBe(`Error: ${CHAT_DOOR.readOnly('Ledger')}`);
    expect(recordRead).not.toHaveBeenCalled();
    expect(staged).toEqual([]);
  });
});

describe('G5-16 (SB-6) the statement refuses the separators and blank fillers the summary rule refuses', () => {
  const HEAD = "UPDATE ledger__transactions SET category = '";
  it.each([
    ['U+2028 LINE SEPARATOR', ' '],
    ['U+2029 PARAGRAPH SEPARATOR', ' '],
    ['U+3164 HANGUL FILLER', 'ㅤ'],
    ['U+115F HANGUL CHOSEONG FILLER', 'ᅟ'],
    ['U+2800 BRAILLE BLANK', '⠀'],
  ])('G5-16 a literal carrying %s → unsafeText; nothing recorded', async (_label, ch) => {
    const h = fakeHarness();
    expect(await propose(h, { statements: [`${HEAD}ok${ch.repeat(3)}' WHERE id = 1`] })).toContain(said(DOOR.unsafeText));
    nothingHappened(h);
  });
});
