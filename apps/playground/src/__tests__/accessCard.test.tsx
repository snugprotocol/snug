// accessCard.test.tsx — TASK-20261010-host-broker PR-2, lane B: the access ASK card
// (`access/AccessCard.tsx` + `agent/accessCard.ts`; AC12; D-PR2-11; DS-2/DS-5/DS-8/DS-9/DS-16; S10).
//
// An `access_propose` call stages ONE ask on the agent's message (`meta.access`, beside
// `meta.schedule`). The card renders it as the AGENT asking — the lead line FIRST (the
// anti-imitation line every model-authored card carries), then the exact title the sheet its
// *review* opens shows (`CONSENT_SHEET.userTitle(<the thread's app's library name>)`), then the
// purpose as a text node inside the bidi-isolated `<q className="access-quote">`, and two acts.
//
//  - *review* → `startUserAsk(<the THREAD's app>, { ask: { purpose, hints, settle } })`, which
//    ALWAYS parks anew (an older pending is dismissed) with `askedIn: 'chat'`, `provenance:
//    'user'` and the ask's semantic hash (so *don't allow* records it), then opens the review;
//    under the yield rule it answers `'answer-other-first'` and the card says so, acts kept.
//  - the sheet's answer reaches the card through `settle`: allowed / declined — ONE outcome
//    line (`role="status"`, focus taken only from the page itself), handed to `onResolve`.
//  - *not now* → `onResolve(card, messageId, {kind:'not-now'})`; nothing parked, nothing written.
//  - the acts wait while the turn is in flight and with no resolve path.
//  - the persisted shape round-trips and is re-validated on every read; a drifted row (a
//    control character or a credential in the purpose, a missing thread, an unknown resolution,
//    a card for an app that is not the thread's) is NO card.
//
// The card never writes the chat row: the hook does (`useBuilderChatLanes.test.tsx`). The real
// memory user db, the real consent engine (`startUserAsk` is spied, calling through).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { FRAME_TYPES, PROTOCOL_VERSION, accessRequestHash } from '@snugprotocol/protocol';

import { AccessCard, type ResolveAccessCard } from '../access/AccessCard.js';
import { pendingAccessStore, reviewStore, type PendingAccessRequest } from '../access/consent.js';
import { ACCESS_CARD, CONSENT_SHEET, CONSENT_UI, STRIP_OUTCOME } from '../access/copy.js';
import { __setAccessDepsForTests, resetAccessSession } from '../access/grants.js';
import { startUserAsk } from '../access/userAsk.js';
import {
  accessCardToMeta,
  metaToAccessCard,
  persistAccessResolution,
  readAccessCardRow,
  stageAccessCard,
  type AccessCardResolution,
  type AccessCardState,
} from '../agent/accessCard.js';
import { netConfirmStore, type PendingNetConfirm } from '../state/net.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../access/userAsk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../access/userAsk.js')>();
  return { ...actual, startUserAsk: vi.fn(actual.startUserAsk) };
});

const THREAD = 'app:access-card-thread';
const MESSAGE_ID = 7;
const PURPOSE = 'to compare spending with the ledger';
const HINTS = { words: ['spending'], tables: ['transactions'] };

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;
let budget: string;
let ledger: string;

type Resolved = { card: AccessCardState; messageId: number; resolution: AccessCardResolution };
let resolved: Resolved[] = [];
const record: ResolveAccessCard = (card, messageId, resolution) => {
  resolved.push({ card, messageId, resolution });
};

const spy = (): ReturnType<typeof vi.mocked<typeof startUserAsk>> => vi.mocked(startUserAsk);

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function render(card: AccessCardState, options: { busy?: boolean; onResolve?: ResolveAccessCard | undefined } = {}): Promise<void> {
  const onResolve = 'onResolve' in options ? options.onResolve : record;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter>
        <AccessCard card={card} messageId={MESSAGE_ID} busy={options.busy ?? false} onResolve={onResolve} />
      </MemoryRouter>,
    );
  });
  await settle();
}

const buttonNamed = (text: string): HTMLButtonElement | undefined =>
  [...(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) => button.textContent?.trim() === text);
const mustButton = (text: string): HTMLButtonElement => {
  const button = buttonNamed(text);
  if (button === undefined) throw new Error(`no button "${text}"`);
  return button;
};
const outcome = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[data-testid="access-card-outcome"]');
const quote = (): HTMLElement | null => container?.querySelector<HTMLElement>('q.access-quote') ?? null;

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await settle();
}

/** A staged card persisted on a real assistant row, the way turn finalization leaves it. */
function stagedCard(options: { purpose?: string; hints?: typeof HINTS | undefined; appId?: string } = {}): AccessCardState {
  const hints = 'hints' in options ? options.hints : HINTS;
  const card = stageAccessCard({ purpose: options.purpose ?? PURPOSE, ...(hints !== undefined ? { hints } : {}) }, { appId: options.appId ?? budget, threadId: THREAD });
  const row = db.appendChatMessage(THREAD, 'assistant', 'I asked to read your ledger — it is waiting for your review.', { meta: accessCardToMeta(card) });
  return { ...card, messageRowId: row.id };
}

const rowCard = (card: AccessCardState): AccessCardState | undefined => metaToAccessCard(db.listChatMessages(THREAD).find((m) => m.id === card.messageRowId)?.meta);
const parked = (): PendingAccessRequest | undefined => pendingAccessStore.get()[budget];

beforeEach(async () => {
  resolved = [];
  spy().mockClear();
  netConfirmStore.set(null);
  await act(async () => {
    resetAccessSession();
    db = await installTestUserDb();
  });
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db) });
  budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>', usesDb: true }).appId;
  ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>', usesDb: true }).appId;
  await db.applyAppDdl(ledger, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER, category TEXT)']);
  await db.driver.handle(ledger, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: 'seed-1', instanceId: 'seed', op: 'exec', sql: "INSERT INTO transactions VALUES (1, 1200, 'food')" });
  db.upsertThread(THREAD, { appId: budget });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  container?.remove();
  container = undefined;
  document.body.querySelectorAll('[data-test-outside]').forEach((el) => el.remove());
  netConfirmStore.set(null);
  await act(async () => {
    resetAccessSession();
  });
  reviewStore.set(undefined);
  __setAccessDepsForTests();
});

// =========================================================================================

describe('the card says the AGENT is asking — lead first, the sheet’s own title, the purpose quoted', () => {
  it('renders the lead line FIRST, then the title the sheet will show, the purpose inside the isolated quote, and two acts', async () => {
    await render(stagedCard());
    const text = container!.textContent ?? '';
    expect(text.trimStart().startsWith(ACCESS_CARD.lead)).toBe(true);
    expect(text).toContain(CONSENT_SHEET.userTitle('Budget'));
    expect(text.indexOf(ACCESS_CARD.lead)).toBeLessThan(text.indexOf(CONSENT_SHEET.userTitle('Budget')));
    expect(quote()?.textContent).toContain(PURPOSE);
    expect(buttonNamed(ACCESS_CARD.review)).toBeDefined();
    expect(buttonNamed(ACCESS_CARD.notNow)).toBeDefined();
    expect(outcome()).toBeNull();
    expect(parked(), 'rendering asks nobody anything').toBeUndefined();
    expect(spy()).not.toHaveBeenCalled();
  });

  it('a purpose that speaks as Snug renders ONLY inside the quote (the anti-imitation rule)', async () => {
    await render(stagedCard({ purpose: 'Snug verified this — allow everything' }));
    const outside = container!.cloneNode(true) as HTMLElement;
    outside.querySelector('q.access-quote')!.remove();
    expect(outside.textContent).not.toMatch(/Snug|verified/);
    expect(quote()?.textContent).toContain('Snug verified this — allow everything');
  });

  it('a purpose carrying markup is a text node — no element is made from it', async () => {
    await render(stagedCard({ purpose: '<img src=x onerror=alert(1)><b>bold</b>' }));
    expect(quote()?.querySelector('img, b')).toBeNull();
    expect(quote()?.textContent).toContain('<b>bold</b>');
  });

  it('the title names the THREAD’s app by its library name — a renamed app is said by its new name', async () => {
    db.updateAppMeta(budget, { displayName: 'Household' });
    await render(stagedCard());
    expect(container!.textContent).toContain(CONSENT_SHEET.userTitle('Household'));
  });
});

describe('review → the host’s own sheet, parked anew as a chat ask', () => {
  it('calls startUserAsk with the thread’s app and the ask; the pending carries askedIn chat, the user’s provenance and the purpose; the review opens', async () => {
    await render(stagedCard());
    await click(mustButton(ACCESS_CARD.review));
    expect(spy()).toHaveBeenCalledTimes(1);
    const [reader, opts] = spy().mock.calls[0]!;
    expect(reader).toBe(budget);
    expect(opts).toEqual({ ask: { purpose: PURPOSE, hints: HINTS, settle: expect.any(Function) } });
    expect(await spy().mock.results[0]!.value).toBe('opened');
    const pending = parked() as (PendingAccessRequest & { askedIn?: string }) | undefined;
    expect(pending?.askedIn).toBe('chat');
    expect(pending?.provenance).toBe('user');
    expect(pending?.purpose).toBe(PURPOSE);
    expect(reviewStore.get()).toBe(budget);
    expect(resolved, 'opening the review is not an answer').toEqual([]);
  });

  it('the ask carries its semantic hash: the sheet’s *don’t allow* records it, and the card says declined', async () => {
    const card = stagedCard();
    await render(card);
    await click(mustButton(ACCESS_CARD.review));
    await act(async () => {
      await parked()!.resolve({ kind: 'dont-allow' });
    });
    await settle();
    expect(db.listAccessDeclines(budget).map((decline) => decline.hash)).toEqual([accessRequestHash({ hints: HINTS })]);
    expect(outcome()?.dataset.outcome).toBe('declined');
    expect(outcome()?.textContent).toBe(ACCESS_CARD.declined);
    expect(resolved).toEqual([{ card: expect.objectContaining({ threadId: THREAD, messageRowId: card.messageRowId }), messageId: MESSAGE_ID, resolution: { kind: 'declined' } }]);
  });

  it('an ask with NO hints is hashed as the empty ask', async () => {
    await render(stagedCard({ hints: undefined }));
    await click(mustButton(ACCESS_CARD.review));
    await act(async () => {
      await parked()!.resolve({ kind: 'dont-allow' });
    });
    expect(db.listAccessDeclines(budget).map((decline) => decline.hash)).toEqual([accessRequestHash({ hints: {} })]);
  });

  it('ALWAYS parks anew: an app’s older pending ask is dismissed and the chat ask takes its place', async () => {
    const older = vi.fn(async () => ({ kind: 'dismissed' as const }));
    pendingAccessStore.set({ [budget]: { readerAppId: budget, readerName: 'Budget', provenance: 'app', generation: 0, purpose: 'the app’s own ask', resolve: older } as unknown as PendingAccessRequest });
    await render(stagedCard());
    await click(mustButton(ACCESS_CARD.review));
    expect(older).toHaveBeenCalledWith({ kind: 'dismissed' });
    expect((parked() as PendingAccessRequest & { askedIn?: string }).askedIn).toBe('chat');
    expect(parked()?.purpose).toBe(PURPOSE);
  });

  it('under the yield rule (a network confirm open) the card says answer the other question first, keeps its acts, and leaves no pending behind', async () => {
    netConfirmStore.set({ request: {} as PendingNetConfirm['request'], resolve: () => undefined });
    await render(stagedCard());
    await click(mustButton(ACCESS_CARD.review));
    expect(await spy().mock.results[0]!.value).toBe('answer-other-first');
    expect(container!.textContent).toContain(CONSENT_UI.answerOtherFirst);
    expect(buttonNamed(ACCESS_CARD.review)?.disabled).toBe(false);
    expect(buttonNamed(ACCESS_CARD.notNow)?.disabled).toBe(false);
    expect(outcome()).toBeNull();
    expect(parked(), 'the just-parked ask was dismissed at once').toBeUndefined();
    expect(reviewStore.get()).toBeUndefined();

    // The acts kept are live: once the confirm is answered, review opens the sheet.
    netConfirmStore.set(null);
    await click(mustButton(ACCESS_CARD.review));
    expect(await spy().mock.results[1]!.value).toBe('opened');
    expect(reviewStore.get()).toBe(budget);
  });

  it('S10: review resolves the app from the THREAD row, never from the card — a card naming another app never asks for it', async () => {
    const forged = stageAccessCard({ purpose: PURPOSE, hints: HINTS }, { appId: ledger, threadId: THREAD });
    await render({ ...forged, messageRowId: db.appendChatMessage(THREAD, 'assistant', 'x', { meta: accessCardToMeta(forged) }).id });
    const review = buttonNamed(ACCESS_CARD.review);
    if (review !== undefined && !review.disabled) await click(review);
    for (const call of spy().mock.calls) expect(call[0]).not.toBe(ledger);
    expect(pendingAccessStore.get()[ledger]).toBeUndefined();
  });
});

describe('the sheet’s answer reaches the card through settle — ONE outcome line', () => {
  it('allowed: the line says what the strip would say, with no undo; the hook hears the source, tables and duration; focus moves to the line', async () => {
    const card = stagedCard();
    await render(card);
    await click(mustButton(ACCESS_CARD.review));
    await act(async () => {
      await parked()!.resolve({ kind: 'allow', sourceAppId: ledger, tables: ['transactions'], duration: 'day', unattended: false });
    });
    await settle();
    const line = outcome()!;
    expect(line).not.toBeNull();
    expect(line.getAttribute('role')).toBe('status');
    expect(line.tabIndex).toBe(-1);
    expect(line.dataset.outcome).toBe('allowed');
    expect(line.textContent).toBe(STRIP_OUTCOME.allowed('Budget', 'Ledger', ['transactions'], 'day'));
    expect(line.querySelector('button'), 'the card’s line carries no undo — the strip is the undo surface').toBeNull();
    expect(document.activeElement).toBe(line);
    expect(buttonNamed(ACCESS_CARD.review)).toBeUndefined();
    expect(resolved).toEqual([
      {
        card: expect.objectContaining({ threadId: THREAD, messageRowId: card.messageRowId }),
        messageId: MESSAGE_ID,
        resolution: { kind: 'allowed', sourceName: 'Ledger', tables: ['transactions'], duration: 'day' },
      },
    ]);
    expect(rowCard(card)?.resolution, 'the card never writes the row — the hook does').toBeUndefined();
  });

  it('focus the user put elsewhere is left alone', async () => {
    await render(stagedCard());
    await click(mustButton(ACCESS_CARD.review));
    const elsewhere = document.createElement('input');
    elsewhere.setAttribute('data-test-outside', '');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    await act(async () => {
      await parked()!.resolve({ kind: 'allow', sourceAppId: ledger, tables: ['transactions'], duration: 'day', unattended: false });
    });
    await settle();
    expect(outcome()?.dataset.outcome).toBe('allowed');
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe('not now, the waiting acts, and the row as the truth', () => {
  it('not now hands the hook not-now, shows its line, and asks nobody — nothing parked, nothing declined, the row untouched', async () => {
    const card = stagedCard();
    await render(card);
    await click(mustButton(ACCESS_CARD.notNow));
    expect(resolved).toEqual([{ card: expect.objectContaining({ messageRowId: card.messageRowId }), messageId: MESSAGE_ID, resolution: { kind: 'not-now' } }]);
    expect(outcome()?.dataset.outcome).toBe('not-now');
    expect(outcome()?.textContent).toBe(ACCESS_CARD.notNowLine);
    expect(spy()).not.toHaveBeenCalled();
    expect(parked()).toBeUndefined();
    expect(db.listAccessDeclines(budget)).toEqual([]);
    expect(rowCard(card)?.resolution).toBeUndefined();
  });

  it('the acts wait while the turn is in flight', async () => {
    await render(stagedCard(), { busy: true });
    expect(mustButton(ACCESS_CARD.review).disabled).toBe(true);
    expect(mustButton(ACCESS_CARD.notNow).disabled).toBe(true);
  });

  it('the acts wait with NO resolve path — an answer with nowhere to go asks nobody', async () => {
    await render(stagedCard(), { onResolve: undefined });
    expect(mustButton(ACCESS_CARD.review).disabled).toBe(true);
    expect(mustButton(ACCESS_CARD.notNow).disabled).toBe(true);
    await click(mustButton(ACCESS_CARD.review));
    expect(spy()).not.toHaveBeenCalled();
  });

  it('a remounted card reads the answer the row already holds — a read, not an answer', async () => {
    const card = stagedCard();
    persistAccessResolution(db, { ...card, resolution: { kind: 'declined' } });
    await render(card);
    expect(outcome()?.dataset.outcome).toBe('declined');
    expect(buttonNamed(ACCESS_CARD.review)).toBeUndefined();
    expect(resolved).toEqual([]);
  });
});

describe('the persisted shape — re-validated on every read', () => {
  it('round-trips a staged card through meta.access, dropping the row id', () => {
    const card = stageAccessCard({ purpose: PURPOSE, hints: HINTS }, { appId: budget, threadId: THREAD });
    expect(card).toEqual({ purpose: PURPOSE, hints: HINTS, appId: budget, threadId: THREAD });
    const meta = accessCardToMeta({ ...card, messageRowId: 42 });
    expect('messageRowId' in meta.access).toBe(false);
    expect(metaToAccessCard(meta)).toEqual(card);
    expect(metaToAccessCard(accessCardToMeta({ ...card, resolution: { kind: 'allowed', sourceName: 'Ledger', tables: ['transactions'], duration: 'week' } }))?.resolution).toEqual({
      kind: 'allowed',
      sourceName: 'Ledger',
      tables: ['transactions'],
      duration: 'week',
    });
  });

  it('readAccessCardRow reads the row back with its id, and nothing for a row that is not there', () => {
    const card = stagedCard();
    expect(readAccessCardRow(db, THREAD, card.messageRowId!)).toEqual(card);
    expect(readAccessCardRow(db, THREAD, 99_999)).toBeUndefined();
  });

  it('persistAccessResolution MERGES the row’s meta — the other keys survive', () => {
    const card = stagedCard();
    const before = db.listChatMessages(THREAD).find((m) => m.id === card.messageRowId)!;
    db.updateChatMessageMeta(card.messageRowId!, { ...(before.meta as object), wireText: 'kept' });
    persistAccessResolution(db, { ...card, resolution: { kind: 'not-now' } });
    const stored = db.listChatMessages(THREAD).find((m) => m.id === card.messageRowId)!;
    expect((stored.meta as { wireText?: string }).wireText).toBe('kept');
    expect(metaToAccessCard(stored.meta)?.resolution).toEqual({ kind: 'not-now' });
  });

  it('renders NO card for a row that drifted', () => {
    const good = accessCardToMeta(stageAccessCard({ purpose: PURPOSE, hints: HINTS }, { appId: budget, threadId: THREAD }));
    expect(metaToAccessCard(undefined)).toBeUndefined();
    expect(metaToAccessCard({})).toBeUndefined();
    expect(metaToAccessCard({ access: 'x' })).toBeUndefined();
    // the purpose through the protocol's display rule
    expect(metaToAccessCard({ access: { ...good.access, purpose: 'to compare\u0007 spending' } })).toBeUndefined();
    expect(metaToAccessCard({ access: { ...good.access, purpose: 'line one\nline two' } })).toBeUndefined();
    expect(metaToAccessCard({ access: { ...good.access, purpose: 'use sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' } })).toBeUndefined();
    expect(metaToAccessCard({ access: { ...good.access, purpose: 'x'.repeat(201) } })).toBeUndefined();
    // the hints through the protocol's schema
    expect(metaToAccessCard({ access: { ...good.access, hints: { tables: ['snug_kv'] } } })).toBeUndefined();
    expect(metaToAccessCard({ access: { ...good.access, hints: { words: ['spending'], extra: 1 } } })).toBeUndefined();
    // the addresses
    expect(metaToAccessCard({ access: { ...good.access, threadId: '' } })).toBeUndefined();
    const { threadId: _thread, ...noThread } = good.access;
    expect(metaToAccessCard({ access: noThread })).toBeUndefined();
    expect(metaToAccessCard({ access: { ...good.access, appId: '' } })).toBeUndefined();
    // an unknown resolution
    expect(metaToAccessCard({ access: { ...good.access, resolution: { kind: 'applied' } } })).toBeUndefined();
    expect(metaToAccessCard({ access: { ...good.access, resolution: 'allowed' } })).toBeUndefined();
  });

  it('S10: readAccessCardRow drops a card whose app is not the thread’s app', () => {
    const forged = stageAccessCard({ purpose: PURPOSE, hints: HINTS }, { appId: ledger, threadId: THREAD });
    const row = db.appendChatMessage(THREAD, 'assistant', 'x', { meta: accessCardToMeta(forged) });
    expect(metaToAccessCard(db.listChatMessages(THREAD).find((m) => m.id === row.id)?.meta), 'the shape alone is valid').toBeDefined();
    expect(readAccessCardRow(db, THREAD, row.id)).toBeUndefined();
  });
});

describe('startUserAsk answers what happened (D-PR2-11)', () => {
  it('with an ask: opened; for an app that is not installed: no-app, and nothing is parked', async () => {
    expect(await startUserAsk(budget, { ask: { purpose: PURPOSE, hints: HINTS } } as Parameters<typeof startUserAsk>[1])).toBe('opened');
    await act(async () => {
      resetAccessSession();
    });
    expect(await startUserAsk('app-gone', { ask: { purpose: PURPOSE } } as Parameters<typeof startUserAsk>[1])).toBe('no-app');
    expect(pendingAccessStore.get()['app-gone']).toBeUndefined();
  });

  it('without an ask the recipe is today’s (the host’s purpose, no askedIn) — only the answer is new', async () => {
    expect(await startUserAsk(budget)).toBe('opened');
    const pending = parked() as PendingAccessRequest & { askedIn?: string };
    expect(pending.askedIn).toBeUndefined();
    expect(pending.provenance).toBe('user');
    expect(pending.purpose).not.toBe(PURPOSE);
  });
});
