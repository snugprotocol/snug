// agentUpdateControls.test.tsx — TASK-20260905-binding-a-artifacts AC8: the run header's
// door to an agent hand-in for an EDITED copy — offered behind one confirm, never applied
// on its own; renders nothing without the seat (web, desktop) or without a pending entry.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';

import type { AgentHandInSeat, PendingAgentUpdate, SnugPlatform } from '../platform/platform.js';
import { createStore } from '../state/store.js';
import { hostPlatform as hostFixture } from './fixtures/hostPlatform.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render(node: ReactElement): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.resetModules();
});

const q = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);
const click = (el: HTMLElement | null): void => {
  if (el === null) throw new Error('nothing to click');
  act(() => {
    el.click();
  });
};

const hostPlatform = (seat?: AgentHandInSeat): SnugPlatform => hostFixture(seat !== undefined ? { agentHandIns: seat } : {});

let db: UserDb;

async function mount(platform: SnugPlatform | undefined, appId: string, onUpdated = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
  vi.resetModules();
  const mod = await import('../platform/platform.js');
  if (platform !== undefined) mod.setPlatform(platform);
  // The access half of the note reads the engine's view of the file — a memory file, handed to
  // THIS module graph's engine (and page db) so nothing boots a real store.
  db = await installTestUserDb();
  (await import('../state/userdb.js')).setUserDbForTests(db);
  (await import('../access/grants.js')).__setAccessDepsForTests({ getDb: () => Promise.resolve(db) });
  const { AgentUpdateControls } = await import('../run/AgentUpdateControls.js');
  render(<AgentUpdateControls appId={appId} onUpdated={onUpdated} />);
  return onUpdated;
}

describe('AgentUpdateControls', () => {
  it('the confirm names the schedules the update will pause (E8), and says nothing when none runs the app', async () => {
    const seat: AgentHandInSeat = {
      pending: createStore<readonly PendingAgentUpdate[]>([{ appId: 'app-1', displayName: 'Pomodoro', bundleId: 'b2' }]),
      apply: vi.fn(async () => ({ version: 3 })),
    };
    await mount(hostPlatform(seat), 'app-1');
    const { schedulerStore } = await import('../schedule/scheduler.js');
    const base = schedulerStore.get();
    const task = (id: string, title: string, appVersions: Record<string, number>, enabled = true) =>
      ({ id, title, enabled, provenance: 'user', steps: [], spec: { kind: 'every', n: 1, unit: 'hours', tz: 'UTC' }, cron: '0 * * * *', missedPolicy: 'ask', staleAfterMs: 3_600_000, alert: 'inbox', appVersions, createdAt: 'x', updatedAt: 'x', consecutiveFailures: 0, unseenResults: 0 }) as (typeof base.tasks)[number];
    act(() => {
      schedulerStore.set({ ...base, tasks: [task('n', 'Nightly', { 'app-1': 1 }), task('w', 'Weekly review', { 'app-1': 2 }), task('o', 'Other', { 'app-9': 1 }), task('p', 'Paused', { 'app-1': 1 }, false)] });
    });
    click(q('agent-update'));
    expect(q('update-pauses-note')?.textContent).toBe('Updating pauses 2 schedules that run this app — “Nightly” and “Weekly review” — until you turn them back on from the Schedule page.');
    act(() => {
      schedulerStore.set({ ...base, tasks: [task('o', 'Other', { 'app-9': 1 })] });
    });
    expect(q('update-pauses-note')).toBeNull();
    expect(q('agent-update-confirm')).not.toBeNull();
  });

  it('web (positive twin) and a host without the seat: nothing', async () => {
    await mount(undefined, 'app-1');
    expect(q('agent-update')).toBeNull();
    act(() => root?.unmount());
    await mount(hostPlatform(), 'app-1');
    expect(q('agent-update')).toBeNull();
  });

  it('nothing pending for THIS app: nothing', async () => {
    const pending = createStore<readonly PendingAgentUpdate[]>([{ appId: 'other', displayName: 'Other', bundleId: 'b' }]);
    await mount(hostPlatform({ pending, apply: async () => ({ version: 2 }) }), 'app-1');
    expect(q('agent-update')).toBeNull();
  });

  it('a pending entry: the door, the confirm, cancel applies nothing, confirm applies once and reports the version', async () => {
    const pending = createStore<readonly PendingAgentUpdate[]>([{ appId: 'app-1', displayName: 'Pomodoro', bundleId: 'b1' }]);
    const apply = vi.fn(async () => ({ version: 3 }));
    const onUpdated = await mount(hostPlatform({ pending, apply }), 'app-1');
    expect(q('agent-update')?.getAttribute('aria-label')).toBe('update this app from your agent');
    click(q('agent-update'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Pomodoro');
    click(q('agent-update-cancel'));
    expect(apply).not.toHaveBeenCalled();
    click(q('agent-update'));
    click(q('agent-update-confirm'));
    expect(apply).toHaveBeenCalledWith('app-1');
    await act(async () => {
      await Promise.resolve();
    });
    expect(onUpdated).toHaveBeenCalledWith(3);
    // The seat clears the entry after the act; the door goes with it.
    act(() => pending.set([]));
    expect(q('agent-update')).toBeNull();
  });

  it('the confirm names the access that will pause beside the schedules (AC21) — live access only, in the copy module\'s sentence', async () => {
    const pending = createStore<readonly PendingAgentUpdate[]>([]);
    const seat: AgentHandInSeat = { pending, apply: vi.fn(async () => ({ version: 2 })) };
    await mount(hostPlatform(seat), 'placeholder');
    act(() => root?.unmount());
    container?.remove();
    const budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
    const ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
    const pantry = db.installApp({ displayName: 'Pantry', html: '<!doctype html><title>p</title>' }).appId;
    const notes = db.installApp({ displayName: 'Notes', html: '<!doctype html><title>n</title>' }).appId;
    for (const [appId, table] of [[ledger, 'transactions'], [pantry, 'items'], [notes, 'notes']] as const) {
      await db.applyAppDdl(appId, [`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT)`]);
      await db.driver.handle(appId, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `seed-${appId}`, instanceId: 'seed', op: 'exec', sql: `INSERT INTO ${table} (label) VALUES ('x')` });
    }
    const consent = await import('../access/consent.js');
    const grants = await import('../access/grants.js');
    const copy = await import('../access/copy.js');
    const allow = async (sourceId: string, table: string, duration: 'session' | 'day'): Promise<string> => {
      const ranked = await consent.collectSources(db, budget);
      const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === sourceId)!;
      const grant = await grants.createGrantFromDecision(db, { readerAppId: budget, source, tables: [table], duration, unattended: false, purpose: 'to plan', provenance: 'app', generation: 0, now: Date.now() });
      return grant.id;
    };
    await allow(pantry, 'items', 'session');
    await allow(ledger, 'transactions', 'day');
    // A stopped access will not pause — it is not named.
    await grants.revokeAccess(await allow(notes, 'notes', 'day'));
    pending.set([{ appId: budget, displayName: 'Budget', bundleId: 'b9' }]);
    const { AgentUpdateControls } = await import('../run/AgentUpdateControls.js');
    render(<AgentUpdateControls appId={budget} onUpdated={vi.fn()} />);
    click(q('agent-update'));
    for (let i = 0; i < 20 && q('update-pauses-access') === null; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(q('update-pauses-access')?.textContent).toBe(copy.updatePausesAccess('Budget', ['Ledger', 'Pantry']));
    expect(q('update-pauses-note')?.textContent).toBe(copy.updatePausesAccess('Budget', ['Ledger', 'Pantry']));
    expect(q('update-pauses-note')?.textContent).not.toContain('Notes');
    // The engine changes; the note re-reads: once nothing live remains, the access half goes, and with no schedule the note goes too.
    await act(async () => {
      for (const row of grants.grantsForApp(db, budget, Date.now()).reads) await grants.revokeAccess(row.grant.id);
    });
    for (let i = 0; i < 20 && q('update-pauses-note') !== null; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(q('update-pauses-access')).toBeNull();
    expect(q('update-pauses-note')).toBeNull();
    expect(q('agent-update-confirm')).not.toBeNull();
  });

  it("the access half follows E8's rule by the update's SOURCE: a shared or agent update names it; the user's own edit and a starter update never do", async () => {
    await mount(hostPlatform({ pending: createStore<readonly PendingAgentUpdate[]>([]), apply: vi.fn(async () => ({ version: 2 })) }), 'placeholder');
    act(() => root?.unmount());
    container?.remove();
    const budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
    const ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
    await db.applyAppDdl(ledger, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER)']);
    await db.driver.handle(ledger, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: 'seed', instanceId: 'seed', op: 'exec', sql: 'INSERT INTO transactions (amount) VALUES (1)' });
    const consent = await import('../access/consent.js');
    const grants = await import('../access/grants.js');
    const copy = await import('../access/copy.js');
    const ranked = await consent.collectSources(db, budget);
    const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === ledger)!;
    await grants.createGrantFromDecision(db, { readerAppId: budget, source, tables: ['transactions'], duration: 'day', unattended: false, purpose: 'to plan', provenance: 'app', generation: 0, now: Date.now() });
    const { UpdatePausesNote } = await import('../run/UpdatePausesNote.js');
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 20; i += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
    };
    for (const source of ['shared', 'agent'] as const) {
      render(<UpdatePausesNote appId={budget} source={source} />);
      await settle();
      expect(q('update-pauses-access')?.textContent).toBe(copy.updatePausesAccess('Budget', ['Ledger']));
      act(() => root?.unmount());
      container?.remove();
    }
    for (const source of ['own', 'starter'] as const) {
      render(<UpdatePausesNote appId={budget} source={source} />);
      await settle();
      expect(q('update-pauses-access')).toBeNull();
      expect(q('update-pauses-note')).toBeNull();
      act(() => root?.unmount());
      container?.remove();
    }
  });

  it('the schedules and the access share ONE note — both sentences, schedules first', async () => {
    const pending = createStore<readonly PendingAgentUpdate[]>([]);
    await mount(hostPlatform({ pending, apply: vi.fn(async () => ({ version: 2 })) }), 'placeholder');
    act(() => root?.unmount());
    container?.remove();
    const budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
    const ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
    await db.applyAppDdl(ledger, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER)']);
    await db.driver.handle(ledger, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: 'seed', instanceId: 'seed', op: 'exec', sql: 'INSERT INTO transactions (amount) VALUES (1)' });
    const consent = await import('../access/consent.js');
    const grants = await import('../access/grants.js');
    const copy = await import('../access/copy.js');
    const ranked = await consent.collectSources(db, budget);
    const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === ledger)!;
    await grants.createGrantFromDecision(db, { readerAppId: budget, source, tables: ['transactions'], duration: 'day', unattended: false, purpose: 'to plan', provenance: 'app', generation: 0, now: Date.now() });
    const { schedulerStore } = await import('../schedule/scheduler.js');
    const base = schedulerStore.get();
    const task = { id: 'n', title: 'Nightly', enabled: true, provenance: 'user', steps: [], spec: { kind: 'every', n: 1, unit: 'hours', tz: 'UTC' }, cron: '0 * * * *', missedPolicy: 'ask', staleAfterMs: 3_600_000, alert: 'inbox', appVersions: { [budget]: 1 }, createdAt: 'x', updatedAt: 'x', consecutiveFailures: 0, unseenResults: 0 } as unknown as (typeof base.tasks)[number];
    schedulerStore.set({ ...base, tasks: [task] });
    pending.set([{ appId: budget, displayName: 'Budget', bundleId: 'b9' }]);
    const { AgentUpdateControls } = await import('../run/AgentUpdateControls.js');
    render(<AgentUpdateControls appId={budget} onUpdated={vi.fn()} />);
    click(q('agent-update'));
    for (let i = 0; i < 20 && q('update-pauses-access') === null; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    const notes = document.querySelectorAll('[data-testid="update-pauses-note"]');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toBe(
      `Updating pauses the schedule that runs this app — “Nightly” — until you turn it back on from the Schedule page. ${copy.updatePausesAccess('Budget', ['Ledger'])}`,
    );
  });
});
