// enableConsent.test.tsx — TASK-20261009-scheduling-framework U8 (security F10): the ONE consent
// surface shows WHAT WILL RUN verbatim before the first enable — for each ask-the-AI step the app,
// the prompt as typed, the queries as typed (or that the AI reads the tables), the hosts the app's
// APPROVED connections may call ("none" otherwise); for a reminder its title; then the daily cost
// bound — and offers exactly two acts. A prompt is rendered as TEXT: a `<b>` typed into it is
// characters on screen, never an element.
//
// `approvedHostsByApp` is pinned against the real memory db with a real approved row: a declared
// (unapproved) row contributes nothing, because it is not a capability yet.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import type { ScheduleSpec, ScheduleStep } from '@snugprotocol/protocol';

import { CONSENT } from '../schedule/copy.js';
import { CONSENT_ROWS } from '../schedule/copy.editor.js';
import { approvedHostsByApp, dailyAiBound } from '../schedule/editorModel.js';
import { EnableConsent, type EnableConsentProps } from '../schedule/EnableConsent.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date('2026-10-09T12:20:00.000Z');
const WEEKLY: ScheduleSpec = { kind: 'weekly', days: ['fri'], time: '17:00', tz: 'device' };
const DAILY: ScheduleSpec = { kind: 'daily', time: '09:00', tz: 'device' };

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;

beforeEach(async () => {
  db = await installTestUserDb();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
});

const q = (testId: string): HTMLElement | null => container?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null;
const must = (testId: string): HTMLElement => {
  const el = q(testId);
  if (el === null) throw new Error(`missing [data-testid="${testId}"]`);
  return el;
};

async function render(props: Partial<EnableConsentProps> & Pick<EnableConsentProps, 'steps'>): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <EnableConsent
        spec={props.spec ?? WEEKLY}
        now={props.now ?? NOW}
        appNames={props.appNames ?? { ledger: 'Ledger' }}
        hostsByApp={props.hostsByApp ?? {}}
        onEnable={props.onEnable ?? ((): void => undefined)}
        onNotNow={props.onNotNow ?? ((): void => undefined)}
        {...(props.busy !== undefined ? { busy: props.busy } : {})}
        {...(props.error !== undefined ? { error: props.error } : {})}
        {...(props.presetOnItsOwn !== undefined ? { presetOnItsOwn: props.presetOnItsOwn } : {})}
        {...(props.connectionsByApp !== undefined ? { connectionsByApp: props.connectionsByApp } : {})}
        steps={props.steps}
      />,
    );
  });
}

const PROMPT = 'Summarise <b>this week</b>; flag anything over $200 & say why.';
const QUERIES = ["SELECT category, SUM(amount) AS total FROM txns WHERE posted >= strftime('%s', 'now', '-7 days') GROUP BY category", 'SELECT category, monthly FROM budgets'];
const think = (appId: string, sql?: string[]): ScheduleStep => ({ kind: 'app-think', appId, prompt: PROMPT, context: sql === undefined ? { maxRows: 50 } : { sql, maxRows: 50 } });

describe('what will run, verbatim', () => {
  it('names the heading, the app, the prompt as text, each query, the hosts and the daily bound', async () => {
    await render({ steps: [think('ledger', QUERIES)], hostsByApp: { ledger: ['api.bank.example', 'sync.bank.example'] } });
    expect(must('enable-consent').querySelector('h3')?.textContent).toBe(CONSENT.heading);
    expect(must('consent-step-0').textContent).toContain('ask Ledger’s AI');
    expect(must('consent-prompt-0').textContent).toBe(PROMPT);
    expect(must('consent-prompt-0').querySelector('b'), 'markup in a prompt is characters, never an element').toBeNull();
    expect([...must('consent-queries-0').querySelectorAll('code')].map((c) => c.textContent)).toEqual(QUERIES);
    // INVERTED by D-PR4-20 (TASK-20261010-host-broker PR-4, D11): a tool-free ask step calls nothing —
    // its call row says so (*may call: none — it only reads data*), never the app's approved hosts.
    // Was: expect(must('consent-hosts-0').textContent).toBe('api.bank.example, sync.bank.example');
    expect(must('consent-hosts-0').textContent).toBe('none — it only reads data');
    expect(must('consent-step-0').textContent).not.toContain('api.bank.example');
    expect(must('consent-cost').textContent).toBe(`${CONSENT.cost}: ${CONSENT_ROWS.dailyBound(1)}`);
    expect(must('consent-enable').textContent).toBe(CONSENT.enable);
    expect(must('consent-not-now').textContent).toBe(CONSENT.notNow);
  });

  it('with no typed queries it says the AI reads the app’s tables; with no approved connection the hosts row says none', async () => {
    await render({ steps: [think('ledger')] });
    expect(must('consent-tables-0').textContent).toBe(CONSENT_ROWS.tables('Ledger'));
    expect(q('consent-queries-0')).toBeNull();
    // INVERTED by D-PR4-20 (PR-4): the tool-free ask step's call row reads *none — it only reads data*.
    // Was: expect(must('consent-hosts-0').textContent).toBe(CONSENT_ROWS.noHosts);
    expect(must('consent-hosts-0').textContent).toBe('none — it only reads data');
  });

  it('a reminder step shows its title and message; two apps are two rows', async () => {
    await render({
      steps: [{ kind: 'notify', title: 'stretch', body: 'stand up and stretch' }, think('ledger'), think('standup')],
      appNames: { ledger: 'Ledger', standup: 'Standup' },
      spec: DAILY,
    });
    expect(must('consent-step-0').textContent).toContain(CONSENT_ROWS.remind('stretch'));
    expect(must('consent-step-0').textContent).toContain('stand up and stretch');
    expect(must('consent-step-1').textContent).toContain('ask Ledger’s AI');
    expect(must('consent-step-2').textContent).toContain('ask Standup’s AI');
    expect(must('consent-cost').textContent).toBe(`${CONSENT.cost}: ${CONSENT_ROWS.dailyBound(2)}`);
  });

  it('the two acts fire their handlers; busy disables both; a refusal is shown in words', async () => {
    let enabled = 0;
    let declined = 0;
    await render({ steps: [think('ledger')], onEnable: () => void enabled++, onNotNow: () => void declined++ });
    await act(async () => {
      must('consent-enable').click();
      must('consent-not-now').click();
    });
    expect(enabled).toBe(1);
    expect(declined).toBe(1);
    await render({ steps: [think('ledger')], busy: true, error: 'the file is read-only here' });
    expect((must('consent-enable') as HTMLButtonElement).disabled).toBe(true);
    expect((must('consent-not-now') as HTMLButtonElement).disabled).toBe(true);
    expect(must('consent-error').textContent).toBe('the file is read-only here');
  });
});

describe('the daily bound (E7) and the hosts (F10) — the pure half', () => {
  it('dailyAiBound: the busiest day of the next seven × the ask-the-AI steps, capped at the ceiling; reminders spend nothing', () => {
    expect(dailyAiBound(WEEKLY, [think('ledger')], NOW)).toBe(1);
    expect(dailyAiBound(DAILY, [think('ledger'), think('standup')], NOW)).toBe(2);
    expect(dailyAiBound({ kind: 'every', n: 5, unit: 'minutes', tz: 'device' }, [think('ledger')], NOW)).toBe(100);
    expect(dailyAiBound({ kind: 'every', n: 2, unit: 'hours', tz: 'device' }, [think('ledger')], NOW)).toBe(12);
    expect(dailyAiBound(DAILY, [{ kind: 'notify', title: 'x', body: 'y' }], NOW)).toBe(0);
    expect(CONSENT_ROWS.dailyBound(0)).toBe('no AI calls');
    expect(CONSENT_ROWS.dailyBound(1)).toBe('up to 1 AI call a day — the daily limit is 100');
    expect(CONSENT_ROWS.dailyBound(12)).toBe('up to 12 AI calls a day — the daily limit is 100');
  });

  it('approvedHostsByApp: the frozen ceiling of APPROVED rows only, sorted and deduplicated; a declared row is not a capability', () => {
    const app = db.installApp({ displayName: 'Ledger', html: '<p>x</p>' }).appId;
    const other = db.installApp({ displayName: 'Standup', html: '<p>y</p>' }).appId;
    const requirement = (slot: string, hosts: string[]) => ({
      slot,
      kind: 'api_key' as const,
      provider: { name: `${slot} service` },
      fields: [{ key: 'api_key', label: 'API key', type: 'secret' as const }],
      request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
      declaredApiHosts: hosts,
    });
    db.putDeclaredConnection(app, 'bank', requirement('bank', ['sync.bank.example', 'api.bank.example']), 'inference');
    db.approveConnection(app, 'bank');
    db.putDeclaredConnection(app, 'pending', requirement('pending', ['never.example']), 'inference');
    db.putDeclaredConnection(other, 'standup', requirement('standup', ['api.standup.example']), 'inference');
    expect(approvedHostsByApp(db, [app, other, app])).toEqual({ [app]: ['api.bank.example', 'sync.bank.example'], [other]: [] });
  });
});

// =============================================================================================
// TASK-20261010-host-broker PR-4 — the task write authority's tick and the ask step's new rows
// (D-PR4-8, D-PR4-20; AC31, AC32). The tick is ONE act on this surface (all four hosts land here):
// OFF on every mount, never seeded from a proposal, an import, a draft or storage — only the
// editor may pre-set it to the choice the user just made there (`presetOnItsOwn`); offered only
// when every *Ask <App>'s AI* step names ONE app; its words are `CONSENT_ROWS.onItsOwn(appName)`.
// The user's answer reaches the host through `onEnable({ onItsOwn })`.
//
// Assumed (lane T-C questions): the tick is `[data-testid="consent-on-its-own"]` (a checkbox), its
// unticked hint `consent-on-its-own-hint`, the > 20-a-week note `consent-on-its-own-often`; the
// look-up row `consent-lookups-<i>` composes the names `fetchableConnections` gives, handed in as
// `connectionsByApp` (library id → connection display names).
// =============================================================================================

const tools = (appId: string, sql?: string[]): ScheduleStep => ({ kind: 'app-think', appId, prompt: PROMPT, context: sql === undefined ? { maxRows: 50 } : { sql, maxRows: 50 }, tools: true });
const HOURLY: ScheduleSpec = { kind: 'every', n: 1, unit: 'hours', tz: 'device' };

const tick = (): HTMLInputElement => must('consent-on-its-own') as HTMLInputElement;

async function remount(props: Partial<EnableConsentProps> & Pick<EnableConsentProps, 'steps'>): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  await render(props);
}

describe('PR-4 — the tick: *make changes on its own* (D-PR4-8, D-PR4-20)', () => {
  it('a one-app ask step offers the tick, OFF, labelled with the contract’s words, with the off hint', async () => {
    await render({ steps: [think('ledger')] });
    expect(tick().type).toBe('checkbox');
    expect(tick().checked).toBe(false);
    expect(must('enable-consent').textContent).toContain(CONSENT_ROWS.onItsOwn('Ledger'));
    expect(CONSENT_ROWS.onItsOwn('Ledger')).toBe('let it make its changes to Ledger’s data on its own — never another app’s · up to 200 rows each time · undo any of it for seven days');
    expect(tick().labels?.[0]?.textContent ?? '', 'the tick is named by its own words').toContain(CONSENT_ROWS.onItsOwn('Ledger'));
    expect(must('consent-on-its-own-hint').textContent).toBe('off: its changes wait for your OK on the result');
  });

  it('ticking it is the ONE act: the hint goes, and schedule it hands the host { onItsOwn: true }; left off, { onItsOwn: false }', async () => {
    const choices: unknown[] = [];
    await render({ steps: [think('ledger')], onEnable: (choice?: unknown) => void choices.push(choice) });
    await act(async () => {
      tick().click();
    });
    expect(tick().checked).toBe(true);
    expect(q('consent-on-its-own-hint')).toBeNull();
    await act(async () => {
      must('consent-enable').click();
    });
    expect(choices).toEqual([{ onItsOwn: true }]);

    choices.length = 0;
    await remount({ steps: [think('ledger')], onEnable: (choice?: unknown) => void choices.push(choice) });
    await act(async () => {
      must('consent-enable').click();
    });
    expect(choices).toEqual([{ onItsOwn: false }]);
  });

  it('a reminder and an ask step of ONE app still offer it; the app named is that app', async () => {
    await render({ steps: [{ kind: 'notify', title: 'stretch', body: 'stand up' }, think('ledger')] });
    expect(tick().checked).toBe(false);
    expect(must('enable-consent').textContent).toContain(CONSENT_ROWS.onItsOwn('Ledger'));
  });

  it('NEGATIVE: a task whose ask steps name TWO apps shows no tick at all — one seat call per run, one undo per run', async () => {
    await render({ steps: [think('ledger'), think('standup')], appNames: { ledger: 'Ledger', standup: 'Standup' } });
    expect(q('consent-on-its-own')).toBeNull();
    expect(q('consent-on-its-own-hint')).toBeNull();
    expect(must('enable-consent').textContent).not.toContain('on its own');
  });

  it('NEGATIVE: nothing to make changes with — a reminder-only or a run-only schedule shows no tick', async () => {
    await render({ steps: [{ kind: 'notify', title: 'stretch', body: 'stand up' }] });
    expect(q('consent-on-its-own')).toBeNull();
    await remount({ steps: [{ kind: 'app-run', appId: 'ledger' }] });
    expect(q('consent-on-its-own')).toBeNull();
  });

  it('NEGATIVE: OFF on every mount — a tick given on one mount is not there on the next, and nothing is kept in storage', async () => {
    localStorage.clear();
    sessionStorage.clear();
    await render({ steps: [think('ledger')] });
    await act(async () => {
      tick().click();
    });
    expect(tick().checked).toBe(true);
    await remount({ steps: [think('ledger')] });
    expect(tick().checked, 'never seeded from the last mount').toBe(false);
    expect(localStorage.length, 'never seeded from storage — so never written there').toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('NEGATIVE: never seeded from the steps — an ask step carrying anything authority-shaped still mounts the tick OFF', async () => {
    const smuggled = { ...think('ledger'), writeAuthority: { rowsPerRun: 200, armedAt: '2026-10-09T12:00:00.000Z', armedVersion: 1 }, onItsOwn: true } as unknown as ScheduleStep;
    await render({ steps: [smuggled] });
    expect(tick().checked).toBe(false);
  });

  it('the editor — and only the editor — pre-sets it to the choice the user just made there (presetOnItsOwn)', async () => {
    const choices: unknown[] = [];
    await render({ steps: [think('ledger')], presetOnItsOwn: true, onEnable: (choice?: unknown) => void choices.push(choice) });
    expect(tick().checked).toBe(true);
    expect(q('consent-on-its-own-hint')).toBeNull();
    // …and the user can still take it back here: the consent is the review.
    await act(async () => {
      tick().click();
    });
    await act(async () => {
      must('consent-enable').click();
    });
    expect(choices).toEqual([{ onItsOwn: false }]);
  });

  it('a schedule that runs more than 20 times a week says what happens once 20 changes wait to age out; a daily one does not', async () => {
    await render({ steps: [think('ledger')], spec: HOURLY });
    expect(must('consent-on-its-own-often').textContent).toBe('it runs more than 20 times a week — once 20 changes are waiting to age out, the rest wait for your OK');
    await remount({ steps: [think('ledger')], spec: DAILY });
    expect(q('consent-on-its-own-often')).toBeNull();
  });

  it('the busy flag disables the tick with the two acts', async () => {
    await render({ steps: [think('ledger')], busy: true });
    expect(tick().disabled).toBe(true);
  });
});

describe('PR-4 — an ask step that may look things up: the call row, the queries line, the cost row (D-PR4-20; D11, D12)', () => {
  const LOOK_UP = 'may look up (read only — it can’t send or change anything there; it can use them without asking you each time)';

  it('the call row names the connections it may use (fetchableConnections’ names), in the contract’s words — never the hosts', async () => {
    await render({
      steps: [tools('ledger')],
      hostsByApp: { ledger: ['api.bank.example'] },
      connectionsByApp: { ledger: ['Spotify', 'Bank'] },
    });
    expect(must('consent-lookups-0').textContent).toBe(`${LOOK_UP}: Spotify, Bank`);
    expect(must('consent-step-0').textContent).not.toContain('api.bank.example');
    expect(must('consent-step-0').textContent).not.toContain('it only reads data');
  });

  it('NEGATIVE: the tool-free ask step shows no look-up row, whatever connections the app has', async () => {
    await render({ steps: [think('ledger')], connectionsByApp: { ledger: ['Spotify'] } });
    expect(q('consent-lookups-0')).toBeNull();
    expect(must('consent-step-0').textContent).not.toContain('Spotify');
    expect(must('consent-hosts-0').textContent).toBe('none — it only reads data');
  });

  it('typed queries stay as starting context — the consent says it starts from them and may read more itself', async () => {
    await render({ steps: [tools('ledger', QUERIES)] });
    expect([...must('consent-queries-0').querySelectorAll('code')].map((c) => c.textContent)).toEqual(QUERIES);
    expect(must('consent-step-0').textContent).toContain('starts from these; may read more of Ledger’s data itself');
  });

  it('…and a tool-free step with typed queries does NOT say so (negative twin)', async () => {
    await render({ steps: [think('ledger', QUERIES)] });
    expect(must('consent-step-0').textContent).not.toContain('starts from these');
  });

  it('the cost row: up to 10 AI calls and 8 look-ups each time — up to N AI calls a day (the daily limit is 100)', async () => {
    await render({ steps: [tools('ledger')], spec: WEEKLY });
    expect(dailyAiBound(WEEKLY, [tools('ledger')], NOW)).toBe(10);
    expect(must('consent-cost').textContent).toContain('up to 10 AI calls and 8 look-ups each time — up to 10 AI calls a day (the daily limit is 100)');
    await remount({ steps: [tools('ledger')], spec: { kind: 'every', n: 2, unit: 'hours', tz: 'device' } });
    expect(must('consent-cost').textContent).toContain('up to 10 AI calls and 8 look-ups each time — up to 100 AI calls a day (the daily limit is 100)');
  });

  it('the tick is offered on a tools step too (one app), still OFF', async () => {
    await render({ steps: [tools('ledger')] });
    expect(tick().checked).toBe(false);
  });
});
