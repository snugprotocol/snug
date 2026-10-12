// scheduleEditor.test.tsx — TASK-20261009-scheduling-framework U3 (+ U8 on the create path): the
// editor ROUTE. `/schedule/new` prefills from `?text=` (the deterministic grammar fills the chips
// and the time; a sentence without a time keeps its words as the title and says so), from each of
// the four `?template=` names (against the apps actually installed), and from `?app=`; the chips
// are one radiogroup whose change re-reads the preview; the frequency floor refuses in words and
// disables the save; the cost line names the app's brain NOW and where the rows go; a schedule
// that asks the AI shows the consent panel — the prompt and the queries verbatim — before
// `createTask` is called with EXACTLY the input the form holds; a *run <app>* step (PR-B, A-UI) is
// selectable, carries an optional input ≤ 1 KiB and the note that the app must handle scheduled
// runs, and goes through the consent like anything that spends; `?suggestion=` (the chat's suggestion
// card) prefills the form and `?back=` is where the save and the cancel return; the custom cron
// and the chips derive each other; `/schedule/:id` edits through `updateTask`, and an imported
// schedule turns on only through the consent.
//
// A ROUTED mount with the real memory user db (`installTestUserDb`), the clock pinned to a Friday
// so the weekly templates have a definite "next". `createTask` is wrapped (not replaced) so the
// exact input is observable while the real writer still lands the row.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import type { ScheduleStep, ScheduledTask } from '@snugprotocol/protocol';

import { armTask } from '../schedule/acts.js';
import { brainBlocked, disarmed, imported, nextLine } from '../schedule/copy.js';
import { ACTIONS, CHANGES_CONTROL, CONSENT_ROWS, FROM_SUGGESTION, SENTENCE, STEPS, TEMPLATE_TITLES, TITLE, WHEN } from '../schedule/copy.editor.js';
import { LEDGER_QUERIES, STANDUP_QUERIES, TEMPLATE_PROMPTS, draftsFromSteps, lookUpNamesByApp, parseRunInput, prepareSteps, proposalFill, remainderOf } from '../schedule/editorModel.js';
import { readSchedule } from '../schedule/parseScheduleText.js';
import { newScheduleHref } from '../schedule/routes.js';
import { ScheduleEditorView } from '../schedule/ScheduleEditorView.js';
import { createTask } from '../schedule/scheduler.js';
import { appModelStore, appProviderStore } from '../state/appModel.js';
import { byokKeyPresenceStore, modeStore, providerStore } from '../state/mode.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import { installTestUserDb } from './userdbTestHelper.js';

vi.mock('../schedule/scheduler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../schedule/scheduler.js')>();
  return { ...actual, createTask: vi.fn(actual.createTask) };
});
// PR-4 Gate-5 U13: `armTask` wrapped (not replaced) so ONE test can make the arming after a create refuse.
vi.mock('../schedule/acts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../schedule/acts.js')>();
  return { ...actual, armTask: vi.fn(actual.armTask) };
});

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** A Friday, midday UTC — every weekly template's "next" is this evening or next week. */
const NOW = new Date('2026-10-09T12:20:00.000Z');

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  modeStore.set('byok');
  providerStore.set('mock');
  byokKeyPresenceStore.set({ anthropic: false, openai: false });
  appModelStore.set({});
  appProviderStore.set({});
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  vi.mocked(createTask).mockClear();
  vi.mocked(armTask).mockClear();
  db = await installTestUserDb();
});

afterEach(async () => {
  await unmount();
  vi.useRealTimers();
});

function Probe(): React.ReactElement {
  const location = useLocation();
  return <div data-testid="schedule-page">{location.pathname}</div>;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

async function settleUntil(done: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (done()) return;
    await settle();
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const q = (testId: string): HTMLElement | null => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const must = (testId: string): HTMLElement => {
  const el = q(testId);
  if (el === null) throw new Error(`missing [data-testid="${testId}"]`);
  return el;
};
const input = (testId: string): HTMLInputElement => must(testId) as HTMLInputElement;
const select = (testId: string): HTMLSelectElement => must(testId) as HTMLSelectElement;

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
}

/** A second mount in one test tears the first down first — a stale editor left in <body> would answer every later query. */
async function mount(path: string): Promise<void> {
  await unmount();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/schedule" element={<Probe />} />
          <Route path="/schedule/new" element={<ScheduleEditorView />} />
          <Route path="/schedule/:id" element={<ScheduleEditorView />} />
          <Route path="/run/:id" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settleUntil(() => q('schedule-editor-loading') === null && (q('schedule-editor-view') !== null || q('schedule-page') !== null), `the editor at ${path}`);
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

async function blur(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

const checked = (kind: string): boolean => must(`spec-kind-${kind}`).getAttribute('aria-checked') === 'true';
const pressed = (testId: string): boolean => must(testId).getAttribute('aria-pressed') === 'true';
const occurrences = (): string[] => [...document.body.querySelectorAll<HTMLTimeElement>('[data-testid="preview-occurrences"] time')].map((t) => t.dateTime);

const installLedger = (): string => db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>Ledger</title>', usesDb: true, installSource: 'starter:ledger' }).appId;
const installWeather = (): string => db.installApp({ displayName: 'Should I?', html: '<!doctype html><title>Should I?</title>', installSource: 'starter:weather' }).appId;
const installStandup = (): string => db.installApp({ displayName: 'Standup', html: '<!doctype html><title>Standup</title>', usesDb: true, installSource: 'starter:github' }).appId;

describe('remainderOf — the words beside the schedule (design F1: the create bar is one click from schedule it)', () => {
  // the text · the phrase the grammar read (`readSchedule(…).phrase`) · the task’s own words
  const ROWS: ReadonlyArray<readonly [string, string, string]> = [
    ['remind me to call mom at 5', 'at 5', 'call mom'],
    ['every weekday at 8, summarise my ledger', 'every weekday at 8', 'summarise my ledger'],
    ['at 5pm', 'at 5pm', ''],
    ['every morning at 7 tell me the weather', 'every morning at 7', 'tell me the weather'],
    // spelled as typed; edge punctuation and whitespace trimmed
    ['  Remind me to   call Mom at 5pm!  ', 'at 5pm', 'call Mom'],
    ['Every weekday at 8 — summarise my Ledger.', 'every weekday at 8', 'summarise my Ledger'],
    // the intent words, once, at the start ("tell me" alone is not one); a trailing please
    ['remind me every weekday at 8 to stretch, please', 'every weekday at 8', 'stretch'],
    ['please summarise my ledger every monday at 9', 'every monday at 9', 'summarise my ledger'],
    ['tell me to water the ferns tomorrow at 9', 'tomorrow at 9', 'water the ferns'],
    ['remind me the weather at 7', 'at 7', 'the weather'],
    ['remind me to remind me to breathe at 9', 'at 9', 'remind me to breathe'],
    // the grammar’s own normalisation ("each" → "every", "p.m." → "pm") and a phrase the task splits
    ['each day at 7pm, water the ferns', 'every day at 7pm', 'water the ferns'],
    ['check the inbox at 5 p.m. today', 'at 5 pm today', 'check the inbox'],
    ['at 5 remind me every weekday to stretch', 'at 5 every weekday', 'stretch'],
    // nothing parsed: the whole sentence, minus the intent
    ['remind me to buy milk', '', 'buy milk'],
  ];

  it.each(ROWS)('%j minus %j → %j', (text, phrase, words) => {
    expect(remainderOf(text, phrase)).toBe(words);
  });

  it('the phrases above are the ones the grammar reads', () => {
    for (const [text, phrase] of ROWS) if (phrase !== '') expect(readSchedule(text, NOW, 'device')?.phrase, text).toBe(phrase);
  });

  it('a phrase the text does not carry answers nothing — the caller keeps the whole sentence', () => {
    expect(remainderOf('every weekday at 8', 'tomorrow at 9')).toBe('');
  });
});

describe('prefill from ?text= (the sentence box)', () => {
  it('"every weekday at 8" checks the weekly chip, presses Monday–Friday, sets 08:00, and titles the schedule with the sentence', async () => {
    await mount('/schedule/new?text=every%20weekday%20at%208');
    expect(checked('weekly')).toBe(true);
    expect(checked('daily')).toBe(false);
    expect(input('spec-time').value).toBe('08:00');
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri']) expect(pressed(`spec-day-${day}`), day).toBe(true);
    for (const day of ['sat', 'sun']) expect(pressed(`spec-day-${day}`), day).toBe(false);
    expect(pressed('spec-preset-weekdays')).toBe(true);
    expect(input('schedule-title').value).toBe('every weekday at 8');
    expect(must('preview-next-line').textContent).toBe(nextLine('Weekdays at 8:00 AM'));
    expect(must('schedule-text-note').textContent).toBe('');
  });

  it('a sentence without a time says so, keeps the words as the title, and leaves the controls at their default', async () => {
    await mount('/schedule/new?text=buy%20milk');
    expect(must('schedule-text-note').textContent).toBe(SENTENCE.cannotRead);
    expect(input('schedule-title').value).toBe('buy milk');
    expect(checked('daily')).toBe(true);
    expect(input('spec-time').value).toBe('09:00');
  });

  it('typing re-parses live: a reading fills the controls, a failure leaves them as they are and says so', async () => {
    await mount('/schedule/new');
    await type(input('schedule-text'), 'every day at 7pm');
    expect(checked('daily')).toBe(true);
    expect(input('spec-time').value).toBe('19:00');
    expect(input('schedule-title').value).toBe('every day at 7pm');
    await type(input('schedule-text'), 'every day at 7pm and nothing readable yesterday');
    expect(must('schedule-text-note').textContent).toBe(SENTENCE.cannotRead);
    expect(checked('daily')).toBe(true);
    expect(input('spec-time').value).toBe('19:00');
  });

  it('day chips carry their full names (U9) and the chips are one radiogroup moved by the arrow keys', async () => {
    await mount('/schedule/new?text=every%20weekday%20at%208');
    expect(must('spec-day-mon').getAttribute('aria-label')).toBe('Monday');
    expect(must('spec-day-sun').getAttribute('aria-label')).toBe('Sunday');
    expect(must('spec-kinds').getAttribute('role')).toBe('radiogroup');
    expect(must('spec-kind-weekly').getAttribute('role')).toBe('radio');
    await act(async () => {
      must('spec-kinds').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(checked('monthly')).toBe(true);
    expect(checked('weekly')).toBe(false);
  });

  it('"remind me to call mom at 5" (the create bar’s sentence) titles the schedule "call mom", fills the reminder with the same words, and is one click from schedule it', async () => {
    await mount('/schedule/new?text=remind%20me%20to%20call%20mom%20at%205');
    expect(checked('once')).toBe(true);
    expect(input('schedule-title').value).toBe('call mom');
    expect(must('step-0').dataset.kind).toBe('notify');
    expect(input('step-0-title').value).toBe('call mom');
    expect(input('step-0-body').value).toBe('call mom');
    expect(q('save-blocker')).toBeNull();
    expect((must('schedule-save') as HTMLButtonElement).disabled).toBe(false);
    await click(must('schedule-save'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(vi.mocked(createTask)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createTask).mock.calls[0]?.[0]).toEqual({
      title: 'call mom',
      steps: [{ kind: 'notify', title: 'call mom', body: 'call mom' }],
      spec: { kind: 'once', at: expect.stringMatching(/T\d{2}:00:00\.000Z$/), tz: 'device' },
      missedPolicy: 'run-once',
      alert: 'inbox',
      provenance: 'user',
    });
    expect(db.listScheduledTasks()).toHaveLength(1);
  });

  it('"every weekday at 8, summarise my ledger" with ?app= (the sheet’s more options) is an ask-the-AI step whose prompt is the words beside the schedule', async () => {
    const ledger = installLedger();
    await mount(`/schedule/new?${new URLSearchParams({ text: 'every weekday at 8, summarise my ledger', app: ledger }).toString()}`);
    expect(checked('weekly')).toBe(true);
    expect(input('spec-time').value).toBe('08:00');
    expect(input('schedule-title').value).toBe('summarise my ledger');
    expect(must('step-0').dataset.kind).toBe('app-think');
    expect(select('step-0-app').value).toBe(ledger);
    expect((must('step-0-prompt') as HTMLTextAreaElement).value).toBe('summarise my ledger');
    expect(q('save-blocker')).toBeNull();
    expect((must('schedule-save') as HTMLButtonElement).disabled).toBe(false);
    await click(must('schedule-save'));
    expect(must('consent-prompt-0').textContent).toBe('summarise my ledger');
  });

  it('a sentence that is only a schedule leaves the reminder’s words to the user, and the save waits for them', async () => {
    await mount('/schedule/new?text=every%20weekday%20at%208');
    expect(input('schedule-title').value).toBe('every weekday at 8');
    expect(input('step-0-title').value).toBe('');
    expect(input('step-0-body').value).toBe('');
    expect(must('save-blocker').textContent).toBe(STEPS.needTitle);
    expect((must('schedule-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a sentence without a time still keeps its words — minus the intent — as the title and the reminder, and says so', async () => {
    await mount('/schedule/new?text=remind%20me%20to%20buy%20milk');
    expect(must('schedule-text-note').textContent).toBe(SENTENCE.cannotRead);
    expect(input('schedule-title').value).toBe('buy milk');
    expect(input('step-0-title').value).toBe('buy milk');
    expect(input('step-0-body').value).toBe('buy milk');
  });
});

describe('prefill from ?template=', () => {
  it('nudge: a reminder every day at 20:00 with a notification', async () => {
    await mount('/schedule/new?template=nudge');
    expect(input('schedule-title').value).toBe(TEMPLATE_TITLES.nudge);
    expect(checked('daily')).toBe(true);
    expect(input('spec-time').value).toBe('20:00');
    expect(must('step-0').dataset.kind).toBe('notify');
    expect(input('step-0-title').value).toBe('nudge');
    expect(input('alert-notification').checked).toBe(true);
    // Cost-derived catch-up (Q12): reminders only → run once when it opens.
    expect(input('missed-run-once').checked).toBe(true);
  });

  it('spend-review: Ledger’s AI every Friday at 17:00 with two typed queries over its tables', async () => {
    const ledger = installLedger();
    await mount('/schedule/new?template=spend-review');
    expect(input('schedule-title').value).toBe(TEMPLATE_TITLES['spend-review']);
    expect(checked('weekly')).toBe(true);
    expect(pressed('spec-day-fri')).toBe(true);
    expect(pressed('spec-day-thu')).toBe(false);
    expect(input('spec-time').value).toBe('17:00');
    expect(must('step-0').dataset.kind).toBe('app-think');
    expect(select('step-0-app').value).toBe(ledger);
    expect((must('step-0-prompt') as HTMLTextAreaElement).value).toBe(TEMPLATE_PROMPTS.spend);
    expect(input('step-0-data-queries').checked).toBe(true);
    expect((must('step-0-query-0') as HTMLTextAreaElement).value).toBe(LEDGER_QUERIES[0]);
    expect((must('step-0-query-1') as HTMLTextAreaElement).value).toBe(LEDGER_QUERIES[1]);
    expect(input('missed-ask').checked).toBe(true);
  });

  it('spend-review without Ledger installed says so on the step, disables it, and the save with it', async () => {
    await mount('/schedule/new?template=spend-review');
    expect(must('step-0-missing').textContent).toBe(STEPS.appMissing('Ledger'));
    expect(must('step-0').className).toContain('schedule-step-off');
    expect((must('schedule-save') as HTMLButtonElement).disabled).toBe(true);
    expect(must('save-blocker').textContent).toBe(STEPS.needStep);
  });

  it('friday-review: Ledger and Standup, two independent ask-the-AI steps on one schedule', async () => {
    const ledger = installLedger();
    const standup = installStandup();
    await mount('/schedule/new?template=friday-review');
    expect(select('step-0-app').value).toBe(ledger);
    expect(select('step-1-app').value).toBe(standup);
    expect((must('step-1-query-0') as HTMLTextAreaElement).value).toBe(STANDUP_QUERIES[0]);
    expect(must('preview-cost').textContent).toBe('cost: ≈ 2 AI calls a week on demo brain · sends rows from Ledger and Standup to that provider');
  });

  it('morning-weather: the run-Weather step is selectable, carries the app, an empty input and the handles-scheduled-runs note; the save goes through the consent and lands the run step', async () => {
    const weather = installWeather();
    await mount('/schedule/new?template=morning-weather');
    expect(must('step-0').dataset.kind).toBe('app-run');
    expect(must('step-0').className).not.toContain('schedule-step-off');
    expect(select('step-0-app').value).toBe(weather);
    expect((must('step-0-input') as HTMLTextAreaElement).value).toBe('');
    expect(must('step-0-run-note').textContent).toBe(STEPS.runNote('Should I?'));
    expect(must('step-0-run-note').textContent).toBe('Should I? must handle scheduled runs — apps built after today do');
    expect(q('step-0-later')).toBeNull();
    expect(must('step-1').dataset.kind).toBe('notify');
    expect(input('alert-notification').checked).toBe(true);
    expect(input('missed-ask').checked, 'a run spends — the catch-up default asks').toBe(true);
    expect(q('later-release-refusal')).toBeNull();
    expect((must('schedule-save') as HTMLButtonElement).disabled).toBe(false);

    await click(must('schedule-save'));
    expect(vi.mocked(createTask), 'what will run is shown first (U8)').not.toHaveBeenCalled();
    expect(must('consent-step-0').textContent).toContain('run Should I?');
    expect(must('consent-step-0').textContent).toContain(CONSENT_ROWS.noHosts);
    await click(must('consent-enable'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(vi.mocked(createTask).mock.calls[0]?.[0]).toEqual({
      title: TEMPLATE_TITLES['morning-weather'],
      steps: [
        { kind: 'app-run', appId: weather },
        { kind: 'notify', title: 'morning weather', body: 'your morning weather is ready' },
      ],
      spec: { kind: 'daily', time: '07:00', tz: 'device' },
      missedPolicy: 'ask',
      alert: 'notification',
      provenance: 'user',
    });
    expect(db.listScheduledTasks()[0]?.cron).toBe('0 7 * * *');
  });

  it('morning-weather without the app says so on the step and disables it, like any template step', async () => {
    await mount('/schedule/new?template=morning-weather');
    expect(must('step-0-missing').textContent).toBe(STEPS.appMissing('Should I?'));
    expect(must('step-0').className).toContain('schedule-step-off');
  });

  it('a run step’s input reaches the task as JSON when it parses, as text otherwise, and is refused over 1 KiB', async () => {
    const weather = installWeather();
    await mount('/schedule/new?template=morning-weather');
    await type(must('step-0-input') as HTMLTextAreaElement, '{"units":"metric"}');
    await click(must('schedule-save'));
    expect(must('consent-step-0').textContent).toContain('{"units":"metric"}');
    await click(must('consent-enable'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect((vi.mocked(createTask).mock.calls[0]?.[0] as { steps: unknown[] }).steps[0]).toEqual({ kind: 'app-run', appId: weather, input: { units: 'metric' } });
    expect(parseRunInput('plain words')).toEqual({ ok: true, input: 'plain words' });
    expect(parseRunInput('   ')).toEqual({ ok: true });
    expect(parseRunInput('x'.repeat(1100))).toEqual({ ok: false, reason: STEPS.runInputTooLong });

    await mount('/schedule/new?template=morning-weather');
    await type(must('step-0-input') as HTMLTextAreaElement, 'x'.repeat(1100));
    expect(must('save-blocker').textContent).toBe(STEPS.runInputTooLong);
    expect((must('schedule-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the kind select offers run <app> and switching to it keeps the app', async () => {
    const ledger = installLedger();
    await mount(`/schedule/new?app=${ledger}`);
    const kind = select('step-0-kind');
    expect([...kind.options].map((option) => [option.value, option.disabled])).toEqual([
      ['notify', false],
      ['app-think', false],
      ['app-run', false],
    ]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(kind, 'app-run');
      kind.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(must('step-0').dataset.kind).toBe('app-run');
    expect(select('step-0-app').value).toBe(ledger);
    expect(must('step-0-run-note').textContent).toBe(STEPS.runNote('Ledger'));
  });

  it('?app= preselects the app in an ask-the-AI step', async () => {
    const ledger = installLedger();
    await mount(`/schedule/new?app=${ledger}`);
    expect(must('step-0').dataset.kind).toBe('app-think');
    expect(select('step-0-app').value).toBe(ledger);
    expect(input('schedule-title').value).toBe('ask Ledger’s AI');
  });
});

describe('prefill from ?suggestion= — the chat’s suggestion card (P1)', () => {
  it('opens with the suggestion’s title, when and steps, says where it came from, and the cancel goes back to the thread', async () => {
    const ledger = installLedger();
    const proposal = {
      title: 'morning summary',
      steps: [{ kind: 'app-think', appId: ledger, prompt: 'Sum up yesterday in two lines.', context: { maxRows: 50 } }],
      spec: { kind: 'weekly', days: ['mon', 'wed'], time: '08:30', tz: 'device' },
    };
    await mount(newScheduleHref({ suggestion: JSON.stringify(proposal), app: ledger, back: `/run/${ledger}` }));
    expect(must('from-suggestion-note').textContent).toBe(FROM_SUGGESTION.note);
    expect(input('schedule-title').value).toBe('morning summary');
    expect(checked('weekly')).toBe(true);
    expect(pressed('spec-day-mon')).toBe(true);
    expect(pressed('spec-day-wed')).toBe(true);
    expect(pressed('spec-day-tue')).toBe(false);
    expect(input('spec-time').value).toBe('08:30');
    expect(must('step-0').dataset.kind).toBe('app-think');
    expect(select('step-0-app').value).toBe(ledger);
    expect((must('step-0-prompt') as HTMLTextAreaElement).value).toBe('Sum up yesterday in two lines.');
    expect(input('step-0-data-tables').checked).toBe(true);
    await click(must('schedule-cancel'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation back');
    expect(must('schedule-page').textContent).toBe(`/run/${ledger}`);
    expect(db.listScheduledTasks()).toHaveLength(0);
  });

  it('the save is the user’s own, and lands back on the thread', async () => {
    const ledger = installLedger();
    const proposal = { title: 'nudge', steps: [{ kind: 'notify', title: 'hi', body: 'there' }], spec: { kind: 'daily', time: '20:00', tz: 'device' } };
    await mount(newScheduleHref({ suggestion: JSON.stringify(proposal), app: ledger, back: `/run/${ledger}` }));
    await click(must('schedule-save'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation back');
    expect(must('schedule-page').textContent).toBe(`/run/${ledger}`);
    expect(vi.mocked(createTask).mock.calls[0]?.[0]).toMatchObject({ title: 'nudge', provenance: 'user' });
  });

  it('a suggestion step naming an app this file does not hold is off and named in WORDS — "that app", never the id (M14)', async () => {
    const ghost = '0b6e5a1c-8d5e-4f13-9a2b-7c1d2e3f4a5b';
    const proposal = { title: 'ghost run', steps: [{ kind: 'app-run', appId: ghost }], spec: { kind: 'daily', time: '08:00', tz: 'device' } };
    const fill = proposalFill(JSON.stringify(proposal), []);
    const step = fill?.steps[0];
    expect(step?.kind).toBe('app-run');
    expect(step?.kind === 'app-run' ? step.missingApp : undefined).toBe(STEPS.unknownApp);
    expect(JSON.stringify(fill)).not.toContain(`"missingApp":"${ghost}"`);

    await mount(newScheduleHref({ suggestion: JSON.stringify(proposal) }));
    expect(must('step-0-missing').textContent).toBe(STEPS.appMissing(STEPS.unknownApp));
    expect(must('step-0-missing').textContent).not.toContain(ghost);
    expect(input('schedule-title').value).toBe('ghost run');
  });

  it('a proposal that does not parse, and a back that is not an in-app path, are ignored', async () => {
    await mount('/schedule/new?suggestion=%7B%22title%22%3A%22x%22%7D&back=https%3A%2F%2Fevil.example');
    expect(q('from-suggestion-note')).not.toBeNull();
    expect(input('schedule-title').value).toBe('');
    expect(checked('daily')).toBe(true);
    expect(newScheduleHref({ back: 'https://evil.example' })).toBe('/schedule/new');
    expect(newScheduleHref({ back: '//evil.example' })).toBe('/schedule/new');
    await click(must('schedule-cancel'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation');
    expect(must('schedule-page').textContent).toBe('/schedule');
  });
});

describe('the chips and the preview', () => {
  it('a chip change re-reads the next three occurrences and the next line', async () => {
    await mount('/schedule/new');
    expect(must('preview-next-line').textContent).toBe(nextLine('Every day at 9:00 AM'));
    const daily = occurrences();
    expect(daily).toHaveLength(3);
    await click(must('spec-kind-weekly'));
    expect(checked('weekly')).toBe(true);
    expect(must('preview-next-line').textContent).toBe(nextLine('Weekdays at 9:00 AM'));
    const weekly = occurrences();
    expect(weekly).toHaveLength(3);
    expect(weekly).not.toEqual(daily);
    await click(must('spec-kind-every'));
    expect(must('preview-next-line').textContent).toBe(nextLine('Every hour'));
    await click(must('spec-kind-once'));
    expect(must('preview-next-line').textContent).toMatch(/^Once on /);
    expect(occurrences()).toHaveLength(1);
    expect(must('schedule-preview').getAttribute('aria-live')).toBe('polite');
  });

  it('every… days offers a time (the protocol’s optional `time` on a day stride) and names what no time means', async () => {
    await mount('/schedule/new');
    await click(must('spec-kind-every'));
    expect(q('spec-time')).toBeNull();
    await act(async () => {
      select('spec-every-unit').value = 'days';
      select('spec-every-unit').dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(input('spec-time').value).toBe('');
    expect(must('spec-controls').textContent).toContain(WHEN.daysTimeHint);
    await type(input('spec-time'), '09:30');
    expect(must('preview-next-line').textContent).toBe(nextLine('Every day at 9:30 AM'));
  });

  it('the zone line follows this device by default and reads pinned once a zone is chosen', async () => {
    await mount('/schedule/new');
    const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(must('spec-zone-line').textContent).toBe(`${device} · follows this device`);
    await act(async () => {
      select('spec-zone-select').value = 'Pacific/Auckland';
      select('spec-zone-select').dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(must('spec-zone-line').textContent).toBe('Pacific/Auckland · pinned');
    expect(occurrences()[0]).toMatch(/T(20|21):00:00\.000Z$/); // 09:00 Auckland = 20:00 or 21:00 UTC across DST
  });
});

describe('refusals and the cost line', () => {
  it('the frequency floor refuses in words and disables the save', async () => {
    await mount('/schedule/new?text=every%20minute');
    expect(must('preview-floor').textContent).toBe('too often: this would run every 1 minute, and your own schedule may run at most every 5 minutes');
    expect(must('preview-floor').getAttribute('role')).toBe('alert');
    expect((must('schedule-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the cost line names the calls a week, the app’s brain NOW and where the rows go; a reminder-only schedule spends nothing', async () => {
    installLedger();
    await mount('/schedule/new?template=spend-review');
    expect(must('preview-cost').textContent).toBe('cost: ≈ 1 AI call a week on demo brain · sends rows from Ledger to that provider');
    await act(async () => {
      byokKeyPresenceStore.set({ anthropic: true, openai: false });
      providerStore.set('anthropic');
    });
    expect(must('preview-cost').textContent).toBe('cost: ≈ 1 AI call a week on claude · sends rows from Ledger to that provider');
    await mount('/schedule/new?template=nudge');
    expect(must('preview-cost').textContent).toBe('cost: no AI calls');
  });

  it('an empty title is named as the blocker before an empty step (top to bottom, as the form reads); the honesty line sits in the footer', async () => {
    await mount('/schedule/new');
    expect(must('save-blocker').textContent).toBe(TITLE.required);
    await type(input('schedule-title'), 'stretch');
    expect(must('save-blocker').textContent).toBe(STEPS.needTitle);
    await type(input('schedule-title'), '');
    expect(must('save-blocker').textContent).toBe(TITLE.required);
    expect(must('preview-honesty').textContent).toBe('runs while this tab is open');
  });
});

describe('consent before the first save (U8) and the exact createTask input', () => {
  it('shows the prompt and the queries verbatim, the hosts (none), the daily bound; schedule it calls createTask with the form’s exact input and lands on /schedule', async () => {
    const ledger = installLedger();
    await mount('/schedule/new?template=spend-review');
    expect(q('enable-consent')).toBeNull();
    await click(must('schedule-save'));
    expect(vi.mocked(createTask)).not.toHaveBeenCalled();
    const consent = must('enable-consent');
    expect(consent.querySelector('h3')?.textContent).toBe('what will run');
    expect(must('consent-prompt-0').textContent).toBe(TEMPLATE_PROMPTS.spend);
    const queries = [...must('consent-queries-0').querySelectorAll('code')].map((code) => code.textContent);
    expect(queries).toEqual([...LEDGER_QUERIES]);
    // INVERTED by D-PR4-20 (TASK-20261010-host-broker PR-4, D11): a tool-free ask step's call row reads
    // *may call: none — it only reads data*. Was: expect(must('consent-hosts-0').textContent).toBe(CONSENT_ROWS.noHosts);
    expect(must('consent-hosts-0').textContent).toBe('none — it only reads data');
    expect(must('consent-cost').textContent).toBe(`daily cost: ${CONSENT_ROWS.dailyBound(1)}`);
    await click(must('consent-enable'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(vi.mocked(createTask)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createTask).mock.calls[0]?.[0]).toEqual({
      title: TEMPLATE_TITLES['spend-review'],
      steps: [{ kind: 'app-think', appId: ledger, prompt: TEMPLATE_PROMPTS.spend, context: { sql: [...LEDGER_QUERIES], maxRows: 50 } }],
      spec: { kind: 'weekly', days: ['fri'], time: '17:00', tz: 'device' },
      missedPolicy: 'ask',
      alert: 'inbox',
      provenance: 'user',
    });
    const saved = db.listScheduledTasks();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.enabled).toBe(true);
    expect(saved[0]?.cron).toBe('0 17 * * 5');
  });

  it('not now returns to the form with nothing written', async () => {
    installLedger();
    await mount('/schedule/new?template=spend-review');
    await click(must('schedule-save'));
    await click(must('consent-not-now'));
    expect(q('enable-consent')).toBeNull();
    expect(q('schedule-save')).not.toBeNull();
    expect(db.listScheduledTasks()).toHaveLength(0);
  });

  it('a reminder-only schedule needs no consent: schedule it writes at once', async () => {
    await mount('/schedule/new?template=nudge');
    await click(must('schedule-save'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(q('enable-consent')).toBeNull();
    const saved = db.listScheduledTasks();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.steps).toEqual([{ kind: 'notify', title: 'nudge', body: 'time to check in' }]);
    expect(saved[0]?.alert).toBe('notification');
    expect(saved[0]?.missedPolicy).toBe('run-once');
  });

  it('a refused write is shown in words and the form stays', async () => {
    await mount('/schedule/new?template=nudge');
    vi.mocked(createTask).mockResolvedValueOnce({ ok: false, reason: 'the file is read-only here' });
    await click(must('schedule-save'));
    await settleUntil(() => q('save-error') !== null, 'the refusal');
    expect(must('save-error').textContent).toBe('the file is read-only here');
    expect(q('schedule-page')).toBeNull();
  });
});

describe('custom cron ↔ the chips', () => {
  it('custom starts from the checked preset’s compiled cron and reads it back; a typed preset-shaped cron derives the chips when the field is left', async () => {
    await mount('/schedule/new');
    await click(must('spec-kind-custom'));
    expect(input('spec-cron').value).toBe('0 9 * * *');
    expect(must('spec-cron-reads').textContent).toBe(WHEN.cronReadsAs('Every day at 9:00 AM'));
    await type(input('spec-cron'), '0 8 * * 1-5');
    expect(must('spec-cron-reads').textContent).toBe(WHEN.cronReadsAs('Weekdays at 8:00 AM'));
    expect(must('preview-next-line').textContent).toBe(nextLine('Weekdays at 8:00 AM'));
    expect(checked('custom')).toBe(true); // the chips derive on leaving the field, not mid-keystroke
    await blur(input('spec-cron'));
    expect(checked('weekly')).toBe(true);
    expect(input('spec-time').value).toBe('08:00');
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri']) expect(pressed(`spec-day-${day}`), day).toBe(true);
    expect(pressed('spec-day-sat')).toBe(false);
  });

  it('a cron no preset can say stays custom with the preview as the truth; an unreadable cron is refused and leaves the spec where it was', async () => {
    await mount('/schedule/new?template=nudge');
    await click(must('spec-kind-custom'));
    expect(input('spec-cron').value).toBe('0 20 * * *');
    await type(input('spec-cron'), '*/10 9-17 * * *');
    expect(must('spec-cron-reads').textContent).toBe('');
    expect(must('preview-next-line').textContent).toBe(nextLine('Custom (*/10 9-17 * * *)'));
    await blur(input('spec-cron'));
    expect(checked('custom')).toBe(true);
    await type(input('spec-cron'), 'not a cron');
    expect(must('spec-cron-invalid').textContent).toBe(WHEN.cronInvalid);
    expect(input('spec-cron').getAttribute('aria-invalid')).toBe('true');
    expect(must('preview-next-line').textContent).toBe(nextLine('Custom (*/10 9-17 * * *)'));
    expect((must('schedule-save') as HTMLButtonElement).disabled, 'the last readable cron still stands, so the save does too').toBe(false);
  });
});

describe('/schedule/:id', () => {
  async function seed(): Promise<ScheduledTask> {
    const result = await createTask({
      title: 'water the plants',
      steps: [{ kind: 'notify', title: 'plants', body: 'water them' }],
      spec: { kind: 'daily', time: '18:00', tz: 'device' },
      provenance: 'user',
    });
    if (!result.ok) throw new Error(result.reason);
    return result.task;
  }

  it('loads the schedule into the form and saves changes through updateTask, keeping it enabled', async () => {
    const task = await seed();
    vi.mocked(createTask).mockClear();
    await mount(`/schedule/${task.id}`);
    expect(input('schedule-title').value).toBe('water the plants');
    expect(checked('daily')).toBe(true);
    expect(input('spec-time').value).toBe('18:00');
    expect(input('step-0-body').value).toBe('water them');
    expect(must('schedule-save').textContent).toBe('save changes');
    await type(input('schedule-title'), 'water the ferns');
    await type(input('spec-time'), '07:30');
    await click(must('schedule-save'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    const saved = db.getScheduledTask(task.id);
    expect(saved?.title).toBe('water the ferns');
    expect(saved?.spec).toEqual({ kind: 'daily', time: '07:30', tz: 'device' });
    expect(saved?.cron).toBe('30 7 * * *');
    expect(saved?.enabled).toBe(true);
    expect(vi.mocked(createTask)).not.toHaveBeenCalled();
  });

  it('an unknown id is a named empty state with the way back', async () => {
    await mount('/schedule/does-not-exist');
    await settleUntil(() => q('schedule-back') !== null, 'the not-found state');
    expect(document.body.textContent).toContain('no such schedule');
  });

  it('an imported schedule shows the imported line and turns on only through the consent', async () => {
    const task = await seed();
    db.putScheduledTask({ ...task, enabled: false, provenance: 'imported' });
    delete (db.getScheduledTask(task.id) as { enabledAt?: string }).enabledAt;
    await mount(`/schedule/${task.id}`);
    expect(must('imported-note').textContent).toBe(imported.text);
    expect(must('schedule-save').textContent).toBe('schedule it');
    await click(must('schedule-save'));
    const consent = must('enable-consent');
    expect(consent.textContent).toContain(CONSENT_ROWS.remind('plants'));
    expect(must('consent-cost').textContent).toBe(`daily cost: ${CONSENT_ROWS.dailyBound(0)}`);
    expect(db.getScheduledTask(task.id)?.enabled).toBe(false);
    await click(must('consent-enable'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    const saved = db.getScheduledTask(task.id);
    expect(saved?.enabled).toBe(true);
    expect(saved?.provenance).toBe('imported');
  });
});

// =============================================================================================
// TASK-20261010-host-broker PR-4 — the editor's words and the task write authority (D-PR4-8,
// D-PR4-20; AC31, AC32). The chooser keeps the `<select>` and its pinned labels and gains ONE hint
// per kind (`STEPS.kindHint`); an *Ask <App>'s AI* step gains the tick *let it look things up* with
// its line, which replaces *which data?* while typed queries stay as starting context; a brain that
// cannot use tools for the app is said HERE first. The task-level control *changes it suggests:*
// (•) *wait for my OK* / (•) *make them on its own* sits under the steps when a step asks an app's
// AI (one app only), and an existing task's save goes through the consent when the choice moves to
// *make them on its own*, when an ARMED task's steps change (canonical JSON), or when its minimum
// interval gets SHORTER; a title, alert or missed-policy edit never disarms; *wait for my OK*
// disarms with no consent.
//
// Assumed (lane T-C questions): the hint `step-<i>-kind-hint`; the tick `step-<i>-tools` with its line
// `step-<i>-tools-line` and the brain line `step-<i>-tools-unavailable`; the control `changes-it-suggests`
// with the radios `changes-wait` / `changes-on-its-own`; the warning `armed-warning`; the consent's tick
// `consent-on-its-own` (enableConsent.test.tsx).
// =============================================================================================

const WARNING = 'changing what it does stops it making changes on its own — you’ll confirm again before saving';
const ASK_LEDGER = (appId: string, over: Partial<Extract<ScheduleStep, { kind: 'app-think' }>> = {}): ScheduleStep => ({ kind: 'app-think', appId, prompt: 'sum it', context: { maxRows: 50 }, ...over });

async function setSelect(el: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('PR-4 — the chooser’s hints (D-PR4-20; D10)', () => {
  it('ONE hint under the kind select, per kind, naming the app — and the select and its labels are unchanged', async () => {
    const ledger = installLedger();
    await mount(`/schedule/new?app=${ledger}`);
    expect([...select('step-0-kind').options].map((option) => option.textContent)).toEqual(['remind me', 'ask this app’s AI', 'run this app']);
    expect(must('step-0-kind-hint').textContent).toBe(STEPS.kindHint('app-think', 'Ledger'));
    expect(must('step-0-kind-hint').textContent).toBe('Ledger’s AI answers from Ledger’s data — Ledger doesn’t need to open');
    await setSelect(select('step-0-kind'), 'app-run');
    expect(must('step-0-kind-hint').textContent).toBe('Ledger itself does the job, the way it was built — in the app if it’s open, out of sight if not');
    expect(must('step-0-kind-hint').textContent).not.toMatch(/\b(routine|background)\b/);
  });
});

describe('PR-4 — *let it look things up* (D-PR4-15, D-PR4-20; D10, D13)', () => {
  // INVERTED by PR-4 Gate-5 U3 (ADR-0076 §9: GET-only is not read-only — the orchestrator's decision, reversal word "read-only").
  // Was: const TOOLS_LINE = 'it can choose its own questions over Ledger’s data and what you let it read from other apps, and fetch from Ledger’s connections — read only · up to 10 AI calls each time';
  const TOOLS_LINE = 'it can choose its own questions over Ledger’s data and what you let it read from other apps, and ask Ledger’s connections (it only asks, never posts) · up to 10 AI calls each time';

  it('an ask step offers the tick OFF; ticked, its line REPLACES *which data?*', async () => {
    const ledger = installLedger();
    await mount(`/schedule/new?app=${ledger}`);
    const toolsTick = input('step-0-tools');
    expect(toolsTick.type).toBe('checkbox');
    expect(toolsTick.checked).toBe(false);
    expect(must('step-0').textContent).toContain('let it look things up');
    expect(must('step-0').querySelector(`[role="radiogroup"][aria-label="${STEPS.data}"]`), 'which data? is there while the tick is off').not.toBeNull();
    await click(toolsTick);
    expect(input('step-0-tools').checked).toBe(true);
    expect(must('step-0-tools-line').textContent).toBe(TOOLS_LINE);
    // PR-4 Gate-5 U3's negative: the line never promises what the host does not make.
    expect(must('step-0-tools-line').textContent).not.toMatch(/read[\s-]only/i);
    expect(must('step-0-tools-line').textContent).not.toMatch(/can[’']t send/i);
    expect(must('step-0').querySelector(`[role="radiogroup"][aria-label="${STEPS.data}"]`), 'which data? is replaced by the line').toBeNull();
    expect(q('step-0-data-tables')).toBeNull();
  });

  it('a reminder or a run step has no such tick (negative)', async () => {
    installWeather();
    await mount('/schedule/new?template=morning-weather');
    expect(q('step-0-tools')).toBeNull();
    expect(q('step-1-tools')).toBeNull();
  });

  it('typed queries stay as starting context: the save carries them AND tools: true, and the consent says it starts from them', async () => {
    const ledger = installLedger();
    await mount('/schedule/new?template=spend-review');
    await click(input('step-0-tools'));
    await click(must('schedule-save'));
    expect(must('consent-step-0').textContent).toContain('starts from these; may read more of Ledger’s data itself');
    await click(must('consent-enable'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect((vi.mocked(createTask).mock.calls[0]?.[0] as { steps: unknown[] }).steps).toEqual([
      { kind: 'app-think', appId: ledger, prompt: TEMPLATE_PROMPTS.spend, context: { sql: [...LEDGER_QUERIES], maxRows: 50 }, tools: true },
    ]);
  });

  it('the cost line counts what a tools step may spend — ten AI calls a time', async () => {
    installLedger();
    await mount('/schedule/new?template=spend-review');
    expect(must('preview-cost').textContent).toContain('≈ 1 AI call a week');
    await click(input('step-0-tools'));
    expect(must('preview-cost').textContent).toContain('≈ 10 AI calls a week');
  });

  it('tools round-trips through draftsFromSteps / prepareSteps; a tool-free step stays tool-free (absent, never false)', () => {
    const withTools = [ASK_LEDGER('ledger', { tools: true })];
    const prepared = prepareSteps(draftsFromSteps(withTools));
    expect(prepared).toEqual({ ok: true, steps: withTools });
    const toolFree = [ASK_LEDGER('ledger')];
    const back = prepareSteps(draftsFromSteps(toolFree));
    expect(back).toEqual({ ok: true, steps: toolFree });
    expect(back.ok && 'tools' in (back.steps[0] as object), 'absent ≡ tool-free (omit-defaults)').toBe(false);
  });

  it('a brain that cannot use tools for this app is said HERE, first: *this brain will answer without looking things up*', async () => {
    const ledger = installLedger();
    modeStore.set('subscription');
    await mount(`/schedule/new?app=${ledger}`);
    await click(input('step-0-tools'));
    expect(must('step-0-tools-unavailable').textContent).toBe('this brain will answer without looking things up');
  });

  it('…and a keyed brain that can use them says nothing of the sort (negative twin)', async () => {
    const ledger = installLedger();
    db.setSecret('byok:anthropic', 'sk-test-key');
    byokKeyPresenceStore.set({ anthropic: true, openai: false });
    providerStore.set('anthropic');
    await mount(`/schedule/new?app=${ledger}`);
    await click(input('step-0-tools'));
    expect(q('step-0-tools-unavailable')).toBeNull();
  });
});

describe('PR-4 — *changes it suggests:* — the task-level control (D-PR4-8; D1)', () => {
  it('sits under the steps when a step asks ONE app’s AI: *wait for my OK* (checked) and *make them on its own*', async () => {
    const ledger = installLedger();
    await mount(`/schedule/new?app=${ledger}`);
    const control = must('changes-it-suggests');
    expect(control.textContent).toContain('changes it suggests:');
    expect(control.textContent).toContain('wait for my OK');
    expect(control.textContent).toContain('make them on its own');
    expect(input('changes-wait').checked, 'never seeded: a new schedule waits for your OK').toBe(true);
    expect(input('changes-on-its-own').checked).toBe(false);
    expect(must('steps-editor').compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING, 'under the steps').toBeTruthy();
  });

  it('NEGATIVE: no control for a reminder-only schedule, nor for one that asks TWO apps’ AI', async () => {
    await mount('/schedule/new?template=nudge');
    expect(q('changes-it-suggests')).toBeNull();
    installLedger();
    installStandup();
    await mount('/schedule/new?template=friday-review');
    expect(q('changes-it-suggests')).toBeNull();
  });

  it('a NEW schedule set to *make them on its own*: the consent opens with its tick pre-set to that choice, and schedule it arms the task', async () => {
    const ledger = installLedger();
    await mount('/schedule/new?template=spend-review');
    await click(input('changes-on-its-own'));
    await click(must('schedule-save'));
    expect((must('consent-on-its-own') as HTMLInputElement).checked, 'the tick carries the editor’s choice').toBe(true);
    await click(must('consent-enable'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    const saved = db.listScheduledTasks()[0];
    expect(saved?.writeAuthority).toMatchObject({ rowsPerRun: 200, armedVersion: db.getApp(ledger)?.currentVersion });
    expect(saved?.writeAuthority?.armedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('a NEW schedule left at *wait for my OK*: the tick is OFF and the task is saved without an authority; ticking it in the consent arms it', async () => {
    installLedger();
    await mount('/schedule/new?template=spend-review');
    await click(must('schedule-save'));
    expect((must('consent-on-its-own') as HTMLInputElement).checked).toBe(false);
    await click(must('consent-enable'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(db.listScheduledTasks()[0]?.writeAuthority).toBeUndefined();

    await mount('/schedule/new?template=spend-review');
    await click(must('schedule-save'));
    await click(must('consent-on-its-own'));
    await click(must('consent-enable'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(db.listScheduledTasks().filter((task) => task.writeAuthority !== undefined)).toHaveLength(1);
  });

  it('NEGATIVE: the ?suggestion= draft can never pre-set it — a proposal carrying an authority opens at *wait for my OK*', async () => {
    const ledger = installLedger();
    const proposal = {
      title: 'tidy',
      steps: [{ kind: 'app-think', appId: ledger, prompt: 'Tidy the categories.', context: { maxRows: 50 } }],
      spec: { kind: 'daily', time: '08:00', tz: 'device' },
      writeAuthority: { rowsPerRun: 200, armedAt: '2026-10-09T12:00:00.000Z', armedVersion: 1 },
    };
    await mount(newScheduleHref({ suggestion: JSON.stringify(proposal), app: ledger }));
    if (q('changes-it-suggests') !== null) expect(input('changes-wait').checked).toBe(true);
    expect(q('changes-on-its-own') === null || !input('changes-on-its-own').checked).toBe(true);
  });
});

describe('PR-4 — an EXISTING schedule: what goes through the consent, what disarms, what never does (D-PR4-8; D1)', () => {
  const ARMED_AT = '2026-10-08T09:00:00.000Z';

  async function seedArmed(over: Partial<ScheduledTask> = {}): Promise<{ task: ScheduledTask; ledger: string }> {
    const ledger = installLedger();
    const result = await createTask({ title: 'tidy ledger', steps: [ASK_LEDGER(ledger)], spec: { kind: 'daily', time: '18:00', tz: 'device' }, provenance: 'user' });
    if (!result.ok) throw new Error(result.reason);
    const armed = { ...result.task, writeAuthority: { rowsPerRun: 200, armedAt: ARMED_AT, armedVersion: db.getApp(ledger)!.currentVersion }, ...over } as ScheduledTask;
    db.putScheduledTask(armed);
    vi.mocked(createTask).mockClear();
    return { task: armed, ledger };
  }

  const authority = (id: string): unknown => db.getScheduledTask(id)?.writeAuthority;

  it('the control shows the task’s state: an armed task reads *make them on its own*', async () => {
    const { task } = await seedArmed();
    await mount(`/schedule/${task.id}`);
    expect(input('changes-on-its-own').checked).toBe(true);
    expect(input('changes-wait').checked).toBe(false);
    expect(q('armed-warning'), 'nothing changed yet — no warning').toBeNull();
  });

  it('a TITLE edit saves at once and never disarms', async () => {
    const { task } = await seedArmed();
    await mount(`/schedule/${task.id}`);
    await type(input('schedule-title'), 'tidy the ledger');
    expect(q('armed-warning')).toBeNull();
    await click(must('schedule-save'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(q('enable-consent')).toBeNull();
    expect(db.getScheduledTask(task.id)?.title).toBe('tidy the ledger');
    expect(authority(task.id)).toEqual(task.writeAuthority);
  });

  it('an ALERT or a MISSED-POLICY edit saves at once and never disarms', async () => {
    const { task } = await seedArmed();
    await mount(`/schedule/${task.id}`);
    await click(input('alert-notification'));
    await click(input('missed-skip'));
    await click(must('schedule-save'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(db.getScheduledTask(task.id)?.alert).toBe('notification');
    expect(db.getScheduledTask(task.id)?.missedPolicy).toBe('skip');
    expect(authority(task.id)).toEqual(task.writeAuthority);
  });

  it('NEGATIVE: a save that changes nothing — the editor sends steps on every save — never asks again and never disarms (canonical compare, never `steps !== undefined`)', async () => {
    const { task } = await seedArmed();
    await mount(`/schedule/${task.id}`);
    await click(must('schedule-save'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(q('enable-consent')).toBeNull();
    expect(authority(task.id)).toEqual(task.writeAuthority);
  });

  it('NEGATIVE: a prompt edited and put back is the same steps — no warning, no consent, still armed', async () => {
    const { task } = await seedArmed();
    await mount(`/schedule/${task.id}`);
    const prompt = must('step-0-prompt') as HTMLTextAreaElement;
    await type(prompt, 'sum it all');
    expect(must('armed-warning').textContent).toBe(WARNING);
    await type(prompt, 'sum it');
    expect(q('armed-warning')).toBeNull();
    await click(must('schedule-save'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(authority(task.id)).toEqual(task.writeAuthority);
  });

  it('a STEPS change on an armed task warns above save, then goes through the consent with the tick pre-set; schedule it keeps it armed with the new steps', async () => {
    const { task } = await seedArmed();
    await mount(`/schedule/${task.id}`);
    await type(must('step-0-prompt') as HTMLTextAreaElement, 'sum it and tidy the categories');
    const warning = must('armed-warning');
    expect(warning.textContent).toBe(WARNING);
    expect(warning.compareDocumentPosition(must('schedule-save')) & Node.DOCUMENT_POSITION_FOLLOWING, 'the warning sits above save').toBeTruthy();
    await click(must('schedule-save'));
    expect((must('consent-on-its-own') as HTMLInputElement).checked).toBe(true);
    expect(db.getScheduledTask(task.id)?.steps, 'nothing saved before the consent').toEqual(task.steps);
    await click(must('consent-enable'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    const saved = db.getScheduledTask(task.id);
    expect(saved?.steps[0]).toMatchObject({ prompt: 'sum it and tidy the categories' });
    expect(saved?.writeAuthority).toMatchObject({ rowsPerRun: 200 });
  });

  it('…the consent’s *not now* saves nothing; unticking there saves the steps DISARMED', async () => {
    const { task } = await seedArmed();
    await mount(`/schedule/${task.id}`);
    await type(must('step-0-prompt') as HTMLTextAreaElement, 'sum it and tidy the categories');
    await click(must('schedule-save'));
    await click(must('consent-not-now'));
    expect(db.getScheduledTask(task.id)?.steps).toEqual(task.steps);
    expect(authority(task.id)).toEqual(task.writeAuthority);
    await click(must('schedule-save'));
    await click(must('consent-on-its-own'));
    await click(must('consent-enable'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(db.getScheduledTask(task.id)?.steps[0]).toMatchObject({ prompt: 'sum it and tidy the categories' });
    expect(authority(task.id)).toBeUndefined();
  });

  it('a SHORTER minimum interval on an armed task warns and goes through the consent', async () => {
    const { task } = await seedArmed();
    await mount(`/schedule/${task.id}`);
    await click(must('spec-kind-every'));
    expect(must('armed-warning').textContent).toBe(WARNING);
    await click(must('schedule-save'));
    expect(q('enable-consent')).not.toBeNull();
  });

  it('NEGATIVE: a LONGER interval does not widen it — no warning, no consent, still armed', async () => {
    const { task } = await seedArmed({ spec: { kind: 'every', n: 1, unit: 'hours', tz: 'device' }, cron: '0 * * * *' });
    await mount(`/schedule/${task.id}`);
    await click(must('spec-kind-daily'));
    expect(q('armed-warning')).toBeNull();
    await click(must('schedule-save'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(q('enable-consent')).toBeNull();
    expect(authority(task.id)).toEqual(task.writeAuthority);
  });

  it('*wait for my OK* disarms on save with no consent', async () => {
    const { task } = await seedArmed();
    await mount(`/schedule/${task.id}`);
    await click(input('changes-wait'));
    await click(must('schedule-save'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(q('enable-consent')).toBeNull();
    expect(authority(task.id)).toBeUndefined();
  });

  it('an UNARMED existing task moved to *make them on its own* goes through the consent (tick pre-set), and schedule it arms it', async () => {
    const ledger = installLedger();
    const result = await createTask({ title: 'tidy ledger', steps: [ASK_LEDGER(ledger)], spec: { kind: 'daily', time: '18:00', tz: 'device' }, provenance: 'user' });
    if (!result.ok) throw new Error(result.reason);
    await mount(`/schedule/${result.task.id}`);
    expect(input('changes-wait').checked).toBe(true);
    await click(input('changes-on-its-own'));
    await click(must('schedule-save'));
    expect((must('consent-on-its-own') as HTMLInputElement).checked).toBe(true);
    expect(authority(result.task.id), 'nothing armed before the consent').toBeUndefined();
    await click(must('consent-enable'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(authority(result.task.id)).toMatchObject({ rowsPerRun: 200, armedVersion: db.getApp(ledger)?.currentVersion });
  });

  it('NEGATIVE: a task disarmed by an import or an update reads *wait for my OK* — the trace never re-seeds the choice', async () => {
    const ledger = installLedger();
    const result = await createTask({ title: 'tidy ledger', steps: [ASK_LEDGER(ledger)], spec: { kind: 'daily', time: '18:00', tz: 'device' }, provenance: 'user' });
    if (!result.ok) throw new Error(result.reason);
    db.putScheduledTask({ ...result.task, disarmed: { reason: 'imported', at: '2026-10-09T10:00:00.000Z' } } as ScheduledTask);
    await mount(`/schedule/${result.task.id}`);
    expect(input('changes-wait').checked).toBe(true);
    expect(input('changes-on-its-own').checked).toBe(false);
  });
});

// =============================================================================================
// TASK-20261010-host-broker PR-4 Gate 5 — the editor's UI folds (U1, U5, U8, U9, U11, U13).
//
// U1: the editor's brain read is tri-state. `blocked` (the demo override, or BYOK with no key in the
// FILE — `keylessBrainGate(db, appId, chatBrainRoute(db, appId)) !== undefined`): `brainBlocked.text`
// with a link to Settings under EVERY ask step, ticked or not, and on the consent; `no-tools`
// (subscription, …): `STEPS.toolsUnavailable` under a ticked step, as before; a keyed brain: neither.
// U5: an armed schedule edited out of one-app says so in the warning slot (`CHANGES_CONTROL.armedLost`).
// U8: a disarmed schedule opens with the disarm line and `CHANGES_CONTROL.disarmedHint`.
// U9: an existing schedule whose ask step GAINS *let it look things up* saves through the consent.
// U11: the tick and the kind select are described by the lines that explain them.
// U13: an arming refused after a create reads `ACTIONS.savedButWaits(refusal)`.
//
// Assumed: the blocked line `step-<i>-brain-blocked` holding a link to `/settings`; the disarm line a
// `role="note"` above the control.
// =============================================================================================

/** The text of every element an `aria-describedby` names, in order. */
const describedBy = (el: HTMLElement): string[] =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? `<missing #${id}>`);

describe('PR-4 Gate-5 U1 — a brain that cannot answer an ask step here is said under EVERY ask step, first', () => {
  const blockedLine = (index: number): HTMLElement => must(`step-${index}-brain-blocked`);

  async function expectBlocked(): Promise<void> {
    // unticked: said already — a tool-free ask step is refused just the same
    expect(input('step-0-tools').checked).toBe(false);
    expect(blockedLine(0).textContent).toContain(brainBlocked.text);
    const link = blockedLine(0).querySelector<HTMLAnchorElement>('a');
    expect(link?.textContent).toBe(brainBlocked.action);
    expect(link?.getAttribute('href')).toBe('/settings');
    expect(q('step-0-tools-unavailable'), 'never the no-tools line: this brain does not answer at all').toBeNull();
    // ticked: still the blocked line, still not the no-tools line
    await click(input('step-0-tools'));
    expect(blockedLine(0).textContent).toContain(brainBlocked.text);
    expect(q('step-0-tools-unavailable')).toBeNull();
  }

  it('BYOK with a keyed provider and NO key in the file: blocked', async () => {
    const ledger = installLedger();
    modeStore.set('byok');
    providerStore.set('anthropic');
    await mount(`/schedule/new?app=${ledger}`);
    await expectBlocked();
  });

  it('the demo override (the in-browser brain asked for where it cannot run): blocked', async () => {
    const ledger = installLedger();
    db.setSecret('byok:anthropic', 'sk-test-key');
    providerStore.set('anthropic');
    webllmFlagStore.set(true);
    webgpuStore.set('no');
    await mount(`/schedule/new?app=${ledger}`);
    await expectBlocked();
  });

  it('every ask step of a blocked app says it — the second one too', async () => {
    installLedger();
    installStandup();
    providerStore.set('anthropic');
    await mount('/schedule/new?template=friday-review');
    expect(blockedLine(0).textContent).toContain(brainBlocked.text);
    expect(blockedLine(1).textContent).toContain(brainBlocked.text);
  });

  it('…and the consent says it on the step too (`blockedApps`)', async () => {
    installLedger();
    providerStore.set('anthropic');
    await mount('/schedule/new?template=spend-review');
    await click(must('schedule-save'));
    expect(must('consent-step-0').textContent).toContain(brainBlocked.text);
  });

  it('the subscription twin keeps today’s line: *this brain will answer without looking things up* under a ticked step — never the blocked line', async () => {
    const ledger = installLedger();
    modeStore.set('subscription');
    await mount(`/schedule/new?app=${ledger}`);
    expect(q('step-0-brain-blocked')).toBeNull();
    await click(input('step-0-tools'));
    expect(must('step-0-tools-unavailable').textContent).toBe(STEPS.toolsUnavailable);
    expect(q('step-0-brain-blocked')).toBeNull();
  });

  it('NEGATIVE: a keyed brain says neither, ticked or not, here or on the consent', async () => {
    installLedger();
    db.setSecret('byok:anthropic', 'sk-test-key');
    byokKeyPresenceStore.set({ anthropic: true, openai: false });
    providerStore.set('anthropic');
    await mount('/schedule/new?template=spend-review');
    expect(q('step-0-brain-blocked')).toBeNull();
    await click(input('step-0-tools'));
    expect(q('step-0-brain-blocked')).toBeNull();
    expect(q('step-0-tools-unavailable')).toBeNull();
    await click(must('schedule-save'));
    expect(must('enable-consent').textContent).not.toContain(brainBlocked.text);
  });
});

describe('PR-4 Gate-5 U11 — the new controls are described by the lines that explain them', () => {
  it('ticked, *let it look things up* is described by its tools line', async () => {
    const ledger = installLedger();
    await mount(`/schedule/new?app=${ledger}`);
    await click(input('step-0-tools'));
    const toolsLine = must('step-0-tools-line');
    expect(toolsLine.id, 'the line has an id to be named by').not.toBe('');
    expect((input('step-0-tools').getAttribute('aria-describedby') ?? '').split(/\s+/)).toContain(toolsLine.id);
    expect(describedBy(input('step-0-tools'))).toContain(toolsLine.textContent);
  });

  it('…and by the no-tools line too, where the brain cannot look things up', async () => {
    const ledger = installLedger();
    modeStore.set('subscription');
    await mount(`/schedule/new?app=${ledger}`);
    await click(input('step-0-tools'));
    const lines = describedBy(input('step-0-tools'));
    expect(lines).toContain(must('step-0-tools-line').textContent);
    expect(lines).toContain(STEPS.toolsUnavailable);
  });

  it('every id the tick names resolves — unticked, it names no line that is not there', async () => {
    const ledger = installLedger();
    await mount(`/schedule/new?app=${ledger}`);
    expect(describedBy(input('step-0-tools')).filter((line) => line.startsWith('<missing'))).toEqual([]);
  });

  it('the kind select is described by its one hint', async () => {
    const ledger = installLedger();
    await mount(`/schedule/new?app=${ledger}`);
    expect(describedBy(select('step-0-kind'))).toContain(STEPS.kindHint('app-think', 'Ledger'));
  });
});

describe('PR-4 Gate-5 U5, U8, U9, U13 — an existing schedule’s authority and look-ups, said and confirmed', () => {
  const ARMED_AT = '2026-10-08T09:00:00.000Z';

  async function seed(over: Partial<ScheduledTask> = {}, step: Partial<Extract<ScheduleStep, { kind: 'app-think' }>> = {}): Promise<{ task: ScheduledTask; ledger: string }> {
    const ledger = installLedger();
    const result = await createTask({ title: 'tidy ledger', steps: [ASK_LEDGER(ledger, step)], spec: { kind: 'daily', time: '18:00', tz: 'device' }, provenance: 'user' });
    if (!result.ok) throw new Error(result.reason);
    const task = { ...result.task, ...over } as ScheduledTask;
    db.putScheduledTask(task);
    vi.mocked(createTask).mockClear();
    return { task, ledger };
  }

  const armedOver = (ledgerVersion: number): Partial<ScheduledTask> => ({ writeAuthority: { rowsPerRun: 200, armedAt: ARMED_AT, armedVersion: ledgerVersion } }) as Partial<ScheduledTask>;

  it('U5: an armed schedule edited out of one-app (a *run* step of another app added) says it stops making changes on its own; the save leaves no authority', async () => {
    const weather = installWeather();
    const ledger = installLedger();
    const result = await createTask({ title: 'tidy ledger', steps: [ASK_LEDGER(ledger)], spec: { kind: 'daily', time: '18:00', tz: 'device' }, provenance: 'user' });
    if (!result.ok) throw new Error(result.reason);
    db.putScheduledTask({ ...result.task, ...armedOver(db.getApp(ledger)!.currentVersion) } as ScheduledTask);
    await mount(`/schedule/${result.task.id}`);
    expect(q('armed-warning'), 'nothing changed yet').toBeNull();
    await click(must('step-add'));
    await setSelect(select('step-1-kind'), 'app-run');
    await setSelect(select('step-1-app'), weather);
    expect(q('changes-it-suggests'), 'two apps: the control is not offered').toBeNull();
    const warning = must('armed-warning');
    expect(warning.textContent).toContain(CHANGES_CONTROL.armedLost);
    expect(warning.compareDocumentPosition(must('schedule-save')) & Node.DOCUMENT_POSITION_FOLLOWING, 'above save').toBeTruthy();
    await click(must('schedule-save'));
    if (q('enable-consent') !== null) await click(must('consent-enable'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(db.getScheduledTask(result.task.id)?.steps).toHaveLength(2);
    expect(db.getScheduledTask(result.task.id)?.writeAuthority).toBeUndefined();
  });

  it('U5 NEGATIVE: an UNARMED schedule edited the same way shows no such warning', async () => {
    const weather = installWeather();
    const { task } = await seed();
    await mount(`/schedule/${task.id}`);
    await click(must('step-add'));
    await setSelect(select('step-1-kind'), 'app-run');
    await setSelect(select('step-1-app'), weather);
    expect(q('armed-warning')).toBeNull();
  });

  it.each(['app-updated', 'imported'] as const)('U8: a schedule disarmed (%s) opens with the disarm line and the way out, above the control; save clears the trace', async (reason) => {
    const { task } = await seed({ disarmed: { reason, at: '2026-10-09T10:00:00.000Z' } } as Partial<ScheduledTask>);
    await mount(`/schedule/${task.id}`);
    const note = [...document.body.querySelectorAll<HTMLElement>('[role="note"]')].find((el) => el.textContent?.includes(disarmed(reason).text));
    expect(note, 'the disarm line is a role=note').toBeDefined();
    expect(must('schedule-editor').textContent).toContain(CHANGES_CONTROL.disarmedHint);
    expect(CHANGES_CONTROL.disarmedHint).toBe('save to keep it waiting for your OK, or choose make them on its own');
    expect(note!.compareDocumentPosition(must('changes-it-suggests')) & Node.DOCUMENT_POSITION_FOLLOWING, 'above the control').toBeTruthy();
    expect(input('changes-wait').checked, 'the trace never re-seeds the choice').toBe(true);
    await click(must('schedule-save'));
    if (q('enable-consent') !== null) await click(must('consent-enable'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(db.getScheduledTask(task.id)?.disarmed, 'the user reviewed it — the trace is gone').toBeUndefined();
    expect(db.getScheduledTask(task.id)?.writeAuthority, 'saving at *wait for my OK* never arms').toBeUndefined();
  });

  it('U8 NEGATIVE: a schedule never disarmed opens with no disarm line', async () => {
    const { task } = await seed();
    await mount(`/schedule/${task.id}`);
    expect(must('schedule-editor').textContent).not.toContain('no longer makes changes on its own');
    expect(must('schedule-editor').textContent).not.toContain(CHANGES_CONTROL.disarmedHint);
  });

  /** An approved connection the look-up tool can reach — named *Bank* by its provider. */
  function approveBank(appId: string): void {
    db.putDeclaredConnection(
      appId,
      'bank',
      {
        slot: 'bank',
        kind: 'api_key',
        provider: { name: 'Bank' },
        fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
        request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
        declaredApiHosts: ['api.bank.example'],
      },
      'inference',
    );
    db.approveConnection(appId, 'bank');
  }

  it('U9: an existing UNARMED schedule whose ask step GAINS *let it look things up* saves through the consent, naming the connections; *not now* writes nothing', async () => {
    const { task, ledger } = await seed();
    approveBank(ledger);
    expect(lookUpNamesByApp(db, [ledger])[ledger], 'precondition: the tool can reach Bank').toEqual(['Bank']);
    await mount(`/schedule/${task.id}`);
    await click(input('step-0-tools'));
    await click(must('schedule-save'));
    expect(q('enable-consent'), 'the consent opens — the 10× cost and the connections are confirmed').not.toBeNull();
    expect(must('consent-lookups-0').textContent).toContain('Bank');
    expect(must('consent-cost').textContent).toContain('look-ups each time');
    expect(db.getScheduledTask(task.id)?.steps, 'nothing saved before the consent').toEqual(task.steps);
    await click(must('consent-not-now'));
    expect(db.getScheduledTask(task.id)?.steps).toEqual(task.steps);
    await click(must('schedule-save'));
    await click(must('consent-enable'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(db.getScheduledTask(task.id)?.steps[0]).toMatchObject({ tools: true });
  });

  it('U9 NEGATIVE: a schedule that already looked things up and keeps doing so saves a title edit at once — no consent', async () => {
    const { task } = await seed({}, { tools: true });
    await mount(`/schedule/${task.id}`);
    await type(input('schedule-title'), 'tidy the ledger');
    await click(must('schedule-save'));
    await settleUntil(() => q('schedule-page') !== null, 'navigation to /schedule');
    expect(q('enable-consent')).toBeNull();
    expect(db.getScheduledTask(task.id)?.title).toBe('tidy the ledger');
  });

  it('U13: an arming refused after the create says the schedule WAS saved and waits — `ACTIONS.savedButWaits(refusal)`; the schedule is there, unarmed', async () => {
    installLedger();
    const refusal = 'app "ledger" is not installed in this file';
    vi.mocked(armTask).mockResolvedValueOnce({ ok: false, reason: refusal } as Awaited<ReturnType<typeof armTask>>);
    await mount('/schedule/new?template=spend-review');
    await click(input('changes-on-its-own'));
    await click(must('schedule-save'));
    await click(must('consent-enable'));
    await settleUntil(() => q('save-error') !== null, 'the refusal line');
    expect(vi.mocked(armTask)).toHaveBeenCalledTimes(1);
    expect(must('save-error').textContent).toBe(ACTIONS.savedButWaits(refusal));
    expect(must('save-error').textContent).not.toBe(refusal);
    const saved = db.listScheduledTasks();
    expect(saved, 'the schedule was written').toHaveLength(1);
    expect(saved[0]?.writeAuthority).toBeUndefined();
  });
});
