// accessStrip.test.tsx — the strip above the asking app's frame (TASK-20261010-cross-app-access
// AC18; ADR-0074 §4 — an app's ask is a STRIP, never a modal; D12 — three distinct negative acts).
//
// "<Reader> wants to read another app's data" · "<Reader> says: “…”" · review · not now · stop
// asking — then ONE outcome line for the visit (`data-outcome`): allowed (with *stop* as the
// undo), not-now, declined (won't ask this again), muted. The allowed and undo rows run the REAL
// engine (a parked ask over a real file, a real grant, a real stop); the rest drive a recorded
// pending.
//
// TASK-20261010-host-broker PR-3 (D-PR3-23; DS2): an ask that carried `access: 'write'` titles the
// strip "<Reader> wants to read — and change — another app's data"; an allow that ticked a write
// says "can now read and change …" (every table) or "… and change <t>" (some); and the undo's
// line says "no longer reads or changes" for such an access. The real-engine rows answer in the
// decision v2 (a LOCAL structural type until consent.ts exports it).
//
// TASK-20261010-host-broker PR-5 (D-PR5-5/15; AC35): a write ask allowed with no write ticked says
// "can now read — not change —" in the one clause, and the source's offer leaves its outcome on BOTH
// strips (the reader's and the source's) — the last two describe blocks.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';

import { AccessConsentSheet } from '../access/AccessConsentSheet.js';
import { AccessStrip } from '../access/AccessStrip.js';
import {
  collectSources,
  parkAccessRequest,
  pendingAccessStore,
  reviewStore,
  type ConsentDecision,
  type ConsentOutcome,
  type PendingAccessRequest,
} from '../access/consent.js';
import { CONSENT_UI, STRIP, STRIP_OUTCOME } from '../access/copy.js';
import { __setAccessDepsForTests, grantsForApp, resetAccessSession } from '../access/grants.js';
import { answerAccess } from '../access/outcome.js';
import { startUserAsk } from '../access/userAsk.js';
import { netConfirmStore, type PendingNetConfirm } from '../state/net.js';
import { openUrlConfirmStore } from '../state/openUrl.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const READER = 'app-budget';

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let resolve: ReturnType<typeof vi.fn<(decision: ConsentDecision) => Promise<ConsentOutcome>>>;

const OUTCOMES: Record<ConsentDecision['kind'], ConsentOutcome> = {
  allow: { kind: 'allowed', grantId: 'g-1', sourceAppId: 'app-ledger', sourceName: 'Ledger', tables: ['transactions'], duration: 'session', write: [] },
  'not-now': { kind: 'not-now' },
  'dont-allow': { kind: 'declined' },
  'stop-asking': { kind: 'muted' },
  dismissed: { kind: 'dismissed' },
};

function fakePending(over: Partial<PendingAccessRequest> = {}): PendingAccessRequest {
  return {
    readerAppId: READER,
    readerName: 'Budget',
    readerProvenance: 'built here · v1',
    generation: 0,
    purpose: 'to show spending by category',
    provenance: 'app',
    candidates: { matched: [], rest: [], excluded: [] },
    egressFor: () => [],
    resolve,
    ...over,
  };
}

const q = <T extends Element = HTMLElement>(testId: string): T | null => document.querySelector<T>(`[data-testid="${testId}"]`);

function mount(appId = READER, withSheet = false): void {
  act(() =>
    root!.render(
      <>
        <AccessStrip appId={appId} />
        {withSheet ? <AccessConsentSheet /> : null}
      </>,
    ),
  );
}

function park(pending: PendingAccessRequest = fakePending()): PendingAccessRequest {
  act(() => pendingAccessStore.set({ ...pendingAccessStore.get(), [pending.readerAppId]: pending }));
  return pending;
}

beforeEach(() => {
  pendingAccessStore.set({});
  reviewStore.set(undefined);
  openUrlConfirmStore.set(null);
  netConfirmStore.set(null);
  resolve = vi.fn(async (decision: ConsentDecision): Promise<ConsentOutcome> => {
    pendingAccessStore.set({});
    reviewStore.set(undefined);
    return OUTCOMES[decision.kind];
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  pendingAccessStore.set({});
  reviewStore.set(undefined);
  openUrlConfirmStore.set(null);
  netConfirmStore.set(null);
});

describe('AC18 — the strip', () => {
  it('nothing without an ask', () => {
    mount();
    expect(container!.innerHTML).toBe('');
  });

  it('is a .connection-note.is-strip with role=status: the title, "Budget says:" and the purpose in an isolated quote, and the three acts', () => {
    mount();
    park();
    const strip = q('access-ask')!;
    expect(strip.getAttribute('role')).toBe('status');
    expect(strip.classList.contains('connection-note')).toBe(true);
    expect(strip.classList.contains('is-strip')).toBe(true);
    expect(q('access-ask-title')!.textContent).toBe(STRIP.title('Budget'));
    expect(q('access-ask-says')!.textContent).toBe(`${STRIP.says('Budget')} ${STRIP.quote('to show spending by category')}`);
    const quote = q('access-ask-quote')!;
    expect(quote.tagName).toBe('Q');
    expect(quote.classList.contains('access-quote')).toBe(true);
    expect(quote.textContent).toBe(STRIP.quote('to show spending by category'));
    expect(q('access-ask-review')!.textContent).toBe(STRIP.review);
    expect(q('access-ask-not-now')!.textContent).toBe(STRIP.notNow);
    expect(q('access-ask-stop-asking')!.textContent).toBe(STRIP.stopAsking);
  });

  it('a purpose with markup is text, never an element', () => {
    mount();
    park(fakePending({ purpose: '<b>urgent</b>' }));
    expect(q('access-ask-quote')!.querySelector('b')).toBeNull();
    expect(q('access-ask-quote')!.textContent).toContain('<b>urgent</b>');
  });

  it("another app's ask is not this strip's; an access the user started has no strip (the sheet is already open)", () => {
    mount();
    park(fakePending({ readerAppId: 'app-other' }));
    expect(q('access-ask')).toBeNull();
    park(fakePending({ provenance: 'user' }));
    expect(q('access-ask')).toBeNull();
  });
});

describe('AC18 — the three acts', () => {
  it('review opens the sheet (reviewStore names this app); focus goes to not now and comes back to review when the sheet closes unanswered', async () => {
    mount(READER, true);
    park();
    const review = q<HTMLButtonElement>('access-ask-review')!;
    review.focus();
    await act(async () => review.click());
    expect(reviewStore.get()).toBe(READER);
    expect(q('access-consent-sheet')).not.toBeNull();
    expect(document.activeElement).toBe(q('access-not-now'));
    expect(resolve).not.toHaveBeenCalled();
    // A link confirm arrives: the sheet yields, unanswered, and focus returns to review.
    act(() => openUrlConfirmStore.set({ appId: READER, url: 'https://example.com/', resolve: () => undefined }));
    expect(q('access-consent-sheet')).toBeNull();
    expect(document.activeElement).toBe(q('access-ask-review'));
  });

  it('an answer on the sheet (Escape) removes review with the ask — focus lands on the outcome line, never on <body>', async () => {
    mount(READER, true);
    park();
    const review = q<HTMLButtonElement>('access-ask-review')!;
    review.focus();
    await act(async () => review.click());
    expect(document.activeElement).toBe(q('access-not-now'));
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(resolve).toHaveBeenCalledWith({ kind: 'not-now' });
    expect(q('access-consent-sheet')).toBeNull();
    expect(q('access-ask-review')).toBeNull();
    const line = q('access-ask-outcome')!;
    expect(line.getAttribute('data-outcome')).toBe('not-now');
    expect(line.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(line);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('an outcome line that arrives while focus is elsewhere on the page leaves focus where it is', async () => {
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    try {
      mount();
      const pending = park();
      elsewhere.focus();
      await act(async () => {
        await answerAccess(pending, { kind: 'not-now' });
      });
      expect(q('access-ask-outcome')).not.toBeNull();
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });

  it('review while a link confirm is open does not open the sheet — the strip says to answer that first', async () => {
    mount();
    park();
    act(() => openUrlConfirmStore.set({ appId: READER, url: 'https://example.com/', resolve: () => undefined }));
    await act(async () => q<HTMLButtonElement>('access-ask-review')!.click());
    expect(reviewStore.get()).toBeUndefined();
    expect(q('access-ask-wait')!.textContent).toBe(CONSENT_UI.answerOtherFirst);
    expect(CONSENT_UI.answerOtherFirst).toBe('answer the open question first, then review');
    // The confirm goes: the note goes with it, and review works.
    act(() => openUrlConfirmStore.set(null));
    expect(q('access-ask-wait')).toBeNull();
    await act(async () => q<HTMLButtonElement>('access-ask-review')!.click());
    expect(reviewStore.get()).toBe(READER);
  });

  // W6 finding 28 — the NETWORK confirm's twin of the row above.
  it('review while a NETWORK confirm is open does not open the sheet — the strip says to answer that first', async () => {
    mount();
    park();
    act(() => netConfirmStore.set({ request: {} as PendingNetConfirm['request'], resolve: () => undefined }));
    await act(async () => q<HTMLButtonElement>('access-ask-review')!.click());
    expect(reviewStore.get()).toBeUndefined();
    expect(q('access-ask-wait')!.textContent).toBe(CONSENT_UI.answerOtherFirst);
    act(() => netConfirmStore.set(null));
    expect(q('access-ask-wait')).toBeNull();
    await act(async () => q<HTMLButtonElement>('access-ask-review')!.click());
    expect(reviewStore.get()).toBe(READER);
  });

  it('not now → resolve not-now, and one line: "not now — Budget may ask again"', async () => {
    mount();
    park();
    await act(async () => q<HTMLButtonElement>('access-ask-not-now')!.click());
    expect(resolve).toHaveBeenCalledWith({ kind: 'not-now' });
    const line = q('access-ask-outcome')!;
    expect(line.getAttribute('role')).toBe('status');
    expect(line.getAttribute('data-outcome')).toBe('not-now');
    expect(line.textContent).toBe(STRIP_OUTCOME.notNow('Budget'));
  });

  it('stop asking → resolve stop-asking, and "Budget won\'t ask again — change that in Settings"', async () => {
    mount();
    park();
    await act(async () => q<HTMLButtonElement>('access-ask-stop-asking')!.click());
    expect(resolve).toHaveBeenCalledWith({ kind: 'stop-asking' });
    expect(q('access-ask-outcome')!.getAttribute('data-outcome')).toBe('muted');
    expect(q('access-ask-outcome')!.textContent).toBe(STRIP_OUTCOME.muted('Budget'));
  });

  it("the sheet's don't allow lands here as \"won't ask this again\"", async () => {
    mount();
    const pending = park();
    await act(async () => {
      await answerAccess(pending, { kind: 'dont-allow' });
    });
    expect(q('access-ask-outcome')!.getAttribute('data-outcome')).toBe('declined');
    expect(q('access-ask-outcome')!.textContent).toBe(STRIP_OUTCOME.wontAskAgain('Budget'));
  });

  it('a new ask replaces the last outcome line', async () => {
    mount();
    park();
    await act(async () => q<HTMLButtonElement>('access-ask-not-now')!.click());
    expect(q('access-ask-outcome')).not.toBeNull();
    park();
    expect(q('access-ask-outcome')).toBeNull();
    expect(q('access-ask')).not.toBeNull();
  });

  it("a failure the engine has no words for is ONE fixed sentence — the raw message (internal words, caps) goes to the console, never the strip", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const raw = 'the file already holds 100 live access grants';
      resolve.mockImplementationOnce(async () => {
        pendingAccessStore.set({});
        return { kind: 'failed', message: raw };
      });
      mount();
      const pending = park();
      await act(async () => {
        await answerAccess(pending, { kind: 'allow', sourceAppId: 'app-ledger', tables: ['transactions'], duration: 'day', unattended: false });
      });
      const line = q('access-ask-outcome')!;
      expect(line.getAttribute('data-outcome')).toBe('failed');
      expect(line.textContent).toBe(CONSENT_UI.nothingAllowed);
      expect(line.textContent).not.toContain('grant');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]!.join(' '))).toContain(raw);
    } finally {
      warn.mockRestore();
    }
  });

  it('an outcome from before this strip mounted is not shown (one line for THIS visit)', async () => {
    const pending = park();
    await act(async () => {
      await answerAccess(pending, { kind: 'not-now' });
    });
    mount();
    expect(q('access-ask-outcome')).toBeNull();
  });
});

describe('AC18 — allowed, with stop as the undo (the real engine)', () => {
  let db: UserDb;
  let budget: string;
  let ledger: string;

  beforeEach(async () => {
    await act(async () => {
      resetAccessSession();
      db = await installTestUserDb();
    });
    __setAccessDepsForTests({ getDb: () => Promise.resolve(db) });
    budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
    ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
    await db.applyAppDdl(ledger, ['CREATE TABLE transactions (amount INTEGER, category TEXT)']);
    await db.driver.handle(ledger, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: 'seed-1', instanceId: 'seed', op: 'exec', sql: "INSERT INTO transactions VALUES (450, 'food')" });
  });

  afterEach(() => {
    act(() => resetAccessSession());
    __setAccessDepsForTests();
  });

  it('"Budget can now read Ledger\'s transactions · for a day · stop" — and stop stops it', async () => {
    const candidates = await collectSources(db, budget, { tables: ['transactions'] });
    mount(budget);
    let pending: PendingAccessRequest | undefined;
    act(() => {
      pending = parkAccessRequest({ db, reader: db.getApp(budget)!, generation: 0, purpose: 'to add things up', provenance: 'app', candidates, hash: '0123456789abcdef' });
    });
    expect(q('access-ask')).not.toBeNull();
    await act(async () => {
      await answerAccess(pending!, { kind: 'allow', sourceAppId: ledger, tables: ['transactions'], duration: 'day', unattended: false });
    });
    const line = q('access-ask-outcome')!;
    expect(line.getAttribute('data-outcome')).toBe('allowed');
    expect(q('access-ask-outcome-words')!.textContent).toBe(STRIP_OUTCOME.allowed('Budget', 'Ledger', ['transactions'], 'day'));
    const undo = q<HTMLButtonElement>('access-ask-undo')!;
    expect(undo.textContent).toBe(STRIP_OUTCOME.undo);
    const before = grantsForApp(db, budget, Date.now()).reads;
    expect(before).toHaveLength(1);
    expect(before[0]!.live).toBe(true);
    await act(async () => undo.click());
    await act(async () => {
      await vi.waitFor(() => expect(grantsForApp(db, budget, Date.now()).reads[0]!.grant.status).toBe('revoked'));
    });
    expect(q('access-ask-outcome')!.getAttribute('data-outcome')).toBe('stopped');
    expect(q('access-ask-outcome')!.textContent).toBe(CONSENT_UI.stopped('Budget', 'Ledger', ['transactions']));
    expect(CONSENT_UI.stopped('Budget', 'Ledger', ['transactions'])).toBe("stopped — Budget no longer reads Ledger's transactions");
  });

  it("the default duration's undo: a session access (memory, never in the file) is stopped by *stop* too", async () => {
    const candidates = await collectSources(db, budget, { tables: ['transactions'] });
    mount(budget);
    let pending: PendingAccessRequest | undefined;
    act(() => {
      pending = parkAccessRequest({ db, reader: db.getApp(budget)!, generation: 0, purpose: 'to add things up', provenance: 'app', candidates, hash: '0123456789abcdef' });
    });
    await act(async () => {
      await answerAccess(pending!, { kind: 'allow', sourceAppId: ledger, tables: ['transactions'], duration: 'session', unattended: false });
    });
    expect(q('access-ask-outcome-words')!.textContent).toBe(STRIP_OUTCOME.allowed('Budget', 'Ledger', ['transactions'], 'session'));
    const before = grantsForApp(db, budget, Date.now()).reads;
    expect(before).toHaveLength(1);
    expect(before[0]!.session).toBe(true);
    expect(db.listAccessGrants()).toEqual([]);
    await act(async () => q<HTMLButtonElement>('access-ask-undo')!.click());
    await act(async () => {
      await vi.waitFor(() => expect(grantsForApp(db, budget, Date.now()).reads).toEqual([]));
    });
    expect(q('access-ask-outcome')!.getAttribute('data-outcome')).toBe('stopped');
    expect(db.listAccessLog(ledger).map((entry) => entry.kind).sort()).toEqual(['granted', 'revoked']);
  });

  it('an allow the engine refuses says so in one line', async () => {
    const candidates = await collectSources(db, budget);
    mount(budget);
    let pending: PendingAccessRequest | undefined;
    act(() => {
      pending = parkAccessRequest({ db, reader: db.getApp(budget)!, generation: 0, purpose: 'to add things up', provenance: 'app', candidates });
    });
    await act(async () => {
      await answerAccess(pending!, { kind: 'allow', sourceAppId: ledger, tables: [], duration: 'day', unattended: false });
    });
    expect(q('access-ask-outcome')!.getAttribute('data-outcome')).toBe('failed');
    expect(q('access-ask-outcome')!.textContent).toBe(CONSENT_UI.failed('choose at least one table'));
  });
});

// =========================================================================================
// TASK-20261010-host-broker PR-3 (D-PR3-23; DS2) — the strip and its lines when the access can change rows
// =========================================================================================

/** LOCAL structural types (D-PR3-23) — replaced by the real exports at Gate 5. */
interface TableChoiceV2 {
  name: string;
  withheld: string[];
  write: boolean;
}
type AllowV2 = { kind: 'allow'; sourceAppId: string; tables: TableChoiceV2[]; duration: 'session' | 'day' | 'week' | 'always'; unattended: boolean; kv: boolean; refresh: boolean };
const answerV2 = answerAccess as unknown as (pending: PendingAccessRequest, decision: AllowV2) => Promise<ConsentOutcome>;
const STRIP3 = STRIP as unknown as { title(readerName: string, wantsWrite?: boolean): string };
const allowed3 = STRIP_OUTCOME.allowed as unknown as (readerName: string, sourceName: string, tables: readonly string[], duration: AllowV2['duration'], write?: readonly string[]) => string;
const stopped3 = CONSENT_UI.stopped as unknown as (readerName: string, sourceName: string, tables: readonly string[], write?: readonly string[]) => string;

describe('PR-3 — an ask that carried access: write (D-PR3-4/23; DS2)', () => {
  it('the strip says "Budget wants to read — and change — another app\'s data"', () => {
    mount();
    park(fakePending({ wantsWrite: true } as Partial<PendingAccessRequest>));
    expect(q('access-ask-title')!.textContent).toBe(STRIP3.title('Budget', true));
    expect(STRIP3.title('Budget', true)).not.toBe(STRIP.title('Budget'));
  });

  it('the twin: a read ask keeps today’s title', () => {
    mount();
    park();
    expect(q('access-ask-title')!.textContent).toBe(STRIP.title('Budget'));
  });
});

describe('PR-3 — allowed with write, and its stop (the real engine; D-PR3-23)', () => {
  let db: UserDb;
  let budget: string;
  let ledger: string;

  beforeEach(async () => {
    await act(async () => {
      resetAccessSession();
      db = await installTestUserDb();
    });
    __setAccessDepsForTests({ getDb: () => Promise.resolve(db) });
    budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
    ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
    await db.applyAppDdl(ledger, ['CREATE TABLE transactions (amount INTEGER, category TEXT)', 'CREATE TABLE accounts (name TEXT, balance INTEGER)']);
    await db.driver.handle(ledger, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: 'seed-1', instanceId: 'seed', op: 'exec', sql: "INSERT INTO transactions VALUES (450, 'food')" });
  });

  afterEach(() => {
    act(() => resetAccessSession());
    __setAccessDepsForTests();
  });

  async function allowVia(tables: TableChoiceV2[], duration: AllowV2['duration'] = 'day'): Promise<void> {
    const candidates = await collectSources(db, budget, { tables: ['transactions'] });
    mount(budget);
    let pending: PendingAccessRequest | undefined;
    act(() => {
      pending = parkAccessRequest({ db, reader: db.getApp(budget)!, generation: 0, purpose: 'to tidy the categories', provenance: 'app', candidates, hash: '0123456789abcdef' });
    });
    await act(async () => {
      await answerV2(pending!, { kind: 'allow', sourceAppId: ledger, tables, duration, unattended: false, kv: false, refresh: false });
    });
  }

  it('every table writable: "Budget can now read and change Ledger\'s transactions · for a day"', async () => {
    await allowVia([{ name: 'transactions', withheld: [], write: true }]);
    expect(q('access-ask-outcome')!.getAttribute('data-outcome')).toBe('allowed');
    expect(q('access-ask-outcome-words')!.textContent).toBe(allowed3('Budget', 'Ledger', ['transactions'], 'day', ['transactions']));
    expect(allowed3('Budget', 'Ledger', ['transactions'], 'day', ['transactions'])).toBe("Budget can now read and change Ledger's transactions · for a day");
  });

  it('some tables writable: "Budget can now read Ledger\'s transactions and accounts, and change transactions · while it\'s open"', async () => {
    await allowVia([{ name: 'transactions', withheld: [], write: true }, { name: 'accounts', withheld: [], write: false }], 'session');
    expect(q('access-ask-outcome-words')!.textContent).toBe(allowed3('Budget', 'Ledger', ['transactions', 'accounts'], 'session', ['transactions']));
    expect(q('access-ask-outcome-words')!.textContent).toContain('and change transactions');
  });

  it('nothing writable: today’s line, byte for byte', async () => {
    await allowVia([{ name: 'transactions', withheld: [], write: false }]);
    expect(q('access-ask-outcome-words')!.textContent).toBe(STRIP_OUTCOME.allowed('Budget', 'Ledger', ['transactions'], 'day'));
  });

  it('*stop* on a write access says "no longer reads or changes"', async () => {
    await allowVia([{ name: 'transactions', withheld: [], write: true }]);
    await act(async () => q<HTMLButtonElement>('access-ask-undo')!.click());
    await act(async () => {
      await vi.waitFor(() => expect(grantsForApp(db, budget, Date.now()).reads[0]!.grant.status).toBe('revoked'));
    });
    expect(q('access-ask-outcome')!.getAttribute('data-outcome')).toBe('stopped');
    expect(q('access-ask-outcome')!.textContent).toBe(stopped3('Budget', 'Ledger', ['transactions'], ['transactions']));
    expect(stopped3('Budget', 'Ledger', ['transactions'], ['transactions'])).toBe("stopped — Budget no longer reads or changes Ledger's transactions");
  });
});

// =========================================================================================
// TASK-20261010-host-broker PR-5 (contract v2 D-PR5-5, D-PR5-15; AC35; D17)
//
//  - an ask that WANTED write (`wantsWrite` — an app's `access: 'write'`, or the chat's ask carrying
//    `access: 'write'`) allowed with NO table ticked *can also change rows* says so in the one clause:
//    `STRIP_OUTCOME.allowed(…, {notChange: true})` — *Budget can now read — not change — Ledger's
//    transactions · for a day*; a read ask, and a write ask allowed with a write, keep their lines;
//  - the source's OFFER records its outcome under BOTH ids: the reader's strip and the source's strip
//    each show the allowed line.
// =========================================================================================

const allowed5 = STRIP_OUTCOME.allowed as unknown as (
  readerName: string,
  sourceName: string,
  tables: readonly string[],
  duration: AllowV2['duration'],
  write?: readonly string[],
  opts?: { notChange?: boolean },
) => string;

describe('PR-5 — the ask wanted change, none was allowed: "can now read — not change —" (D-PR5-15; D17)', () => {
  let db: UserDb;
  let budget: string;
  let ledger: string;

  beforeEach(async () => {
    await act(async () => {
      resetAccessSession();
      db = await installTestUserDb();
    });
    __setAccessDepsForTests({ getDb: () => Promise.resolve(db) });
    budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
    ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
    await db.applyAppDdl(ledger, ['CREATE TABLE transactions (amount INTEGER, category TEXT)']);
    await db.driver.handle(ledger, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: 'seed-5', instanceId: 'seed', op: 'exec', sql: "INSERT INTO transactions VALUES (450, 'food')" });
  });

  afterEach(() => {
    act(() => resetAccessSession());
    __setAccessDepsForTests();
  });

  async function allowFrom(park: { provenance: 'app' | 'user'; askedIn?: 'chat'; wantsWrite?: boolean }, write: boolean): Promise<void> {
    const candidates = await collectSources(db, budget, { tables: ['transactions'] });
    mount(budget);
    let pending: PendingAccessRequest | undefined;
    act(() => {
      pending = parkAccessRequest({
        db,
        reader: db.getApp(budget)!,
        generation: 0,
        purpose: 'to tidy the categories',
        provenance: park.provenance,
        ...(park.askedIn !== undefined ? { askedIn: park.askedIn } : {}),
        ...(park.wantsWrite === true ? { wantsWrite: true } : {}),
        candidates,
        hash: '0123456789abcdef',
      });
    });
    await act(async () => {
      await answerV2(pending!, { kind: 'allow', sourceAppId: ledger, tables: [{ name: 'transactions', withheld: [], write }], duration: 'day', unattended: false, kv: false, refresh: false });
    });
  }

  it('an APP’s write ask allowed read-only: "Budget can now read — not change — Ledger\'s transactions · for a day"', async () => {
    await allowFrom({ provenance: 'app', wantsWrite: true }, false);
    expect(q('access-ask-outcome')!.getAttribute('data-outcome')).toBe('allowed');
    expect(q('access-ask-outcome-words')!.textContent).toBe(allowed5('Budget', 'Ledger', ['transactions'], 'day', [], { notChange: true }));
    expect(q('access-ask-outcome-words')!.textContent).toBe("Budget can now read — not change — Ledger's transactions · for a day");
  });

  it('the CHAT’s write ask (access: write) allowed read-only says the same', async () => {
    await allowFrom({ provenance: 'user', askedIn: 'chat', wantsWrite: true }, false);
    expect(q('access-ask-outcome-words')!.textContent).toBe(allowed5('Budget', 'Ledger', ['transactions'], 'day', [], { notChange: true }));
    expect(q('access-ask-outcome-words')!.textContent).toContain('— not change —');
  });

  it('GUARD — a write ask allowed WITH the write keeps the "read and change" line', async () => {
    await allowFrom({ provenance: 'app', wantsWrite: true }, true);
    expect(q('access-ask-outcome-words')!.textContent).toBe(allowed3('Budget', 'Ledger', ['transactions'], 'day', ['transactions']));
  });

  it('GUARD — a READ ask allowed read-only keeps today’s line, byte for byte (no "not change")', async () => {
    await allowFrom({ provenance: 'app' }, false);
    expect(q('access-ask-outcome-words')!.textContent).toBe(STRIP_OUTCOME.allowed('Budget', 'Ledger', ['transactions'], 'day'));
    expect(q('access-ask-outcome-words')!.textContent).not.toContain('not change');
  });
});

describe('PR-5 — the source’s offer: its outcome on BOTH strips (D-PR5-5)', () => {
  let db: UserDb;
  let budget: string;
  let ledger: string;

  beforeEach(async () => {
    await act(async () => {
      resetAccessSession();
      db = await installTestUserDb();
    });
    __setAccessDepsForTests({ getDb: () => Promise.resolve(db) });
    budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
    ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
    await db.applyAppDdl(ledger, ['CREATE TABLE transactions (amount INTEGER, category TEXT)']);
  });

  afterEach(() => {
    act(() => resetAccessSession());
    __setAccessDepsForTests();
  });

  const outcomeIn = (appId: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="access-ask-outcome"][data-app="${appId}"]`);

  it('allowed from the offer: the reader’s strip AND the source’s strip each say "Budget can now read Ledger\'s transactions"', async () => {
    act(() =>
      root!.render(
        <>
          <AccessStrip appId={budget} />
          <AccessStrip appId={ledger} />
        </>,
      ),
    );
    await act(async () => {
      await (startUserAsk as unknown as (id: string, opts: { source: string; offer: true }) => Promise<unknown>)(budget, { source: ledger, offer: true });
    });
    const pending = pendingAccessStore.get()[budget] as (PendingAccessRequest & { offeredBy?: string }) | undefined;
    expect(pending?.offeredBy, 'the offer parked').toBe('source');
    await act(async () => {
      await answerV2(pending!, { kind: 'allow', sourceAppId: ledger, tables: [{ name: 'transactions', withheld: [], write: false }], duration: 'day', unattended: false, kv: false, refresh: false });
    });
    const words = STRIP_OUTCOME.allowed('Budget', 'Ledger', ['transactions'], 'day');
    expect(outcomeIn(budget)?.getAttribute('data-outcome')).toBe('allowed');
    expect(outcomeIn(budget)?.textContent).toContain(words);
    expect(outcomeIn(ledger)?.getAttribute('data-outcome'), 'the source’s strip hears it too').toBe('allowed');
    expect(outcomeIn(ledger)?.textContent).toContain(words);
  });

  it('GUARD — a reader-side user ask records under the reader only (the source’s strip stays silent)', async () => {
    act(() =>
      root!.render(
        <>
          <AccessStrip appId={budget} />
          <AccessStrip appId={ledger} />
        </>,
      ),
    );
    await act(async () => {
      await startUserAsk(budget);
    });
    const pending = pendingAccessStore.get()[budget]!;
    await act(async () => {
      await answerV2(pending, { kind: 'allow', sourceAppId: ledger, tables: [{ name: 'transactions', withheld: [], write: false }], duration: 'day', unattended: false, kv: false, refresh: false });
    });
    expect(outcomeIn(budget)?.getAttribute('data-outcome')).toBe('allowed');
    expect(outcomeIn(ledger)).toBeNull();
  });
});

// =========================================================================================
// TASK-20261010-host-broker PR-5 — Gate-5 fold G5-12 (IB-1): a DECLARED-form *don't allow* is
// recorded as a strip outcome on the reader. The ⋈ sheet's pair act closes the sheet before the
// review opens (`beforeOpen`), so the act's own settle is unmounted with it; `worthALine` dropped
// every user-provenance `declined`, so the person saw no line anywhere. `worthALine` now admits
// `declined` when `askedIn: 'declared'`, and the reader's strip says `wontAskAgain(reader)`.
// =========================================================================================

describe('G5-12 a declared-form decline leaves the reader’s strip a line', () => {
  type PendingDeclared = PendingAccessRequest & { askedIn?: 'chat' | 'declared' };

  it('G5-12 askedIn declared + don’t allow → the strip says "Budget won’t ask this again…" (data-outcome declined)', async () => {
    mount();
    const pending = fakePending({ provenance: 'user', askedIn: 'declared' } as Partial<PendingDeclared>);
    await act(async () => {
      await answerAccess(pending, { kind: 'dont-allow' });
    });
    const line = q('access-ask-outcome');
    expect(line?.getAttribute('data-outcome')).toBe('declined');
    expect(line?.textContent).toContain(STRIP_OUTCOME.wontAskAgain('Budget'));
  });

  it('G5-12 guard: a BARE user ask declined still leaves no line (only the declared form is admitted)', async () => {
    mount();
    const pending = fakePending({ provenance: 'user' });
    await act(async () => {
      await answerAccess(pending, { kind: 'dont-allow' });
    });
    expect(q('access-ask-outcome')).toBeNull();
  });

  it('G5-12 guard: a declared-form NOT NOW leaves no line (only the decline is admitted)', async () => {
    mount();
    const pending = fakePending({ provenance: 'user', askedIn: 'declared' } as Partial<PendingDeclared>);
    await act(async () => {
      await answerAccess(pending, { kind: 'not-now' });
    });
    expect(q('access-ask-outcome')).toBeNull();
  });
});
