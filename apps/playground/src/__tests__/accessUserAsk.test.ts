// accessUserAsk.test.ts — TASK-20261010-host-broker PR-5: the user's ask from host chrome gains its
// three PR-5 forms and its two fixes (contract v2 D-PR5-3, D-PR5-4, D-PR5-5, D-PR5-15; AC33 UI
// half, AC34, AC35; S10, S16, D1, D4).
//
// `startUserAsk(reader, opts)` — `access/userAsk.ts`, THE recipe every surface's act goes through:
//
//   - DECLARED `{declared: want, source?}` (Settings' *review…*, the Hub's *could read…*, the
//     reader's ⋈ pair act): RE-READS the reader's declaration (`getAccessWants`) and answers
//     `{kind: 'not-offered', reason: 'gone'}` unless a deep-equal want is still declared (S16a); parks
//     a USER ask (`provenance: 'user'`) with `askedIn: 'declared'`, the want's hints and its hash,
//     the sheet showing the APP's purpose — while the grant persists the HOST's words
//     `ACCESS_SHEET.declaredPurpose(reader)` (S16c). Preselection ticks ONLY table-tier tables (an
//     exact hint table, or a hint word inside an offerable table's name) — never the every-table
//     fallback; no table-tier match → the source chosen, nothing ticked; never write, kv, refresh,
//     the away box or a non-default duration (S10). *don't allow* RECORDS the want's
//     `accessRequestHash` decline (the app's identical runtime ask then answers declined).
//   - PAIR `{declared, source}`: the sheet PINNED to that source; a source `collectSources` would
//     not offer answers `{kind: 'not-offered', reason}` BEFORE anything parks.
//   - OFFER `{source, offer: true}` (the source's ⋈ offer): the pending carries `offeredBy:
//     'source'`, is pinned to the source, provenance `'user'`, purpose `ACCESS_SHEET.userPurpose`.
//   - T1: a call carrying any of `{declared, source, offer}` DISMISSES an older pending for that
//     reader (nothing recorded — the user's act wins) and parks anew. T2: on the yield rule it
//     answers `{kind: 'answer-other-first'}` WITHOUT parking. The BARE form keeps today's
//     behaviour (pinned below — green today).
//   - D-PR5-15: the chat's ask carries `access: 'write'` → `wantsWrite`, and the SAME
//     `accessRequestHash({hints, access})` the tool hashes.
//
// The real memory user db; apps declare through their own HTML (the meta KB 87 teaches). The new
// options are typed LOCALLY until userAsk.ts exports them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { ACCESS_SOURCE_MAX_BYTES, SIDECAR_SYMBOLIC_HOST, accessRequestHash } from '@snugprotocol/protocol';

import { accessAskLadder, collectSources, parkAccessRequest, pendingAccessStore, reviewStore, type ConsentOutcome, type PendingAccessRequest } from '../access/consent.js';
import { ACCESS_SHEET } from '../access/copy.js';
import * as copy from '../access/copy.js';
import { __setAccessDepsForTests, grantsForApp, resetAccessSession } from '../access/grants.js';
import { sheetSeedOf, startUserAsk } from '../access/userAsk.js';
import { netConfirmStore, type PendingNetConfirm } from '../state/net.js';
import { openUrlConfirmStore } from '../state/openUrl.js';
import { installTestUserDb } from './userdbTestHelper.js';

// ------------------------------------------------------------------- the PR-5 seats, locally

interface Want {
  purpose: string;
  hints?: { tables?: string[]; words?: string[] };
}
interface UserAskOptionsV5 {
  declared?: Want;
  source?: string;
  offer?: boolean;
  ask?: { purpose: string; hints?: Want['hints']; access?: 'read' | 'write' };
}
type UserAskAnswerV5 = 'opened' | 'answer-other-first' | 'no-app' | { kind: 'not-offered'; reason: string } | { kind: 'answer-other-first' };
const ask = startUserAsk as unknown as (readerAppId: string, opts?: UserAskOptionsV5) => Promise<UserAskAnswerV5>;
/** The pending's PR-5 seats (consent.ts). */
type PendingV5 = PendingAccessRequest & { askedIn?: 'chat' | 'declared'; offeredBy?: 'source' };
const pendingOf = (readerAppId: string): PendingV5 | undefined => pendingAccessStore.get()[readerAppId] as PendingV5 | undefined;
const DECLARED_PURPOSE = (copy as unknown as { ACCESS_SHEET: { declaredPurpose(readerName: string): string } }).ACCESS_SHEET;

/** The allow decision v2 (D-PR3-23). */
interface TableChoiceV2 {
  name: string;
  withheld: string[];
  write: boolean;
}
type AllowV2 = { kind: 'allow'; sourceAppId: string; tables: TableChoiceV2[]; duration: 'session' | 'day' | 'week' | 'always'; unattended: boolean; kv: boolean; refresh: boolean };
const resolveV2 = (pending: PendingAccessRequest, decision: AllowV2 | { kind: 'dont-allow' } | { kind: 'not-now' }): Promise<ConsentOutcome> =>
  (pending.resolve as unknown as (d: unknown) => Promise<ConsentOutcome>)(decision);

// ----------------------------------------------------------------------------------- fixtures

const T0 = Date.parse('2026-10-10T09:00:00.000Z');
const SPENDING: Want = { purpose: 'to show spending by category', hints: { tables: ['transactions'], words: ['category'] } };

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
    '</head>',
    '<body><div id="root"></div></body>',
    '</html>',
  ].join('\n');
}

let db: UserDb;
let budget: string;
let ledger: string;
let pantry: string;
let notes: string;

function holdWhatsApp(appId: string): void {
  db.putDeclaredConnection(
    appId,
    'whatsapp',
    { slot: 'whatsapp', provider: { name: 'WhatsApp' }, kind: 'linked_device', declaredApiHosts: [SIDECAR_SYMBOLIC_HOST] } as Parameters<UserDb['putDeclaredConnection']>[2],
    'starter',
  );
}

const netConfirm = (): PendingNetConfirm => ({ request: {} as PendingNetConfirm['request'], resolve: () => undefined });
const offeredIds = (pending: PendingAccessRequest | undefined): string[] => (pending === undefined ? [] : [...pending.candidates.matched, ...pending.candidates.rest].map((c) => c.appId));

beforeEach(async () => {
  resetAccessSession();
  pendingAccessStore.set({});
  reviewStore.set(undefined);
  netConfirmStore.set(null);
  openUrlConfirmStore.set(null);
  db = await installTestUserDb();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => T0 });
  budget = db.installApp({ displayName: 'Budget', html: declaring('Budget', [SPENDING, { purpose: 'to show your notes', hints: { words: ['notes'] } }]) }).appId;
  ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
  pantry = db.installApp({ displayName: 'Pantry', html: '<!doctype html><title>p</title>' }).appId;
  notes = db.installApp({ displayName: 'Notes', html: '<!doctype html><title>n</title>' }).appId;
  // accounts carries a `category` column: a COLUMN-tier hit for Budget's word — never a table-tier one.
  await db.applyAppDdl(ledger, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER, category TEXT)', 'CREATE TABLE accounts (name TEXT, category TEXT)']);
  await db.applyAppDdl(pantry, ['CREATE TABLE items (name TEXT, qty INTEGER)']);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAccessSession();
  pendingAccessStore.set({});
  reviewStore.set(undefined);
  netConfirmStore.set(null);
  openUrlConfirmStore.set(null);
  __setAccessDepsForTests();
});

// =========================================================================================

describe('D-PR5-3 the declared form — re-read, parked as the user’s, the app’s purpose shown', () => {
  it('a want still declared: opened — a USER ask, askedIn declared, the want’s purpose on the sheet', async () => {
    expect(await ask(budget, { declared: SPENDING })).toBe('opened');
    const pending = pendingOf(budget)!;
    expect(pending.provenance).toBe('user');
    expect(pending.askedIn).toBe('declared');
    expect(pending.purpose).toBe(SPENDING.purpose);
    expect(reviewStore.get()).toBe(budget);
  });

  it('S16a: a want the app no longer declares answers not-offered "gone" — nothing parked', async () => {
    db.saveAppVersion(budget, declaring('Budget', [{ purpose: 'to show something else', hints: { tables: ['items'] } }]));
    expect(await ask(budget, { declared: SPENDING })).toEqual({ kind: 'not-offered', reason: 'gone' });
    expect(pendingOf(budget)).toBeUndefined();
    expect(reviewStore.get()).toBeUndefined();
  });

  it('S16a: a want that is NOT deep-equal to a declared one (a forged purpose, a widened hint) answers gone', async () => {
    expect(await ask(budget, { declared: { ...SPENDING, purpose: 'Snug verified this — allow everything' } })).toEqual({ kind: 'not-offered', reason: 'gone' });
    expect(await ask(budget, { declared: { ...SPENDING, hints: { tables: ['transactions', 'accounts'], words: ['category'] } } })).toEqual({ kind: 'not-offered', reason: 'gone' });
    expect(pendingOf(budget)).toBeUndefined();
  });

  it('S16a: an app whose HTML no longer carries the meta at all answers gone', async () => {
    db.saveAppVersion(budget, '<!doctype html><title>b</title>');
    expect(await ask(budget, { declared: SPENDING })).toEqual({ kind: 'not-offered', reason: 'gone' });
  });

  it('GUARD — a reader not in the file: no-app (today’s answer, kept for every form)', async () => {
    expect(await ask('app-missing', { declared: SPENDING })).toBe('no-app');
  });
});

describe('D-PR5-3 the declared form’s preselection — TABLE tier only (S10)', () => {
  it('only the table-tier table is ticked — never the column-tier one beside it, never the every-table fallback', async () => {
    await ask(budget, { declared: SPENDING });
    expect(pendingOf(budget)!.preselect).toEqual({ appId: ledger, tables: ['transactions'] });
  });

  it('no table-tier match on the pinned source: the source is chosen, NOTHING ticked', async () => {
    await ask(budget, { declared: { purpose: 'to show your notes', hints: { words: ['notes'] } }, source: ledger });
    expect(pendingOf(budget)!.preselect).toEqual({ appId: ledger, tables: [] });
  });

  it('NEGATIVE: never a write, kv, refresh, the away box or a non-default duration — the sheet starts on its own defaults', async () => {
    await ask(budget, { declared: SPENDING });
    const pending = pendingOf(budget)!;
    expect(pending.askedIn, 'the declared form parked').toBe('declared');
    const seed = sheetSeedOf(pending);
    expect(seed === undefined || (seed.duration === 'session' && !seed.unattended && seed.tables === undefined && seed.kv === undefined && seed.refresh === undefined), JSON.stringify(seed)).toBe(true);
    expect(pending.wantsWrite).toBeUndefined();
  });

  it('NEGATIVE: a declaration never writes a grant — parking it writes nothing, and a not-now writes nothing', async () => {
    await ask(budget, { declared: SPENDING });
    expect(pendingOf(budget)?.askedIn, 'the declared form parked').toBe('declared');
    expect(db.listAccessGrants()).toEqual([]);
    expect(grantsForApp(db, budget, T0).reads).toEqual([]);
    await resolveV2(pendingOf(budget)!, { kind: 'not-now' });
    expect(db.listAccessGrants()).toEqual([]);
    expect(db.listAccessLog(ledger)).toEqual([]);
  });
});

describe('D-PR5-3 the declared form’s answers', () => {
  it('S16c: an allow persists the HOST’s purpose — declaredPurpose(reader) — with provenance user; the app’s words never sit on the record', async () => {
    await ask(budget, { declared: SPENDING });
    const outcome = await resolveV2(pendingOf(budget)!, {
      kind: 'allow',
      sourceAppId: ledger,
      tables: [{ name: 'transactions', withheld: [], write: false }],
      duration: 'day',
      unattended: false,
      kv: false,
      refresh: false,
    });
    expect(outcome.kind).toBe('allowed');
    const grant = db.listAccessGrants()[0]!;
    expect(grant.provenance).toBe('user');
    expect(grant.purpose).toBe(DECLARED_PURPOSE.declaredPurpose('Budget'));
    expect(grant.purpose).toBe('you started this from what Budget said it would like to read');
    expect(JSON.stringify(grant)).not.toContain(SPENDING.purpose);
  });

  it('don’t allow RECORDS the want’s accessRequestHash — and the app’s identical runtime ask then answers declined', async () => {
    await ask(budget, { declared: SPENDING });
    await resolveV2(pendingOf(budget)!, { kind: 'dont-allow' });
    const hash = accessRequestHash({ hints: SPENDING.hints });
    expect(db.listAccessDeclines(budget).map((decline) => decline.hash)).toEqual([hash]);
    expect(accessAskLadder.consume({ appId: budget, generation: 0, ask: { hints: SPENDING.hints }, db })).toBe('declined');
  });

  it('a want WITHOUT hints has nothing to record a no against: don’t allow records nothing', async () => {
    const bare: Want = { purpose: 'to read along' };
    db.saveAppVersion(budget, declaring('Budget', [bare]));
    await ask(budget, { declared: bare, source: ledger });
    expect(pendingOf(budget)?.askedIn, 'the declared form parked').toBe('declared');
    await resolveV2(pendingOf(budget)!, { kind: 'dont-allow' });
    expect(db.listAccessDeclines(budget)).toEqual([]);
  });
});

describe('D-PR5-4 the pair form {declared, source} — pinned; not-offered BEFORE anything parks', () => {
  it('the sheet is PINNED to the source: the one candidate it offers, preselected', async () => {
    expect(await ask(budget, { declared: SPENDING, source: ledger })).toBe('opened');
    const pending = pendingOf(budget)!;
    expect(offeredIds(pending)).toEqual([ledger]);
    expect(pending.preselect?.appId).toBe(ledger);
    expect(pending.askedIn).toBe('declared');
  });

  it.each([
    ['too-large', async () => {
      const real = db.exportAppRuntime.bind(db);
      vi.spyOn(db, 'exportAppRuntime').mockImplementation(async (appId: string) => (appId === ledger ? new Uint8Array(ACCESS_SOURCE_MAX_BYTES + 1) : real(appId)));
      return ledger;
    }],
    ['sidecar', async () => {
      holdWhatsApp(ledger);
      return ledger;
    }],
    ['no-tables', async () => notes],
    ['reader', async () => budget],
  ] as const)('a source collectSources would not offer (%s) answers not-offered with that reason — nothing parked, no sheet', async (reason, sourceOf) => {
    const source = await sourceOf();
    expect(await ask(budget, { declared: SPENDING, source })).toEqual({ kind: 'not-offered', reason });
    expect(pendingOf(budget)).toBeUndefined();
    expect(reviewStore.get()).toBeUndefined();
  });

  it('a source no longer in the file answers not-offered "gone"', async () => {
    expect(await ask(budget, { declared: SPENDING, source: 'app-deleted' })).toEqual({ kind: 'not-offered', reason: 'gone' });
    expect(pendingOf(budget)).toBeUndefined();
  });
});

describe('D-PR5-5 the offer form {source, offer: true} — the source offers itself', () => {
  it('parks a USER ask carrying offeredBy source, pinned to the source, with the host’s purpose', async () => {
    expect(await ask(budget, { source: ledger, offer: true })).toBe('opened');
    const pending = pendingOf(budget)!;
    expect(pending.offeredBy).toBe('source');
    expect(pending.provenance).toBe('user');
    expect(pending.purpose).toBe(ACCESS_SHEET.userPurpose('Budget'));
    expect(offeredIds(pending)).toEqual([ledger]);
    expect(pending.preselect?.appId).toBe(ledger);
    expect(pending.askedIn).toBeUndefined();
  });

  it('an allow writes a user access with the host’s purpose', async () => {
    await ask(budget, { source: ledger, offer: true });
    expect(pendingOf(budget)?.offeredBy, 'the offer form parked').toBe('source');
    const outcome = await resolveV2(pendingOf(budget)!, {
      kind: 'allow',
      sourceAppId: ledger,
      tables: [{ name: 'transactions', withheld: [], write: false }],
      duration: 'day',
      unattended: false,
      kv: false,
      refresh: false,
    });
    expect(outcome.kind).toBe('allowed');
    const grant = db.listAccessGrants()[0]!;
    expect(grant.provenance).toBe('user');
    expect(grant.purpose).toBe(ACCESS_SHEET.userPurpose('Budget'));
  });

  it('NEGATIVE: a table-less source offers nothing — not-offered no-tables, nothing parked', async () => {
    expect(await ask(budget, { source: notes, offer: true })).toEqual({ kind: 'not-offered', reason: 'no-tables' });
    expect(pendingOf(budget)).toBeUndefined();
  });
});

describe('D-PR5-5 T1 — a PR-5 form dismisses an older pending for the reader and parks anew (the user’s act wins)', () => {
  const forms: ReadonlyArray<[string, () => UserAskOptionsV5]> = [
    ['declared', () => ({ declared: SPENDING })],
    ['pair', () => ({ declared: SPENDING, source: ledger })],
    ['offer', () => ({ source: ledger, offer: true })],
  ];

  it.each(forms)('%s: the app’s older ask is dismissed — nothing recorded — and a NEW pending is parked', async (_name, opts) => {
    const candidates = await collectSources(db, budget);
    const settled = vi.fn();
    const older = parkAccessRequest({ db, reader: db.getApp(budget)!, generation: 0, purpose: 'to tidy up', provenance: 'app', candidates, hash: '0123456789abcdef', settle: settled });
    expect(await ask(budget, opts())).toBe('opened');
    expect(settled).toHaveBeenCalledWith({ kind: 'dismissed' }, undefined);
    const now = pendingOf(budget)!;
    expect(now).not.toBe(older);
    expect(now.provenance).toBe('user');
    expect(db.listAccessDeclines(budget)).toEqual([]);
    expect(db.isAccessMuted(budget)).toBe(false);
  });

  it('GUARD — the BARE form keeps today’s behaviour: an ask already waiting is OPENED, not replaced', async () => {
    const candidates = await collectSources(db, budget);
    const older = parkAccessRequest({ db, reader: db.getApp(budget)!, generation: 0, purpose: 'to tidy up', provenance: 'app', candidates });
    expect(await startUserAsk(budget)).toBe('opened');
    expect(pendingOf(budget)).toBe(older);
  });
});

describe('D-PR5-5 T2 — on the yield rule a PR-5 form answers answer-other-first WITHOUT parking', () => {
  it.each([
    ['declared', (): UserAskOptionsV5 => ({ declared: SPENDING })],
    ['pair', (): UserAskOptionsV5 => ({ declared: SPENDING, source: ledger })],
    ['offer', (): UserAskOptionsV5 => ({ source: ledger, offer: true })],
  ] as const)('%s under an open network confirm: {kind: answer-other-first}, nothing parked, no sheet', async (_name, opts) => {
    netConfirmStore.set(netConfirm());
    expect(await ask(budget, opts())).toEqual({ kind: 'answer-other-first' });
    expect(pendingOf(budget)).toBeUndefined();
    expect(reviewStore.get()).toBeUndefined();
  });

  it('GUARD — the BARE form under the yield rule keeps today’s answer ("answer-other-first", the string) and its parked ask', async () => {
    netConfirmStore.set(netConfirm());
    expect(await startUserAsk(budget)).toBe('answer-other-first');
    expect(pendingOf(budget)?.provenance).toBe('user');
  });

  it('GUARD — the bare form’s answers are byte-compatible: "opened" as a string', async () => {
    expect(await startUserAsk(budget)).toBe('opened');
  });
});

describe('D-PR5-15 the chat’s ask carries access: write', () => {
  const HINTS = { tables: ['transactions'], words: ['category'] };

  it('access: write → the pending wants write, and don’t allow records accessRequestHash({hints, access: write}) — the tool’s hash', async () => {
    await ask(budget, { ask: { purpose: 'to fix the categories', hints: HINTS, access: 'write' } });
    const pending = pendingOf(budget)!;
    expect(pending.askedIn).toBe('chat');
    expect(pending.wantsWrite).toBe(true);
    await resolveV2(pending, { kind: 'dont-allow' });
    expect(db.listAccessDeclines(budget).map((decline) => decline.hash)).toEqual([accessRequestHash({ hints: HINTS, access: 'write' })]);
  });

  it('GUARD — a read ask (no access) keeps today’s hash and no write want', async () => {
    await ask(budget, { ask: { purpose: 'to compare spending', hints: HINTS } });
    const pending = pendingOf(budget)!;
    expect(pending.wantsWrite).toBeUndefined();
    await resolveV2(pending, { kind: 'dont-allow' });
    expect(db.listAccessDeclines(budget).map((decline) => decline.hash)).toEqual([accessRequestHash({ hints: HINTS })]);
  });
});

// =========================================================================================
// TASK-20261010-host-broker PR-5 — Gate-5 fold G5-15 on the user's ask.
//
// IB-5 a PINNED ask describes only the pinned source (`collectSource(db, reader, sourceId)`, the
//      same sidecar, too-large and no-tables rules — pinned above, still green after it): before the
//      fold `collectSources` exported EVERY app on the main thread to offer one.
// IB-6 a declared ask carries `tableTierOnly: true` on the pending (the seat name is this lane's
//      choice) and `parkAccessRequest` never falls back to `preselectionFor` (the every-table rule)
//      for `askedIn: 'declared'`.
// SA-5 the declared preselection takes an exact hint table or a hint word EQUAL to a whole
//      `_`-token (≥ 3 chars): words ['es'] over expenses + notes ticks nothing.
// SA-8 `offeredBy: 'source'` is set on EVERY pinned branch — `{declared, source, offer: true}`
//      dropped it, and the sheet then drew the write toggle the offer must never show.
// =========================================================================================

type PendingG5 = PendingV5 & { tableTierOnly?: true };

describe('G5-15 (IB-5) a pinned ask describes and exports ONLY the pinned source', () => {
  it('G5-15 the pair form in a 4-app file exports at most the pinned source — never the others', async () => {
    const exportSpy = vi.spyOn(db, 'exportAppRuntime');
    const describeSpy = vi.spyOn(db, 'describeAppData');
    expect(await ask(budget, { declared: SPENDING, source: ledger })).toBe('opened');
    const exported = exportSpy.mock.calls.map((call) => call[0]);
    expect(exported.length, exported.join(',')).toBeLessThanOrEqual(1);
    expect(exported.filter((id) => id !== ledger)).toEqual([]);
    expect(describeSpy.mock.calls.map((call) => call[0]).filter((id) => id !== ledger)).toEqual([]);
  });

  it('G5-15 the offer form in a 4-app file exports at most the pinned source', async () => {
    const exportSpy = vi.spyOn(db, 'exportAppRuntime');
    expect(await ask(budget, { source: ledger, offer: true })).toBe('opened');
    expect(exportSpy.mock.calls.map((call) => call[0]).filter((id) => id !== ledger)).toEqual([]);
  });
});

describe('G5-15 (IB-6) a declared ask is table-tier only, wherever it is parked', () => {
  it('G5-15 the unpinned declared ask carries tableTierOnly on its pending', async () => {
    await ask(budget, { declared: SPENDING });
    expect((pendingOf(budget) as PendingG5).tableTierOnly).toBe(true);
  });

  it('G5-15 the pinned declared ask carries it too; the offer and the bare form do not', async () => {
    await ask(budget, { declared: SPENDING, source: ledger });
    expect((pendingOf(budget) as PendingG5).tableTierOnly).toBe(true);
    pendingAccessStore.set({});
    reviewStore.set(undefined);
    await ask(budget, { source: ledger, offer: true });
    expect((pendingOf(budget) as PendingG5).tableTierOnly).toBeUndefined();
  });

  it('G5-15 parkAccessRequest never falls back to the every-table rule for askedIn declared', async () => {
    // A COLUMN-tier match only (Ledger's `category` columns): preselectionFor would tick both of Ledger's tables.
    const hints = { words: ['category'] };
    const candidates = await collectSources(db, budget, hints);
    const pending = parkAccessRequest({
      db,
      reader: db.getApp(budget)!,
      generation: -1,
      provenance: 'user',
      purpose: 'to show spending',
      askedIn: 'declared',
      hints,
      candidates,
    } as Parameters<typeof parkAccessRequest>[0]);
    expect(pending.preselect?.tables ?? []).toEqual([]);
  });
});

describe('G5-15 (SA-5) the declared preselection: a whole `_`-token (≥ 3 chars), never a substring', () => {
  it('G5-15 a want with words ["es"] over a source holding expenses and notes pins nothing ticked', async () => {
    const want: Want = { purpose: 'to read everything', hints: { words: ['es'] } };
    const spree = db.installApp({ displayName: 'Spree', html: declaring('Spree', [want]) }).appId;
    const books = db.installApp({ displayName: 'Books', html: '<!doctype html><title>b</title>' }).appId;
    await db.applyAppDdl(books, ['CREATE TABLE expenses (amount INTEGER)', 'CREATE TABLE notes (body TEXT)']);
    expect(await ask(spree, { declared: want, source: books })).toBe('opened');
    expect(pendingOf(spree)!.preselect).toEqual({ appId: books, tables: [] });
  });
});

describe('G5-15 (SA-8) offeredBy is set on every pinned branch', () => {
  it('G5-15 {declared, source, offer: true} parks with offeredBy source', async () => {
    expect(await ask(budget, { declared: SPENDING, source: ledger, offer: true })).toBe('opened');
    expect(pendingOf(budget)!.offeredBy).toBe('source');
  });

  it('G5-15 a forged WRITE decision on that pending answers failed — no grant written', async () => {
    await ask(budget, { declared: SPENDING, source: ledger, offer: true });
    expect(pendingOf(budget)?.offeredBy, 'the mixed form parked as an offer').toBe('source');
    const outcome = await resolveV2(pendingOf(budget)!, {
      kind: 'allow',
      sourceAppId: ledger,
      tables: [{ name: 'transactions', withheld: [], write: true }],
      duration: 'day',
      unattended: false,
      kv: false,
      refresh: false,
    });
    expect(outcome.kind).toBe('failed');
    expect(db.listAccessGrants()).toEqual([]);
  });
});
