// runHeaderSchedule.test.tsx — TASK-20261009-scheduling-framework U5: the run header gains a
// `schedule…` action for OWNED apps where the host allows scheduling. It is an icon button with a
// real accessible name (the header's own rule: a glyph is not a name), sits between the
// connections door and the share control (share keeps the cluster's last slot — the ordering
// claim `runHeaderIcons.test.tsx` pins), is absent for a starter or a shared preview, is absent
// where the host says `schedule: false`, and opens the SMALL sheet (portaled to <body>) rather
// than the route.
//
// The `schedule: false` case takes a fresh module registry: `setPlatform` is set-once and locks
// on the first `getPlatform()` read (the `desktopSettingsView.test.tsx` precedent).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SnugPlatform } from '../platform/platform.js';
import { RunHeaderActions, type RunHeaderActionsProps } from '../run/RunHeaderActions.js';
import { RUN_HEADER_SCHEDULE } from '../schedule/copy.editor.js';
import { appModelStore } from '../state/appModel.js';
import { modeStore, modelStore, providerStore } from '../state/mode.js';
import { ollamaStore } from '../state/ollama.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let appId: string;

beforeEach(async () => {
  appModelStore.set({});
  modelStore.set(undefined);
  modeStore.set('byok');
  providerStore.set('anthropic');
  ollamaStore.set('unknown');
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  const db = await installTestUserDb();
  appId = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>Ledger</title>' }).appId;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
});

type Actions = typeof RunHeaderActions;

async function renderActions(Component: Actions, options: Partial<RunHeaderActionsProps> & { owned?: boolean } = {}): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[`/run/${appId}`]}>
        <Component
          appId={options.appId ?? appId}
          isStarter={options.isStarter ?? false}
          connectionSlots={options.connectionSlots ?? 1}
          onManageConnections={options.onManageConnections ?? ((): void => undefined)}
          {...(options.owned === false ? {} : { onShare: options.onShare ?? ((): void => undefined) })}
        />
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const byTestId = (id: string): HTMLElement | null => container?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const inBody = (id: string): HTMLElement | null => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function precedes(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('the schedule action (U5)', () => {
  it('renders for an owned app as an icon button named "schedule", with a tooltip, between connections and share', async () => {
    await renderActions(RunHeaderActions);
    const el = byTestId('schedule-app');
    expect(el).not.toBeNull();
    expect(el!.getAttribute('aria-label')).toBe(RUN_HEADER_SCHEDULE.label);
    expect(el!.getAttribute('title')).toBe(RUN_HEADER_SCHEDULE.title);
    expect(el!.className).toContain('btn-icon');
    expect(el!.textContent ?? '').not.toMatch(/schedule/i);
    expect(precedes(byTestId('manage-connections')!, el!)).toBe(true);
    expect(precedes(el!, byTestId('share-app')!)).toBe(true);
    expect(container!.querySelector('[data-testid="share-app"] ~ *'), 'share keeps the last slot').toBeNull();
  });

  it('is absent for a read-only starter and for a shared preview', async () => {
    await renderActions(RunHeaderActions, { isStarter: true });
    expect(byTestId('schedule-app')).toBeNull();
    await renderActions(RunHeaderActions, { isStarter: true, owned: false });
    expect(byTestId('schedule-app')).toBeNull();
  });

  it('is absent where the host says schedule: false', async () => {
    vi.resetModules();
    const platformModule = await import('../platform/platform.js');
    const platform: SnugPlatform = { kind: 'host', capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: false, schedule: false } };
    platformModule.setPlatform(platform);
    const helper = await import('./userdbTestHelper.js');
    const db = await helper.installTestUserDb();
    appId = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>Ledger</title>' }).appId;
    const fresh = await import('../run/RunHeaderActions.js');
    await renderActions(fresh.RunHeaderActions);
    expect(byTestId('schedule-app')).toBeNull();
    expect(byTestId('share-app'), 'the other controls are untouched').not.toBeNull();
    vi.resetModules();
  });

  it('opens the small sheet for this app (portaled to <body>), and the sheet’s close returns the header to rest', async () => {
    await renderActions(RunHeaderActions);
    expect(inBody('schedule-sheet')).toBeNull();
    expect(byTestId('schedule-app')!.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      byTestId('schedule-app')!.click();
    });
    const sheet = inBody('schedule-sheet');
    expect(sheet).not.toBeNull();
    expect(sheet!.getAttribute('role')).toBe('dialog');
    expect(container!.querySelector('[data-testid="schedule-sheet"]'), 'rendered through the portal, not in the header').toBeNull();
    expect(byTestId('schedule-app')!.getAttribute('aria-expanded')).toBe('true');
    const close = sheet!.querySelector<HTMLButtonElement>('button[aria-label^="close"]');
    expect(close).not.toBeNull();
    await act(async () => {
      close!.click();
    });
    expect(inBody('schedule-sheet')).toBeNull();
  });
});
