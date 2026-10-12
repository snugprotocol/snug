// accessPairs.test.ts — TASK-20261010-host-broker PR-5, AC34 (contract v2 D-PR5-4; Q15 narrowed;
// S10, S11, F3, SC4, D3): *apps that could work together*, derived ONCE for Settings, the Hub and
// the reader's ⋈ sheet.
//
// `access/pairs.ts` `listPairSuggestions(db, now) → readonly PairSuggestion[]`
// (`{readerAppId, readerName, sourceAppId, sourceName, want, matchedTables, score}`). The signal is
// the access DECLARATION only — the `snug:access-wants` meta the host derives from each app's own
// HTML at every admission (D-PR5-2), read here through `listAccessWants()`. For every reader with a
// declaration — an app that may use access, not muted, asks not switched off in this browser, and
// NOT a share-link install or an imported app (S11) — and each want WITH hints, the sources are
// built from the REGISTERED schema (`getAppSchema` → `registryTables`: no export, no
// `describeAppData`, so a Hub render never copies a runtime) and ranked by `rankPairs`; a pair is
// admitted ONLY on a TABLE-tier match (S10). Excluded: the reader itself, a source holding a
// WhatsApp fact, a source already giving this reader live access, a declined want, and any
// (reader, source) answered *not offered* in this session — a memory cleared on the LIBRARY
// revision (no loop). Deterministic; Settings shows at most `PAIRS_MAX` (5).
//
// The real memory user db; apps declare through their HTML exactly as an agent's app would (the
// meta right after the viewport meta, single-quoted). The module is loaded through a VARIABLE
// specifier, so its absence reds each row on its own.
//
// Q (lane T-B): the session's *not offered* memory is written by `startUserAsk` itself when a
// `{declared, source}` ask answers `not-offered` (every surface's tap goes through it), and
// `PAIRS_MAX` is exported from pairs.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { ACCESS_SOURCE_MAX_BYTES, SIDECAR_SYMBOLIC_HOST, accessRequestHash, type AccessWants } from '@snugprotocol/protocol';

import { NO_ACCESS_ASKS_KEY, collectSources, pendingAccessStore } from '../access/consent.js';
import { __setAccessDepsForTests, createGrantFromDecision, resetAccessSession, revokeAccess, type AnyAccessGrant } from '../access/grants.js';
import { startUserAsk } from '../access/userAsk.js';
import { bumpLibraryRevision } from '../platform/signals.js';
import { installTestUserDb } from './userdbTestHelper.js';

// ------------------------------------------------------------------------- the module, lazily

interface PairSuggestion {
  readerAppId: string;
  readerName: string;
  sourceAppId: string;
  sourceName: string;
  want: AccessWants[number];
  matchedTables: string[];
  score: number;
}
interface PairsModule {
  listPairSuggestions(db: UserDb, now: number): readonly PairSuggestion[];
  PAIRS_MAX: number;
}
const PAIRS_MODULE = '../access/pairs.js';
const pairsModule = (): Promise<PairsModule> => import(/* @vite-ignore */ PAIRS_MODULE) as Promise<PairsModule>;
async function pairs(): Promise<readonly PairSuggestion[]> {
  return (await pairsModule()).listPairSuggestions(db, clock.now);
}
const named = (list: readonly PairSuggestion[]): string[] => list.map((pair) => `${pair.readerName}→${pair.sourceName}`);

// ----------------------------------------------------------------------------------- fixtures

const T0 = Date.parse('2026-10-10T09:00:00.000Z');
const SPENDING = { purpose: 'to show spending by category', hints: { tables: ['transactions'], words: ['category'] } };

/** An app page that DECLARES `wants` the way KB 87 teaches: right after the viewport meta, single-quoted. */
function declaring(title: string, wants: unknown): string {
  const content = JSON.stringify(wants).replace(/&/g, '&amp;').replace(/'/g, '&apos;');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="snug:access-wants" content='${content}'>`,
    `<title>${title}</title>`,
    '<script>window.app = 1</script>',
    '</head>',
    '<body><div id="root"></div></body>',
    '</html>',
  ].join('\n');
}
const plain = (title: string): string => `<!doctype html><html><head><title>${title}</title></head><body></body></html>`;

let db: UserDb;
let clock: { now: number };

async function app(name: string, opts: { wants?: unknown; ddl?: string[]; installSource?: string } = {}): Promise<string> {
  const appId = db.installApp({
    displayName: name,
    html: opts.wants !== undefined ? declaring(name, opts.wants) : plain(name),
    ...(opts.installSource !== undefined ? { installSource: opts.installSource } : {}),
  }).appId;
  // `applyAppDdl` registers the schema (the write-back) — the registry is what the pairs read.
  if (opts.ddl !== undefined && opts.ddl.length > 0) await db.applyAppDdl(appId, opts.ddl);
  return appId;
}

/** A declared WhatsApp connection: the sidecar's symbolic host — the fact, whatever the row's status. */
function holdWhatsApp(appId: string): void {
  db.putDeclaredConnection(
    appId,
    'whatsapp',
    { slot: 'whatsapp', provider: { name: 'WhatsApp' }, kind: 'linked_device', declaredApiHosts: [SIDECAR_SYMBOLIC_HOST] } as Parameters<UserDb['putDeclaredConnection']>[2],
    'starter',
  );
}

async function allow(reader: string, sourceId: string, duration: 'session' | 'day' = 'day'): Promise<AnyAccessGrant> {
  const ranked = await collectSources(db, reader);
  const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === sourceId);
  if (source === undefined) throw new Error('no such candidate');
  return createGrantFromDecision(db, {
    readerAppId: reader,
    source,
    tables: ['transactions'],
    duration,
    unattended: false,
    purpose: 'to show spending',
    provenance: 'app',
    generation: 0,
    now: clock.now,
  });
}

const LEDGER_DDL = ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, category TEXT, api_key TEXT)', 'CREATE TABLE accounts (name TEXT, balance INTEGER)'];

let budget: string;
let ledger: string;

beforeEach(async () => {
  resetAccessSession();
  try {
    localStorage.removeItem(NO_ACCESS_ASKS_KEY);
  } catch {
    /* jsdom always has storage */
  }
  clock = { now: T0 };
  db = await installTestUserDb();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => clock.now });
  budget = await app('Budget', { wants: [SPENDING] });
  ledger = await app('Ledger', { ddl: LEDGER_DDL });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAccessSession();
  __setAccessDepsForTests();
  try {
    localStorage.removeItem(NO_ACCESS_ASKS_KEY);
  } catch {
    /* jsdom always has storage */
  }
});

// =========================================================================================

describe('D-PR5-4 the pair — from declarations only', () => {
  it('a reader’s want WITH hints and a source whose REGISTERED table it names: one pair, with the want, the matched table and a score', async () => {
    const list = await pairs();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ readerAppId: budget, readerName: 'Budget', sourceAppId: ledger, sourceName: 'Ledger', matchedTables: ['transactions'] });
    expect(list[0]!.want).toEqual(SPENDING);
    expect(list[0]!.score).toBeGreaterThan(0);
  });

  it('declarations ONLY (Q15 narrowed): an app that declares nothing never pairs — however well its own tables overlap', async () => {
    const pantry = await app('Pantry', { ddl: ['CREATE TABLE transactions (amount INTEGER)'] });
    const list = await pairs();
    expect(list.map((pair) => pair.readerAppId)).not.toContain(ledger);
    expect(list.map((pair) => pair.readerAppId)).not.toContain(pantry);
  });

  it('a want WITHOUT hints never pairs — nothing to match', async () => {
    await app('Notes', { wants: [{ purpose: 'to read what you wrote' }] });
    expect(named(await pairs())).toEqual(['Budget→Ledger']);
  });

  it('every want of a reader is considered: a second want naming another source pairs too', async () => {
    const pantry = await app('Pantry', { ddl: ['CREATE TABLE items (name TEXT, qty INTEGER)'] });
    const cook = await app('Cook', { wants: [{ purpose: 'to plan meals', hints: { tables: ['items'] } }, { purpose: 'to cost meals', hints: { tables: ['transactions'] } }] });
    const mine = (await pairs()).filter((pair) => pair.readerAppId === cook);
    expect(mine.map((pair) => pair.sourceAppId).sort()).toEqual([ledger, pantry].sort());
    expect(mine.find((pair) => pair.sourceAppId === pantry)?.want).toEqual({ purpose: 'to plan meals', hints: { tables: ['items'] } });
  });
});

describe('D-PR5-4 the sources come from the REGISTERED schema — never an export, never a describe (F3)', () => {
  it('spies on exportAppRuntime and describeAppData see ZERO calls', async () => {
    const exportSpy = vi.spyOn(db, 'exportAppRuntime');
    const describeSpy = vi.spyOn(db, 'describeAppData');
    const list = await pairs();
    expect(list).toHaveLength(1);
    expect(exportSpy).not.toHaveBeenCalled();
    expect(describeSpy).not.toHaveBeenCalled();
  });

  it('an app with NO schema row is absent — even one whose name says what the hint names', async () => {
    await app('Transactions');
    expect(named(await pairs())).toEqual(['Budget→Ledger']);
  });

  it('NEGATIVE: an all-credential table never pairs, even named exactly', async () => {
    await app('Vault', { ddl: ['CREATE TABLE tokens (api_key TEXT, access_token TEXT)'] });
    await app('Signer', { wants: [{ purpose: 'to sign you in', hints: { tables: ['tokens'], words: ['token'] } }] });
    expect(named(await pairs())).toEqual(['Budget→Ledger']);
  });
});

describe('D-PR5-4 a TABLE-tier match only (S10)', () => {
  it('NEGATIVE: a hint matching only a column never pairs', async () => {
    await app('Sums', { wants: [{ purpose: 'to add amounts', hints: { words: ['amount', 'balance'] } }] });
    expect(named(await pairs())).toEqual(['Budget→Ledger']);
  });

  it('a hint word inside a table name pairs ("transaction" finds transactions)', async () => {
    await app('Sums', { wants: [{ purpose: 'to add things up', hints: { words: ['transaction'] } }] });
    expect(named(await pairs()).sort()).toEqual(['Budget→Ledger', 'Sums→Ledger']);
  });

  it('matchedTables names only the table-tier tables', async () => {
    const list = await pairs();
    expect(list[0]!.matchedTables).toEqual(['transactions']);
  });

  it('a hint matching a parsed COLUMN ranks in the column tier: of two sources with the table, the one with the column comes first', async () => {
    await app('Bank', { ddl: ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER)'] });
    const list = await pairs();
    expect(named(list)).toEqual(['Budget→Ledger', 'Budget→Bank']);
    expect(list[0]!.score).toBeGreaterThan(list[1]!.score);
  });
});

describe('D-PR5-4 the exclusions', () => {
  it('the reader itself never pairs — even when its own registered table matches its want', async () => {
    const self = await app('Tally', { wants: [{ purpose: 'to count', hints: { tables: ['tallies'] } }], ddl: ['CREATE TABLE tallies (n INTEGER)'] });
    expect((await pairs()).filter((pair) => pair.readerAppId === self)).toEqual([]);
  });

  it('a muted reader has no pair', async () => {
    db.setAccessMuted(budget, true);
    expect(await pairs()).toEqual([]);
  });

  it('asks switched off in this browser: no pair at all', async () => {
    localStorage.setItem(NO_ACCESS_ASKS_KEY, '1');
    expect(await pairs()).toEqual([]);
  });

  it('S11: a reader installed from a share link has no pair', async () => {
    await app('Shared', { wants: [SPENDING], installSource: 'share:7e2d' });
    expect(named(await pairs())).toEqual(['Budget→Ledger']);
  });

  it('S11: an IMPORTED reader (the appProvenance marker) has no pair — whatever its installSource claims', async () => {
    const starterish = await app('Weather', { wants: [SPENDING], installSource: 'starter:weather' });
    const before = (await pairs()).filter((pair) => pair.readerAppId === starterish);
    expect(before.length, 'a starter reader may pair').toBe(1);
    db.setSetting(`appProvenance:${starterish}`, { imported: true, at: new Date(T0).toISOString() });
    expect((await pairs()).filter((pair) => pair.readerAppId === starterish)).toEqual([]);
  });

  it('an agent hand-in reader still pairs (only share and imported are excluded)', async () => {
    const handed = await app('Handed', { wants: [SPENDING], installSource: 'agent:6f1c1d4e-2b3a-4c5d-8e9f-0a1b2c3d4e5f' });
    expect((await pairs()).some((pair) => pair.readerAppId === handed)).toBe(true);
  });

  it('a source holding a WhatsApp fact never pairs', async () => {
    holdWhatsApp(ledger);
    expect(await pairs()).toEqual([]);
  });

  it('a source already giving this reader LIVE access is excluded — persisted; and it pairs again once that access is stopped', async () => {
    const grant = await allow(budget, ledger, 'day');
    expect(await pairs()).toEqual([]);
    await revokeAccess(grant.id);
    expect(named(await pairs())).toEqual(['Budget→Ledger']);
  });

  it('a live SESSION access excludes the pair too', async () => {
    await allow(budget, ledger, 'session');
    expect(await pairs()).toEqual([]);
  });

  it('an access that EXPIRED no longer excludes the pair', async () => {
    await allow(budget, ledger, 'day');
    clock.now = T0 + 2 * 86_400_000;
    expect(named(await pairs())).toEqual(['Budget→Ledger']);
  });

  it('a declined want (its accessRequestHash on the reader’s declines) is excluded', async () => {
    db.addAccessDecline(budget, accessRequestHash({ hints: SPENDING.hints }), { purpose: SPENDING.purpose, hints: SPENDING.hints, at: new Date(T0).toISOString() });
    expect(await pairs()).toEqual([]);
  });

  it('a (reader, source) answered NOT OFFERED in this session is excluded — until the library revision clears the memory (no loop)', async () => {
    // Ledger over the copy cap: the pair (which never exports) still sees it; the sheet would not offer it.
    const real = db.exportAppRuntime.bind(db);
    vi.spyOn(db, 'exportAppRuntime').mockImplementation(async (appId: string) => (appId === ledger ? new Uint8Array(ACCESS_SOURCE_MAX_BYTES + 1) : real(appId)));
    expect(named(await pairs())).toEqual(['Budget→Ledger']);
    const answer = await (startUserAsk as unknown as (id: string, opts: { declared: unknown; source: string }) => Promise<unknown>)(budget, { declared: SPENDING, source: ledger });
    expect(answer).toEqual({ kind: 'not-offered', reason: 'too-large' });
    expect(pendingAccessStore.get()[budget], 'nothing parked').toBeUndefined();
    expect(await pairs(), 'the session remembers').toEqual([]);
    bumpLibraryRevision();
    expect(named(await pairs()), 'the library revision clears the memory').toEqual(['Budget→Ledger']);
  });
});

describe('D-PR5-4 deterministic; at most PAIRS_MAX shown', () => {
  it('PAIRS_MAX is 5', async () => {
    expect((await pairsModule()).PAIRS_MAX).toBe(5);
  });

  it('the order is score desc, then reader name, then source name — whatever the install order', async () => {
    await app('Accounts', { wants: [{ purpose: 'to show balances', hints: { tables: ['transactions'] } }] });
    await app('Bank', { ddl: ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER)'] });
    const first = named(await pairs());
    // Budget's want also names a column Ledger has (category): its Ledger pair outscores the rest.
    expect(first).toEqual(['Budget→Ledger', 'Accounts→Bank', 'Accounts→Ledger', 'Budget→Bank']);
    expect(named(await pairs())).toEqual(first);
  });

  it('two derivations over the same file answer the same list, value for value', async () => {
    await app('Bank', { ddl: ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER)'] });
    expect(await pairs()).toEqual(await pairs());
  });
});
