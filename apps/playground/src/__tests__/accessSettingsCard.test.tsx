// accessSettingsCard.test.tsx — Settings → *access between apps* (TASK-20261010-cross-app-access
// AC19; ADR-0075 §7; Q15).
//
// Rows: every access across apps through the ONE GrantRow (re-read on the access revision); the
// per-browser *never let apps ask to read other apps' data* switch writes the key the ask ladder
// reads (`NO_ACCESS_ASKS_KEY` — single-homed in consent.ts) and states its custody; per-app
// unmute; *clear history* behind an armed inline confirm (the schedule card's shape) — clears
// the reads, keeps the lifecycle lines; the same creation act, for the app the user picks; and
// the card is mounted in SettingsView only where the host allows access.
//
// TASK-20261010-host-broker PR-3 (D-PR3-24; DS14, DS21): a write access's row carries the write
// badge here too (`access-row-write`, *can also change rows*) beside its ONE act, and the card's
// intro and *clear history* hint say changes too — their new bytes pinned through the export.
//
// TASK-20261010-host-broker PR-5 (D-PR5-4/6a; AC34): *apps that could work together* — the section,
// its ≤ 5 rows, *review…* — and the act line that says every outcome of the ask it starts.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { ACCESS_SOURCE_MAX_BYTES, FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';

import { AccessSettingsCard } from '../access/AccessSettingsCard.js';
import { NO_ACCESS_ASKS_KEY, accessAsksOff, collectSources, pendingAccessStore, reviewStore } from '../access/consent.js';
import { ACCESS_SHEET, CONSENT_UI, SETTINGS_CARD, STRIP_OUTCOME, excludedFooter } from '../access/copy.js';
import { __setAccessDepsForTests, createGrantFromDecision, resetAccessSession, type AnyAccessGrant } from '../access/grants.js';
import { answerAccess } from '../access/outcome.js';
import { netConfirmStore, type PendingNetConfirm } from '../state/net.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const T0 = Date.parse('2026-10-10T09:00:00.000Z');

let db: UserDb;
let budget: string;
let ledger: string;
let pantry: string;
let clock: { now: number };
let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function seedSource(appId: string, ddl: string[], inserts: string[]): Promise<void> {
  await db.applyAppDdl(appId, ddl);
  for (const sql of inserts) {
    await db.driver.handle(appId, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `seed-${Math.random()}`, instanceId: 'seed', op: 'exec', sql });
  }
}

async function allow(reader: string, sourceId: string, tables: string[]): Promise<AnyAccessGrant> {
  const ranked = await collectSources(db, reader);
  const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === sourceId);
  if (source === undefined) throw new Error('no such candidate');
  return createGrantFromDecision(db, { readerAppId: reader, source, tables, duration: 'day', unattended: false, purpose: 'to show spending', provenance: 'app', generation: 0, now: clock.now });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`never happened: ${what}`);
}

async function renderCard(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AccessSettingsCard />);
  });
  await settle();
}

const one = (testId: string, within: ParentNode = document): HTMLElement | null => within.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const all = (testId: string, within: ParentNode = document): HTMLElement[] => [...within.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];

async function click(el: HTMLElement | null): Promise<void> {
  if (el === null) throw new Error('nothing to click');
  await act(async () => {
    el.click();
  });
  await settle();
}

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
  budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
  ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
  pantry = db.installApp({ displayName: 'Pantry', html: '<!doctype html><title>p</title>' }).appId;
  await seedSource(ledger, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)'], ['INSERT INTO transactions (amount) VALUES (450), (500)']);
  await seedSource(pantry, ['CREATE TABLE items (name TEXT, qty INTEGER)'], ["INSERT INTO items VALUES ('rice', 2)"]);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
  resetAccessSession();
  __setAccessDepsForTests();
  try {
    localStorage.removeItem(NO_ACCESS_ASKS_KEY);
  } catch {
    /* nothing */
  }
});

describe('every access across apps', () => {
  it('with none: the empty sentence and the intro', async () => {
    await renderCard();
    expect(one('access-settings-card')).not.toBeNull();
    expect(one('access-settings-intro')?.textContent).toBe(SETTINGS_CARD.intro);
    expect(one('access-settings-empty')?.textContent).toBe(SETTINGS_CARD.empty);
    expect(all('access-row')).toHaveLength(0);
  });

  it('lists every access, whichever app reads, through the one row — neither side muted', async () => {
    await allow(budget, ledger, ['transactions']);
    await allow(pantry, ledger, ['transactions']);
    await allow(budget, pantry, ['items']);
    await renderCard();
    const sentences = all('access-row-sentence').map((el) => el.textContent).sort();
    expect(sentences).toEqual(
      [ACCESS_SHEET.row('Budget', 'Ledger', ['transactions']), ACCESS_SHEET.row('Pantry', 'Ledger', ['transactions']), ACCESS_SHEET.row('Budget', 'Pantry', ['items'])].sort(),
    );
    expect(document.querySelectorAll('[data-testid="access-row"] [data-known="true"]')).toHaveLength(0);
    expect(one('access-settings-empty')).toBeNull();
  });

  it('re-reads on the access revision, and *stop* from Settings revokes', async () => {
    await renderCard();
    let grant: AnyAccessGrant | undefined;
    await act(async () => {
      grant = await allow(budget, ledger, ['transactions']);
    });
    await until(() => all('access-row').length === 1, 'the new row');
    await click(one('access-row-act'));
    await until(() => one('access-row-act')?.getAttribute('data-act') === 'remove', 'the row turns stopped');
    expect(db.getAccessGrant(grant!.id)?.status).toBe('revoked');
  });
});

describe('the per-browser switch (Q15)', () => {
  it('writes the key the ask ladder reads, states its custody, and turns back off', async () => {
    await renderCard();
    const label = one('access-no-asks-label');
    expect(label?.textContent).toBe(SETTINGS_CARD.neverAsk);
    expect(one('access-no-asks-hint')?.textContent).toBe(SETTINGS_CARD.neverAskHint);
    const toggle = one('access-no-asks')!;
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.getAttribute('aria-labelledby')).toBe(label!.id);
    await click(toggle);
    expect(localStorage.getItem(NO_ACCESS_ASKS_KEY)).toBe('1');
    expect(accessAsksOff()).toBe(true);
    expect(one('access-no-asks')!.getAttribute('aria-checked')).toBe('true');
    await click(one('access-no-asks'));
    expect(localStorage.getItem(NO_ACCESS_ASKS_KEY)).toBeNull();
    expect(accessAsksOff()).toBe(false);
  });

  it('reads the switch as it stands when the card mounts', async () => {
    localStorage.setItem(NO_ACCESS_ASKS_KEY, '1');
    await renderCard();
    expect(one('access-no-asks')!.getAttribute('aria-checked')).toBe('true');
  });
});

describe('per-app unmute', () => {
  it("lists the apps that won't ask and lets each ask again", async () => {
    db.setAccessMuted(budget, true);
    await renderCard();
    const muted = one('access-muted')!;
    expect(muted.querySelector('h3')?.textContent).toBe(SETTINGS_CARD.mutedTitle);
    const buttons = all('access-unmute', muted);
    expect(buttons.map((el) => el.textContent)).toEqual([SETTINGS_CARD.unmute('Budget')]);
    await click(buttons[0]!);
    expect(db.isAccessMuted(budget)).toBe(false);
    await until(() => one('access-muted') === null, 'the muted list empties');
  });

  it('no muted app: no list', async () => {
    await renderCard();
    expect(one('access-muted')).toBeNull();
  });
});

describe('*clear history* behind an armed inline confirm', () => {
  it('the first press only arms; *keep* disarms with nothing cleared; confirming clears the reads and keeps the lifecycle lines', async () => {
    const grant = await allow(budget, ledger, ['transactions']);
    db.appendAccessLog(ledger, { at: new Date(clock.now).toISOString(), kind: 'read', grantId: grant.id, readerAppId: budget, readerName: 'Budget', tables: ['transactions'], rows: 2, attended: true });
    await renderCard();
    const clear = one('access-clear-history')!;
    expect(clear.textContent).toBe(SETTINGS_CARD.clearHistory);
    expect(one('access-clear-history-hint')?.textContent).toBe(SETTINGS_CARD.clearHistoryHint);
    await click(clear);
    const confirm = one('access-clear-confirm')!;
    expect(confirm.getAttribute('role')).toBe('group');
    expect(confirm.getAttribute('aria-label')).toBe(SETTINGS_CARD.clearHistory);
    expect(db.listAccessLog(ledger).some((entry) => entry.kind === 'read')).toBe(true);
    await click(one('access-clear-keep'));
    expect(one('access-clear-confirm')).toBeNull();
    expect(db.listAccessLog(ledger).some((entry) => entry.kind === 'read')).toBe(true);
    await click(one('access-clear-history'));
    await click(one('access-clear-yes'));
    expect(db.listAccessLog(ledger).some((entry) => entry.kind === 'read')).toBe(false);
    expect(db.listAccessLog(ledger).map((entry) => entry.kind)).toEqual(['granted']);
    expect(one('access-clear-confirm')).toBeNull();
    expect(one('access-cleared')).not.toBeNull();
  });
});

describe('the same creation act', () => {
  it('names the picked app and starts its user ask', async () => {
    await renderCard();
    const pick = one('access-create-pick') as HTMLSelectElement;
    expect(pick.tagName).toBe('SELECT');
    expect(pick.getAttribute('aria-label')).toBe(SETTINGS_CARD.createPick);
    expect([...pick.options].map((option) => option.textContent).sort()).toEqual(['Budget', 'Ledger', 'Pantry']);
    await act(async () => {
      pick.value = budget;
      pick.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const create = one('access-settings-create')!;
    expect(create.textContent).toBe(SETTINGS_CARD.create('Budget'));
    await click(create);
    await until(() => reviewStore.get() === budget, 'the review opens');
    expect(pendingAccessStore.get()[budget]?.provenance).toBe('user');
    expect(pendingAccessStore.get()[budget]?.purpose).toBe(ACCESS_SHEET.userPurpose('Budget'));
  });
});

// SettingsView mounts the card only where the host allows access: pinned by BEHAVIOUR in
// hostSettings.test.tsx ('Settings → access between apps is mounted only where the host allows
// access' — absent with access off, present with it on), not by the shape of the JSX (W6 finding 34).

// =========================================================================================
// TASK-20261010-host-broker PR-3 (D-PR3-24; DS14, DS21)
// =========================================================================================

describe('PR-3 — the write badge in Settings, and the intro and hint that say changes too', () => {
  /** LOCAL structural types (D-PR3-23/24) until grants.ts / copy.ts export them. */
  type CreateGrantV2 = (
    db: UserDb,
    input: Omit<Parameters<typeof createGrantFromDecision>[1], 'tables'> & { tables: Array<{ name: string; withheld: string[]; write: boolean }> },
  ) => ReturnType<typeof createGrantFromDecision>;
  const createGrantV2 = createGrantFromDecision as unknown as CreateGrantV2;
  const SHEET3 = ACCESS_SHEET as unknown as { canChange: string };

  it('a write access’s row carries *can also change rows* — and exactly one act; a read access’s row none', async () => {
    const ranked = await collectSources(db, budget);
    const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === ledger)!;
    await createGrantV2(db, {
      readerAppId: budget,
      source,
      tables: [{ name: 'transactions', withheld: [], write: true }],
      duration: 'day',
      unattended: false,
      purpose: 'to tidy the categories',
      provenance: 'app',
      generation: 0,
      now: clock.now,
    });
    await allow(budget, pantry, ['items']);
    await renderCard();
    const rows = all('access-row');
    expect(rows).toHaveLength(2);
    const writeRow = rows.find((row) => one('access-row-sentence', row)?.textContent === ACCESS_SHEET.row('Budget', 'Ledger', ['transactions']))!;
    const readRow = rows.find((row) => one('access-row-sentence', row)?.textContent === ACCESS_SHEET.row('Budget', 'Pantry', ['items']))!;
    expect(one('access-row-write', writeRow)?.textContent).toBe(SHEET3.canChange);
    expect(all('access-row-act', writeRow)).toHaveLength(1);
    expect(one('access-row-write', readRow)).toBeNull();
    expect(all('access-row-act', readRow)).toHaveLength(1);
  });

  it('the intro and the *clear history* hint say changes too — the contract’s bytes, through the export', async () => {
    expect(SETTINGS_CARD.intro).toBe(
      "which of your apps can read — or change, when you allowed it — another app's data; the app that was read keeps a history of its reads and changes",
    );
    expect(SETTINGS_CARD.clearHistoryHint).toBe('when access was allowed, stopped or paused — and every change — stays on record');
    await allow(budget, ledger, ['transactions']);
    await renderCard();
    expect(one('access-settings-intro')?.textContent).toBe(SETTINGS_CARD.intro);
    expect(one('access-clear-history-hint')?.textContent).toBe(SETTINGS_CARD.clearHistoryHint);
  });
});

// =========================================================================================
// TASK-20261010-host-broker PR-5 (contract v2 D-PR5-4, D-PR5-6a; AC34; D1, D3)
//
// Settings gains *apps that could work together* (`SETTINGS_CARD.pairsTitle`): at most `PAIRS_MAX`
// (5) rows from `listPairSuggestions`, each `SETTINGS_CARD.pairRow(reader, source, matchedTables)`
// — *Budget could read Ledger's transactions* — with the want's purpose quoted below it (a
// bidi-isolated `<q>`) and the act *review…* (aria: the row sentence + " — review"), which starts
// `startUserAsk(reader, {declared: want, source})`. Every outcome of that ask is SAID, in the act
// line (`access/AccessActLine.tsx`, role=status, tabIndex −1, taking focus when its trigger has
// unmounted): allowed → `STRIP_OUTCOME.allowed(…)` with *stop*; a declared-form decline →
// `STRIP_OUTCOME.wontAskAgain(reader)`; not offered → `excludedFooter([{displayName, reason}])`;
// answer-other-first → `CONSENT_UI.answerOtherFirst`; *not now* → no line, focus back on the act.
//
// Q (lane T-B — test ids the contract leaves open): the section `access-pairs`, a row
// `access-pair-row`, its act `access-pair-review`, the act line `access-act-line`.
// =========================================================================================

const SETTINGS5 = SETTINGS_CARD as unknown as { pairsTitle: string; pairRow(readerName: string, sourceName: string, tables: readonly string[]): string };
const SPENDING_WANT = { purpose: 'to show spending by category', hints: { tables: ['transactions'] } };

function declaringPage(title: string, wants: unknown): string {
  const content = JSON.stringify(wants).replace(/&/g, '&amp;').replace(/'/g, '&apos;');
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="snug:access-wants" content='${content}'>\n<title>${title}</title>\n</head>\n<body></body>\n</html>`;
}

/** The user's answer on the sheet, as the sheet gives it (the decision v2). */
async function answerPending(reader: string, decision: Record<string, unknown>): Promise<void> {
  const pending = pendingAccessStore.get()[reader];
  if (pending === undefined) throw new Error('no pending ask');
  await act(async () => {
    await answerAccess(pending, decision as Parameters<typeof answerAccess>[1]);
  });
  await settle();
}
const ALLOW_DAY = { kind: 'allow', tables: [{ name: 'transactions', withheld: [], write: false }], duration: 'day', unattended: false, kv: false, refresh: false };

describe('PR-5 — *apps that could work together* (D-PR5-4; D3)', () => {
  beforeEach(() => {
    db.saveAppVersion(budget, declaringPage('Budget', [SPENDING_WANT]));
  });

  it('D-PR5-4 the section, titled by the copy, with one row: the sentence, the purpose quoted below it, and *review…*', async () => {
    await renderCard();
    const section = one('access-pairs');
    expect(section, 'a pair exists: the section is there').not.toBeNull();
    expect(section!.textContent).toContain(SETTINGS5.pairsTitle);
    const rows = all('access-pair-row', section!);
    expect(rows).toHaveLength(1);
    const sentence = SETTINGS5.pairRow('Budget', 'Ledger', ['transactions']);
    expect(rows[0]!.textContent).toContain(sentence);
    const quote = rows[0]!.querySelector('q');
    expect(quote, 'the purpose is quoted').not.toBeNull();
    expect(quote!.textContent).toContain(SPENDING_WANT.purpose);
    const review = one('access-pair-review', rows[0])!;
    expect(review.textContent).toBe('review…');
    expect(review.getAttribute('aria-label')).toBe(`${sentence} — review`);
  });

  it('no pair: no section at all', async () => {
    db.saveAppVersion(budget, '<!doctype html><title>b</title>');
    await renderCard();
    expect(one('access-pairs')).toBeNull();
  });

  it('at most PAIRS_MAX (5) rows, however many pairs the file holds', async () => {
    for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']) db.installApp({ displayName: name, html: declaringPage(name, [SPENDING_WANT]) });
    await renderCard();
    expect(all('access-pair-row')).toHaveLength(5);
  });

  it('*review…* starts the declared ask pinned to the source and opens the review', async () => {
    await renderCard();
    await click(one('access-pair-review'));
    await until(() => reviewStore.get() === budget, 'the review opens');
    const pending = pendingAccessStore.get()[budget] as ReturnType<typeof pendingAccessStore.get>[string] & { askedIn?: string };
    expect(pending.askedIn).toBe('declared');
    expect(pending.preselect).toEqual({ appId: ledger, tables: ['transactions'] });
  });
});

describe('PR-5 — the act line: every ask from host chrome has a visible outcome (D-PR5-6a; D1)', () => {
  beforeEach(() => {
    db.saveAppVersion(budget, declaringPage('Budget', [SPENDING_WANT]));
  });

  const line = (): HTMLElement | null => one('access-act-line');

  it('allowed: the allowed line with *stop* — role status, focusable — and *stop* stops it', async () => {
    await renderCard();
    await click(one('access-pair-review'));
    await until(() => pendingAccessStore.get()[budget] !== undefined, 'the ask is parked');
    await answerPending(budget, { ...ALLOW_DAY, sourceAppId: ledger });
    await until(() => line() !== null, 'the act line');
    expect(line()!.getAttribute('role')).toBe('status');
    expect(line()!.tabIndex).toBe(-1);
    expect(line()!.textContent).toContain(STRIP_OUTCOME.allowed('Budget', 'Ledger', ['transactions'], 'day'));
    const stop = [...line()!.querySelectorAll('button')].find((button) => button.textContent === STRIP_OUTCOME.undo);
    expect(stop, 'the line carries *stop*').toBeDefined();
    await click(stop!);
    await until(() => db.listAccessGrants().every((grant) => grant.status === 'revoked'), 'the access is stopped');
    expect(db.listAccessGrants()).toHaveLength(1);
  });

  it('allowed: the pair (and its *review…*) is gone — the act line takes focus', async () => {
    await renderCard();
    await click(one('access-pair-review'));
    await until(() => pendingAccessStore.get()[budget] !== undefined, 'the ask is parked');
    await answerPending(budget, { ...ALLOW_DAY, sourceAppId: ledger });
    await until(() => line() !== null, 'the act line');
    await until(() => one('access-pair-review') === null, 'the pair is gone: Budget now reads Ledger');
    expect(document.activeElement).toBe(line());
  });

  it('a declared-form decline: "Budget won\'t ask for this again" — the copy’s wontAskAgain', async () => {
    await renderCard();
    await click(one('access-pair-review'));
    await until(() => pendingAccessStore.get()[budget] !== undefined, 'the ask is parked');
    await answerPending(budget, { kind: 'dont-allow' });
    await until(() => line() !== null, 'the act line');
    expect(line()!.textContent).toContain(STRIP_OUTCOME.wontAskAgain('Budget'));
  });

  it('not offered (the source is over the copy cap): the footer’s words, nothing parked', async () => {
    const real = db.exportAppRuntime.bind(db);
    vi.spyOn(db, 'exportAppRuntime').mockImplementation(async (appId: string) => (appId === ledger ? new Uint8Array(ACCESS_SOURCE_MAX_BYTES + 1) : real(appId)));
    await renderCard();
    await click(one('access-pair-review'));
    await until(() => line() !== null, 'the act line');
    expect(line()!.textContent).toContain(excludedFooter([{ displayName: 'Ledger', reason: 'too-large' }]));
    expect(pendingAccessStore.get()[budget]).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('another question is open first: "answer the open question first, then review" — nothing parked', async () => {
    netConfirmStore.set({ request: {} as PendingNetConfirm['request'], resolve: () => undefined });
    try {
      await renderCard();
      await click(one('access-pair-review'));
      await until(() => line() !== null, 'the act line');
      expect(line()!.textContent).toContain(CONSENT_UI.answerOtherFirst);
      expect(pendingAccessStore.get()[budget]).toBeUndefined();
    } finally {
      netConfirmStore.set(null);
    }
  });

  it('*not now*: no line — focus goes back to the act', async () => {
    await renderCard();
    const review = one('access-pair-review')!;
    review.focus();
    await click(review);
    await until(() => pendingAccessStore.get()[budget] !== undefined, 'the ask is parked');
    (document.activeElement as HTMLElement | null)?.blur();
    await answerPending(budget, { kind: 'not-now' });
    expect(line()).toBeNull();
    expect(document.activeElement).toBe(one('access-pair-review'));
  });
});
