// accessDrift.test.ts — reader updates suspend (TASK-20261010-cross-app-access AC21's non-UI rows
// and AC14's fan-out; ADR-0075 §9; ADR-0074 E8; D18).
//
// E8's rule, not a wider one: when the READER is replaced by someone other than the user — a
// shared bundle taken from the shelf, an agent hand-in — every live access it holds is paused
// `suspended / reader-updated`, a `suspended` line lands on each SOURCE's history and the reader's
// live frame is rung `access-changed { grantId }`. The user's own edit and a starter update change
// nothing. The access an app GIVES (it is the source) is never touched by its own update — the
// columns a reader may read are guarded by the drift check at query time, not here.
//
// ONE fan-out: `state/appVersionChanged.ts onAppVersionChanged` pauses the schedules AND suspends
// the access; the three places an app's version changes under the user (`share/installShared.ts`,
// both call expressions in `apps/host/src/handin.ts`, `schedule/acts.ts noteAppVersion`) call it,
// and NO other module calls either pause function directly — the source scan below pins it, with
// a planted call proving the scan can fail.
//
// THE RESET SEAMS (AC14): deleting an app drops the engine's memory for it (`resetAccessSession(id)`
// beside `resetThreadSessions({ appId: id })` in the library's delete), and every file-swap seam
// that resets the thread sessions resets the access engine too (`resetAccessSession()`). Pinned
// end to end on the delete and the test swap seam, and by a source scan (the TypeScript parser,
// with planted-omission proofs) over every call of `resetThreadSessions`.
//
// The real memory user db; the engine's clock is its injected seam.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { ACCESS_CHANGED_EVENT, FRAME_TYPES, PROTOCOL_VERSION, SIDECAR_SYMBOLIC_HOST, type AccessRequestFrame } from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAccessHandlerFor } from '../access/accessHandler.js';
import { suspendAccessForAppVersion } from '../access/appDrift.js';
import { collectSources, pendingAccessStore } from '../access/consent.js';
import { ACCESS_APP_MESSAGES } from '../access/copy.js';
import { __setAccessDepsForTests, accessRevisionStore, createGrantFromDecision, findAccessGrant, resetAccessSession, revokeAccess, type AnyAccessGrant } from '../access/grants.js';
import { resetScopedReadForTests } from '../access/scopedRead.js';
import { scheduleRevisionStore } from '../platform/signals.js';
import { registerAppHost } from '../state/appHosts.js';
import { onAppVersionChanged } from '../state/appVersionChanged.js';
import { createUserDbLibrary } from '../state/library.js';
import { invalidateNetGrants } from '../state/net.js';
import { resetUserDbForTests } from '../state/userdb.js';
import { installTestUserDb } from './userdbTestHelper.js';

const T0 = Date.parse('2026-10-10T09:00:00.000Z');
const NOW = new Date(T0 + 60_000).toISOString();
const DAY = 86_400_000;

let db: UserDb;
let budget: string;
let ledger: string;
let pantry: string;
let rings: Array<{ appId: string; event: string; data: unknown }>;
let unregister: Array<() => void>;

async function seedSource(appId: string, ddl: string[], inserts: string[]): Promise<void> {
  await db.applyAppDdl(appId, ddl);
  for (const sql of inserts) {
    await db.driver.handle(appId, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `seed-${Math.random()}`, instanceId: 'seed', op: 'exec', sql });
  }
}

function listen(appId: string): void {
  unregister.push(registerAppHost(appId, (event, data) => rings.push({ appId, event, data })));
}

async function allow(reader: string, sourceId: string, table: string, duration: 'session' | 'day' | 'week' | 'always'): Promise<AnyAccessGrant> {
  const ranked = await collectSources(db, reader);
  const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === sourceId);
  if (source === undefined) throw new Error('no such candidate');
  return createGrantFromDecision(db, {
    readerAppId: reader,
    source,
    tables: [table],
    duration,
    unattended: false,
    purpose: 'to show spending by category',
    provenance: 'app',
    generation: 0,
    now: T0,
  });
}

const statusOf = (id: string) => {
  const found = findAccessGrant(db, id);
  return found === undefined ? undefined : { status: found.grant.status, suspendedReason: found.grant.suspendedReason };
};
const linesOf = (sourceId: string) => db.listAccessLog(sourceId).map((entry) => ({ kind: entry.kind, grantId: entry.grantId, reason: entry.reason }));

/** Budget reads Ledger (a day, persisted) and Pantry (while it's open, in memory); Pantry reads Budget; a week of Pantry was stopped. */
async function seedGrants(): Promise<{ readsLedger: AnyAccessGrant; readsPantry: AnyAccessGrant; readBy: AnyAccessGrant; stopped: AnyAccessGrant }> {
  const readsLedger = await allow(budget, ledger, 'transactions', 'day');
  const readsPantry = await allow(budget, pantry, 'items', 'session');
  const readBy = await allow(pantry, budget, 'budgets', 'day');
  const stopped = await allow(budget, pantry, 'items', 'week');
  await revokeAccess(stopped.id);
  rings = [];
  return { readsLedger, readsPantry, readBy, stopped };
}

beforeEach(async () => {
  resetAccessSession();
  resetScopedReadForTests();
  rings = [];
  unregister = [];
  db = await installTestUserDb();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => T0 });
  budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
  ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
  pantry = db.installApp({ displayName: 'Pantry', html: '<!doctype html><title>p</title>' }).appId;
  await seedSource(budget, ['CREATE TABLE budgets (category TEXT, cap INTEGER)'], ["INSERT INTO budgets VALUES ('food', 400)"]);
  await seedSource(ledger, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER, category TEXT)'], ['INSERT INTO transactions (amount, category) VALUES (450, \'food\')']);
  await seedSource(pantry, ['CREATE TABLE items (name TEXT, qty INTEGER)'], ["INSERT INTO items VALUES ('rice', 2)"]);
  // Both readers' views are open: a session grant lives only while its reader is, and a ring needs a live frame.
  listen(budget);
  listen(pantry);
});

afterEach(() => {
  for (const off of unregister) off();
  resetAccessSession();
  resetScopedReadForTests();
  __setAccessDepsForTests();
});

describe('suspendAccessForAppVersion — the reader side of E8 (AC21)', () => {
  for (const source of ['shared', 'agent'] as const) {
    it(`a ${source} update of the READER pauses every live access it holds — persisted and in memory — 'reader-updated', a line on each source, the reader rung once per access`, async () => {
      const { readsLedger, readsPantry, readBy, stopped } = await seedGrants();
      const revision = accessRevisionStore.get();
      const pantryLinesBefore = linesOf(pantry).length; // the history is newest first

      expect(suspendAccessForAppVersion(db, budget, 2, source, NOW)).toBe(2);

      expect(statusOf(readsLedger.id)).toEqual({ status: 'suspended', suspendedReason: 'reader-updated' });
      expect(statusOf(readsPantry.id)).toEqual({ status: 'suspended', suspendedReason: 'reader-updated' });
      expect(db.getAccessGrant(readsLedger.id)?.updatedAt).toBe(NOW);
      // The history is the SOURCE's: one `suspended` line each, with the reason.
      expect(linesOf(ledger)[0]).toEqual({ kind: 'suspended', grantId: readsLedger.id, reason: 'reader-updated' });
      expect(linesOf(pantry).slice(0, linesOf(pantry).length - pantryLinesBefore)).toEqual([{ kind: 'suspended', grantId: readsPantry.id, reason: 'reader-updated' }]);
      // Rung: the READER's live frame, ids only — once per access, and never the other app.
      expect(rings).toHaveLength(2);
      expect(rings.every((ring) => ring.appId === budget && ring.event === ACCESS_CHANGED_EVENT)).toBe(true);
      expect(rings.map((ring) => ring.data).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual(
        [{ grantId: readsLedger.id }, { grantId: readsPantry.id }].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      );
      expect(accessRevisionStore.get()).toBeGreaterThan(revision);
      // What the updated app GIVES is not its own update's business; a stopped access stays stopped.
      expect(statusOf(readBy.id)).toEqual({ status: 'active', suspendedReason: undefined });
      expect(statusOf(stopped.id)?.status).toBe('revoked');
      expect(linesOf(budget).filter((line) => line.kind === 'suspended')).toEqual([]);
    });
  }

  for (const source of ['own', 'starter'] as const) {
    it(`a ${source === 'own' ? 'builder edit (the user’s own)' : 'starter update'} changes NOTHING: no pause, no line, no ring`, async () => {
      const { readsLedger, readsPantry } = await seedGrants();
      const before = { ledger: linesOf(ledger), pantry: linesOf(pantry) };
      const revision = accessRevisionStore.get();

      expect(suspendAccessForAppVersion(db, budget, 2, source, NOW)).toBe(0);

      expect(statusOf(readsLedger.id)?.status).toBe('active');
      expect(statusOf(readsPantry.id)?.status).toBe('active');
      expect({ ledger: linesOf(ledger), pantry: linesOf(pantry) }).toEqual(before);
      expect(rings).toEqual([]);
      expect(accessRevisionStore.get()).toBe(revision);
    });
  }

  it('access allowed for THIS version is not drift (E8: "at another version") — and an access already paused is not paused twice', async () => {
    const { readsLedger } = await seedGrants();
    expect(suspendAccessForAppVersion(db, budget, 1, 'shared', NOW)).toBe(0);
    expect(statusOf(readsLedger.id)?.status).toBe('active');

    expect(suspendAccessForAppVersion(db, budget, 2, 'shared', NOW)).toBe(2);
    rings = [];
    const lines = linesOf(ledger).length;
    expect(suspendAccessForAppVersion(db, budget, 3, 'agent', NOW)).toBe(0);
    expect(linesOf(ledger)).toHaveLength(lines);
    expect(rings).toEqual([]);
  });

  it('an access that has run out is not paused (expired is derived, never overwritten by a pause)', async () => {
    const { readsLedger } = await seedGrants();
    const later = new Date(T0 + 2 * DAY).toISOString();
    expect(suspendAccessForAppVersion(db, budget, 2, 'shared', later)).toBe(1); // only the session grant
    expect(statusOf(readsLedger.id)?.status).toBe('active');
  });

  it('an app that reads nothing answers 0 and writes nothing', () => {
    expect(suspendAccessForAppVersion(db, ledger, 2, 'shared', NOW)).toBe(0);
    expect(rings).toEqual([]);
  });
});

// ------------------------------------------------------------------------------- the ONE fan-out

type TaskRow = Parameters<UserDb['putScheduledTask']>[0];
const CREATED = '2026-10-01T00:00:00.000Z';
const scheduleNaming = (appId: string, version: number): TaskRow => ({
  id: `names-${version}`,
  title: 'Nightly',
  enabled: true,
  enabledAt: CREATED,
  provenance: 'user',
  steps: [{ kind: 'app-think', appId, prompt: 'sum it', context: { maxRows: 50 } }],
  spec: { kind: 'every', n: 1, unit: 'hours', tz: 'UTC' },
  cron: '0 * * * *',
  missedPolicy: 'ask',
  staleAfterMs: 7 * DAY,
  alert: 'inbox',
  appVersions: { [appId]: version },
  createdAt: CREATED,
  updatedAt: CREATED,
  consecutiveFailures: 0,
  unseenResults: 0,
});

describe('onAppVersionChanged — ONE fan-out: the schedules AND the access (AC14, D18)', () => {
  it('a shared update pauses the schedule naming the reader at its old version and suspends its access — and says how many of each', async () => {
    const { readsLedger } = await seedGrants();
    db.putScheduledTask(scheduleNaming(budget, 1));
    const schedules = scheduleRevisionStore.get();
    expect(onAppVersionChanged(db, budget, 2, 'shared', NOW)).toEqual({ schedulesPaused: 1, accessSuspended: 2 });
    expect(db.getScheduledTask('names-1')).toMatchObject({ enabled: false, pausedReason: 'app-updated' });
    expect(scheduleRevisionStore.get()).toBe(schedules + 1);
    expect(statusOf(readsLedger.id)).toEqual({ status: 'suspended', suspendedReason: 'reader-updated' });
  });

  it('an agent update does the same', async () => {
    await seedGrants();
    db.putScheduledTask(scheduleNaming(budget, 1));
    expect(onAppVersionChanged(db, budget, 2, 'agent', NOW)).toEqual({ schedulesPaused: 1, accessSuspended: 2 });
  });

  it('the user’s own edit and a starter update pause NOTHING on either side', async () => {
    const { readsLedger } = await seedGrants();
    db.putScheduledTask(scheduleNaming(budget, 1));
    expect(onAppVersionChanged(db, budget, 2, 'own', NOW)).toEqual({ schedulesPaused: 0, accessSuspended: 0 });
    expect(onAppVersionChanged(db, budget, 2, 'starter', NOW)).toEqual({ schedulesPaused: 0, accessSuspended: 0 });
    expect(db.getScheduledTask('names-1')).toMatchObject({ enabled: true });
    expect(statusOf(readsLedger.id)?.status).toBe('active');
  });
});

// ------------------------------------------------------------- the connection-approve seam (AC14)

describe('invalidateNetGrants — a connection change re-checks the app as a SOURCE (AC14, D6)', () => {
  it('an app that now holds a WhatsApp fact pauses every live access to it `source-restricted` — the connection act is not held up for it', async () => {
    const { readsLedger, readsPantry } = await seedGrants();
    db.putDeclaredConnection(
      ledger,
      'whatsapp',
      { slot: 'whatsapp', provider: { name: 'WhatsApp' }, kind: 'linked_device', declaredApiHosts: [SIDECAR_SYMBOLIC_HOST] } as Parameters<UserDb['putDeclaredConnection']>[2],
      'starter',
    );
    expect(invalidateNetGrants(ledger)).toBeUndefined(); // synchronous for its caller; the re-check runs behind it
    await vi.waitFor(() => expect(statusOf(readsLedger.id)).toEqual({ status: 'suspended', suspendedReason: 'source-restricted' }));
    expect(statusOf(readsPantry.id)?.status).toBe('active');
  });

  it('twin: a connection change on an app with no WhatsApp fact pauses nothing', async () => {
    const { readsLedger } = await seedGrants();
    const lines = linesOf(ledger).length;
    invalidateNetGrants(ledger);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(statusOf(readsLedger.id)?.status).toBe('active');
    expect(linesOf(ledger)).toHaveLength(lines);
  });
});

// ------------------------------------------------------------------------------- the source scan

const APPS = path.resolve(__dirname, '..', '..', '..');
const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

/** Every non-test source under `dir`. */
function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourcesUnder(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** The direct CALLS of either pause function in `code` (a definition `function name(` is not a call). */
function directPauseCalls(code: string): string[] {
  return [...strip(code).matchAll(/(\bfunction\s+)?\b(pauseSchedulesForAppVersion|suspendAccessForAppVersion)\s*\(/g)].filter((match) => match[1] === undefined).map((match) => match[2]!);
}

const callsOf = (code: string, name: string): number => [...strip(code).matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))].length;

describe('the fan-out is the ONLY caller (a source scan — AC14)', () => {
  const FAN_OUT = path.join(APPS, 'playground', 'src', 'state', 'appVersionChanged.ts');
  const files = [...sourcesUnder(path.join(APPS, 'playground', 'src')), ...sourcesUnder(path.join(APPS, 'host', 'src'))];

  it('the walk is not vacuous: it reaches the three call sites, both definitions and the fan-out', () => {
    for (const rel of ['playground/src/share/installShared.ts', 'host/src/handin.ts', 'playground/src/schedule/acts.ts', 'playground/src/schedule/appDrift.ts', 'playground/src/access/appDrift.ts']) {
      expect(files, rel).toContain(path.join(APPS, rel));
    }
    expect(files).toContain(FAN_OUT);
  });

  it('no module but `state/appVersionChanged.ts` calls `pauseSchedulesForAppVersion` or `suspendAccessForAppVersion`', () => {
    const offenders = files.filter((file) => file !== FAN_OUT && directPauseCalls(readFileSync(file, 'utf8')).length > 0).map((file) => path.relative(APPS, file));
    expect(offenders).toEqual([]);
    // …and the fan-out calls BOTH.
    expect(directPauseCalls(readFileSync(FAN_OUT, 'utf8')).sort()).toEqual(['pauseSchedulesForAppVersion', 'suspendAccessForAppVersion']);
  });

  it('the three places an app changes under the user call the fan-out — the hand-in from BOTH of its call expressions', () => {
    expect(callsOf(readFileSync(path.join(APPS, 'playground/src/share/installShared.ts'), 'utf8'), 'onAppVersionChanged')).toBe(1);
    expect(callsOf(readFileSync(path.join(APPS, 'host/src/handin.ts'), 'utf8'), 'onAppVersionChanged')).toBe(2);
    expect(callsOf(readFileSync(path.join(APPS, 'playground/src/schedule/acts.ts'), 'utf8'), 'onAppVersionChanged')).toBe(1);
  });

  it('PLANTED-CALL PROOF: the scan sees a direct call (either function, any spacing), and ignores a definition and a comment', () => {
    expect(directPauseCalls("if (x) pauseSchedulesForAppVersion(db, appId, 2, 'shared', now);")).toEqual(['pauseSchedulesForAppVersion']);
    expect(directPauseCalls('const n = suspendAccessForAppVersion (db, id, v, s, t);')).toEqual(['suspendAccessForAppVersion']);
    expect(directPauseCalls('export function pauseSchedulesForAppVersion(db: UserDb): number {')).toEqual([]);
    expect(directPauseCalls('// pauseSchedulesForAppVersion(db, appId, …) used to be called here\n/* suspendAccessForAppVersion(x) */')).toEqual([]);
    const installShared = readFileSync(path.join(APPS, 'playground/src/share/installShared.ts'), 'utf8');
    expect(directPauseCalls(`${installShared}\npauseSchedulesForAppVersion(db, appId, 3, 'shared', 'now');`)).toEqual(['pauseSchedulesForAppVersion']);
  });
});

// ---------------------------------------------------------------------------------------------
// The reset seams (AC14): a delete and every file swap drop the access engine's memory
// ---------------------------------------------------------------------------------------------

const askFrame = (): AccessRequestFrame => ({ v: PROTOCOL_VERSION, type: FRAME_TYPES.accessRequest, requestId: 'ask-1', instanceId: 'i1', op: 'request', purpose: 'to show spending' });

describe('the reset seams — behaviour through the real seams (AC14)', () => {
  it('deleting the READER through the library drops its session access and its held ask (answered not now, nothing recorded) — a sibling app’s access survives', async () => {
    const readerSession = await allow(budget, ledger, 'transactions', 'session');
    const siblingSession = await allow(pantry, ledger, 'transactions', 'session');
    const siblingPersisted = await allow(pantry, ledger, 'transactions', 'day');
    const held = createAccessHandlerFor(budget, { attended: true, generation: 0 }).handle(budget, askFrame());
    await expect.poll(() => pendingAccessStore.get()[budget], { timeout: 3000 }).toBeDefined();

    await createUserDbLibrary(() => Promise.resolve(db)).delete(budget);

    expect(findAccessGrant(db, readerSession.id), 'the deleted reader’s session access is gone').toBeUndefined();
    expect(pendingAccessStore.get()[budget]).toBeUndefined();
    expect(await held).toEqual({ ok: false, code: 'ACCESS_DECLINED', message: ACCESS_APP_MESSAGES.notNow, retryable: true });
    expect(db.listAccessDeclines(budget)).toEqual([]);
    expect(statusOf(siblingSession.id)).toEqual({ status: 'active', suspendedReason: undefined });
    expect(statusOf(siblingPersisted.id)).toEqual({ status: 'active', suspendedReason: undefined });
  });

  it('deleting the SOURCE through the library drops every session access that reads it', async () => {
    const readsPantry = await allow(budget, pantry, 'items', 'session');
    const readsLedger = await allow(budget, ledger, 'transactions', 'session');
    await createUserDbLibrary(() => Promise.resolve(db)).delete(pantry);
    expect(findAccessGrant(db, readsPantry.id)).toBeUndefined();
    expect(statusOf(readsLedger.id)).toEqual({ status: 'active', suspendedReason: undefined });
  });

  it('the file-swap seam (resetUserDbForTests, the same list as restore / recover / import / pull) drops every session access and every held ask', async () => {
    const session = await allow(budget, ledger, 'transactions', 'session');
    const held = createAccessHandlerFor(budget, { attended: true, generation: 0 }).handle(budget, askFrame());
    await expect.poll(() => pendingAccessStore.get()[budget], { timeout: 3000 }).toBeDefined();
    resetUserDbForTests();
    expect(findAccessGrant(db, session.id)).toBeUndefined();
    expect(pendingAccessStore.get()).toEqual({});
    expect(await held).toEqual({ ok: false, code: 'ACCESS_DECLINED', message: ACCESS_APP_MESSAGES.notNow, retryable: true });
  });
});

/**
 * Every `resetThreadSessions(…)` call in `code` that is NOT paired, inside the same function, with
 * the access engine's reset: no argument → `resetAccessSession()`; `{ appId: X }` →
 * `resetAccessSession(X)`. A thread-only reset (`{ threadId }`) is neither a swap nor a delete.
 */
function unpairedResets(code: string, file = 'scan.ts'): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const callsNamed = (root: ts.Node, name: string): ts.CallExpression[] => {
    const out: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) out.push(node);
      ts.forEachChild(node, visit);
    };
    visit(root);
    return out;
  };
  const enclosingFunction = (node: ts.Node): ts.Node => {
    let at: ts.Node = node.parent;
    while (!ts.isSourceFile(at) && !ts.isFunctionLike(at)) at = at.parent;
    return at;
  };
  const missing: string[] = [];
  for (const call of callsNamed(source, 'resetThreadSessions')) {
    const arg = call.arguments[0];
    let expected: string | undefined; // '' = no argument
    if (arg === undefined) expected = '';
    else if (ts.isObjectLiteralExpression(arg)) {
      const appId = arg.properties.find((property) => property.name !== undefined && ts.isIdentifier(property.name) && property.name.text === 'appId');
      if (appId === undefined) continue; // a thread reset
      expected = ts.isShorthandPropertyAssignment(appId) ? appId.name.text : ts.isPropertyAssignment(appId) ? appId.initializer.getText(source) : '?';
    } else expected = '?'; // a form the scan does not know is never assumed paired
    const paired = callsNamed(enclosingFunction(call), 'resetAccessSession').some((reset) =>
      expected === '' ? reset.arguments.length === 0 : reset.arguments.length === 1 && reset.arguments[0]!.getText(source) === expected,
    );
    if (!paired) missing.push(`${file}:${source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1} ${call.getText(source)}`);
  }
  return missing;
}

describe('the reset seams — a source scan: every thread-session reset is paired with the access reset (AC14)', () => {
  const files = sourcesUnder(path.join(APPS, 'playground', 'src'));
  const read = (rel: string): string => readFileSync(path.join(APPS, 'playground', 'src', rel), 'utf8');

  it('the walk is not vacuous: it reaches the swap seams in userdb.ts and sync.ts and the delete in library.ts', () => {
    const withResets = files.filter((file) => /\bresetThreadSessions\s*\(/.test(readFileSync(file, 'utf8'))).map((file) => path.relative(path.join(APPS, 'playground', 'src'), file));
    for (const rel of [path.join('state', 'userdb.ts'), path.join('state', 'sync.ts'), path.join('state', 'library.ts')]) expect(withResets).toContain(rel);
  });

  it('every resetThreadSessions() in the tree is paired with resetAccessSession() — and { appId: id } with resetAccessSession(id)', () => {
    const offenders = files.flatMap((file) => unpairedResets(readFileSync(file, 'utf8'), path.relative(APPS, file)));
    expect(offenders).toEqual([]);
  });

  it('PLANTED-OMISSION PROOF: dropping either reset — or pairing the wrong id — is caught; a thread-only reset is not a seam', () => {
    const library = read(path.join('state', 'library.ts'));
    expect(unpairedResets(library)).toEqual([]);
    expect(unpairedResets(library.replace('resetAccessSession(id);', ''))).toHaveLength(1);
    expect(unpairedResets(library.replace('resetAccessSession(id);', 'resetAccessSession(otherId);'))).toHaveLength(1);
    const userdb = read(path.join('state', 'userdb.ts'));
    expect(unpairedResets(userdb)).toEqual([]);
    expect(unpairedResets(userdb.replace(/resetAccessSession\(\);/, ''))).toHaveLength(1);
    const sync = read(path.join('state', 'sync.ts'));
    expect(unpairedResets(sync.replace(/resetAccessSession\(\);/, ''))).toHaveLength(1);
    // a reset in ANOTHER function does not pair
    expect(unpairedResets('function a() { resetThreadSessions(); }\nfunction b() { resetAccessSession(); }')).toHaveLength(1);
    expect(unpairedResets('function t(threadId: string) { resetThreadSessions({ threadId }); }')).toEqual([]);
  });
});
