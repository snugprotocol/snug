// scheduleCard.test.tsx — TASK-20261009-scheduling-framework P1 (ADR-0074 §4; ADR-0031 §3): the
// schedule SUGGESTION card in the chat rail. A `schedule_propose` call stages one proposal on the
// agent's message (`meta.schedule`, the data-write card's pattern — never `present_card`); `ChatLog`
// renders it — the provenance line, the title, the steps in words, the when and the next time —
// with three acts. *Schedule it* opens the ONE consent surface inside the card and the user's act
// there calls the ONE writer, which creates the task ENABLED with the channel's provenance and
// the thread's app as owner; *not now* dims the card; *edit…* opens the editor route with the
// proposal and the way back; a card whose app is gone is stale. Every answer persists on the row
// by merging its meta, and a persisted row is re-validated through the protocol's parser on read.
//
// The real memory user db and the real writer: the task the card creates is in the file.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { proposalHash, type ScheduleProposal } from '@snugprotocol/protocol';

import { metaToScheduleCard, persistScheduleResolution, readScheduleCardRow, scheduleCardToMeta, stageScheduleCard } from '../agent/scheduleCard.js';
import type { ChatMessage } from '../agent/useBuilderChat.js';
import { CONSENT, SCHEDULE_CARD } from '../schedule/copy.js';
import { OFFER } from '../schedule/copy.page.js';
import { __setPageClockForTests } from '../schedule/pageModel.js';
import { __resetSchedulerForTests } from '../schedule/scheduler.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import { ChatLog } from '../views/ChatLog.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const brainGate = vi.hoisted(() => ({ host: false }));
vi.mock('../state/webllm.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../state/webllm.js')>();
  return { ...original, useBrain: () => (brainGate.host ? { kind: 'host', label: 'Claude', streaming: true, tools: false } : original.useBrain()) };
});

/** Friday 2026-10-09 12:20Z — a daily 08:00 is tomorrow morning. */
const NOW = new Date('2026-10-09T12:20:00.000Z');
const THREAD = 'app:card-thread';

const DAILY: ScheduleProposal['spec'] = { kind: 'daily', time: '08:00', tz: 'UTC' };

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;
let appId: string;
let lastPath = '';

function Probe(): React.ReactElement {
  const location = useLocation();
  lastPath = `${location.pathname}${location.search}`;
  return <span data-testid="probe">{lastPath}</span>;
}

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function render(messages: ChatMessage[], busy = false): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[`/run/${appId}`]}>
        <Routes>
          <Route path="/run/:id" element={<ChatLog messages={messages} busy={busy} />} />
          <Route path="/schedule/new" element={<Probe />} />
          <Route path="/schedule/:id" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settle();
  return container;
}

const q = (testId: string): HTMLElement | null => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const must = (testId: string): HTMLElement => {
  const el = q(testId);
  if (el === null) throw new Error(`missing [data-testid="${testId}"]`);
  return el;
};
async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await settle();
}

const proposalFor = (id: string): ScheduleProposal => ({
  title: 'morning summary',
  steps: [{ kind: 'app-think', appId: id, prompt: 'Sum up yesterday in two lines.', context: { maxRows: 50 } }],
  spec: DAILY,
});

/** A staged card persisted on a real assistant row, the way turn finalization leaves it. */
function stagedMessage(proposal: ScheduleProposal, options: { channel?: 'builder' | 'chat'; withApp?: boolean } = {}): ChatMessage {
  const card = stageScheduleCard(proposal, { ...(options.withApp === false ? {} : { appId }), channel: options.channel ?? 'builder', threadId: THREAD });
  const row = db.appendChatMessage(THREAD, 'assistant', 'I suggested a schedule — it is waiting for your OK.', { meta: scheduleCardToMeta(card) });
  return { id: 2, role: 'agent', displayText: 'I suggested a schedule — it is waiting for your OK.', schedule: { ...card, messageRowId: row.id } };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  __setPageClockForTests(() => new Date(NOW));
  __resetSchedulerForTests();
  brainGate.host = false;
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  db = await installTestUserDb();
  appId = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>Ledger</title>', usesDb: true }).appId;
  db.upsertThread(THREAD, { appId });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
  __setPageClockForTests();
  __resetSchedulerForTests();
  vi.useRealTimers();
});

describe('the card shows what was suggested', () => {
  it('renders the provenance line, the title, the step in words with the app’s name, the when and the next time, and three acts', async () => {
    const message = stagedMessage(proposalFor(appId));
    await render([{ id: 1, role: 'user', displayText: 'every morning sum up yesterday' }, message]);
    const card = must('schedule-card');
    expect(card.dataset.resolution).toBe('staged');
    expect(card.textContent).toContain(SCHEDULE_CARD.lead);
    expect(card.textContent).toContain('morning summary');
    expect(must('schedule-card-step-0').textContent).toBe('ask Ledger’s AI: Sum up yesterday in two lines.');
    expect(must('schedule-card-when').textContent).toContain('Every day at 8:00 AM');
    expect(must('schedule-card-when').textContent).toContain('next Sat, Oct 10, 8:00 AM UTC');
    expect(must('schedule-card-accept').textContent).toBe(CONSENT.enable);
    expect(must('schedule-card-decline').textContent).toBe(CONSENT.notNow);
    expect(must('schedule-card-edit').textContent).toBe(SCHEDULE_CARD.edit);
    expect(q('enable-consent')).toBeNull();
    expect(db.listScheduledTasks()).toHaveLength(0);
  });

  it('edit… opens the editor route with the proposal, the app and the way back to this thread', async () => {
    const proposal = proposalFor(appId);
    await render([stagedMessage(proposal)]);
    const href = must('schedule-card-edit').getAttribute('href') ?? '';
    const url = new URL(href, 'http://x');
    expect(url.pathname).toBe('/schedule/new');
    expect(JSON.parse(url.searchParams.get('suggestion') ?? '')).toEqual(proposal);
    expect(url.searchParams.get('app')).toBe(appId);
    expect(url.searchParams.get('back')).toBe(`/run/${appId}`);
    await click(must('schedule-card-edit'));
    expect(lastPath.startsWith('/schedule/new?')).toBe(true);
  });

  it('the acts wait while the turn is in flight — there is no row to persist an answer to yet', async () => {
    await render([stagedMessage(proposalFor(appId))], true);
    expect((must('schedule-card-accept') as HTMLButtonElement).disabled).toBe(true);
    expect((must('schedule-card-decline') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('schedule it → the one consent surface → the one writer', () => {
  it('shows what will run verbatim; the enable creates the task ENABLED with the builder’s provenance and the thread’s app as owner, and the card says scheduled with open', async () => {
    const message = stagedMessage(proposalFor(appId), { channel: 'builder' });
    await render([message]);
    await click(must('schedule-card-accept'));
    expect(db.listScheduledTasks(), 'nothing is written by opening the consent').toHaveLength(0);
    const consent = must('enable-consent');
    expect(consent.querySelector('h3')?.textContent).toBe(CONSENT.heading);
    expect(must('consent-prompt-0').textContent).toBe('Sum up yesterday in two lines.');
    expect(must('consent-tables-0').textContent).toBe('the AI reads Ledger’s tables — no queries');

    await click(must('consent-enable'));
    const tasks = db.listScheduledTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'morning summary', enabled: true, provenance: 'builder', ownerAppId: appId, cron: '0 8 * * *' });
    expect(tasks[0]?.steps).toEqual([{ kind: 'app-think', appId, prompt: 'Sum up yesterday in two lines.', context: { maxRows: 50 } }]);

    expect(q('enable-consent')).toBeNull();
    expect(must('schedule-card').dataset.resolution).toBe('scheduled');
    expect(must('schedule-card-outcome').textContent).toContain(SCHEDULE_CARD.scheduled('Sat, Oct 10, 8:00 AM UTC'));
    expect(must('schedule-card-open').getAttribute('href')).toBe(`/schedule/${tasks[0]?.id}`);
    expect(q('schedule-card-accept')).toBeNull();

    // Persisted on the row, merged — the message's own text and nothing else is lost.
    const row = db.listChatMessages(THREAD).find((m) => m.id === message.schedule?.messageRowId);
    const persisted = metaToScheduleCard(row?.meta);
    expect(persisted?.resolution).toBe('scheduled');
    expect(persisted?.taskId).toBe(tasks[0]?.id);
  });

  it('the chat lane’s card writes with the chat provenance', async () => {
    await render([stagedMessage(proposalFor(appId), { channel: 'chat' })]);
    await click(must('schedule-card-accept'));
    await click(must('consent-enable'));
    expect(db.listScheduledTasks()[0]?.provenance).toBe('chat');
  });

  it('not now on the consent returns to the acts with nothing written', async () => {
    await render([stagedMessage(proposalFor(appId))]);
    await click(must('schedule-card-accept'));
    await click(must('consent-not-now'));
    expect(q('enable-consent')).toBeNull();
    expect(q('schedule-card-accept')).not.toBeNull();
    expect(db.listScheduledTasks()).toHaveLength(0);
  });

  it('a refused write is shown in words on the consent and the card stays staged', async () => {
    // Under the floor of a suggested schedule (15 minutes): the writer refuses, the card says so.
    const tooOften: ScheduleProposal = { title: 'every five', steps: [{ kind: 'notify', title: 'hi', body: 'there' }], spec: { kind: 'every', n: 5, unit: 'minutes', tz: 'UTC' } };
    await render([stagedMessage(tooOften)]);
    await click(must('schedule-card-accept'));
    await click(must('consent-enable'));
    expect(must('consent-error').textContent).toContain('too often');
    expect(db.listScheduledTasks()).toHaveLength(0);
    expect(must('schedule-card').dataset.resolution).toBe('staged');
  });
});

describe('not now, stale, and the row as the truth', () => {
  it('not now dims the card, offers no act, writes no task, and persists the answer on the row', async () => {
    const message = stagedMessage(proposalFor(appId));
    await render([message]);
    await click(must('schedule-card-decline'));
    expect(must('schedule-card').dataset.resolution).toBe('declined');
    expect(must('schedule-card').className).toContain('is-declined');
    expect(must('schedule-card-outcome').textContent).toBe(SCHEDULE_CARD.declined);
    expect(q('schedule-card-accept')).toBeNull();
    expect(db.listScheduledTasks()).toHaveLength(0);
    const row = db.listChatMessages(THREAD).find((m) => m.id === message.schedule?.messageRowId);
    expect(metaToScheduleCard(row?.meta)?.resolution).toBe('declined');
  });

  it('a card whose app was deleted is stale: no act, the stale line', async () => {
    const message = stagedMessage(proposalFor(appId));
    await db.deleteApp(appId);
    await render([message]);
    expect(must('schedule-card').dataset.resolution).toBe('stale');
    expect(must('schedule-card-outcome').textContent).toBe(SCHEDULE_CARD.stale);
    expect(q('schedule-card-accept')).toBeNull();
  });

  it('a one-off whose time has passed is stale too', async () => {
    const past: ScheduleProposal = { title: 'once', steps: [{ kind: 'notify', title: 'hi', body: 'there' }], spec: { kind: 'once', at: '2026-10-01T09:00:00.000Z', tz: 'UTC' } };
    await render([stagedMessage(past, { withApp: false })]);
    expect(must('schedule-card').dataset.resolution).toBe('stale');
  });

  it('a remounted card reads the answer the row already holds', async () => {
    const message = stagedMessage(proposalFor(appId));
    // Answered elsewhere (the other view): the row says declined, the in-memory message does not.
    persistScheduleResolution(db, { ...message.schedule!, resolution: 'declined' });
    await render([message]);
    expect(must('schedule-card').dataset.resolution).toBe('declined');
  });
});

describe('the persisted shape — re-validated on every read', () => {
  const proposal = (): ScheduleProposal => proposalFor(appId);

  it('round-trips a staged card through meta, dropping the row id and recomputing the hash', () => {
    const card = stageScheduleCard(proposal(), { appId, channel: 'builder', threadId: THREAD });
    expect(card.hash).toBe(proposalHash(proposal()));
    const meta = scheduleCardToMeta({ ...card, messageRowId: 42 });
    expect('messageRowId' in meta.schedule).toBe(false);
    expect(metaToScheduleCard(meta)).toEqual(card);
    expect(readScheduleCardRow(db, THREAD, 999)).toBeUndefined();
  });

  it('renders NO card for a row that drifted: an unparseable proposal, a credential in a step, a bad channel, a missing thread, a forged hash', () => {
    const good = scheduleCardToMeta(stageScheduleCard(proposal(), { appId, channel: 'chat', threadId: THREAD }));
    expect(metaToScheduleCard(undefined)).toBeUndefined();
    expect(metaToScheduleCard({})).toBeUndefined();
    expect(metaToScheduleCard({ schedule: 'x' })).toBeUndefined();
    expect(metaToScheduleCard({ schedule: { ...good.schedule, proposal: { title: 'x' } } })).toBeUndefined();
    expect(metaToScheduleCard({ schedule: { ...good.schedule, proposal: { ...good.schedule.proposal, enabled: true } } })).toBeUndefined();
    expect(
      metaToScheduleCard({
        schedule: { ...good.schedule, proposal: { ...good.schedule.proposal, steps: [{ kind: 'notify', title: 'key', body: 'sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' }] } },
      }),
    ).toBeUndefined();
    expect(metaToScheduleCard({ schedule: { ...good.schedule, channel: 'app' } })).toBeUndefined();
    expect(metaToScheduleCard({ schedule: { ...good.schedule, threadId: '' } })).toBeUndefined();
    expect(metaToScheduleCard({ schedule: { ...good.schedule, resolution: 'applied' } })).toBeUndefined();
    // A forged hash is simply replaced by the recomputed one.
    expect(metaToScheduleCard({ schedule: { ...good.schedule, hash: 'deadbeefdeadbeef' } })?.hash).toBe(good.schedule.hash);
  });

  it('is gated on allows("schedule") like every scheduling surface — ChatLog renders no card where the host does not schedule', async () => {
    vi.resetModules();
    const platformModule = await import('../platform/platform.js');
    platformModule.setPlatform({ kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false, schedule: false } });
    const helper = await import('./userdbTestHelper.js');
    const fresh = await helper.installTestUserDb();
    const id = fresh.installApp({ displayName: 'Ledger', html: '<!doctype html><title>Ledger</title>' }).appId;
    const { ChatLog: FreshChatLog } = await import('../views/ChatLog.js');
    const { stageScheduleCard: stage } = await import('../agent/scheduleCard.js');
    const card = stage(proposalFor(id), { appId: id, channel: 'builder', threadId: THREAD });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <FreshChatLog messages={[{ id: 2, role: 'agent', displayText: 'hi', schedule: card }]} />
        </MemoryRouter>,
      );
    });
    await settle();
    expect(q('schedule-card')).toBeNull();
  });
});

describe('under a host brain the deterministic offer is the route, and the line says so (P2)', () => {
  it('the offer under a user message carries the host-brain note only under the host brain', async () => {
    await render([{ id: 1, role: 'user', displayText: 'remind me every weekday at 8 to stretch' }]);
    expect(q('schedule-offer')).not.toBeNull();
    expect(q('schedule-offer-note')).toBeNull();
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    brainGate.host = true;
    await render([{ id: 1, role: 'user', displayText: 'remind me every weekday at 8 to stretch' }]);
    expect(must('schedule-offer-note').textContent).toBe(OFFER.hostBrain);
  });
});
