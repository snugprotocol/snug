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
//
// TASK-20261010-host-broker PR-3 (D-PR3-23; DS2–DS6, DS18, DS22, DS23): the sheet v2 — the chips
// stay on the default path; each table row gains *choose columns…* (`access-columns-<app>-<t>`),
// which swaps the chips for pre-ticked per-column boxes (`access-column-<app>-<t>-<c>`; a
// sensitive column a DISABLED unticked box reading *never shared*; *show all N columns* past the
// eighth); the write toggle (`access-write-<app>-<t>`, OFF) and the options row (`access-kv`,
// `access-refresh`) live under ONE *more options…* disclosure (`access-options-more`) that starts
// CLOSED — and OPEN when the ask carried `access: 'write'` or a seed turned a write, kv or refresh
// on; the undo note under a ticked write only; NO write or refresh egress line, the closing says
// *reads and changes*; the title says *— and change —* for a write ask; and the allow answers the
// decision v2 `{ tables: [{ name, withheld, write }], kv, refresh }`. The three rows that pinned
// the v1 decision (`tables: string[]`) are rewritten to v2 with the reason in their titles. The
// new keys and the v2 decision are LOCAL structural types until copy.ts / consent.ts export them.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { FRAME_TYPES, PROTOCOL_VERSION, accessRequestHash, type AccessDuration } from '@snugprotocol/protocol';

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
import { __setAccessDepsForTests, createGrantFromDecision, noteReaderGeneration, resetAccessSession } from '../access/grants.js';
import { provenanceLine } from '../access/provenance.js';
import { rankSources, type RankedSources, type SourceApp, type SourceInput } from '../access/relevance.js';
import { seedSheet, sheetSeedOf, startUserAsk } from '../access/userAsk.js';
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

// ---- PR-3 LOCAL structural types (D-PR3-23) — replaced by the real exports at Gate 5 ----------
/** One ticked table in the decision v2. */
interface TableChoiceV2 {
  name: string;
  withheld: string[];
  write: boolean;
}
/** The allow decision v2 (`ConsentDecision.allow`, D-PR3-23). */
interface AllowV2 {
  kind: 'allow';
  sourceAppId: string;
  tables: TableChoiceV2[];
  duration: AccessDuration;
  unattended: boolean;
  kv: boolean;
  refresh: boolean;
}
const allowV2 = (over: Partial<AllowV2> & Pick<AllowV2, 'tables'>): AllowV2 => ({
  kind: 'allow',
  sourceAppId: 'app-ledger',
  duration: 'session',
  unattended: false,
  kv: false,
  refresh: false,
  ...over,
});
const readOf = (name: string, withheld: string[] = []): TableChoiceV2 => ({ name, withheld, write: false });
/** The PR-3 consent-sheet sentences (copy.ts, D-PR3-23). */
const SHEET3 = CONSENT_SHEET as unknown as {
  title(readerName: string, wantsWrite?: boolean): string;
  canChange: string;
  chooseColumns: string;
  showAllColumns(n: number): string;
  pickAColumn: string;
  settingsAndNotes(sourceName: string): string;
  settingsAndNotesHint(sourceName: string): string;
  fetchFirst(sourceName: string): string;
  fetchFirstHint(sourceName: string): string;
  undoNote(sourceName: string, table: string, readerName: string): string;
  moreOptions: string;
};
/** `EGRESS.closing(sourceName, canChange)` (D-PR3-23). */
const closing3 = EGRESS.closing as unknown as (sourceName: string, canChange?: boolean) => string;

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
      ? // As the real resolve answers (consent.ts): the outcome names the tables, and the written ones (a bare name is a read, E1-Q7).
        {
          kind: 'allowed',
          grantId: 'g-1',
          sourceAppId: decision.sourceAppId,
          sourceName: 'Ledger',
          tables: decision.tables.map((table) => (typeof table === 'string' ? table : table.name)),
          duration: decision.duration,
          write: decision.tables.flatMap((table) => (typeof table !== 'string' && table.write ? [table.name] : [])),
        }
      : { kind: 'not-now' };
  });
  egress = vi.fn((opts: { unattended: boolean; sourceName: string }): EgressLine[] => [
    { kind: 'brain', text: EGRESS.keyed('Claude', 'Anthropic') },
    { kind: 'approved', text: EGRESS.approved('GitHub', 'api.github.com') },
    { kind: 'open-url', text: EGRESS.openUrl },
    ...(opts.unattended ? [{ kind: 'away' as const, text: EGRESS.away('Budget') }] : []),
    // PR-3: the closing says *reads and changes* when the sheet asks for it (`canChange`, D-PR3-23).
    { kind: 'closing', text: closing3(opts.sourceName, (opts as { canChange?: boolean }).canChange === true) },
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

  it("an ask that RENEWS an access starts on that access's own duration and away box — the prefilled allow is one tap (AC21) — answered in the v2 decision shape (D-PR3-23)", async () => {
    const pending = fakePending({ provenance: 'user', purpose: 'you started this yourself — Budget did not ask', renew: 'g-old' });
    seedSheet(pending, { duration: 'week', unattended: true });
    openSheet(pending);
    expect(q<HTMLInputElement>('access-duration-week')!.checked).toBe(true);
    expect(q<HTMLInputElement>('access-duration-session')!.checked).toBe(false);
    expect(q<HTMLInputElement>('access-away')!.checked).toBe(true);
    expect(allowButton().textContent).toBe(allowLabel('week'));
    arm();
    await press(allowButton());
    expect(resolve).toHaveBeenCalledWith(allowV2({ tables: [readOf('transactions')], duration: 'week', unattended: true }));
  });

  it('a renewed SESSION access never seeds the away box (D30)', () => {
    const pending = fakePending({ provenance: 'user', renew: 'g-old' });
    seedSheet(pending, { duration: 'session', unattended: true });
    expect(sheetSeedOf(pending)).toEqual({ duration: 'session', unattended: false });
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
    expect(q('access-egress')!.textContent).toContain(EGRESS.away('Budget'));
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

  it('a pointerdown that PRECEDED the render never allows; a fresh press does — with the choice as made, in the v2 decision shape (D-PR3-23)', async () => {
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
    expect(resolve).toHaveBeenCalledWith(allowV2({ tables: [readOf('transactions')] }));
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

  it('the allow carries the tables ticked, the duration chosen and the away box (day + away) — each table v2: nothing withheld, no write (D-PR3-23)', async () => {
    openSheet();
    await act(async () => q<HTMLInputElement>('access-table-app-ledger-accounts')!.click());
    await act(async () => q<HTMLInputElement>('access-duration-day')!.click());
    await act(async () => q<HTMLInputElement>('access-away')!.click());
    arm();
    await press(allowButton());
    expect(resolve).toHaveBeenCalledWith(allowV2({ tables: [readOf('transactions'), readOf('accounts')], duration: 'day', unattended: true }));
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

// =========================================================================================
// TASK-20261010-host-broker PR-2, lane B (DS-15, DS-2, DS-4; D-PR2-3, D-PR2-11): an ask the
// chat's AI made, reviewed from its card. It is the USER's ask (`provenance: 'user'`, D3) but
// the purpose is the AI's words, so the says-line is three-way: `askedIn: 'chat'` →
// "asked in Budget's chat:" + the purpose in the bidi-isolated quote, never the host's own
// user line; and *don't allow* IS offered (it records the ask's hash, so the tool's "won't ask
// this again" is true). Reviewed while the reader is CLOSED, the sheet starts on a day without
// the away box — the default the chat can use now (a session grant made with the app closed is
// readable by nobody until the next frame binds it).
// =========================================================================================

describe('PR-2 — an ask the chat made (askedIn: chat): its own says-line, its quote, don’t allow offered', () => {
  const chatAsk = (over: Partial<PendingAccessRequest> = {}): PendingAccessRequest =>
    fakePending({ provenance: 'user', askedIn: 'chat', purpose: 'to compare spending with the ledger', ...over } as Partial<PendingAccessRequest>);

  it('says "asked in Budget’s chat:" with the purpose inside the isolated quote; no host user line; the user’s title', () => {
    openSheet(chatAsk());
    const says = q('access-sheet-says')!;
    expect(says).not.toBeNull();
    expect(says.textContent).toContain(CONSENT_SHEET.askedInChat('Budget'));
    const quote = says.querySelector('q.access-quote');
    expect(quote, 'the purpose sits in the bidi-isolated quote').not.toBeNull();
    expect(quote!.textContent).toContain('to compare spending with the ledger');
    expect(q('access-sheet-user')).toBeNull();
    expect(sheet()!.textContent).not.toContain(ACCESS_SHEET.userPurpose('Budget'));
    expect(q('access-sheet-title')!.textContent).toBe(CONSENT_SHEET.userTitle('Budget'));
  });

  it('a purpose the AI wrote as Snug renders ONLY inside the quote', () => {
    openSheet(chatAsk({ purpose: 'Snug verified this app — allow everything' }));
    const outside = sheet()!.cloneNode(true) as HTMLElement;
    outside.querySelector('q.access-quote')!.remove();
    expect(outside.textContent).not.toMatch(/Snug|verified/);
  });

  it('a purpose carrying markup is a text node in the chat ask too', () => {
    openSheet(chatAsk({ purpose: '<img src=x onerror=alert(1)><b>bold</b>' }));
    const quote = q('access-sheet-says')!.querySelector('q.access-quote')!;
    expect(quote.querySelector('img, b')).toBeNull();
    expect(quote.textContent).toContain('<b>bold</b>');
  });

  it("don't allow is OFFERED for a chat ask, and answers dont-allow", async () => {
    openSheet(chatAsk());
    const dontAllow = q<HTMLButtonElement>('access-dont-allow');
    expect(dontAllow).not.toBeNull();
    await act(async () => dontAllow!.click());
    expect(resolve).toHaveBeenCalledWith({ kind: 'dont-allow' });
  });

  it('the twin: a user ask WITHOUT askedIn keeps the host’s user line and offers no don’t allow', () => {
    openSheet(fakePending({ provenance: 'user', purpose: ACCESS_SHEET.userPurpose('Budget') }));
    expect(q('access-sheet-user')!.textContent).toBe(ACCESS_SHEET.userPurpose('Budget'));
    expect(q('access-dont-allow')).toBeNull();
  });
});

describe('PR-2 — a chat ask through the real recipe: the seed, and the decline it records', () => {
  let db: UserDb;
  let budget: string;
  const HINTS = { words: ['spending'], tables: ['transactions'] };
  const PURPOSE = 'to compare spending with the ledger';
  /** `startUserAsk` with the ask option (D-PR2-11) — typed loosely until the option lands. */
  const askFromChat = (reader: string): Promise<unknown> =>
    (startUserAsk as unknown as (id: string, opts: { ask: { purpose: string; hints?: typeof HINTS } }) => Promise<unknown>)(reader, { ask: { purpose: PURPOSE, hints: HINTS } });

  beforeEach(async () => {
    vi.useRealTimers();
    await act(async () => {
      resetAccessSession();
      db = await installTestUserDb();
    });
    __setAccessDepsForTests({ getDb: () => Promise.resolve(db) });
    budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
    const ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
    await db.applyAppDdl(ledger, ['CREATE TABLE transactions (amount INTEGER)']);
    await db.driver.handle(ledger, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: 'seed-1', instanceId: 'seed', op: 'exec', sql: 'INSERT INTO transactions VALUES (1)' });
  });

  afterEach(async () => {
    await act(async () => {
      resetAccessSession();
    });
    __setAccessDepsForTests();
  });

  it('reviewed while the reader is CLOSED: the sheet starts on a day, the away box unticked (D-PR2-3)', async () => {
    await act(async () => {
      await askFromChat(budget);
    });
    expect(sheet()).not.toBeNull();
    expect((pendingAccessStore.get()[budget] as PendingAccessRequest & { askedIn?: string }).askedIn).toBe('chat');
    expect(q<HTMLInputElement>('access-duration-day')!.checked).toBe(true);
    expect(q<HTMLInputElement>('access-duration-session')!.checked).toBe(false);
    expect(q<HTMLInputElement>('access-away')!.checked).toBe(false);
    expect(allowButton().textContent).toBe(allowLabel('day'));
    const userAsk = (await import('../access/userAsk.js')) as unknown as { sheetSeedOf?: (p: PendingAccessRequest) => unknown };
    expect(userAsk.sheetSeedOf?.(pendingAccessStore.get()[budget]!)).toEqual({ duration: 'day', unattended: false });
  });

  it('reviewed while the reader is OPEN beside the chat: the session default stays', async () => {
    noteReaderGeneration(budget, 0);
    await act(async () => {
      await askFromChat(budget);
    });
    expect(sheet()).not.toBeNull();
    expect((pendingAccessStore.get()[budget] as PendingAccessRequest & { askedIn?: string }).askedIn).toBe('chat');
    expect(q<HTMLInputElement>('access-duration-session')!.checked).toBe(true);
  });

  it("don't allow on the sheet records the ask's semantic hash for the reader", async () => {
    await act(async () => {
      await askFromChat(budget);
    });
    await act(async () => q<HTMLButtonElement>('access-dont-allow')!.click());
    await act(async () => {
      await vi.waitFor(() => expect(db.listAccessDeclines(budget)).toHaveLength(1));
    });
    expect(db.listAccessDeclines(budget)[0]?.hash).toBe(accessRequestHash({ hints: HINTS }));
    expect(pendingAccessStore.get()[budget]).toBeUndefined();
  });
});

// =========================================================================================
// TASK-20261010-host-broker PR-3 (D-PR3-23; DS2–DS6, DS18, DS22, DS23): the sheet v2.
//
// A disclosure here may be a <details> or a button that reveals (the contract names the test id,
// not the element): `shown` treats an element inside a CLOSED <details> as not shown, and
// `openDisclosure` opens either kind the way a person would.
// =========================================================================================

/** On screen: rendered, and not inside a closed <details>. */
const shown = (el: Element | null): boolean => el !== null && el.closest('details:not([open])') === null;
const shownBy = (testId: string): boolean => shown(q(testId));

async function openDisclosure(testId: string): Promise<void> {
  const el = q(testId);
  if (el === null) throw new Error(`no disclosure ${testId}`);
  const details = el instanceof HTMLDetailsElement ? el : el.tagName === 'SUMMARY' ? (el.parentElement as HTMLDetailsElement | null) : null;
  await act(async () => {
    if (details === null) {
      el.click();
      return;
    }
    if (!details.open) {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    }
  });
}

/** The words beside a control: its label, or the row it sits in. */
const wordsBeside = (el: Element): string => (el.closest('label') ?? el.parentElement)?.textContent ?? '';

const columnBox = (app: string, table: string, column: string): HTMLInputElement | null => q<HTMLInputElement>(`access-column-${app}-${table}-${column}`);
const writeToggle = (app: string, table: string): HTMLInputElement | null => q<HTMLInputElement>(`access-write-${app}-${table}`);
const egressKinds = (): (string | null)[] => [...q('access-egress')!.querySelectorAll('li')].map((line) => line.getAttribute('data-kind'));
const clickIn = async (el: Element | null): Promise<void> => {
  if (el === null) throw new Error('nothing to click');
  await act(async () => (el as HTMLElement).click());
};

describe('PR-3 — the chips stay on the default path; *choose columns…* swaps them for pre-ticked boxes (D-PR3-23; DS5)', () => {
  it('closed: today’s chips, and no per-column box on screen', () => {
    openSheet();
    expect(q('access-chips-app-ledger-transactions')).not.toBeNull();
    expect(q('access-columns-app-ledger-transactions')).not.toBeNull();
    expect(q('access-columns-app-ledger-transactions')!.textContent).toContain(SHEET3.chooseColumns);
    for (const column of ['id', 'amount', 'category', 'date', 'note', 'api_key']) expect(shown(columnBox('app-ledger', 'transactions', column)), column).toBe(false);
  });

  it('open: every non-sensitive column a ticked box; a sensitive one a DISABLED unticked box reading never shared; the chips swapped away', async () => {
    openSheet();
    await openDisclosure('access-columns-app-ledger-transactions');
    for (const column of ['id', 'amount', 'category', 'date', 'note']) {
      const box = columnBox('app-ledger', 'transactions', column)!;
      expect(shown(box), column).toBe(true);
      expect(box.type, column).toBe('checkbox');
      expect(box.checked, column).toBe(true);
      expect(box.disabled, column).toBe(false);
    }
    const key = columnBox('app-ledger', 'transactions', 'api_key')!;
    expect(shown(key)).toBe(true);
    expect(key.disabled).toBe(true);
    expect(key.checked).toBe(false);
    expect(wordsBeside(key)).toContain(CONSENT_SHEET.neverShared);
    expect(shownBy('access-chips-app-ledger-transactions'), 'the boxes REPLACE the chips').toBe(false);
  });

  it('unticked columns are WITHHELD in the decision, in the source’s column order — never a sensitive one', async () => {
    openSheet();
    await openDisclosure('access-columns-app-ledger-transactions');
    await clickIn(columnBox('app-ledger', 'transactions', 'note'));
    await clickIn(columnBox('app-ledger', 'transactions', 'date'));
    expect(columnBox('app-ledger', 'transactions', 'note')!.checked).toBe(false);
    arm();
    await press(allowButton());
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(allowV2({ tables: [readOf('transactions', ['date', 'note'])] }));
  });

  it('every column of a ticked table unticked → allow is disabled and the sheet says choose at least one column; one back → armed again', async () => {
    openSheet();
    await openDisclosure('access-columns-app-ledger-transactions');
    for (const column of ['id', 'amount', 'category', 'date', 'note']) await clickIn(columnBox('app-ledger', 'transactions', column));
    arm();
    expect(allowButton().disabled).toBe(true);
    expect(sheet()!.textContent).toContain(SHEET3.pickAColumn);
    await press(allowButton());
    expect(resolve).not.toHaveBeenCalled();
    await clickIn(columnBox('app-ledger', 'transactions', 'amount'));
    expect(allowButton().disabled).toBe(false);
    expect(sheet()!.textContent).not.toContain(SHEET3.pickAColumn);
  });

  it('past the eighth column: *show all N columns* inside the disclosure reveals the rest', async () => {
    openSheet();
    await act(async () => q<HTMLButtonElement>('access-more-apps')!.click());
    await act(async () => q<HTMLInputElement>('access-source-app-wide')!.click());
    await openDisclosure('access-columns-app-wide-wide');
    const visibleBoxes = (): string[] =>
      [...document.querySelectorAll<HTMLInputElement>('[data-testid^="access-column-app-wide-wide-"]')].filter(shown).map((box) => box.getAttribute('data-testid')!);
    expect(visibleBoxes()).toHaveLength(8);
    const showAll = [...sheet()!.querySelectorAll<HTMLElement>('button, summary')].find((el) => el.textContent?.trim() === SHEET3.showAllColumns(10));
    expect(showAll, 'a *show all 10 columns* control').toBeDefined();
    await clickIn(showAll!);
    expect(visibleBoxes()).toHaveLength(10);
    await clickIn(columnBox('app-wide', 'wide', 'c9'));
    arm();
    await press(allowButton());
    expect(resolve).toHaveBeenCalledWith(allowV2({ sourceAppId: 'app-wide', tables: [readOf('wide', ['c9'])] }));
  });
});

describe('PR-3 — *more options…*: the write toggle and the options row, CLOSED by default (D-PR3-23; DS6, DS23)', () => {
  it('a read ask: the disclosure is there, closed — no write toggle, no settings & notes, no fetch-first on screen', () => {
    openSheet();
    expect(q('access-options-more')).not.toBeNull();
    expect(q('access-options-more')!.textContent).toContain(SHEET3.moreOptions);
    expect(shown(writeToggle('app-ledger', 'transactions'))).toBe(false);
    expect(shownBy('access-kv')).toBe(false);
    expect(shownBy('access-refresh')).toBe(false);
  });

  it('opened: the write toggle on the table row (OFF, *can also change rows*), and the options row naming the source with its hints', async () => {
    openSheet();
    await openDisclosure('access-options-more');
    const write = writeToggle('app-ledger', 'transactions')!;
    expect(shown(write)).toBe(true);
    expect(write.type).toBe('checkbox');
    expect(write.checked).toBe(false);
    expect(wordsBeside(write)).toContain(SHEET3.canChange);
    const kv = q<HTMLInputElement>('access-kv')!;
    const refresh = q<HTMLInputElement>('access-refresh')!;
    expect(shown(kv)).toBe(true);
    expect(shown(refresh)).toBe(true);
    expect(kv.checked).toBe(false);
    expect(refresh.checked).toBe(false);
    const more = sheet()!.textContent ?? '';
    expect(more).toContain(SHEET3.settingsAndNotes('Ledger'));
    expect(more).toContain(SHEET3.settingsAndNotesHint('Ledger'));
    expect(more).toContain(SHEET3.fetchFirst('Ledger'));
    expect(more).toContain(SHEET3.fetchFirstHint('Ledger'));
  });

  it('the chips are byte-identical whatever the options say (the default path is untouched by a ticked write)', async () => {
    openSheet();
    const before = q('access-chips-app-ledger-transactions')!.outerHTML;
    await openDisclosure('access-options-more');
    await clickIn(writeToggle('app-ledger', 'transactions'));
    expect(q('access-chips-app-ledger-transactions')!.outerHTML).toBe(before);
  });

  it('a ticked write: the one-breath undo note under it, the closing says reads and changes — and NO write line joins the egress block', async () => {
    openSheet();
    await openDisclosure('access-options-more');
    const note = SHEET3.undoNote('Ledger', 'transactions', 'Budget');
    expect(sheet()!.textContent).not.toContain(note);
    expect(egressKinds()).toEqual(['brain', 'approved', 'open-url', 'closing']);
    await clickIn(writeToggle('app-ledger', 'transactions'));
    expect(writeToggle('app-ledger', 'transactions')!.checked).toBe(true);
    expect(sheet()!.textContent).toContain(note);
    expect(egressKinds(), 'the block lists places data can go — a write is not one').toEqual(['brain', 'approved', 'open-url', 'closing']);
    expect(q('access-egress')!.querySelector('li[data-kind="closing"]')!.textContent).toBe(closing3('Ledger', true));
    // Unticked again: the note goes, and the closing is today's.
    await clickIn(writeToggle('app-ledger', 'transactions'));
    expect(sheet()!.textContent).not.toContain(note);
    expect(q('access-egress')!.querySelector('li[data-kind="closing"]')!.textContent).toBe(EGRESS.closing('Ledger'));
  });

  it('settings & notes and fetch-first add NO egress line and leave the closing as it is', async () => {
    openSheet();
    await openDisclosure('access-options-more');
    await clickIn(q('access-kv'));
    await clickIn(q('access-refresh'));
    expect(egressKinds()).toEqual(['brain', 'approved', 'open-url', 'closing']);
    expect(q('access-egress')!.querySelector('li[data-kind="closing"]')!.textContent).toBe(EGRESS.closing('Ledger'));
  });

  it('the allow carries the ticked write on THAT table only, and kv / refresh as ticked', async () => {
    openSheet();
    await act(async () => q<HTMLInputElement>('access-table-app-ledger-accounts')!.click());
    await openDisclosure('access-options-more');
    await clickIn(writeToggle('app-ledger', 'transactions'));
    await clickIn(q('access-kv'));
    await clickIn(q('access-refresh'));
    await act(async () => q<HTMLInputElement>('access-duration-day')!.click());
    arm();
    await press(allowButton());
    expect(resolve).toHaveBeenCalledWith(
      allowV2({ tables: [{ name: 'transactions', withheld: [], write: true }, readOf('accounts')], duration: 'day', kv: true, refresh: true }),
    );
  });
});

describe('PR-3 — an ask that carried access: write (D-PR3-4/23; DS2, DS6)', () => {
  const writeAsk = (over: Partial<PendingAccessRequest> = {}): PendingAccessRequest => fakePending({ wantsWrite: true, ...over } as Partial<PendingAccessRequest>);

  it('the title says "— and change —"; a read ask keeps today’s title', () => {
    openSheet(writeAsk());
    expect(q('access-sheet-title')!.textContent).toBe(SHEET3.title('Budget', true));
    expect(SHEET3.title('Budget', true)).not.toBe(CONSENT_SHEET.title('Budget'));
    act(() => {
      pendingAccessStore.set({});
      reviewStore.set(undefined);
    });
    openSheet();
    expect(q('access-sheet-title')!.textContent).toBe(CONSENT_SHEET.title('Budget'));
  });

  it('*more options…* starts OPEN: the write toggle is on screen at once — and still OFF until the person ticks it', () => {
    openSheet(writeAsk());
    const write = writeToggle('app-ledger', 'transactions');
    expect(shown(write), 'offered without a click').toBe(true);
    expect(write!.checked, 'never pre-ticked by the app’s ask').toBe(false);
    expect(sheet()!.textContent).not.toContain(SHEET3.undoNote('Ledger', 'transactions', 'Budget'));
  });

  it('allowed without ticking it, the access stays read-only (write: false)', async () => {
    openSheet(writeAsk());
    arm();
    await press(allowButton());
    expect(resolve).toHaveBeenCalledWith(allowV2({ tables: [readOf('transactions')] }));
  });

  it('allowed with it ticked, the decision says write on that table', async () => {
    openSheet(writeAsk());
    await clickIn(writeToggle('app-ledger', 'transactions'));
    expect(sheet()!.textContent).toContain(SHEET3.undoNote('Ledger', 'transactions', 'Budget'));
    arm();
    await press(allowButton());
    expect(resolve).toHaveBeenCalledWith(allowV2({ tables: [{ name: 'transactions', withheld: [], write: true }] }));
  });
});

describe('PR-3 — a renewal of a write access shows its toggle ticked without a click (D-PR3-23; DS6)', () => {
  let db: UserDb;
  let budget: string;
  let ledger: string;
  /** LOCAL structural type — `CreateGrantInput` v2 (D-PR3-23) until grants.ts exports it. */
  type CreateGrantV2 = (
    db: UserDb,
    input: Omit<Parameters<typeof createGrantFromDecision>[1], 'tables'> & { tables: TableChoiceV2[]; kv?: boolean; refresh?: boolean },
  ) => ReturnType<typeof createGrantFromDecision>;
  const createGrantV2 = createGrantFromDecision as unknown as CreateGrantV2;

  beforeEach(async () => {
    vi.useRealTimers();
    await act(async () => {
      resetAccessSession();
      db = await installTestUserDb();
    });
    __setAccessDepsForTests({ getDb: () => Promise.resolve(db) });
    budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
    ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
    await db.applyAppDdl(ledger, ['CREATE TABLE transactions (amount INTEGER, category TEXT)']);
    await db.driver.handle(ledger, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: 'seed-1', instanceId: 'seed', op: 'exec', sql: "INSERT INTO transactions VALUES (1, 'food')" });
  });

  afterEach(async () => {
    await act(async () => {
      resetAccessSession();
    });
    __setAccessDepsForTests();
  });

  it('*allow again* on a paused write + fetch-first access: more options OPEN, the write toggle and fetch-first TICKED, nothing clicked', async () => {
    const sources = await collectSources(db, budget);
    const source = [...sources.matched, ...sources.rest].find((candidate) => candidate.appId === ledger)!;
    let grant: Awaited<ReturnType<typeof createGrantFromDecision>> | undefined;
    await act(async () => {
      grant = await createGrantV2(db, {
        readerAppId: budget,
        source,
        tables: [{ name: 'transactions', withheld: [], write: true }],
        refresh: true,
        duration: 'week',
        unattended: false,
        purpose: 'to tidy the categories',
        provenance: 'app',
        generation: 0,
        now: Date.now(),
      });
    });
    await act(async () => {
      await startUserAsk(budget, { renew: { grant: grant!, duration: 'week' } });
    });
    expect(sheet()).not.toBeNull();
    const write = writeToggle(ledger, 'transactions');
    expect(shown(write), 'the toggle is on screen without opening anything').toBe(true);
    expect(write!.checked, 'the renewal carries the old access’s write').toBe(true);
    expect(shownBy('access-refresh')).toBe(true);
    expect(q<HTMLInputElement>('access-refresh')!.checked).toBe(true);
    expect(q<HTMLInputElement>('access-kv')!.checked).toBe(false);
    expect(sheet()!.textContent).toContain(SHEET3.undoNote('Ledger', 'transactions', 'Budget'));
  });

  it('the twin: renewing a READ access leaves more options closed', async () => {
    const sources = await collectSources(db, budget);
    const source = [...sources.matched, ...sources.rest].find((candidate) => candidate.appId === ledger)!;
    let grant: Awaited<ReturnType<typeof createGrantFromDecision>> | undefined;
    await act(async () => {
      grant = await createGrantV2(db, {
        readerAppId: budget,
        source,
        tables: [{ name: 'transactions', withheld: [], write: false }],
        duration: 'week',
        unattended: false,
        purpose: 'to add things up',
        provenance: 'app',
        generation: 0,
        now: Date.now(),
      });
    });
    await act(async () => {
      await startUserAsk(budget, { renew: { grant: grant!, duration: 'week' } });
    });
    expect(sheet()).not.toBeNull();
    expect(shown(writeToggle(ledger, 'transactions'))).toBe(false);
    expect(shownBy('access-refresh')).toBe(false);
  });
});
