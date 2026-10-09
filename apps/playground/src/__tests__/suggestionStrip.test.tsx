// suggestionStrip.test.tsx — TASK-20261009-scheduling-framework P3 (ADR-0074 §4; design F2): the
// run header's suggestion STRIP. It renders the pending suggestion for its app — "<app> suggests:
// <when>", the steps in words — with three acts and never a modal: *schedule it* opens the ONE
// consent surface inside the strip, and the user's act there writes through the one writer
// (provenance `app`, the sender as owner) and says when it next runs with *open*; *not now*
// records the decline (the second mutes the app and says so); *stop suggestions from this app*
// mutes at once. Nothing runs, and nothing is written, until the consent said so.
//
// The real memory user db and the real intake (`scheduleRequest.ts`), mounted the harness's way.

import { act } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import type { ScheduleProposal, ScheduleStep } from '@snugprotocol/protocol';

import { CONSENT, SUGGESTION_ACTIONS, SUGGESTION_OUTCOME, stepWords, suggestionStrip } from '../schedule/copy.js';
import { __setPageClockForTests } from '../schedule/pageModel.js';
import { __resetSchedulerForTests } from '../schedule/scheduler.js';
import {
  SCHEDULE_REQUEST_EVENT,
  SCHEDULE_REQUEST_MIN_GAP_MS,
  __resetScheduleRequestsForTests,
  __setScheduleRequestDepsForTests,
  consumeScheduleRequest,
  pendingSuggestionFor,
} from '../schedule/scheduleRequest.js';
import { SuggestionStrip, suggestionStepsLine } from '../schedule/SuggestionStrip.js';
import { installTestUserDb } from './userdbTestHelper.js';
import { click, mount, settle, unmount } from './scheduleUiHarness.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Friday 2026-10-09 12:05Z — a daily 07:00 UTC is tomorrow morning. */
const NOW = Date.parse('2026-10-09T12:05:00.000Z');

let db: UserDb;
let weather: string;
let clock: { now: number };

const proposal = (over: Partial<ScheduleProposal> = {}): ScheduleProposal => ({
  title: 'morning weather',
  steps: [{ kind: 'app-run', appId: weather }, { kind: 'notify', title: 'weather', body: 'your call for the day' }],
  spec: { kind: 'daily', time: '07:00', tz: 'UTC' },
  ...over,
});

/** An app's request, delivered inside act — the strip subscribes to the store the intake writes. */
async function suggest(over: Partial<ScheduleProposal> = {}, generation = 0): Promise<string> {
  let decision = '';
  await act(async () => {
    decision = await consumeScheduleRequest({ appId: weather, generation, event: SCHEDULE_REQUEST_EVENT, data: proposal(over) });
  });
  return decision;
}

const q = (c: HTMLElement, testId: string): HTMLElement | null => c.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const must = (c: HTMLElement, testId: string): HTMLElement => {
  const el = q(c, testId);
  if (el === null) throw new Error(`missing [data-testid="${testId}"]`);
  return el;
};

function render(): HTMLDivElement {
  return mount(
    <MemoryRouter>
      <SuggestionStrip appId={weather} />
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  __resetSchedulerForTests();
  __resetScheduleRequestsForTests();
  __setPageClockForTests(() => new Date(NOW));
  clock = { now: NOW };
  db = await installTestUserDb();
  weather = db.installApp({ displayName: 'Should I?', html: '<!doctype html><title>w</title>', installSource: 'starter:weather' }).appId;
  __setScheduleRequestDepsForTests({ getDb: () => Promise.resolve(db), now: () => clock.now, noSuggestions: () => false });
});

afterEach(() => {
  unmount();
  __resetScheduleRequestsForTests();
  __resetSchedulerForTests();
  __setPageClockForTests();
  vi.useRealTimers();
});

describe('the strip renders the pending suggestion', () => {
  it('renders nothing with nothing pending, then the strip — the note family, the app’s name, the when, the steps in words, three acts', async () => {
    const c = render();
    expect(q(c, 'schedule-suggestion')).toBeNull();
    await suggest();
    await settle();
    const strip = must(c, 'schedule-suggestion');
    expect(strip.className).toBe('connection-note is-strip');
    expect(strip.getAttribute('role')).toBe('status');
    expect(must(c, 'schedule-suggestion-title').textContent).toBe(suggestionStrip('Should I?', 'Every day at 7:00 AM'));
    expect(must(c, 'schedule-suggestion-steps').textContent).toBe('run Should I? · remind me: weather — your call for the day');
    expect(must(c, 'schedule-suggestion-accept').textContent).toBe(SUGGESTION_ACTIONS.accept);
    expect(must(c, 'schedule-suggestion-decline').textContent).toBe(SUGGESTION_ACTIONS.decline);
    expect(must(c, 'schedule-suggestion-mute').textContent).toBe(SUGGESTION_ACTIONS.mute);
    expect(c.querySelector('[role="dialog"]'), 'never a modal').toBeNull();
    expect(db.listScheduledTasks()).toHaveLength(0);
  });

  it('suggestionStepsLine is copy.stepWords per step, joined — the strip’s one line leaves a run step’s input out (M6)', () => {
    const steps: ScheduleStep[] = [
      { kind: 'app-think', appId: 'x', prompt: 'Sum it', context: { maxRows: 5 } },
      { kind: 'app-run', appId: 'x', input: { fetch: true } },
    ];
    expect(suggestionStepsLine(steps, 'Ledger')).toBe('ask Ledger’s AI: Sum it · run Ledger');
    expect(suggestionStepsLine(steps, 'Ledger')).toBe(steps.map((step) => stepWords(step, 'Ledger')).join(' · '));
  });
});

describe('schedule it → the consent surface → the one writer', () => {
  it('shows the input and the hosts, then creates the task ENABLED with provenance app and the sender as owner, and says when it next runs', async () => {
    const c = render();
    await suggest();
    await settle();
    await click(must(c, 'schedule-suggestion-accept'));
    expect(db.listScheduledTasks(), 'opening the consent writes nothing').toHaveLength(0);
    const consent = must(c, 'enable-consent');
    expect(consent.querySelector('h3')?.textContent).toBe(CONSENT.heading);
    expect(must(c, 'consent-step-0').textContent).toContain('run Should I?');
    expect(must(c, 'consent-step-1').textContent).toContain('remind me: weather');

    await click(must(c, 'consent-enable'));
    const tasks = db.listScheduledTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'morning weather', enabled: true, provenance: 'app', ownerAppId: weather, cron: '0 7 * * *' });
    expect(pendingSuggestionFor(weather)).toBeUndefined();
    expect(q(c, 'schedule-suggestion')).toBeNull();
    const outcome = must(c, 'schedule-suggestion-outcome');
    expect(outcome.dataset.outcome).toBe('scheduled');
    expect(outcome.textContent).toContain(SUGGESTION_OUTCOME.scheduled('Sat, Oct 10, 7:00 AM UTC'));
    expect(must(c, 'schedule-suggestion-open').getAttribute('href')).toBe(`/schedule/${tasks[0]?.id}`);
  });

  it('not now on the consent keeps the suggestion and the acts', async () => {
    const c = render();
    await suggest();
    await settle();
    await click(must(c, 'schedule-suggestion-accept'));
    await click(must(c, 'consent-not-now'));
    expect(q(c, 'enable-consent')).toBeNull();
    expect(q(c, 'schedule-suggestion-accept')).not.toBeNull();
    expect(pendingSuggestionFor(weather)).toBeDefined();
    expect(db.listScheduledTasks()).toHaveLength(0);
  });

  it('a refused write is shown on the consent in words; nothing is written', async () => {
    const c = render();
    await suggest({ spec: { kind: 'every', n: 5, unit: 'minutes', tz: 'UTC' } });
    await settle();
    await click(must(c, 'schedule-suggestion-accept'));
    await click(must(c, 'consent-enable'));
    expect(must(c, 'consent-error').textContent).toContain('too often');
    expect(db.listScheduledTasks()).toHaveLength(0);
  });
});

describe('not now and stop suggestions', () => {
  it('not now records the decline and says so; a second decline (another suggestion) mutes the app and says so', async () => {
    const c = render();
    await suggest();
    await settle();
    await click(must(c, 'schedule-suggestion-decline'));
    expect(db.listScheduleDeclines(weather)).toHaveLength(1);
    expect(db.isScheduleMuted(weather)).toBe(false);
    expect(must(c, 'schedule-suggestion-outcome').textContent).toBe(SUGGESTION_OUTCOME.declined);
    expect(q(c, 'schedule-suggestion')).toBeNull();

    clock.now += SCHEDULE_REQUEST_MIN_GAP_MS;
    expect(await suggest({ spec: { kind: 'daily', time: '08:00', tz: 'UTC' } })).toBe('accepted');
    await settle();
    expect(q(c, 'schedule-suggestion-outcome'), 'a new suggestion replaces the outcome line').toBeNull();
    await click(must(c, 'schedule-suggestion-decline'));
    expect(db.isScheduleMuted(weather)).toBe(true);
    expect(must(c, 'schedule-suggestion-outcome').textContent).toBe(SUGGESTION_OUTCOME.muted('Should I?'));
    expect(db.listScheduledTasks()).toHaveLength(0);
  });

  it('stop suggestions from this app mutes at once', async () => {
    const c = render();
    await suggest();
    await settle();
    await click(must(c, 'schedule-suggestion-mute'));
    expect(db.isScheduleMuted(weather)).toBe(true);
    expect(pendingSuggestionFor(weather)).toBeUndefined();
    expect(must(c, 'schedule-suggestion-outcome').dataset.outcome).toBe('muted');
    clock.now += SCHEDULE_REQUEST_MIN_GAP_MS;
    expect(await suggest({ spec: { kind: 'daily', time: '08:00', tz: 'UTC' } })).toBe('muted');
    await settle();
    expect(q(c, 'schedule-suggestion')).toBeNull();
  });
});
