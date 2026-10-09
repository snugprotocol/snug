// scheduleRequest.test.tsx — TASK-20261009-scheduling-framework P3 (ADR-0074 §3–§4; Q3): an
// app's `app-event 'schedule-request'` becomes a pending suggestion — or is dropped, silently
// for the app and by name for this file. The negatives: another app named; a second pending for
// the same frame generation dropped; a declined hash never re-prompts; a muted app never
// prompts (two declines, *stop suggestions*, or the Settings switch); the rate limit; the cap of
// five app-proposed schedules; an unreadable request; an app not in the file. Then the acts:
// *schedule it* through the one writer (provenance `app`, the sender as owner), *not now*
// recording the decline, *stop suggestions* muting.
//
// The real memory user db; the clock and the Settings flag are the module's injected seams.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { proposalHash, type ScheduleProposal } from '@snugprotocol/protocol';

import { __resetSchedulerForTests } from '../schedule/scheduler.js';
import {
  APP_PROPOSED_TASK_CAP,
  SCHEDULE_REQUEST_EVENT,
  SCHEDULE_REQUEST_MAX_BYTES,
  SCHEDULE_REQUEST_MIN_GAP_MS,
  __rateLimitSizeForTests,
  __resetScheduleRequestsForTests,
  __setScheduleRequestDepsForTests,
  acceptSuggestion,
  appProposedCount,
  consumeScheduleRequest,
  declineSuggestion,
  muteSuggestions,
  pendingSuggestionFor,
  requestBytes,
  suggestionStore,
  useAppEventConsumer,
} from '../schedule/scheduleRequest.js';
import { installTestUserDb } from './userdbTestHelper.js';
import { makeTask } from './scheduleUiHarness.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-10-09T12:05:00.000Z');

let db: UserDb;
let weather: string;
let other: string;
let clock: { now: number };
let noSuggestions: boolean;

const proposal = (appId: string, over: Partial<ScheduleProposal> = {}): ScheduleProposal => ({
  title: 'morning weather',
  steps: [{ kind: 'app-run', appId }],
  spec: { kind: 'daily', time: '07:00', tz: 'device' },
  ...over,
});

const request = (appId: string, data: unknown, generation = 0): Promise<string> => consumeScheduleRequest({ appId, generation, event: SCHEDULE_REQUEST_EVENT, data });

beforeEach(async () => {
  __resetSchedulerForTests();
  __resetScheduleRequestsForTests();
  clock = { now: NOW };
  noSuggestions = false;
  db = await installTestUserDb();
  weather = db.installApp({ displayName: 'Should I?', html: '<!doctype html><title>w</title>', installSource: 'starter:weather' }).appId;
  other = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
  __setScheduleRequestDepsForTests({ getDb: () => Promise.resolve(db), now: () => clock.now, noSuggestions: () => noSuggestions });
});

afterEach(() => {
  __resetScheduleRequestsForTests();
  __resetSchedulerForTests();
});

describe('the intake — a request becomes a pending suggestion', () => {
  it('accepts a well-formed request from an installed app, once, with the app’s name and the hash', async () => {
    expect(await request(weather, proposal(weather))).toBe('accepted');
    const pending = pendingSuggestionFor(weather);
    expect(pending).toMatchObject({ appId: weather, appName: 'Should I?', generation: 0, hash: proposalHash(proposal(weather)) });
    expect(pending?.proposal).toEqual(proposal(weather));
    expect(db.listScheduledTasks(), 'a request never creates a task').toHaveLength(0);
  });

  it('ignores any other app event over the same seam', async () => {
    expect(await consumeScheduleRequest({ appId: weather, generation: 0, event: 'connection-event', data: proposal(weather) })).toBe('ignored');
    expect(pendingSuggestionFor(weather)).toBeUndefined();
  });

  it('refuses a step naming another app — an app may only suggest for itself', async () => {
    expect(await request(weather, proposal(weather, { steps: [{ kind: 'app-run', appId: other }] }))).toBe('other-app');
    expect(await request(weather, proposal(weather, { steps: [{ kind: 'app-run', appId: weather }, { kind: 'app-think', appId: other, prompt: 'x', context: { maxRows: 5 } }] }))).toBe('rate-limited');
    clock.now += SCHEDULE_REQUEST_MIN_GAP_MS;
    expect(await request(weather, proposal(weather, { steps: [{ kind: 'app-run', appId: weather }, { kind: 'app-think', appId: other, prompt: 'x', context: { maxRows: 5 } }] }))).toBe('other-app');
    expect(pendingSuggestionFor(weather)).toBeUndefined();
  });

  it('strict-parses: an unknown key, a missing field, a credential, a non-object or an oversize request is unreadable', async () => {
    const bad: unknown[] = [
      { ...proposal(weather), enabled: true },
      { title: 'x', spec: { kind: 'daily', time: '07:00', tz: 'device' } },
      proposal(weather, { steps: [{ kind: 'notify', title: 'key', body: 'sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' }] }),
      'every morning at 7',
      null,
      proposal(weather, { title: 'x'.repeat(81) }),
      { ...proposal(weather), steps: [{ kind: 'app-run', appId: weather, input: 'y'.repeat(20 * 1024) }] },
    ];
    for (const data of bad) {
      clock.now += SCHEDULE_REQUEST_MIN_GAP_MS;
      expect(await request(weather, data), JSON.stringify(data).slice(0, 60)).toBe('unreadable');
    }
    expect(pendingSuggestionFor(weather)).toBeUndefined();
  });

  it('refuses an app the file does not hold (a read-only starter, a shared preview)', async () => {
    expect(await request('starter--weather', proposal('starter--weather'))).toBe('unknown-app');
  });

  it('a second request from the same frame generation is dropped while one is pending; a new generation replaces it', async () => {
    expect(await request(weather, proposal(weather))).toBe('accepted');
    clock.now += SCHEDULE_REQUEST_MIN_GAP_MS;
    expect(await request(weather, proposal(weather, { title: 'again' }))).toBe('pending');
    expect(pendingSuggestionFor(weather)?.proposal.title).toBe('morning weather');
    expect(await request(weather, proposal(weather, { title: 'after a remount' }), 1)).toBe('accepted');
    expect(pendingSuggestionFor(weather)?.proposal.title).toBe('after a remount');
    expect(pendingSuggestionFor(weather)?.generation).toBe(1);
  });

  it('≤ 1 request a minute per instance — counted on every request, readable or not', async () => {
    expect(await request(weather, 'junk')).toBe('unreadable');
    expect(await request(weather, proposal(weather))).toBe('rate-limited');
    clock.now += SCHEDULE_REQUEST_MIN_GAP_MS - 1;
    expect(await request(weather, proposal(weather))).toBe('rate-limited');
    clock.now += 1;
    expect(await request(weather, proposal(weather))).toBe('accepted');
    // Another instance (a remounted frame) has its own minute — and, as a new generation, replaces the pending.
    expect(await request(weather, proposal(weather, { title: 'from the remount' }), 7)).toBe('accepted');
    expect(pendingSuggestionFor(weather)?.generation).toBe(7);
  });
});

describe('the guards after the parse (S11, M10, M11)', () => {
  it('S11: the request’s size is measured in UTF-8 BYTES, not characters — a request under the cap in characters but over it in bytes is unreadable', async () => {
    const wide = 'é'.repeat(SCHEDULE_REQUEST_MAX_BYTES / 2); // 8 192 characters, 16 384 bytes — plus the quotes
    expect(JSON.stringify(wide).length).toBeLessThan(SCHEDULE_REQUEST_MAX_BYTES);
    expect(requestBytes(wide)).toBe(SCHEDULE_REQUEST_MAX_BYTES + 2);
    expect(requestBytes(wide)! > SCHEDULE_REQUEST_MAX_BYTES).toBe(true);
    expect(requestBytes({ title: 'x' })).toBe(13);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(requestBytes(circular)).toBeUndefined();
    expect(await request(weather, wide)).toBe('unreadable');
  });

  it('M10: the rate limit is keyed by APP — one entry per app however many frame generations come and go (bounded), and a new generation starts its own minute', async () => {
    for (let generation = 0; generation < 50; generation += 1) {
      expect(await request(weather, proposal(weather), generation)).toBe('accepted'); // each remount is a new instance; it replaces the pending
    }
    expect(__rateLimitSizeForTests()).toBe(1);
    expect(await request(weather, proposal(weather), 49)).toBe('rate-limited'); // the same instance, inside its minute
    expect(await request(weather, proposal(weather), 50)).toBe('accepted'); // a new instance is not rate-limited by the old one
    await request(other, proposal(other), 0);
    expect(__rateLimitSizeForTests()).toBe(2);
  });

  it('M11: a throw after the parse — the file refusing a read, the db failing to open — is a named `failed` decision, never a throw out of the frame seam', async () => {
    const muted = vi.spyOn(db, 'isScheduleMuted').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await request(weather, proposal(weather))).toBe('failed');
    muted.mockRestore();
    expect(pendingSuggestionFor(weather)).toBeUndefined();
    __setScheduleRequestDepsForTests({ getDb: () => Promise.reject(new Error('no file')), now: () => clock.now, noSuggestions: () => false });
    clock.now += SCHEDULE_REQUEST_MIN_GAP_MS;
    expect(await request(weather, proposal(weather))).toBe('failed');
  });
});

describe('declines, mutes and the cap', () => {
  it('a declined hash never re-prompts, however the title is reworded', async () => {
    expect(await request(weather, proposal(weather))).toBe('accepted');
    expect(await declineSuggestion(weather)).toBe('declined');
    expect(pendingSuggestionFor(weather)).toBeUndefined();
    expect(db.listScheduleDeclines(weather)).toEqual([proposalHash(proposal(weather))]);
    clock.now += SCHEDULE_REQUEST_MIN_GAP_MS;
    expect(await request(weather, proposal(weather, { title: 'A different name' }))).toBe('declined');
    // A different SUGGESTION (another time) is a new ask.
    clock.now += SCHEDULE_REQUEST_MIN_GAP_MS;
    expect(await request(weather, proposal(weather, { spec: { kind: 'daily', time: '08:00', tz: 'device' } }))).toBe('accepted');
  });

  it('two declines mute the app; a muted app never prompts', async () => {
    expect(await request(weather, proposal(weather))).toBe('accepted');
    expect(await declineSuggestion(weather)).toBe('declined');
    clock.now += SCHEDULE_REQUEST_MIN_GAP_MS;
    expect(await request(weather, proposal(weather, { spec: { kind: 'daily', time: '08:00', tz: 'device' } }))).toBe('accepted');
    expect(await declineSuggestion(weather)).toBe('muted');
    expect(db.isScheduleMuted(weather)).toBe(true);
    clock.now += SCHEDULE_REQUEST_MIN_GAP_MS;
    expect(await request(weather, proposal(weather, { spec: { kind: 'daily', time: '09:00', tz: 'device' } }))).toBe('muted');
    // Another app is not muted by this app's declines.
    expect(await request(other, proposal(other))).toBe('accepted');
  });

  it('stop suggestions from this app mutes at once and clears the pending', async () => {
    expect(await request(weather, proposal(weather))).toBe('accepted');
    await muteSuggestions(weather);
    expect(pendingSuggestionFor(weather)).toBeUndefined();
    expect(db.isScheduleMuted(weather)).toBe(true);
    clock.now += SCHEDULE_REQUEST_MIN_GAP_MS;
    expect(await request(weather, proposal(weather))).toBe('muted');
  });

  it('the Settings switch mutes every app', async () => {
    noSuggestions = true;
    expect(await request(weather, proposal(weather))).toBe('muted');
    expect(await request(other, proposal(other))).toBe('muted');
    expect(db.isScheduleMuted(weather), 'the switch is a browser flag, not a row').toBe(false);
  });

  it('at most five app-proposed schedules per app — the user’s own and other apps’ do not count', async () => {
    for (let i = 0; i < APP_PROPOSED_TASK_CAP; i++) {
      db.putScheduledTask(makeTask({ id: `app-${i}`, provenance: 'app', ownerAppId: weather, steps: [{ kind: 'app-run', appId: weather }], appVersions: { [weather]: 1 } }));
    }
    db.putScheduledTask(makeTask({ id: 'mine', provenance: 'user', steps: [{ kind: 'app-run', appId: weather }], appVersions: { [weather]: 1 } }));
    db.putScheduledTask(makeTask({ id: 'theirs', provenance: 'app', ownerAppId: other, steps: [{ kind: 'app-run', appId: other }], appVersions: { [other]: 1 } }));
    expect(appProposedCount(db, weather)).toBe(APP_PROPOSED_TASK_CAP);
    expect(await request(weather, proposal(weather))).toBe('capped');
    expect(await request(other, proposal(other))).toBe('accepted');
  });
});

describe('schedule it — the one writer, after the consent', () => {
  it('acceptSuggestion creates the task ENABLED with provenance app and the sender as owner, and clears the pending', async () => {
    expect(await request(weather, proposal(weather))).toBe('accepted');
    const result = await acceptSuggestion(weather);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task).toMatchObject({ title: 'morning weather', enabled: true, provenance: 'app', ownerAppId: weather, cron: '0 7 * * *' });
    expect(result.task.steps).toEqual([{ kind: 'app-run', appId: weather }]);
    expect(db.listScheduledTasks()).toHaveLength(1);
    expect(pendingSuggestionFor(weather)).toBeUndefined();
  });

  it('a refused write keeps the pending so the strip can show the reason', async () => {
    expect(await request(weather, proposal(weather, { spec: { kind: 'every', n: 5, unit: 'minutes', tz: 'device' } }))).toBe('accepted');
    const result = await acceptSuggestion(weather);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('too often');
    expect(pendingSuggestionFor(weather)).toBeDefined();
    expect(db.listScheduledTasks()).toHaveLength(0);
  });

  it('with nothing pending the act refuses by name', async () => {
    expect(await acceptSuggestion(weather)).toEqual({ ok: false, reason: 'nothing is waiting for an answer' });
  });
});

describe('useAppEventConsumer — the run view’s one line', () => {
  it('hands the frame’s app events to the intake under the mounted app id and generation', async () => {
    let onAppEvent: ((event: string, data: unknown) => void) | undefined;
    function Harness({ generation }: { generation: number }): ReactElement {
      onAppEvent = useAppEventConsumer(weather, generation);
      return <span />;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(<Harness generation={3} />);
    });
    await act(async () => {
      onAppEvent?.(SCHEDULE_REQUEST_EVENT, proposal(weather));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(suggestionStore.get()[weather]?.generation).toBe(3);
    await act(async () => {
      onAppEvent?.('connection-event', { slot: 'x' });
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(suggestionStore.get()[weather]?.proposal.title).toBe('morning weather');
    act(() => root.unmount());
    container.remove();
  });
});
