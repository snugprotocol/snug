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
    expect(must('consent-hosts-0').textContent).toBe('api.bank.example, sync.bank.example');
    expect(must('consent-cost').textContent).toBe(`${CONSENT.cost}: ${CONSENT_ROWS.dailyBound(1)}`);
    expect(must('consent-enable').textContent).toBe(CONSENT.enable);
    expect(must('consent-not-now').textContent).toBe(CONSENT.notNow);
  });

  it('with no typed queries it says the AI reads the app’s tables; with no approved connection the hosts row says none', async () => {
    await render({ steps: [think('ledger')] });
    expect(must('consent-tables-0').textContent).toBe(CONSENT_ROWS.tables('Ledger'));
    expect(q('consent-queries-0')).toBeNull();
    expect(must('consent-hosts-0').textContent).toBe(CONSENT_ROWS.noHosts);
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
