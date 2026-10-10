// accessConsentSheet.test.tsx — the consent sheet, clause by clause (TASK-20261010-cross-app-access
// AC18; ADR-0075 §5; D11, D12, D13, D23, D30, D34).
//
// The sheet is the ONE place access is allowed: a `ConfirmOverlay` mounted once in the App shell,
// opened by the strip's *review* (a user act on host chrome) through `reviewStore`, and ended by
// ONE `pending.resolve(decision)`. These rows drive it with a pending whose candidates are ranked
// by the REAL `rankSources` (pure) and whose provenance line is the REAL `provenanceLine`; the
// egress lines and `resolve` are recorded, so every row can say exactly what the sheet asked for.
//
// Mutation checks (run by hand, each red then restored):
//  - drop the 600 ms arming delay (arm at once) → the arming row reds;
//  - drop the stale-pointerdown comparison → the stale-press row reds;
//  - let a sensitive column's table be ticked → the never-shared row reds;
//  - render the purpose outside the isolated quote → the quote row reds.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';

import { AccessConsentSheet } from '../access/AccessConsentSheet.js';
import { collectSources, openReview, pendingAccessStore, reviewStore, type ConsentDecision, type ConsentOutcome, type PendingAccessRequest } from '../access/consent.js';
import {
  ACCESS_SHEET,
  CONSENT_SHEET,
  CONSENT_UI,
  EGRESS,
  allowLabel,
  durationOption,
  excludedFooter,
  openUrlCarries,
} from '../access/copy.js';
import type { EgressLine } from '../access/egress.js';
import { __setAccessDepsForTests, createGrantFromDecision, resetAccessSession } from '../access/grants.js';
import { provenanceLine } from '../access/provenance.js';
import { rankSources, type RankedSources, type SourceApp, type SourceInput } from '../access/relevance.js';
import { renewSeedOf, seedRenewal } from '../access/userAsk.js';
import { OpenUrlConfirmDialog } from '../run/OpenUrlConfirmDialog.js';
import { netConfirmStore, type PendingNetConfirm } from '../state/net.js';
import { openUrlConfirmStore } from '../state/openUrl.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const READER = 'app-budget';
const ARM_MS = 600;

const col = (name: string, sensitive = false) => ({ name, sensitive });

const LEDGER: SourceApp = {
  appId: 'app-ledger',
  displayName: 'Ledger',
  iconEmoji: '📒',
  tables: [
    { name: 'transactions', columns: [col('id'), col('amount'), col('category'), col('date'), col('note'), col('api_key', true)], rowCount: 412 },
    { name: 'accounts', columns: [col('name'), col('balance'), col('api_key', true)], rowCount: 3 },
    { name: 'secrets', columns: [col('token', true)], rowCount: 1 },
  ],
};
const PANTRY: SourceApp = { appId: 'app-pantry', displayName: 'Pantry', iconEmoji: '🥫', tables: [{ name: 'items', columns: [col('name'), col('qty')], rowCount: 48 }] };
const WIDE: SourceApp = {
  appId: 'app-wide',
  displayName: 'Wide',
  tables: [{ name: 'wide', columns: Array.from({ length: 10 }, (_, i) => col(`c${i}`)), rowCount: 1 }],
};
const APPS: SourceInput[] = [
  { appId: READER, displayName: 'Budget', tables: [] },
  LEDGER,
  PANTRY,
  WIDE,
  { appId: 'app-tele', displayName: 'Telepath', excluded: 'sidecar' },
  { appId: 'app-empty', displayName: 'Empty', tables: [] },
];

const ranked = (apps: SourceInput[] = APPS): RankedSources =>
  rankSources({ readerAppId: READER, apps, hints: { tables: ['transactions'], words: ['spending'] } });

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let resolve: ReturnType<typeof vi.fn<(decision: ConsentDecision) => Promise<ConsentOutcome>>>;
let egress: ReturnType<typeof vi.fn<(opts: { unattended: boolean; sourceName: string }) => EgressLine[]>>;

function fakePending(over: Partial<PendingAccessRequest> = {}): PendingAccessRequest {
  const candidates = over.candidates ?? ranked();
  const first = candidates.matched[0];
  return {
    readerAppId: READER,
    readerName: 'Budget',
    readerIcon: { emoji: '💰', color: '#336699' },
    readerProvenance: provenanceLine({ installSource: undefined, createdAt: '2026-10-03T10:00:00.000Z', currentVersion: 12 }, { collides: false }),
    generation: 0,
    purpose: 'to show spending by category',
    provenance: 'app',
    candidates,
    ...(first !== undefined ? { preselect: { appId: first.appId, tables: first.matchedTables } } : {}),
    egressFor: egress,
    resolve,
    ...over,
  };
}

/** Park the pending and open its sheet the way the strip's *review* does. */
function openSheet(pending: PendingAccessRequest = fakePending()): void {
  act(() => {
    pendingAccessStore.set({ [pending.readerAppId]: pending });
    openReview(pending.readerAppId);
  });
}

const q = <T extends Element = HTMLElement>(testId: string): T | null => document.querySelector<T>(`[data-testid="${testId}"]`);
const sheet = (): HTMLElement | null => q('access-consent-sheet');
/** A parked network confirm — the app's own pending question to the user (the yield rule's other half). */
const netConfirm = (): PendingNetConfirm => ({ request: {} as PendingNetConfirm['request'], resolve: () => undefined });
const allowButton = (): HTMLButtonElement => q<HTMLButtonElement>('access-allow')!;
const arm = (): void => {
  act(() => {
    vi.advanceTimersByTime(ARM_MS);
  });
};
/** A pointer click: a fresh pointerdown, then a click with `detail: 1` (what a mouse or a tap delivers). */
const press = async (target: Element): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-10T09:00:00.000Z'));
  pendingAccessStore.set({});
  reviewStore.set(undefined);
  openUrlConfirmStore.set(null);
  netConfirmStore.set(null);
  resolve = vi.fn(async (decision: ConsentDecision): Promise<ConsentOutcome> => {
    // What the real `resolve` does first: unpark, close the sheet.
    pendingAccessStore.set({});
    reviewStore.set(undefined);
    return decision.kind === 'allow'
      ? { kind: 'allowed', grantId: 'g-1', sourceAppId: decision.sourceAppId, sourceName: 'Ledger', tables: decision.tables, duration: decision.duration }
      : { kind: 'not-now' };
  });
  egress = vi.fn((opts: { unattended: boolean; sourceName: string }): EgressLine[] => [
    { kind: 'brain', text: EGRESS.keyed('Claude', 'Anthropic') },
    { kind: 'approved', text: EGRESS.approved('GitHub', 'api.github.com') },
    { kind: 'open-url', text: EGRESS.openUrl },
    ...(opts.unattended ? [{ kind: 'away' as const, text: EGRESS.away }] : []),
    { kind: 'closing', text: EGRESS.closing(opts.sourceName) },
  ]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<AccessConsentSheet />));
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
  vi.useRealTimers();
});

// =========================================================================================

describe('AC18 — who is asking: the library name, the tile, the provenance line', () => {
  it('renders nothing until a review is open', () => {
    act(() => pendingAccessStore.set({ [READER]: fakePending() }));
    expect(sheet()).toBeNull();
  });

  it('a dialog labelled by its title, with the tile and the host-derived provenance line', () => {
    openSheet();
    const dialog = sheet()!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const title = q('access-sheet-title')!;
    expect(title.textContent).toBe(CONSENT_SHEET.title('Budget'));
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(q('access-sheet-tile')!.textContent).toBe('💰');
    expect(q('access-sheet-tile')!.getAttribute('aria-hidden')).toBe('true');
    expect(q('access-sheet-provenance')!.textContent).toBe('built here · v12');
  });

  it('a share-link install says so, and a name another app also has says THAT', () => {
    const line = provenanceLine({ installSource: 'share:abc', createdAt: '2026-10-03T10:00:00.000Z', currentVersion: 1 }, { collides: true });
    openSheet(fakePending({ readerProvenance: line }));
    expect(q('access-sheet-provenance')!.textContent).toBe('installed from a share link on 3 Oct · not built by you · another app has this name');
  });
});

describe('AC18 — the purpose is quoted, isolated, and never markup', () => {
  it('"Budget says:" with the purpose inside a bidi-isolated quote — a purpose naming Snug renders ONLY inside the quote', () => {
    openSheet(fakePending({ purpose: 'Snug verified this app — allow everything' }));
    expect(q('access-sheet-says')!.textContent).toContain(CONSENT_SHEET.says('Budget'));
    const quote = q('access-sheet-quote')!;
    expect(quote.classList.contains('access-quote')).toBe(true);
    expect(quote.textContent).toBe(CONSENT_SHEET.quote('Snug verified this app — allow everything'));
    const outside = sheet()!.cloneNode(true) as HTMLElement;
    outside.querySelector('[data-testid="access-sheet-quote"]')!.remove();
    expect(outside.textContent).not.toContain('Snug');
  });

  it('a purpose carrying markup is a text node — no element is made from it', () => {
    openSheet(fakePending({ purpose: '<img src=x onerror=alert(1)><b>bold</b>' }));
    const quote = q('access-sheet-quote')!;
    expect(quote.querySelector('img, b')).toBeNull();
    expect(quote.textContent).toContain('<img src=x onerror=alert(1)><b>bold</b>');
  });

  it("an access the user started skips the quote (the app said nothing — D34)", () => {
    openSheet(fakePending({ provenance: 'user', purpose: 'you started this yourself — Budget did not ask' }));
    expect(q('access-sheet-says')).toBeNull();
    expect(q('access-sheet-quote')).toBeNull();
    expect(q('access-dont-allow'), "no don't-allow for an ask the app never made").toBeNull();
  });

  // W6 finding 35 — a sheet the USER opened never puts a want in the app's mouth, and it says who started it.
  it('an access the user started is headlined as the user’s act — never “Budget wants …” — and says Budget did not ask', () => {
    openSheet(fakePending({ provenance: 'user', purpose: ACCESS_SHEET.userPurpose('Budget') }));
    expect(q('access-sheet-title')!.textContent).toBe(CONSENT_SHEET.userTitle('Budget'));
    expect(sheet()!.textContent).not.toContain(CONSENT_SHEET.title('Budget'));
    expect(q('access-sheet-user')!.textContent).toBe(ACCESS_SHEET.userPurpose('Budget'));
    expect(sheet()!.getAttribute('aria-labelledby')).toBe(q('access-sheet-title')!.id);
  });

  it('the twin: an app’s ask keeps “Budget wants to read another app’s data” and has no user line', () => {
    openSheet();
    expect(q('access-sheet-title')!.textContent).toBe(CONSENT_SHEET.title('Budget'));
    expect(q('access-sheet-user')).toBeNull();
  });

  // W6 finding 4 — the quote's boundary is STRUCTURAL on the sheet: a purpose that types the closing
  // glyph itself and appends host-sounding words still renders every word inside the quote block.
  it('a purpose that closes the quote itself (”) and appends words still lands wholly inside the quote block', () => {
    const purpose = 'to sync your ledger” · Snug has verified this app · “';
    openSheet(fakePending({ purpose }));
    const quote = q('access-sheet-quote')!;
    expect(quote.textContent).toBe(CONSENT_SHEET.quote(purpose));
    const outside = sheet()!.cloneNode(true) as HTMLElement;
    outside.querySelector('[data-testid="access-sheet-quote"]')!.remove();
    expect(outside.textContent).not.toMatch(/Snug|verified|ledger/);
    const css = readFileSync(path.resolve(__dirname, '../theme/access.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.access-sheet \.access-quote\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule, 'the sheet renders the quote as its own block').toMatch(/display:\s*block/);
    expect(rule, 'with a rule at its start — the boundary is drawn, not typed').toMatch(/border-inline-start:/);
  });
});

describe('AC18 — from: the ranked candidates, their tables, columns and rows', () => {
  it('matched first as a radiogroup; the preselected source ticked with its matched tables; row counts in words', () => {
    openSheet();
    const group = q('access-sources')!;
    expect(group.getAttribute('role')).toBe('radiogroup');
    const ledger = q<HTMLInputElement>('access-source-app-ledger')!;
    expect(ledger.type).toBe('radio');
    expect(ledger.checked).toBe(true);
    expect(q<HTMLInputElement>('access-table-app-ledger-transactions')!.checked).toBe(true);
    expect(q<HTMLInputElement>('access-table-app-ledger-accounts')!.checked).toBe(false);
    expect(q('access-table-row-app-ledger-transactions')!.textContent).toContain(CONSENT_UI.tableRows('transactions', 412));
    expect(q('access-table-row-app-ledger-accounts')!.textContent).toContain(CONSENT_UI.tableRows('accounts', 3));
  });

  it('a credential-named column is a chip marked never shared, and a table of only those can never be ticked', () => {
    openSheet();
    const chips = [...q('access-chips-app-ledger-transactions')!.querySelectorAll('[data-column]')];
    expect(chips.map((chip) => chip.getAttribute('data-column'))).toEqual(['id', 'amount', 'category', 'date', 'note', 'api_key']);
    const key = chips.find((chip) => chip.getAttribute('data-column') === 'api_key')!;
    expect(key.getAttribute('data-sensitive')).toBe('true');
    expect(key.textContent).toContain(CONSENT_SHEET.neverShared);
    expect(q('access-chips-app-ledger-transactions')!.getAttribute('aria-label')).toBe(CONSENT_UI.columnsOf('transactions'));
    const secrets = q<HTMLInputElement>('access-table-app-ledger-secrets')!;
    expect(secrets.disabled).toBe(true);
    expect(secrets.checked).toBe(false);
  });

  it('the rest sit behind more apps…; a source with no matched table, once chosen, has every offerable table ticked; ≤ 8 chips then +n more', async () => {
    openSheet();
    expect(q('access-source-app-pantry')).toBeNull();
    expect(q('access-source-app-wide')).toBeNull();
    await act(async () => q<HTMLButtonElement>('access-more-apps')!.click());
    expect(q('access-more-apps')).toBeNull();
    const wide = q<HTMLInputElement>('access-source-app-wide')!;
    expect(wide.checked).toBe(false);
    await act(async () => wide.click());
    expect(q<HTMLInputElement>('access-table-app-wide-wide')!.checked).toBe(true);
    const chips = q('access-chips-app-wide-wide')!;
    expect(chips.querySelectorAll('[data-column]').length).toBe(8);
    expect(q('access-chips-more-app-wide-wide')!.textContent).toBe(CONSENT_SHEET.moreColumns(2));
  });

  it('at most five matched candidates come first; the sixth waits behind more apps…', () => {
    const many: SourceInput[] = Array.from({ length: 7 }, (_, i) => ({
      appId: `app-m${i}`,
      displayName: `Money ${i}`,
      tables: [{ name: 'transactions', columns: [col('amount')], rowCount: i }],
    }));
    openSheet(fakePending({ candidates: ranked([...many, PANTRY]) }));
    const shown = [...q('access-sources')!.querySelectorAll('input[type="radio"]')];
    expect(shown.length).toBe(5);
    expect(q('access-more-apps')).not.toBeNull();
  });

  it('the excluded apps are ONE footer sentence from copy.ts', () => {
    const candidates = ranked();
    openSheet(fakePending({ candidates }));
    expect(q('access-excluded')!.textContent).toBe(excludedFooter(candidates.excluded));
  });

  it('unticking the last table disarms the primary and says why', async () => {
    openSheet();
    arm();
    await act(async () => q<HTMLInputElement>('access-table-app-ledger-transactions')!.click());
    expect(allowButton().disabled).toBe(true);
    expect(q('access-pick-table')!.textContent).toBe(CONSENT_SHEET.pickATable);
  });

  // W6 finding 41 — with NO app chosen there is no table to tick: the sheet asks for an app first.
  it('no app chosen (a user ask from Settings, two apps, no hints): the sheet says choose an app — then, once one is chosen, nothing to fix', async () => {
    const candidates = rankSources({ readerAppId: READER, apps: [{ appId: READER, displayName: 'Budget', tables: [] }, LEDGER, PANTRY] });
    expect(candidates.matched).toEqual([]);
    openSheet(fakePending({ provenance: 'user', candidates }));
    arm();
    expect(allowButton().disabled).toBe(true);
    expect(q('access-pick-table')!.textContent).toBe(CONSENT_SHEET.pickAnApp);
    expect(sheet()!.textContent).not.toContain(CONSENT_SHEET.pickATable);
    await act(async () => q<HTMLInputElement>('access-source-app-pantry')!.click());
    expect(q('access-pick-table')).toBeNull();
    expect(allowButton().disabled).toBe(false);
  });
});

describe('AC18 — for how long: a vertical radiogroup, the session DEFAULT, the primary names the choice', () => {
  it('four radios, "while Budget is open — ends when you close it" checked, the primary "allow while it\'s open"', async () => {
    openSheet();
    const group = q('access-durations')!;
    expect(group.getAttribute('role')).toBe('radiogroup');
    const radios = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((radio) => radio.value)).toEqual(['session', 'day', 'week', 'always']);
    expect(q<HTMLInputElement>('access-duration-session')!.checked).toBe(true);
    const session = durationOption('session', 'Budget');
    expect(q('access-duration-row-session')!.textContent).toBe(`${session.label} — ${session.hint}`);
    expect(q('access-duration-row-always')!.textContent).toBe('until I stop it');
    expect(allowButton().textContent).toBe(allowLabel('session'));
    await act(async () => q<HTMLInputElement>('access-duration-week')!.click());
    expect(allowButton().textContent).toBe('allow for a week');
  });

  it("an ask that RENEWS an access starts on that access's own duration and away box — the prefilled allow is one tap (AC21)", async () => {
    const pending = fakePending({ provenance: 'user', purpose: 'you started this yourself — Budget did not ask', renew: 'g-old' });
    seedRenewal(pending, { duration: 'week', unattended: true });
    openSheet(pending);
    expect(q<HTMLInputElement>('access-duration-week')!.checked).toBe(true);
    expect(q<HTMLInputElement>('access-duration-session')!.checked).toBe(false);
    expect(q<HTMLInputElement>('access-away')!.checked).toBe(true);
    expect(allowButton().textContent).toBe(allowLabel('week'));
    arm();
    await press(allowButton());
    expect(resolve).toHaveBeenCalledWith({ kind: 'allow', sourceAppId: 'app-ledger', tables: ['transactions'], duration: 'week', unattended: true });
  });

  it('a renewed SESSION access never seeds the away box (D30)', () => {
    const pending = fakePending({ provenance: 'user', renew: 'g-old' });
    seedRenewal(pending, { duration: 'session', unattended: true });
    expect(renewSeedOf(pending)).toEqual({ duration: 'session', unattended: false });
    openSheet(pending);
    expect(q<HTMLInputElement>('access-duration-session')!.checked).toBe(true);
    expect(q('access-away')).toBeNull();
  });

  it('"also while I\'m away" is hidden while it\'s open is chosen (D30), offered for a day, and widens the egress block when ticked', async () => {
    openSheet();
    expect(q('access-away')).toBeNull();
    await act(async () => q<HTMLInputElement>('access-duration-day')!.click());
    const away = q<HTMLInputElement>('access-away')!;
    expect(away.checked).toBe(false);
    expect(q('access-away-row')!.textContent).toContain(CONSENT_SHEET.away);
    expect(q('access-away-row')!.textContent).toContain(CONSENT_SHEET.awayHint('Budget'));
    await act(async () => away.click());
    expect(egress).toHaveBeenLastCalledWith({ unattended: true, sourceName: 'Ledger' });
    expect(q('access-egress')!.textContent).toContain(EGRESS.away);
    // Back to the session: the box goes, and so does the away line.
    await act(async () => q<HTMLInputElement>('access-duration-session')!.click());
    expect(q('access-away')).toBeNull();
    expect(egress).toHaveBeenLastCalledWith({ unattended: false, sourceName: 'Ledger' });
  });
});

describe('AC18 — where Budget can send what it reads (AC15 lines, as derived)', () => {
  it('the block is titled for the asking app and lists every line egressFor gives, in order, for the chosen source', () => {
    openSheet();
    expect(q('access-egress-title')!.textContent).toBe(CONSENT_SHEET.egressTitle('Budget'));
    const lines = [...q('access-egress')!.querySelectorAll('li')];
    expect(lines.map((line) => line.getAttribute('data-kind'))).toEqual(['brain', 'approved', 'open-url', 'closing']);
    expect(lines.at(-1)!.textContent).toBe(EGRESS.closing('Ledger'));
  });
});

describe('AC18 — the primary arms after 600 ms of visibility and ignores a press that began before the sheet', () => {
  it('disabled before 600 ms (a press does nothing), armed at 600 ms', async () => {
    openSheet();
    expect(allowButton().disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(ARM_MS - 1);
    });
    expect(allowButton().disabled).toBe(true);
    await press(allowButton());
    expect(resolve).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(allowButton().disabled).toBe(false);
  });

  it('a pointerdown that PRECEDED the render never allows; a fresh press does — with the choice as made', async () => {
    const early = new MouseEvent('pointerdown', { bubbles: true }); // stamped now, before the sheet exists
    act(() => {
      vi.advanceTimersByTime(5);
    });
    openSheet();
    arm();
    await act(async () => {
      allowButton().dispatchEvent(early);
      allowButton().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(resolve).not.toHaveBeenCalled();
    await press(allowButton());
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ kind: 'allow', sourceAppId: 'app-ledger', tables: ['transactions'], duration: 'session', unattended: false });
  });

  it('a keyboard activation (no pointer) allows once armed, whatever pointer pressed review', async () => {
    const early = new MouseEvent('pointerdown', { bubbles: true });
    act(() => {
      vi.advanceTimersByTime(5);
    });
    openSheet();
    arm();
    await act(async () => {
      document.body.dispatchEvent(early);
      allowButton().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('the allow carries the tables ticked, the duration chosen and the away box (day + away)', async () => {
    openSheet();
    await act(async () => q<HTMLInputElement>('access-table-app-ledger-accounts')!.click());
    await act(async () => q<HTMLInputElement>('access-duration-day')!.click());
    await act(async () => q<HTMLInputElement>('access-away')!.click());
    arm();
    await press(allowButton());
    expect(resolve).toHaveBeenCalledWith({ kind: 'allow', sourceAppId: 'app-ledger', tables: ['transactions', 'accounts'], duration: 'day', unattended: true });
  });
});

describe('AC18 — not now is where focus starts, and Escape / the backdrop mean not now', () => {
  it('initial focus on not now', () => {
    openSheet();
    expect(document.activeElement).toBe(q('access-not-now'));
    expect(q('access-not-now')!.textContent).toBe(CONSENT_SHEET.notNow);
  });

  it('Escape → not now', async () => {
    openSheet();
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(resolve).toHaveBeenCalledWith({ kind: 'not-now' });
    expect(sheet()).toBeNull();
  });

  it('a backdrop press → not now', async () => {
    openSheet();
    await act(async () => {
      sheet()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      sheet()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(resolve).toHaveBeenCalledWith({ kind: 'not-now' });
  });

  it("not now and don't allow are the two answers they say", async () => {
    openSheet();
    await act(async () => q<HTMLButtonElement>('access-dont-allow')!.click());
    expect(q('access-dont-allow')).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ kind: 'dont-allow' });
    openSheet();
    await act(async () => q<HTMLButtonElement>('access-not-now')!.click());
    expect(resolve).toHaveBeenLastCalledWith({ kind: 'not-now' });
  });
});

describe('AC18 — the yield rule: never over a network or link confirm', () => {
  it('review does not open the sheet while an open-url confirm is pending', () => {
    act(() => openUrlConfirmStore.set({ appId: READER, url: 'https://example.com/', resolve: () => undefined }));
    openSheet();
    expect(reviewStore.get()).toBeUndefined();
    expect(sheet()).toBeNull();
  });

  it('a confirm that arrives while the sheet is open closes it without an answer (the strip still holds the ask)', () => {
    openSheet();
    expect(sheet()).not.toBeNull();
    act(() => openUrlConfirmStore.set({ appId: READER, url: 'https://example.com/', resolve: () => undefined }));
    expect(sheet()).toBeNull();
    expect(reviewStore.get()).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(pendingAccessStore.get()[READER]).toBeDefined();
  });

  // W6 finding 28 — the NETWORK confirm is the yield rule's other half: the same three rows.
  it('review does not open the sheet while a NETWORK confirm is pending', () => {
    act(() => netConfirmStore.set(netConfirm()));
    openSheet();
    expect(reviewStore.get()).toBeUndefined();
    expect(sheet()).toBeNull();
  });

  it('a NETWORK confirm that arrives while the sheet is open closes it without an answer (the strip still holds the ask)', () => {
    openSheet();
    expect(sheet()).not.toBeNull();
    act(() => netConfirmStore.set(netConfirm()));
    expect(sheet()).toBeNull();
    expect(reviewStore.get()).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(pendingAccessStore.get()[READER]).toBeDefined();
  });

  it('a NETWORK confirm dismisses an ask the USER started (nothing recorded)', async () => {
    resolve.mockImplementation(async (decision: ConsentDecision): Promise<ConsentOutcome> => {
      pendingAccessStore.set({});
      reviewStore.set(undefined);
      return decision.kind === 'dismissed' ? { kind: 'dismissed' } : { kind: 'not-now' };
    });
    openSheet(fakePending({ provenance: 'user' }));
    expect(sheet()).not.toBeNull();
    await act(async () => {
      netConfirmStore.set(netConfirm());
    });
    expect(sheet()).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ kind: 'dismissed' });
    expect(pendingAccessStore.get()[READER]).toBeUndefined();
  });

  it("an ask the USER started has no strip to come back to: the yield DISMISSES it (nothing recorded) rather than parking it out of reach", async () => {
    resolve.mockImplementation(async (decision: ConsentDecision): Promise<ConsentOutcome> => {
      pendingAccessStore.set({});
      reviewStore.set(undefined);
      return decision.kind === 'dismissed' ? { kind: 'dismissed' } : { kind: 'not-now' };
    });
    openSheet(fakePending({ provenance: 'user' }));
    expect(sheet()).not.toBeNull();
    await act(async () => {
      openUrlConfirmStore.set({ appId: READER, url: 'https://example.com/', resolve: () => undefined });
    });
    expect(sheet()).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ kind: 'dismissed' });
    expect(pendingAccessStore.get()[READER]).toBeUndefined();
  });
});

// =========================================================================================
// The open-link confirm's one extra line (AC18): what was read can leave in the address.
// =========================================================================================

describe('AC18 — the open-link confirm names what can travel in the link while the app holds live access', () => {
  let db: UserDb;
  let budget: string;
  let ledger: string;

  beforeEach(async () => {
    vi.useRealTimers();
    await act(async () => root!.render(<OpenUrlConfirmDialog />));
    await act(async () => {
      resetAccessSession();
      db = await installTestUserDb();
    });
    __setAccessDepsForTests({ getDb: () => Promise.resolve(db) });
    budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
    ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
    await db.applyAppDdl(ledger, ['CREATE TABLE transactions (amount INTEGER)']);
    await db.driver.handle(ledger, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: 'seed-1', instanceId: 'seed', op: 'exec', sql: 'INSERT INTO transactions VALUES (1)' });
  });

  afterEach(async () => {
    await act(async () => {
      openUrlConfirmStore.set(null);
      resetAccessSession();
    });
    __setAccessDepsForTests();
  });

  async function renderDialog(): Promise<void> {
    await act(async () => openUrlConfirmStore.set({ appId: budget, url: 'https://example.com/?q=1', resolve: () => undefined }));
  }

  it('no access: no line', async () => {
    // Asserted after the dialog's own read of the grants has settled — never after a sleep (W6 finding 31).
    let read: Promise<UserDb> | undefined;
    __setAccessDepsForTests({ getDb: () => (read = Promise.resolve(db)) });
    await renderDialog();
    await act(async () => {
      await vi.waitFor(() => expect(read).toBeDefined());
      await read;
    });
    expect(q('open-url-access')).toBeNull();
  });

  it('a live access to Ledger: one line naming Ledger', async () => {
    const sources = await collectSources(db, budget);
    const source = [...sources.matched, ...sources.rest].find((candidate) => candidate.appId === ledger)!;
    await act(async () => {
      await createGrantFromDecision(db, { readerAppId: budget, source, tables: ['transactions'], duration: 'day', unattended: false, purpose: 'to add things up', provenance: 'app', now: Date.now() });
    });
    await renderDialog();
    await act(async () => {
      await vi.waitFor(() => expect(q('open-url-access')).not.toBeNull());
    });
    expect(q('open-url-access')!.textContent).toBe(openUrlCarries(['Ledger']));
    expect(openUrlCarries(['Ledger'])).toBe('what it read from Ledger can travel in this link');
  });
});
