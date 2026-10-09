// agentUpdateControls.test.tsx — TASK-20260905-binding-a-artifacts AC8: the run header's
// door to an agent hand-in for an EDITED copy — offered behind one confirm, never applied
// on its own; renders nothing without the seat (web, desktop) or without a pending entry.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentHandInSeat, PendingAgentUpdate, SnugPlatform } from '../platform/platform.js';
import { createStore } from '../state/store.js';
import { hostPlatform as hostFixture } from './fixtures/hostPlatform.js';

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

async function mount(platform: SnugPlatform | undefined, appId: string, onUpdated = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
  vi.resetModules();
  const mod = await import('../platform/platform.js');
  if (platform !== undefined) mod.setPlatform(platform);
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
});
