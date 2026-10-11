// accessSheet.test.tsx — the run header's ⋈ sheet (TASK-20261010-cross-app-access AC19; ADR-0075
// §7; D20, D34).
//
// Rows: ONE GrantRow for both directions — both parties named, the KNOWN side muted, the words
// and the one act from `grantStateCopy` (never a second derivation: each row's words are
// compared with the copy function's own answer); *stop* revokes through the engine and the row
// turns *stopped · remove*, and *remove* drops the stopped row; a paused row's *allow again*
// parks a prefilled ask that renews THAT access and opens the review; the source side's
// history reads in words with the statement behind *what it asked* (text, never markup) and
// imported entries under their own heading; the reader side's declined asks list the purpose
// with *allow…*, which clears the decline and starts the user's own ask; the ONE creation act
// names this app as the one that reads (provenance `user`, the host's fixed purpose); an app
// with nothing says so; the sheet is a labelled modal dialog and Escape closes it.
//
// The real memory user db; the engine's clock is its injected seam.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { FRAME_TYPES, PROTOCOL_VERSION, SIDECAR_SYMBOLIC_HOST, accessRequestHash } from '@snugprotocol/protocol';

import { ACCESS_ARM_MS, AccessConsentSheet } from '../access/AccessConsentSheet.js';
import { AccessSheet } from '../access/AccessSheet.js';
import { collectSources, pendingAccessStore, reviewStore, type ConsentOutcome } from '../access/consent.js';
import { ACCESS_SHEET, CONSENT_SHEET, allowLabel, grantStateCopy, historyLine } from '../access/copy.js';
import {
  __setAccessDepsForTests,
  createGrantFromDecision,
  grantsForApp,
  noteRead,
  resetAccessSession,
  revokeAccess,
  suspendAccess,
  type AnyAccessGrant,
  type LiveGrantRow,
} from '../access/grants.js';
import { sheetSeedOf } from '../access/userAsk.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const T0 = Date.parse('2026-10-10T09:00:00.000Z');
const MIN = 60_000;

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

async function allow(over: { reader?: string; source?: string; duration?: 'session' | 'day' | 'week' | 'always'; tables?: string[] } = {}): Promise<AnyAccessGrant> {
  const reader = over.reader ?? budget;
  const sourceId = over.source ?? ledger;
  const ranked = await collectSources(db, reader);
  const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === sourceId);
  if (source === undefined) throw new Error('no such candidate');
  return createGrantFromDecision(db, {
    readerAppId: reader,
    source,
    tables: over.tables ?? ['transactions'],
    duration: over.duration ?? 'day',
    unattended: false,
    purpose: 'to show spending by category',
    provenance: 'app',
    generation: 0,
    now: clock.now,
  });
}

/** Let the db reads and the re-renders behind them land. */
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

async function renderSheet(appId: string, onClose: () => void = () => undefined): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AccessSheet appId={appId} onClose={onClose} />);
  });
  await settle();
}

const sheet = (): HTMLElement | null => document.querySelector('[data-testid="access-sheet"]');
const all = (testId: string, within: ParentNode = document): HTMLElement[] => [...within.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
const one = (testId: string, within: ParentNode = document): HTMLElement | null => within.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const rowsIn = (section: string): HTMLElement[] => {
  const el = one(section);
  return el === null ? [] : all('access-row', el);
};

async function click(el: HTMLElement | null): Promise<void> {
  if (el === null) throw new Error('nothing to click');
  await act(async () => {
    el.click();
  });
  await settle();
}

/** What GrantRow must say — derived by the copy module's own function, from the engine's own row. */
function expectedWords(row: LiveGrantRow, now: number): { words: string; act?: { kind: string; label: string } } {
  return grantStateCopy(
    {
      status: row.grant.status,
      suspendedReason: row.grant.suspendedReason,
      expiresAt: row.expiresAt,
      revokedAt: row.grant.revokedAt,
      reads: row.grant.reads,
      lastReadAt: row.grant.lastReadAt,
      readerName: row.readerName,
      sourceName: row.sourceName,
      duration: row.duration,
    },
    now,
  );
}

beforeEach(async () => {
  resetAccessSession();
  clock = { now: T0 };
  db = await installTestUserDb();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => clock.now });
  budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
  ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
  pantry = db.installApp({ displayName: 'Pantry', html: '<!doctype html><title>p</title>' }).appId;
  await seedSource(
    ledger,
    ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, category TEXT)', 'CREATE TABLE accounts (name TEXT, balance INTEGER)'],
    ["INSERT INTO transactions (amount, category) VALUES (450, 'food'), (500, 'rent')", "INSERT INTO accounts VALUES ('main', 9000)"],
  );
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
});

describe('the sheet itself', () => {
  it('is a modal dialog named BY its title, and Escape, the backdrop and ✕ close it', async () => {
    const onClose = vi.fn();
    await renderSheet(budget, onClose);
    const dialog = sheet();
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('role')).toBe('dialog');
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    const title = dialog!.querySelector('h2')!;
    expect(title.textContent).toBe(ACCESS_SHEET.title('Budget'));
    expect(dialog!.getAttribute('aria-labelledby')).toBe(title.id);
    expect(dialog!.hasAttribute('aria-label')).toBe(false);
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // A press inside the card is not a dismissal; one that starts and ends on the backdrop is.
    await act(async () => {
      title.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      title.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      dialog!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      dialog!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
    const close = one('access-sheet-close');
    expect(close?.getAttribute('aria-label')).toBe(`${ACCESS_SHEET.close} ${ACCESS_SHEET.title('Budget')}`);
    await click(close);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('one Escape closes it once — the overlay owns the key (no second, sheet-local listener)', async () => {
    const onClose = vi.fn();
    await renderSheet(budget, onClose);
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // A key another handler already took is not this sheet's.
    const taken = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    taken.preventDefault();
    await act(async () => {
      document.body.dispatchEvent(taken);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('focus: starts on ✕, Tab stays inside the sheet, and closing returns it to the ⋈ that opened it', async () => {
    await allow();
    const opener = document.createElement('button');
    opener.setAttribute('aria-label', ACCESS_SHEET.iconLabel);
    document.body.appendChild(opener);
    try {
      opener.focus();
      await renderSheet(budget);
      const close = one('access-sheet-close')!;
      expect(document.activeElement).toBe(close);
      const create = one('access-create')!;
      // The last control: Tab wraps to the first (✕), Shift+Tab from ✕ wraps to the last.
      create.focus();
      await act(async () => {
        create.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(close);
      await act(async () => {
        close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(create);
      await act(async () => {
        root!.render(<></>);
      });
      expect(document.activeElement).toBe(opener);
    } finally {
      opener.remove();
    }
  });

  it('never shows a nameless dialog: nothing renders until the file is read, then it is named for the app', async () => {
    let open!: (value: UserDb) => void;
    const gate = new Promise<UserDb>((resolve) => {
      open = resolve;
    });
    __setAccessDepsForTests({ getDb: () => gate, now: () => clock.now });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AccessSheet appId={budget} onClose={() => undefined} />);
    });
    expect(sheet()).toBeNull();
    await act(async () => {
      open(db);
    });
    await settle();
    expect(sheet()).not.toBeNull();
    expect(document.getElementById(sheet()!.getAttribute('aria-labelledby')!)?.textContent).toBe(ACCESS_SHEET.title('Budget'));
  });

  it('an app with no access either way says so, and still offers the creation act', async () => {
    await renderSheet(pantry);
    expect(one('access-nothing')?.textContent).toBe(ACCESS_SHEET.nothing('Pantry'));
    expect(rowsIn('access-reads')).toHaveLength(0);
    expect(rowsIn('access-read-by')).toHaveLength(0);
    expect(one('access-create')?.textContent).toBe(ACCESS_SHEET.create('Pantry'));
  });
});

describe('ONE GrantRow for both directions (both parties named, the known side muted)', () => {
  it("on the reading app's sheet: the row names both apps, mutes the app itself, and says the copy's words with *stop*", async () => {
    await allow();
    await renderSheet(budget);
    expect(one('access-reads')?.querySelector('h3')?.textContent).toBe(ACCESS_SHEET.reads('Budget'));
    const rows = rowsIn('access-reads');
    expect(rows).toHaveLength(1);
    expect(one('access-row-sentence', rows[0])?.textContent).toBe(ACCESS_SHEET.row('Budget', 'Ledger', ['transactions']));
    const known = rows[0]!.querySelectorAll('[data-known="true"]');
    expect(known).toHaveLength(1);
    expect(known[0]!.textContent).toBe('Budget');
    const [engineRow] = grantsForApp(db, budget, clock.now).reads;
    const expected = expectedWords(engineRow!, clock.now);
    expect(one('access-row-words', rows[0])?.textContent).toBe(expected.words);
    expect(expected.act?.kind).toBe('stop');
    const actBtn = one('access-row-act', rows[0]);
    expect(actBtn?.textContent).toBe(expected.act?.label);
    expect(actBtn?.getAttribute('data-act')).toBe('stop');
    // The act button is described by its row's sentence — many *stop* buttons stay distinguishable.
    const describedBy = actBtn?.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(ACCESS_SHEET.row('Budget', 'Ledger', ['transactions']));
    expect(rowsIn('access-read-by')).toHaveLength(0);
  });

  it("on the source's sheet: the same row under *what reads Ledger*, with Ledger's side muted", async () => {
    await allow();
    await renderSheet(ledger);
    expect(one('access-read-by')?.querySelector('h3')?.textContent).toBe(ACCESS_SHEET.readBy('Ledger'));
    const rows = rowsIn('access-read-by');
    expect(rows).toHaveLength(1);
    expect(one('access-row-sentence', rows[0])?.textContent).toBe(ACCESS_SHEET.row('Budget', 'Ledger', ['transactions']));
    // Only the known NAME is muted — the tables, the informative half for a source, stay at full weight.
    const known = rows[0]!.querySelectorAll('[data-known="true"]');
    expect(known).toHaveLength(1);
    expect(known[0]!.textContent).toBe('Ledger');
    const tables = rows[0]!.querySelector('[data-testid="access-row-tables"]');
    expect(tables?.textContent).toBe('transactions');
    expect(tables?.closest('[data-known="true"]')).toBeNull();
    expect(rowsIn('access-reads')).toHaveLength(0);
  });

  it("several tables on the source's sheet: the name muted once, every table at full weight", async () => {
    await allow({ tables: ['transactions', 'accounts'] });
    await renderSheet(ledger);
    const row = rowsIn('access-read-by')[0]!;
    expect(one('access-row-sentence', row)?.textContent).toBe(ACCESS_SHEET.row('Budget', 'Ledger', ['transactions', 'accounts']));
    expect([...row.querySelectorAll('[data-known="true"]')].map((el) => el.textContent)).toEqual(['Ledger']);
    expect(one('access-row-tables', row)?.textContent).toBe('transactions and accounts');
  });

  it('a row that has been read says how often and when — the reads and last-read seats reach the words', async () => {
    const grant = await allow();
    noteRead(db, grant.id, new Date(clock.now - 2 * MIN).toISOString());
    await renderSheet(budget);
    const [engineRow] = grantsForApp(db, budget, clock.now).reads;
    expect(engineRow!.grant.reads).toBe(1);
    const words = one('access-row-words', rowsIn('access-reads')[0])?.textContent;
    expect(words).toBe(expectedWords(engineRow!, clock.now).words);
    expect(words).toMatch(/ · 1 read · last read 2 min ago$/);
  });

  it('the ended look follows the words: a row whose words are live (*stop*) is never drawn ended, even when its source just gained a WhatsApp fact', async () => {
    const live = await allow();
    const paused = await allow({ source: pantry, tables: ['items'] });
    await suspendAccess(db, paused.id, 'reader-updated', new Date(clock.now).toISOString());
    db.putDeclaredConnection(ledger, 'whatsapp', { slot: 'whatsapp', provider: { name: 'WhatsApp' }, kind: 'linked_device', declaredApiHosts: [SIDECAR_SYMBOLIC_HOST] } as Parameters<UserDb['putDeclaredConnection']>[2], 'starter');
    await renderSheet(budget);
    const rowOf = (id: string): HTMLElement => rowsIn('access-reads').find((row) => row.getAttribute('data-access-id') === id)!;
    expect(grantsForApp(db, budget, clock.now).reads.find((row) => row.grant.id === live.id)!.live).toBe(false);
    expect(one('access-row-act', rowOf(live.id))?.getAttribute('data-act')).toBe('stop');
    expect(rowOf(live.id).classList.contains('is-ended')).toBe(false);
    expect(one('access-row-act', rowOf(paused.id))?.getAttribute('data-act')).toBe('allow-again');
    expect(rowOf(paused.id).classList.contains('is-ended')).toBe(true);
  });

  it("a session access reads *while it's open* — the duration is always passed", async () => {
    await allow({ duration: 'session' });
    await renderSheet(budget);
    const [engineRow] = grantsForApp(db, budget, clock.now).reads;
    expect(one('access-row-words', rowsIn('access-reads')[0])?.textContent).toBe(expectedWords(engineRow!, clock.now).words);
    expect(one('access-row-words', rowsIn('access-reads')[0])?.textContent).toMatch(/^while it's open · /);
  });

  it('*stop* revokes through the engine: the row turns *stopped*, its act *remove*, and *remove* drops it', async () => {
    const grant = await allow();
    await renderSheet(budget);
    await click(one('access-row-act', rowsIn('access-reads')[0]));
    await until(() => one('access-row-act', rowsIn('access-reads')[0])?.getAttribute('data-act') === 'remove', 'the row turns stopped');
    expect(db.getAccessGrant(grant.id)?.status).toBe('revoked');
    expect(db.listAccessLog(ledger).map((entry) => entry.kind)).toContain('revoked');
    const [engineRow] = grantsForApp(db, budget, clock.now).reads;
    expect(one('access-row-words', rowsIn('access-reads')[0])?.textContent).toBe(expectedWords(engineRow!, clock.now).words);
    await click(one('access-row-act', rowsIn('access-reads')[0]));
    await until(() => rowsIn('access-reads').length === 0, 'the stopped row is removed');
    expect(db.getAccessGrant(grant.id)).toBeUndefined();
  });

  // W6 finding 42 — the sentence carries the state: a stopped or paused row never says "has access".
  it('a stopped row and a paused row read "Budget’s access to Ledger’s transactions" — never "has access" — with the parties still split', async () => {
    const stopped = await allow({ duration: 'week' });
    await revokeAccess(stopped.id);
    const paused = await allow({ duration: 'week' });
    await suspendAccess(db, paused.id, 'reader-updated', new Date(clock.now).toISOString());
    await renderSheet(budget);
    const rows = rowsIn('access-reads');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(one('access-row-sentence', row)?.textContent).toBe(ACCESS_SHEET.endedRow('Budget', 'Ledger', ['transactions']));
      expect(one('access-row-sentence', row)?.textContent).not.toContain('has access');
      expect([...row.querySelectorAll('[data-known="true"]')].map((el) => el.textContent)).toEqual(['Budget']);
    }
  });

  it('a paused row says why and *allow again* parks a prefilled ask that renews THAT access, then opens the review', async () => {
    const onClose = vi.fn();
    const grant = await allow({ duration: 'week' });
    await suspendAccess(db, grant.id, 'reader-updated', new Date(clock.now).toISOString());
    await renderSheet(budget, onClose);
    const row = rowsIn('access-reads')[0]!;
    expect(one('access-row-words', row)?.textContent).toBe('paused — Budget was updated');
    expect(one('access-row-act', row)?.getAttribute('data-act')).toBe('allow-again');
    await click(one('access-row-act', row));
    await until(() => pendingAccessStore.get()[budget] !== undefined, 'the prefilled ask is parked');
    const pending = pendingAccessStore.get()[budget]!;
    expect(pending.provenance).toBe('user');
    expect(pending.purpose).toBe(ACCESS_SHEET.userPurpose('Budget'));
    expect(pending.renew).toBe(grant.id);
    expect(pending.preselect).toEqual({ appId: ledger, tables: ['transactions'] });
    expect(reviewStore.get()).toBe(budget);
    expect(onClose).toHaveBeenCalled();
    // The sheet starts on the paused access's own duration (AC21: one tap puts it back as it was).
    expect(sheetSeedOf(pending)).toEqual({ duration: 'week', unattended: false });
  });

  it("*allow again* is ONE tap: the consent sheet's prefilled default re-activates THAT access in place — one row for the pair, live", async () => {
    const grant = await allow({ duration: 'week' });
    await suspendAccess(db, grant.id, 'reader-updated', new Date(clock.now).toISOString());
    const consentHost = document.createElement('div');
    document.body.appendChild(consentHost);
    const consentRoot = createRoot(consentHost);
    try {
      await act(async () => {
        consentRoot.render(<AccessConsentSheet />);
      });
      await renderSheet(budget);
      await click(one('access-row-act', rowsIn('access-reads')[0]));
      await until(() => one('access-allow') !== null, 'the consent sheet opens');
      expect(one('access-duration-week')).not.toBeNull();
      expect((one('access-duration-week') as HTMLInputElement).checked).toBe(true);
      const allowBtn = one('access-allow') as HTMLButtonElement;
      expect(allowBtn.textContent).toBe(allowLabel('week'));
      expect(allowBtn.disabled).toBe(true);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ACCESS_ARM_MS + 50));
      });
      await until(() => !allowBtn.disabled, 'the primary arms');
      await act(async () => {
        allowBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      });
      await until(() => grantsForApp(db, budget, clock.now).reads.every((row) => row.grant.status === 'active'), 'the access is live again');
      const reads = grantsForApp(db, budget, clock.now).reads;
      expect(reads).toHaveLength(1);
      expect(reads[0]!.grant.id).toBe(grant.id);
      expect(reads[0]!.session).toBe(false);
      expect(reads[0]!.duration).toBe('week');
    } finally {
      await act(async () => {
        consentRoot.unmount();
      });
      consentHost.remove();
    }
  });

  it('*allow again* with ANOTHER duration replaces the paused access — the old one is stopped, never left listed with *allow again*', async () => {
    const grant = await allow({ duration: 'week' });
    await suspendAccess(db, grant.id, 'reader-updated', new Date(clock.now).toISOString());
    await renderSheet(budget);
    await click(one('access-row-act', rowsIn('access-reads')[0]));
    await until(() => pendingAccessStore.get()[budget] !== undefined, 'the prefilled ask is parked');
    let outcome: ConsentOutcome | undefined;
    await act(async () => {
      outcome = await pendingAccessStore.get()[budget]!.resolve({ kind: 'allow', sourceAppId: ledger, tables: ['transactions'], duration: 'session', unattended: false });
    });
    expect(outcome?.kind).toBe('allowed');
    await until(() => db.getAccessGrant(grant.id)?.status === 'revoked', 'the replaced access is stopped');
    const reads = grantsForApp(db, budget, clock.now).reads;
    expect(reads.filter((row) => row.grant.status === 'active')).toHaveLength(1);
    expect(reads.filter((row) => row.grant.status === 'suspended')).toEqual([]);
  });
});

describe("the source's history", () => {
  it('reads in words beside the app that read, with the statement behind *what it asked* as text', async () => {
    const grant = await allow();
    db.appendAccessLog(ledger, {
      at: new Date(clock.now - 2 * MIN).toISOString(),
      kind: 'read',
      grantId: grant.id,
      readerAppId: budget,
      readerName: 'Budget',
      tables: ['transactions'],
      sql: "SELECT '<b>bold</b>' AS x FROM transactions",
      rows: 412,
      attended: true,
    });
    await renderSheet(ledger);
    const history = one('access-history');
    expect(history?.querySelector('h3')?.textContent).toBe(ACCESS_SHEET.history);
    const rows = all('access-history-row', history!);
    const read = rows.find((row) => row.getAttribute('data-kind') === 'read')!;
    expect(one('access-history-who', read)?.textContent).toBe('Budget');
    expect(one('access-history-words', read)?.textContent).toBe('read transactions · 412 rows · 2 min ago · while you were here');
    const asked = one('access-history-asked', read)!;
    expect(asked.tagName).toBe('DETAILS');
    expect(asked.querySelector('summary')?.textContent).toBe(ACCESS_SHEET.whatItAsked);
    expect(asked.querySelector('code')?.textContent).toBe("SELECT '<b>bold</b>' AS x FROM transactions");
    expect(asked.querySelector('b')).toBeNull();
    const granted = rows.find((row) => row.getAttribute('data-kind') === 'granted')!;
    expect(one('access-history-words', granted)?.textContent).toBe(historyLine({ at: new Date(clock.now).toISOString(), kind: 'granted' }, clock.now));
    expect(one('access-history-asked', granted)).toBeNull();
  });

  it('*what it asked* keeps its disclosure marker — a summary that is a list item, never a flex box (WCAG 1.4.1: not told by colour alone)', () => {
    const css = readFileSync(path.resolve(__dirname, '../theme/access-sheet.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.access-history-asked summary\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/display:\s*list-item/);
    expect(rule).not.toMatch(/display:\s*(flex|block|inline-flex|grid)/);
    expect(css).not.toMatch(/summary[^{]*\{[^}]*list-style:\s*none/);
    expect(css).not.toMatch(/summary::-webkit-details-marker/);
  });

  it('imported entries sit under their own heading; an empty history says *no reads on record*', async () => {
    const grant = await allow();
    db.clearAccessLog(ledger);
    await renderSheet(ledger);
    // A lifecycle line stays after a clear; the reads are gone.
    expect(all('access-history-row').every((row) => row.getAttribute('data-kind') !== 'read')).toBe(true);
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    db.appendAccessLog(pantry, { at: new Date(clock.now - MIN).toISOString(), kind: 'read', grantId: grant.id, readerAppId: budget, readerName: 'Budget', tables: ['items'], rows: 1, attended: false, imported: true });
    await renderSheet(pantry);
    const imported = one('access-history-imported');
    expect(imported?.querySelector('h4')?.textContent).toBe(ACCESS_SHEET.historyImported);
    expect(all('access-history-row', imported!)).toHaveLength(1);
    expect(one('access-history-words', imported!)?.textContent).toBe('read items · 1 row · 1 min ago · while you were away');
  });

  it('a source that is read but has no reads yet says *no reads on record* beside its lifecycle lines', async () => {
    await allow();
    await renderSheet(ledger);
    expect(one('access-history-empty')?.textContent).toBe(ACCESS_SHEET.noHistory);
  });
});

describe("the reading side's declined asks", () => {
  it("list the purpose quoted as text; *allow…* starts the user's ask ranked by the declined ask's OWN hints, and opens the review", async () => {
    const onClose = vi.fn();
    const hash = accessRequestHash({ hints: { tables: ['items'] } });
    db.addAccessDecline(budget, hash, { purpose: 'to <i>see</i> spending', hints: { tables: ['items'] }, at: new Date(clock.now).toISOString() });
    await renderSheet(budget, onClose);
    const section = one('access-declined')!;
    expect(section.querySelector('h3')?.textContent).toBe(ACCESS_SHEET.declinedAsks);
    const rows = all('access-declined-row', section);
    expect(rows).toHaveLength(1);
    expect(one('access-declined-purpose', rows[0])?.textContent).toBe(CONSENT_SHEET.quote('to <i>see</i> spending'));
    expect(rows[0]!.querySelector('i')).toBeNull();
    const allowBtn = one('access-declined-allow', rows[0])!;
    expect(allowBtn.textContent).toBe(ACCESS_SHEET.allowDeclined);
    await click(allowBtn);
    await until(() => pendingAccessStore.get()[budget] !== undefined, 'the user ask is parked');
    const pending = pendingAccessStore.get()[budget]!;
    expect(pending.provenance).toBe('user');
    // Ranked for the ask the user turned down: Pantry's items, not the first app in the file.
    expect(pending.candidates.matched.map((candidate) => candidate.appId)).toEqual([pantry]);
    expect(pending.preselect).toEqual({ appId: pantry, tables: ['items'] });
    expect(reviewStore.get()).toBe(budget);
    expect(onClose).toHaveBeenCalled();
  });

  it('the earlier no stays on record until the user ALLOWS: *not now* keeps the decline, an allow clears it', async () => {
    const hash = accessRequestHash({ hints: { tables: ['transactions'] } });
    db.addAccessDecline(budget, hash, { purpose: 'to see spending', hints: { tables: ['transactions'] }, at: new Date(clock.now).toISOString() });
    await renderSheet(budget);
    await click(one('access-declined-allow'));
    await until(() => pendingAccessStore.get()[budget] !== undefined, 'the user ask is parked');
    expect(db.listAccessDeclines(budget).map((decline) => decline.hash)).toEqual([hash]);
    await act(async () => {
      await pendingAccessStore.get()[budget]!.resolve({ kind: 'not-now' });
    });
    expect(db.listAccessDeclines(budget).map((decline) => decline.hash)).toEqual([hash]);
    await settle();
    await click(one('access-declined-allow'));
    await until(() => pendingAccessStore.get()[budget] !== undefined, 'the user ask is parked again');
    let outcome: ConsentOutcome | undefined;
    await act(async () => {
      outcome = await pendingAccessStore.get()[budget]!.resolve({ kind: 'allow', sourceAppId: ledger, tables: ['transactions'], duration: 'day', unattended: false });
    });
    expect(outcome?.kind).toBe('allowed');
    expect(db.listAccessDeclines(budget)).toEqual([]);
  });
});

describe('the ONE creation act', () => {
  it('*let Budget read another app…* starts a user ask with the host purpose and opens the review', async () => {
    const onClose = vi.fn();
    await allow();
    await renderSheet(budget, onClose);
    const create = all('access-create');
    expect(create).toHaveLength(1);
    expect(create[0]!.textContent).toBe(ACCESS_SHEET.create('Budget'));
    await click(create[0]!);
    await until(() => reviewStore.get() === budget, 'the review opens');
    const pending = pendingAccessStore.get()[budget]!;
    expect(pending.provenance).toBe('user');
    expect(pending.purpose).toBe(ACCESS_SHEET.userPurpose('Budget'));
    expect(onClose).toHaveBeenCalled();
  });

  it("the creation act always names THIS app as the one that reads — on a source's sheet too, never the other app", async () => {
    await allow();
    await renderSheet(ledger);
    expect(one('access-create')?.textContent).toBe(ACCESS_SHEET.create('Ledger'));
    expect(document.body.textContent).not.toContain(ACCESS_SHEET.create('Budget'));
  });
});

describe('the sheet re-reads on the access revision', () => {
  it('a grant made while the sheet is open appears without a reopen', async () => {
    await renderSheet(budget);
    expect(rowsIn('access-reads')).toHaveLength(0);
    await act(async () => {
      await allow({ source: pantry, tables: ['items'] });
    });
    await until(() => rowsIn('access-reads').length === 1, 'the new row');
    expect(one('access-row-sentence', rowsIn('access-reads')[0])?.textContent).toBe(ACCESS_SHEET.row('Budget', 'Pantry', ['items']));
  });
});
