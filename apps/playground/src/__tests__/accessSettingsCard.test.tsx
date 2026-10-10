// accessSettingsCard.test.tsx — Settings → *access between apps* (TASK-20261010-cross-app-access
// AC19; ADR-0075 §7; Q15).
//
// Rows: every access across apps through the ONE GrantRow (re-read on the access revision); the
// per-browser *never let apps ask to read other apps' data* switch writes the key the ask ladder
// reads (`NO_ACCESS_ASKS_KEY` — single-homed in consent.ts) and states its custody; per-app
// unmute; *clear history* behind an armed inline confirm (the schedule card's shape) — clears
// the reads, keeps the lifecycle lines; the same creation act, for the app the user picks; and
// the card is mounted in SettingsView only where the host allows access.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';

import { AccessSettingsCard } from '../access/AccessSettingsCard.js';
import { NO_ACCESS_ASKS_KEY, accessAsksOff, collectSources, pendingAccessStore, reviewStore } from '../access/consent.js';
import { ACCESS_SHEET, SETTINGS_CARD } from '../access/copy.js';
import { __setAccessDepsForTests, createGrantFromDecision, resetAccessSession, type AnyAccessGrant } from '../access/grants.js';
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
