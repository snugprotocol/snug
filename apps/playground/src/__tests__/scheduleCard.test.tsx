// scheduleCard.test.tsx — TASK-20261009-scheduling-framework P1 (ADR-0074 §4; ADR-0031 §3; M3): the
// schedule SUGGESTION card, `schedule/ScheduleCard.tsx`. A `schedule_propose` call stages one
// proposal on the agent's message (`meta.schedule`, the data-write card's pattern — never
// `present_card`); the card renders it — the provenance line, the title, the steps in words, the
// when and the next time — with three acts. *Schedule it* opens the ONE consent surface inside the
// card and the user's act there calls the ONE writer, which creates the task ENABLED with the
// channel's provenance and the thread's app as owner; *not now* dims the card; *edit…* opens the
// editor route with the proposal and the way back; a card whose app is gone is stale.
//
// THE CARD NEVER WRITES THE CHAT ROW. It is rendered DIRECTLY here with a RECORDING resolve path:
// every answer goes out through `onResolve` — the card, the message id, the answer, the task it
// became — and the hook that staged the card persists it. With no resolve path the acts wait.
// A remounted card still READS the row (an answer given elsewhere), and a persisted row is
// re-validated through the protocol's parser on read. The last blocks mount `ChatLog`: it threads
// `onResolveSchedule` with the message's id, and renders no card where the host does not schedule.
//
// The real memory user db and the real writer: the task the card creates is in the file.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { proposalHash, type ScheduleProposal } from '@snugprotocol/protocol';

import { metaToScheduleCard, persistScheduleResolution, readScheduleCardRow, scheduleCardToMeta, stageScheduleCard, type ScheduleCardState } from '../agent/scheduleCard.js';
import type { ChatMessage } from '../agent/useBuilderChat.js';
import { CONSENT, SCHEDULE_CARD, stepWords } from '../schedule/copy.js';
import { OFFER } from '../schedule/copy.page.js';
import { __setPageClockForTests, nextWords } from '../schedule/pageModel.js';
import { ScheduleCard, type ResolveScheduleCard, type ScheduleCardAnswer } from '../schedule/ScheduleCard.js';
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
/** The chat message the card sits on — what the hook keys its persist on. */
const MESSAGE_ID = 7;

const DAILY: ScheduleProposal['spec'] = { kind: 'daily', time: '08:00', tz: 'UTC' };

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;
let appId: string;
let lastPath = '';

/** What the card handed the hook. */
type Resolved = { card: ScheduleCardState; messageId: number; resolution: ScheduleCardAnswer; taskId: string | undefined };
let resolved: Resolved[] = [];
const record: ResolveScheduleCard = (card, messageId, resolution, taskId) => {
  resolved.push({ card, messageId, resolution, taskId });
};

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

function mountRoutes(element: React.ReactElement): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={[`/run/${appId}`]}>
        <Routes>
          <Route path="/run/:id" element={element} />
          <Route path="/schedule/new" element={<Probe />} />
          <Route path="/schedule/:id" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

/** The card itself, with the recording resolve path unless the test says otherwise (`onResolve: undefined` = none). */
async function render(card: ScheduleCardState, options: { busy?: boolean; onResolve?: ResolveScheduleCard | undefined } = {}): Promise<void> {
  const onResolve = 'onResolve' in options ? options.onResolve : record;
  mountRoutes(<ScheduleCard card={card} messageId={MESSAGE_ID} busy={options.busy ?? false} onResolve={onResolve} />);
  await settle();
}

/** `ChatLog` over the messages — the mount both chats share. */
async function renderChat(messages: ChatMessage[], options: { busy?: boolean; onResolveSchedule?: ResolveScheduleCard } = {}): Promise<void> {
  mountRoutes(<ChatLog messages={messages} busy={options.busy ?? false} {...(options.onResolveSchedule !== undefined ? { onResolveSchedule: options.onResolveSchedule } : {})} />);
  await settle();
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
function stagedCard(proposal: ScheduleProposal, options: { channel?: 'builder' | 'chat'; withApp?: boolean } = {}): ScheduleCardState {
  const card = stageScheduleCard(proposal, { ...(options.withApp === false ? {} : { appId }), channel: options.channel ?? 'builder', threadId: THREAD });
  const row = db.appendChatMessage(THREAD, 'assistant', 'I suggested a schedule — it is waiting for your OK.', { meta: scheduleCardToMeta(card) });
  return { ...card, messageRowId: row.id };
}

/** The row's persisted card, as the file holds it NOW. */
const rowCard = (card: ScheduleCardState): ScheduleCardState | undefined => metaToScheduleCard(db.listChatMessages(THREAD).find((m) => m.id === card.messageRowId)?.meta);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  __setPageClockForTests(() => new Date(NOW));
  __resetSchedulerForTests();
  brainGate.host = false;
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  resolved = [];
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
    await render(stagedCard(proposalFor(appId)));
    const card = must('schedule-card');
    expect(card.dataset.resolution).toBe('staged');
    expect(card.textContent).toContain(SCHEDULE_CARD.lead);
    expect(card.textContent).toContain('morning summary');
    expect(must('schedule-card-step-0').textContent).toBe('ask Ledger’s AI: Sum up yesterday in two lines.');
    expect(must('schedule-card-step-0').textContent).toBe(stepWords(proposalFor(appId).steps[0]!, 'Ledger', { withInput: true }));
    expect(must('schedule-card-when').textContent).toContain('Every day at 8:00 AM');
    expect(must('schedule-card-when').textContent).toContain('next Sat, Oct 10, 8:00 AM UTC');
    expect(must('schedule-card-accept').textContent).toBe(CONSENT.enable);
    expect(must('schedule-card-decline').textContent).toBe(CONSENT.notNow);
    expect(must('schedule-card-edit').textContent).toBe(SCHEDULE_CARD.edit);
    expect(q('enable-consent')).toBeNull();
    expect(db.listScheduledTasks()).toHaveLength(0);
  });

  it('a *run <app>* step shows its input on the card — the one surface with room for it (M6)', async () => {
    await render(stagedCard({ title: 'fetch it', steps: [{ kind: 'app-run', appId, input: { fetch: true } }], spec: DAILY }));
    expect(must('schedule-card-step-0').textContent).toBe('run Ledger · {"fetch":true}');
  });

  it('edit… opens the editor route with the proposal, the app and the way back to this thread', async () => {
    const proposal = proposalFor(appId);
    await render(stagedCard(proposal));
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
    await render(stagedCard(proposalFor(appId)), { busy: true });
    expect((must('schedule-card-accept') as HTMLButtonElement).disabled).toBe(true);
    expect((must('schedule-card-decline') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the acts wait with NO resolve path — an answer with nowhere to go must not create anything; the in-app edit link needs none', async () => {
    await render(stagedCard(proposalFor(appId)), { onResolve: undefined });
    expect((must('schedule-card-accept') as HTMLButtonElement).disabled).toBe(true);
    expect((must('schedule-card-decline') as HTMLButtonElement).disabled).toBe(true);
    expect(must('schedule-card-edit').getAttribute('href')).toContain('/schedule/new?');
  });
});

describe('schedule it → the one consent surface → the one writer → the hook persists the answer', () => {
  it('shows what will run verbatim; the enable creates the task ENABLED with the builder’s provenance and the thread’s app as owner; the card says scheduled with open; the answer goes to the hook, and the row is NOT written here', async () => {
    const card = stagedCard(proposalFor(appId), { channel: 'builder' });
    await render(card);
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
    expect(must('schedule-card-outcome').textContent).toContain(SCHEDULE_CARD.scheduled(nextWords(DAILY, NOW)));
    expect(must('schedule-card-outcome').textContent).toContain('Sat, Oct 10, 8:00 AM UTC');
    expect(must('schedule-card-open').getAttribute('href')).toBe(`/schedule/${tasks[0]?.id}`);
    expect(q('schedule-card-accept')).toBeNull();

    // THE HOOK'S CONTRACT: the card as rendered, this message's id, the answer, the task it became.
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ messageId: MESSAGE_ID, resolution: 'scheduled', taskId: tasks[0]?.id });
    expect(resolved[0]?.card).toMatchObject({ threadId: THREAD, messageRowId: card.messageRowId, hash: card.hash, channel: 'builder', appId });
    // The row is the hook's to write: the card left it staged.
    expect(rowCard(card)?.resolution).toBeUndefined();
  });

  it('the chat lane’s card writes with the chat provenance', async () => {
    await render(stagedCard(proposalFor(appId), { channel: 'chat' }));
    await click(must('schedule-card-accept'));
    await click(must('consent-enable'));
    expect(db.listScheduledTasks()[0]?.provenance).toBe('chat');
    expect(resolved[0]?.card.channel).toBe('chat');
  });

  it('not now on the consent returns to the acts with nothing written and nothing resolved', async () => {
    await render(stagedCard(proposalFor(appId)));
    await click(must('schedule-card-accept'));
    await click(must('consent-not-now'));
    expect(q('enable-consent')).toBeNull();
    expect(q('schedule-card-accept')).not.toBeNull();
    expect(db.listScheduledTasks()).toHaveLength(0);
    expect(resolved).toEqual([]);
  });

  it('a refused write is shown in words on the consent, the card stays staged, and nothing is resolved', async () => {
    // Under the floor of a suggested schedule (15 minutes): the writer refuses, the card says so.
    const tooOften: ScheduleProposal = { title: 'every five', steps: [{ kind: 'notify', title: 'hi', body: 'there' }], spec: { kind: 'every', n: 5, unit: 'minutes', tz: 'UTC' } };
    await render(stagedCard(tooOften));
    await click(must('schedule-card-accept'));
    await click(must('consent-enable'));
    expect(must('consent-error').textContent).toContain('too often');
    expect(db.listScheduledTasks()).toHaveLength(0);
    expect(must('schedule-card').dataset.resolution).toBe('staged');
    expect(resolved).toEqual([]);
  });
});

describe('not now, stale, and the row as the truth', () => {
  it('not now dims the card, offers no act, writes no task, hands the hook the decline, and leaves the row to the hook', async () => {
    const card = stagedCard(proposalFor(appId));
    await render(card);
    await click(must('schedule-card-decline'));
    expect(must('schedule-card').dataset.resolution).toBe('declined');
    expect(must('schedule-card').className).toContain('is-declined');
    expect(must('schedule-card-outcome').textContent).toBe(SCHEDULE_CARD.declined);
    expect(q('schedule-card-accept')).toBeNull();
    expect(db.listScheduledTasks()).toHaveLength(0);
    expect(resolved).toEqual([{ card: expect.objectContaining({ messageRowId: card.messageRowId }), messageId: MESSAGE_ID, resolution: 'declined', taskId: undefined }]);
    expect(rowCard(card)?.resolution).toBeUndefined();
  });

  it('a card whose app was deleted is stale: no act, the stale line', async () => {
    const card = stagedCard(proposalFor(appId));
    await db.deleteApp(appId);
    await render(card);
    expect(must('schedule-card').dataset.resolution).toBe('stale');
    expect(must('schedule-card-outcome').textContent).toBe(SCHEDULE_CARD.stale);
    expect(q('schedule-card-accept')).toBeNull();
  });

  it('a one-off whose time has passed is stale too', async () => {
    const past: ScheduleProposal = { title: 'once', steps: [{ kind: 'notify', title: 'hi', body: 'there' }], spec: { kind: 'once', at: '2026-10-01T09:00:00.000Z', tz: 'UTC' } };
    await render(stagedCard(past, { withApp: false }));
    expect(must('schedule-card').dataset.resolution).toBe('stale');
  });

  it('a remounted card reads the answer the row already holds — a read, not an answer: nothing is resolved again', async () => {
    const card = stagedCard(proposalFor(appId));
    // Answered elsewhere (the other view): the hook persisted declined; the in-memory card does not say so.
    persistScheduleResolution(db, { ...card, resolution: 'declined' });
    await render(card);
    expect(must('schedule-card').dataset.resolution).toBe('declined');
    expect(resolved).toEqual([]);
  });

  it('an answer the hook rehydrated onto the card is adopted: scheduled, with open to the task', async () => {
    const card = stagedCard(proposalFor(appId));
    await render({ ...card, resolution: 'scheduled', taskId: 'task-x' });
    expect(must('schedule-card').dataset.resolution).toBe('scheduled');
    expect(must('schedule-card-open').getAttribute('href')).toBe('/schedule/task-x');
    expect(q('schedule-card-accept')).toBeNull();
    expect(resolved).toEqual([]);
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
});

describe('ChatLog mounts the card (M3) — under the agent’s message, in both chats', () => {
  const message = (card: ScheduleCardState): ChatMessage => ({ id: 2, role: 'agent', displayText: 'I suggested a schedule — it is waiting for your OK.', schedule: card });

  it('threads onResolveSchedule through with the MESSAGE’s id', async () => {
    const card = stagedCard(proposalFor(appId));
    await renderChat([{ id: 1, role: 'user', displayText: 'every morning sum up yesterday' }, message(card)], { onResolveSchedule: record });
    await click(must('schedule-card-decline'));
    expect(resolved).toEqual([{ card: expect.objectContaining({ messageRowId: card.messageRowId }), messageId: 2, resolution: 'declined', taskId: undefined }]);
  });

  it('without the prop the card’s acts wait — ChatLog never invents a persist path', async () => {
    await renderChat([message(stagedCard(proposalFor(appId)))]);
    expect((must('schedule-card-accept') as HTMLButtonElement).disabled).toBe(true);
    expect((must('schedule-card-decline') as HTMLButtonElement).disabled).toBe(true);
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
    await renderChat([{ id: 1, role: 'user', displayText: 'remind me every weekday at 8 to stretch' }]);
    expect(q('schedule-offer')).not.toBeNull();
    expect(q('schedule-offer-note')).toBeNull();
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    brainGate.host = true;
    await renderChat([{ id: 1, role: 'user', displayText: 'remind me every weekday at 8 to stretch' }]);
    expect(must('schedule-offer-note').textContent).toBe(OFFER.hostBrain);
  });
});
