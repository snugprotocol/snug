// agentUpdateControls.test.tsx — TASK-20260905-binding-a-artifacts AC8: the run header's
// door to an agent hand-in for an EDITED copy — offered behind one confirm, never applied
// on its own; renders nothing without the seat (web, desktop) or without a pending entry.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentHandInSeat, PendingAgentUpdate, SnugPlatform } from '../platform/platform.js';
import { createStore } from '../state/store.js';

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

function hostPlatform(seat?: AgentHandInSeat): SnugPlatform {
  return {
    kind: 'host',
    binding: 'artifact',
    brain: { kind: 'demo' },
    ...(seat !== undefined ? { agentHandIns: seat } : {}),
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: false, hubAuth: false, brainSettings: false, account: false, sync: false, connections: false, share: false },
  };
}

async function mount(platform: SnugPlatform | undefined, appId: string, onUpdated = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
  vi.resetModules();
  const mod = await import('../platform/platform.js');
  if (platform !== undefined) mod.setPlatform(platform);
  const { AgentUpdateControls } = await import('../run/AgentUpdateControls.js');
  render(<AgentUpdateControls appId={appId} onUpdated={onUpdated} />);
  return onUpdated;
}

describe('AgentUpdateControls', () => {
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
