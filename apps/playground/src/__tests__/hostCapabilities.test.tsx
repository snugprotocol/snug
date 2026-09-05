// hostCapabilities.test.tsx — TASK-20260905-host-kit P3 / AC4 / AC5: the run-surface
// gates under the HOST platform, each with its positive twin under the web default
// (lesson 2026-08-21: every negative reachability check owes a positive twin).
//
// D15 hides the controls that CHOOSE a brain (`ModelSelect`, the chip's switch links,
// the mode-coercion note that points at the hidden brain section); capability truth hides
// what an artifact cannot honour (the connections door, the directive card's connect
// button, the share control — the relay is unreachable behind `connect-src 'self'`).
// Everything is asserted against the RENDERED DOM. The platform is set-once, so each case
// takes a fresh module graph (the desktopSettingsView pattern).
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentAdapter } from '@snugprotocol/adapters';

import type { ChatMessage } from '../agent/useBuilderChat.js';
import type { PlatformBrain, SnugPlatform } from '../platform/platform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HOST_LABEL = 'Claude · this artifact’s viewer';
const idleAdapter: AgentAdapter = { complete: async () => ({ ok: true, text: '{}', toolCalls: [], stopReason: 'end' }) };

function hostPlatform(brain: PlatformBrain = { kind: 'demo' }): SnugPlatform {
  return {
    kind: 'host',
    binding: 'artifact',
    brain,
    capabilities: {
      subscriptionMode: false,
      hubSyncOrigin: false,
      lanHttpPrivate: false,
      hubAuth: false,
      brainSettings: false,
      account: false,
      sync: false,
      connections: false,
      share: false,
    },
  };
}

interface Graph {
  RunHeaderActions: typeof import('../run/RunHeaderActions.js')['RunHeaderActions'];
  BrainChip: typeof import('../views/BrainChip.js')['BrainChip'];
  chipCopy: typeof import('../views/BrainChip.js');
  ModeCoercionNote: typeof import('../desktop/ModeCoercionNote.js')['ModeCoercionNote'];
  ChatLog: typeof import('../views/ChatLog.js')['ChatLog'];
  mode: typeof import('../state/mode.js');
}

async function fresh(platform?: SnugPlatform): Promise<Graph> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  await helper.installTestUserDb();
  const mode = await import('../state/mode.js');
  mode.modeStore.set('byok');
  // A keyed provider, so the model selector has something to render under web (the
  // demo provider shows the 'no models' hint instead — a different surface).
  mode.providerStore.set('anthropic');
  mode.byokKeyPresenceStore.set({ anthropic: true, openai: false });
  const chipModule = await import('../views/BrainChip.js');
  return {
    RunHeaderActions: (await import('../run/RunHeaderActions.js')).RunHeaderActions,
    BrainChip: chipModule.BrainChip,
    chipCopy: chipModule,
    ModeCoercionNote: (await import('../desktop/ModeCoercionNote.js')).ModeCoercionNote,
    ChatLog: (await import('../views/ChatLog.js')).ChatLog,
    mode,
  };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
  vi.resetModules();
});

async function render(node: ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const byTestId = (id: string): HTMLElement | null => (container?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null) ?? null;

async function click(el: Element | null): Promise<void> {
  if (!(el instanceof HTMLElement)) throw new Error('nothing to click');
  await act(async () => {
    el.click();
  });
}

describe('the run header cluster (P3: ModelSelect, connections door, share)', () => {
  const props = { appId: 'app-host-1', isStarter: false, connectionSlots: 1 };

  it('host: no model selector, no connections door, no share control', async () => {
    const g = await fresh(hostPlatform());
    await render(<g.RunHeaderActions {...props} onManageConnections={() => undefined} onShare={() => undefined} />);
    expect(byTestId('app-model-select')).toBeNull();
    expect(byTestId('manage-connections')).toBeNull();
    expect(byTestId('share-app')).toBeNull();
  });

  it('web (positive twin): all three render for an owned app with connection rows', async () => {
    const g = await fresh();
    await render(<g.RunHeaderActions {...props} onManageConnections={() => undefined} onShare={() => undefined} />);
    expect(byTestId('app-model-select')).not.toBeNull();
    expect(byTestId('manage-connections')).not.toBeNull();
    expect(byTestId('share-app')).not.toBeNull();
  });
});

describe('the starter install disclosure tail (copy pass: never instruct a hidden control)', () => {
  it('names the review under web and the sample-mode consequence under host', async () => {
    const { starterInstallDisclosureTail } = await import('../run/copy.js');
    expect(starterInstallDisclosureTail(true)).toBe(
      '. installing only copies the app — nothing is connected until you review and approve it yourself.',
    );
    expect(starterInstallDisclosureTail(false)).toBe(
      '. installing only copies the app — connections aren’t available in this host, so it runs in its sample mode.',
    );
  });
});

describe('the brain chip (AC5: disclosure only)', () => {
  it('host + pinned demo brain: names the missing host brain, offers no switch, no key invitation', async () => {
    const g = await fresh(hostPlatform({ kind: 'demo' }));
    g.mode.providerStore.set('mock');
    await render(<g.BrainChip />);
    const chip = byTestId('brain-chip');
    expect(chip?.textContent).toContain('demo brain');
    await click(chip);
    const menu = byTestId('brain-menu');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain(g.chipCopy.HOST_NO_BRAIN_HEADLINE);
    expect(g.chipCopy.HOST_NO_BRAIN_HEADLINE).toBe('demo brain — no host brain wired yet');
    expect(byTestId('brain-menu-settings')).toBeNull();
    expect(byTestId('brain-menu-ollama')).toBeNull();
    expect(menu?.textContent).not.toContain(g.chipCopy.BYOK_HONESTY_COPY);
  });

  it("host + pinned host brain: the chip carries the host's own label and still offers no switch", async () => {
    const g = await fresh(hostPlatform({ kind: 'host', label: HOST_LABEL, adapter: idleAdapter, streaming: true, tools: true }));
    await render(<g.BrainChip />);
    const chip = byTestId('brain-chip');
    expect(chip?.textContent).toContain(HOST_LABEL);
    expect(chip?.getAttribute('data-brain')).toBe('host');
    await click(chip);
    expect(byTestId('brain-menu')?.textContent).toContain(HOST_LABEL);
    expect(byTestId('brain-menu-settings')).toBeNull();
  });

  it('web (positive twin): the demo chip offers the settings door and the key invitation', async () => {
    const g = await fresh();
    g.mode.providerStore.set('mock');
    g.mode.byokKeyPresenceStore.set({ anthropic: false, openai: false });
    await render(<g.BrainChip />);
    await click(byTestId('brain-chip'));
    expect(byTestId('brain-menu-settings')).not.toBeNull();
    expect(byTestId('brain-menu')?.textContent).toContain(g.chipCopy.BYOK_HONESTY_COPY);
  });
});

describe('the mode-coercion note (its copy points at the hidden brain section)', () => {
  it('host: renders nothing even when the file was coerced', async () => {
    const g = await fresh(hostPlatform());
    g.mode.modeCoercedStore.set(true);
    await render(<g.ModeCoercionNote />);
    expect(byTestId('mode-coercion-note')).toBeNull();
  });

  it('web (positive twin): renders the note when coerced', async () => {
    const g = await fresh();
    g.mode.modeCoercedStore.set(true);
    await render(<g.ModeCoercionNote />);
    expect(byTestId('mode-coercion-note')).not.toBeNull();
  });
});

describe("the chat log's directive card (D4: no connected apps inside an artifact)", () => {
  // The card reads `directive.proposal.providerName` only; the rest of the validated
  // directive is irrelevant here, so the fixture is cast rather than fully built.
  const directiveMessage = {
    id: 1,
    role: 'agent',
    displayText: 'you will need to connect Example API.',
    directive: { proposal: { providerName: 'Example API' } },
  } as unknown as ChatMessage;

  it('host: the card names the provider but offers no connect button and says why', async () => {
    const g = await fresh(hostPlatform());
    await render(<g.ChatLog messages={[directiveMessage]} onDirectiveConnect={() => undefined} />);
    const card = byTestId('auth-directive-card');
    expect(card).not.toBeNull();
    expect(card?.querySelector('button')).toBeNull();
    expect(card?.textContent).toContain('connections aren’t available in this host');
  });

  it('web (positive twin): the connect button renders when a mount is supplied', async () => {
    const g = await fresh();
    await render(<g.ChatLog messages={[directiveMessage]} onDirectiveConnect={() => undefined} />);
    expect(byTestId('auth-directive-card')?.querySelector('button')?.textContent).toBe('connect');
  });
});
