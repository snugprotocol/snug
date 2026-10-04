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

import { createStore } from '../state/store.js';

import type { ChatMessage } from '../agent/useBuilderChat.js';
import type { BrainOptionView, BrainSwitchSeat, BrainSwitchState, PlatformBrain, SnugPlatform, TierChoice, TierSeat, TierState } from '../platform/platform.js';
import { hostPlatform as hostFixture } from './fixtures/hostPlatform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HOST_LABEL = 'Claude · this artifact’s viewer';
const idleAdapter: AgentAdapter = { complete: async () => ({ ok: true, text: '{}', toolCalls: [], stopReason: 'end' }) };

const hostPlatform = (brain: PlatformBrain = { kind: 'demo' }): SnugPlatform => hostFixture({ brain });

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

  it('host: no model selector, no connections door; the share door STAYS as the app-export door (T4 AC6: appExport on by absence)', async () => {
    const g = await fresh(hostPlatform());
    await render(<g.RunHeaderActions {...props} onManageConnections={() => undefined} onShare={() => undefined} />);
    expect(byTestId('app-model-select')).toBeNull();
    expect(byTestId('manage-connections')).toBeNull();
    expect(byTestId('share-app')).not.toBeNull();
  });

  it('host with appExport off as well: no share door at all', async () => {
    const base = hostPlatform();
    const g = await fresh({ ...base, capabilities: { ...base.capabilities, appExport: false } });
    await render(<g.RunHeaderActions {...props} onManageConnections={() => undefined} onShare={() => undefined} />);
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
  // MIGRATED (TASK-20261003, ADR-0072 §4 — named in the plan). The host arm used to end
  // ", so it runs in its sample mode": false for `weather`, which has none, and no longer what
  // the route does — a connected starter on a host without connections shows why it cannot
  // run instead of a frame. The web arm is unchanged, byte for byte.
  it('names the review under web; under host it says connections are unavailable and promises NO sample mode', async () => {
    const { starterInstallDisclosureTail } = await import('../run/copy.js');
    expect(starterInstallDisclosureTail(true)).toBe(
      '. installing only copies the app — nothing is connected until you review and approve it yourself.',
    );
    expect(starterInstallDisclosureTail(false)).toBe('. installing only copies the app — connections aren’t available in this host.');
    expect(starterInstallDisclosureTail(false)).not.toMatch(/sample mode/);
  });

  it('the sentence has ONE home: the disclosure and the chat card say it through the same constant', async () => {
    const { CONNECTIONS_UNAVAILABLE } = await import('../platform/availability.js');
    const { starterInstallDisclosureTail } = await import('../run/copy.js');
    expect(starterInstallDisclosureTail(false)).toContain(CONNECTIONS_UNAVAILABLE);
    // The chat log's directive card renders the same constant — pinned on the DOM below.
    expect(CONNECTIONS_UNAVAILABLE).toBe('connections aren’t available in this host');
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
    // TASK-20260906 AC5 twin: a host brain WITHOUT a tier seat shows no thinking-level control.
    expect(byTestId('brain-menu-tier')).toBeNull();
    expect(chip?.getAttribute('data-tier')).toBeNull();
  });

  // TASK-20260906-host-brain-tier-control (ADR-0067): the thinking level is the user's, from
  // the chip, ONLY where the brain carries a tier seat. A fake seat here — the kit's store is
  // the real one (apps/host/src/brains/tierStore.ts); the chip renders any seat honestly.
  function fakeTierSeat(initial: TierState): TierSeat & { sets: TierChoice[] } {
    const store = createStore<TierState>(initial);
    const sets: TierChoice[] = [];
    return {
      sets,
      options: ['quick', 'default', 'complex'],
      viewerDefault: 'default',
      auto: { app: 'quick', chat: 'default' },
      state: { get: store.get, subscribe: store.subscribe },
      set: (choice) => {
        sets.push(choice);
        store.set({ ...store.get(), choice });
      },
    };
  }
  const withSeat = (seat: TierSeat): SnugPlatform => hostPlatform({ kind: 'host', label: HOST_LABEL, adapter: idleAdapter, streaming: true, tools: false, tiers: seat });

  it('TASK-20260906 AC5: with a tier seat the popover lists auto first, then the three tiers with the viewer default marked; auto is selected; the D15 doors stay shut', async () => {
    const seat = fakeTierSeat({ choice: 'auto', unavailable: {} });
    const g = await fresh(withSeat(seat));
    await render(<g.BrainChip />);
    const chip = byTestId('brain-chip');
    expect(chip?.getAttribute('data-tier')).toBe('auto');
    expect(chip?.textContent).toBe(HOST_LABEL); // the label is unchanged (the 375 px header)
    await click(chip);
    const select = byTestId('brain-menu-tier');
    if (!(select instanceof HTMLSelectElement)) throw new Error('expected the thinking-level select');
    expect(select.getAttribute('aria-label')).toBe('thinking level');
    expect(select.value).toBe('auto');
    expect(Array.from(select.options).map((o) => [o.value, o.textContent, o.disabled])).toEqual([
      ['auto', 'auto — quick for app replies, default for building', false],
      ['quick', 'quick — answers at once, no thinking first', false],
      ['default', 'default — thinks first (the viewer’s default)', false],
      ['complex', 'complex — thinks longest, for hard reasoning', false],
    ]);
    expect(byTestId('brain-menu-settings')).toBeNull();
    expect(byTestId('brain-menu-ollama')).toBeNull();
    expect(byTestId('brain-menu-tier-note')).toBeNull();
  });

  it('TASK-20260906 AC2/AC5: choosing a tier calls the seat once, the select follows the seat’s state, the popover stays open', async () => {
    const seat = fakeTierSeat({ choice: 'auto', unavailable: {} });
    const g = await fresh(withSeat(seat));
    await render(<g.BrainChip />);
    await click(byTestId('brain-chip'));
    const select = byTestId('brain-menu-tier') as HTMLSelectElement;
    await act(async () => {
      select.value = 'complex';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(seat.sets).toEqual(['complex']);
    expect((byTestId('brain-menu-tier') as HTMLSelectElement).value).toBe('complex');
    expect(byTestId('brain-menu')).not.toBeNull();
    expect(byTestId('brain-chip')?.getAttribute('data-tier')).toBe('complex');
  });

  it('TASK-20260906 AC4: a substituted tier is disabled and annotated, the selection sits on what answered, and the note names both — all derived from the seat', async () => {
    const seat = fakeTierSeat({ choice: 'default', applied: { asked: 'complex', answered: 'default' }, unavailable: { complex: 'default' } });
    const g = await fresh(withSeat(seat));
    await render(<g.BrainChip />);
    await click(byTestId('brain-chip'));
    const select = byTestId('brain-menu-tier') as HTMLSelectElement;
    expect(select.value).toBe('default');
    const complex = Array.from(select.options).find((o) => o.value === 'complex');
    expect(complex?.disabled).toBe(true);
    expect(complex?.textContent).toBe('complex — not on this plan, answered on default');
    expect(byTestId('brain-menu-tier-note')?.textContent).toBe('asked for complex — this view answered on default (the viewer’s plan)');
  });

  it('TASK-20260906 (review C3): under auto, a pin the plan answered elsewhere is named by what answers in the auto label', async () => {
    const seat = fakeTierSeat({ choice: 'auto', applied: { asked: 'default', answered: 'quick' }, unavailable: { default: 'quick' } });
    const g = await fresh(withSeat(seat));
    await render(<g.BrainChip />);
    await click(byTestId('brain-chip'));
    const select = byTestId('brain-menu-tier') as HTMLSelectElement;
    expect(select.value).toBe('auto');
    expect(Array.from(select.options).find((o) => o.value === 'auto')?.textContent).toBe('auto — quick for app replies, quick for building');
    expect(Array.from(select.options).find((o) => o.value === 'default')?.textContent).toBe('default — not on this plan, answered on quick');
  });

  it('TASK-20260906 AC1 twin: the demo brain under host and the web chip render no thinking-level control', async () => {
    const demo = await fresh(hostPlatform({ kind: 'demo' }));
    demo.mode.providerStore.set('mock');
    await render(<demo.BrainChip />);
    await click(byTestId('brain-chip'));
    expect(byTestId('brain-menu-tier')).toBeNull();
    await act(async () => root?.unmount());
    container?.remove();
    const web = await fresh();
    await render(<web.BrainChip />);
    await click(byTestId('brain-chip'));
    expect(byTestId('brain-menu-tier')).toBeNull();
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

describe('the CLI model + effort control (ADR-0070, TASK-20260922 S7)', () => {
  // MIGRATED 2026-10-03 (TASK-20261003 R4, ADR-0071 — `cliModel` → `brainSwitch`, named in
  // the plan), claim by claim. The control hung off the HOST BRAIN as `cliModel`, existed
  // only while Claude was ready, and offered a hard-coded five levels. It is the platform's
  // `brainSwitch` now: the controls are the ANSWERING brain's, the models and levels are the
  // ones the runner lists for it, and every test id is kept. Each test below keeps its
  // claim; where the words changed the test says so. What the switcher ADDS (the rows, auto,
  // the remedies, "check again") is brainChip.test.tsx.
  const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
  const CLAUDE: BrainOptionView = {
    id: 'claude',
    name: 'Claude',
    via: 'your Claude Code CLI',
    state: 'ready',
    verified: true,
    efforts: FIVE,
    models: [
      { id: 'claude-opus-5-5', name: 'Opus 5.5', efforts: FIVE },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', efforts: [] },
    ],
  };
  const NOTE = 'Thinking itself is never shown. A switch takes effect on your next think and spends nothing; that think may start a little slower, because a brain kept ready for the old choice is started again.';

  function fakeSwitch(initial: Partial<BrainSwitchState> = {}): BrainSwitchSeat & { models_: (string | undefined)[]; efforts_: (string | undefined)[] } {
    const store = createStore<BrainSwitchState>({ choice: 'auto', active: 'claude', brains: [CLAUDE], checking: false, ...initial });
    const models_: (string | undefined)[] = [];
    const efforts_: (string | undefined)[] = [];
    return {
      models_,
      efforts_,
      note: NOTE,
      state: { get: store.get, subscribe: store.subscribe },
      choose: (choice) => store.set({ ...store.get(), choice }),
      setModel: (model) => {
        models_.push(model);
        store.set({ ...store.get(), model });
      },
      setEffort: (effort) => {
        efforts_.push(effort);
        store.set({ ...store.get(), effort });
      },
      recheck: async () => undefined,
    };
  }
  const hostBrain: PlatformBrain = { kind: 'host', label: HOST_LABEL, adapter: idleAdapter, streaming: false, tools: false };
  const withCli = (seat: BrainSwitchSeat, brain: PlatformBrain = hostBrain): SnugPlatform => hostFixture({ binding: 'local-host', brain, brainSwitch: seat });

  it('renders the effort select and the model field, and says what is ACTIVE', async () => {
    const seat = fakeSwitch({ answered: { brain: 'claude', model: 'claude-haiku-4-5-20251001' }, effort: 'low' });
    const g = await fresh(withCli(seat));
    await render(<g.BrainChip />);
    await click(byTestId('brain-chip'));
    const select = byTestId('brain-menu-effort') as HTMLSelectElement;
    expect(select.value).toBe('low');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect((byTestId('brain-menu-model-select') as HTMLSelectElement).value).toBe('');
    expect(byTestId('brain-menu-active')?.textContent).toContain('claude-haiku-4-5-20251001');
  });

  it('a chosen model shows in the field, and the switch reaches the seat', async () => {
    const seat = fakeSwitch({ model: 'haiku' });
    const g = await fresh(withCli(seat));
    await render(<g.BrainChip />);
    await click(byTestId('brain-chip'));
    // A model the catalogue does not list stays VISIBLE rather than reading as "default".
    const select = byTestId('brain-menu-model-select') as HTMLSelectElement;
    expect(select.value).toBe('haiku');
    await act(async () => {
      select.value = 'claude-opus-5-5';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(seat.models_).toContain('claude-opus-5-5');
  });

  it('choosing an effort reaches the seat, and the empty option clears it', async () => {
    const seat = fakeSwitch();
    const g = await fresh(withCli(seat));
    await render(<g.BrainChip />);
    await click(byTestId('brain-chip'));
    const select = byTestId('brain-menu-effort') as HTMLSelectElement;
    await act(async () => {
      select.value = 'max';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(seat.efforts_).toContain('max');
    await act(async () => {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(seat.efforts_).toContain(undefined);
  });

  it('shows a refusal in the CLI’s own words', async () => {
    const seat = fakeSwitch({ refusal: 'There’s an issue with the selected model (nope-not-a-model).' });
    const g = await fresh(withCli(seat));
    await render(<g.BrainChip />);
    await click(byTestId('brain-chip'));
    expect(byTestId('brain-menu-cli-note')?.textContent).toContain('nope-not-a-model');
  });

  it('says thinking is never shown and what a switch costs (Q4/Q5)', async () => {
    const g = await fresh(withCli(fakeSwitch()));
    await render(<g.BrainChip />);
    await click(byTestId('brain-chip'));
    expect(byTestId('brain-menu-cli-hint')?.textContent).toMatch(/thinking/i);
    expect(byTestId('brain-menu-cli-hint')?.textContent).toMatch(/next think/i);
  });

  it('S9/S10: lists the CLI\u2019s own models by display name, default first, and NO other\u2026 rung (owner, 2026-10-02)', async () => {
    const g = await fresh(withCli(fakeSwitch()));
    await render(<g.BrainChip />);
    await click(byTestId('brain-chip'));
    const options = Array.from((byTestId('brain-menu-model-select') as HTMLSelectElement).options);
    // No `other\u2026`: it swapped the dropdown for a text field with no way back (owner's walk).
    // (The default's words were "the CLI\u2019s default"; the brain is named now \u2014 there is more than one.)
    expect(options.map((o) => o.textContent)).toEqual(['Claude\u2019s default', 'Opus 5.5', 'Haiku 4.5']);
    // The VALUES are the exact ids, which is what makes a typo impossible.
    expect(options[1]?.value).toBe('claude-opus-5-5');
  });

  it('S9: choosing a model sends its EXACT id, never the display name', async () => {
    const seat = fakeSwitch();
    const g = await fresh(withCli(seat));
    await render(<g.BrainChip />);
    await click(byTestId('brain-chip'));
    const select = byTestId('brain-menu-model-select') as HTMLSelectElement;
    await act(async () => {
      select.value = 'claude-haiku-4-5-20251001';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(seat.models_).toContain('claude-haiku-4-5-20251001');
  });

  it('S9: with NO catalogue the model control is free text alone, never an empty dropdown', async () => {
    const seat = fakeSwitch({ brains: [{ ...CLAUDE, models: [] }] });
    const g = await fresh(withCli(seat));
    await render(<g.BrainChip />);
    await click(byTestId('brain-chip'));
    expect(byTestId('brain-menu-model-select')).toBeNull();
    const field = byTestId('brain-menu-model');
    if (!(field instanceof HTMLInputElement)) throw new Error('expected the free-text model field');
    // React listens for a text field's change through the native `input` event.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'claude-some-future-model');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(seat.models_).toContain('claude-some-future-model');
  });

  it('S9: a model with no effort axis (Haiku) hides the thinking-level control (AC8)', async () => {
    const g = await fresh(withCli(fakeSwitch({ model: 'claude-haiku-4-5-20251001' })));
    await render(<g.BrainChip />);
    await click(byTestId('brain-chip'));
    expect(byTestId('brain-menu-effort')).toBeNull();
    // …while the model control stays, so the user can switch back off it.
    expect(byTestId('brain-menu-model-select')).not.toBeNull();
  });

  it('S12: the chip shows the thinking level in a smaller line under its label', async () => {
    const g = await fresh(withCli(fakeSwitch({ effort: 'low' })));
    await render(<g.BrainChip />);
    expect(byTestId('brain-chip-effort')?.textContent).toBe('thinking · low');
    // The label line itself is untouched — it is an API (tests, AT, docs).
    expect(byTestId('brain-chip')?.querySelector('.brain-chip-label')?.textContent).toBe(HOST_LABEL);
  });

  it('S12: with no level chosen it says "default" — the CLI reports its default level nowhere, so none is invented', async () => {
    const g = await fresh(withCli(fakeSwitch()));
    await render(<g.BrainChip />);
    expect(byTestId('brain-chip-effort')?.textContent).toBe('thinking · default');
  });

  it('S12: the line follows a switch made in the popover, live', async () => {
    const seat = fakeSwitch();
    const g = await fresh(withCli(seat));
    await render(<g.BrainChip />);
    await click(byTestId('brain-chip'));
    const select = byTestId('brain-menu-effort') as HTMLSelectElement;
    await act(async () => {
      select.value = 'max';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(byTestId('brain-chip-effort')?.textContent).toBe('thinking · max');
  });

  it('S12: the accessible name carries the level too', async () => {
    const g = await fresh(withCli(fakeSwitch({ effort: 'high' })));
    await render(<g.BrainChip />);
    expect(byTestId('brain-chip')?.getAttribute('aria-label')).toMatch(/thinking level high$/);
  });

  it('S12: NO level line for a model without an effort axis (Haiku) — a level it ignores is noise (AC8)', async () => {
    const g = await fresh(withCli(fakeSwitch({ model: 'claude-haiku-4-5-20251001', effort: 'low' })));
    await render(<g.BrainChip />);
    expect(byTestId('brain-chip-effort')).toBeNull();
  });

  it('S12: NO level line on a host brain without the seat, nor while no brain answers (a non-ready CLI)', async () => {
    const chat = await fresh(hostPlatform({ kind: 'host', label: HOST_LABEL, adapter: idleAdapter, streaming: false, tools: false }));
    await render(<chat.BrainChip />);
    expect(byTestId('brain-chip-effort')).toBeNull();
    await act(async () => root?.unmount());
    container?.remove();
    // The runner, its one brain logged out: the demo brain stands in, and there is no level to name.
    const { active: _none, ...standingIn } = fakeSwitch({ brains: [{ ...CLAUDE, state: 'logged-out' }], effort: 'low' }).state.get();
    const seat = fakeSwitch();
    const g = await fresh(withCli({ ...seat, state: { get: () => standingIn, subscribe: seat.state.subscribe } }, { kind: 'demo' }));
    g.mode.providerStore.set('mock');
    await render(<g.BrainChip />);
    expect(byTestId('brain-chip')?.getAttribute('data-brain')).toBe('demo');
    expect(byTestId('brain-chip-effort')).toBeNull();
  });

  it('a host brain with NO seat shows no control; and neither does the runner while no brain answers (AC8)', async () => {
    const chat = await fresh(hostPlatform({ kind: 'host', label: HOST_LABEL, adapter: idleAdapter, streaming: false, tools: false }));
    await render(<chat.BrainChip />);
    await click(byTestId('brain-chip'));
    expect(byTestId('brain-menu-effort')).toBeNull();
    expect(byTestId('brain-menu-model')).toBeNull();
    expect(byTestId('brain-menu-model-select')).toBeNull();
    await act(async () => root?.unmount());
    container?.remove();
    const { active: _none, ...standingIn } = fakeSwitch({ brains: [{ ...CLAUDE, state: 'logged-out' }] }).state.get();
    const seat = fakeSwitch();
    const g = await fresh(withCli({ ...seat, state: { get: () => standingIn, subscribe: seat.state.subscribe } }, { kind: 'demo' }));
    g.mode.providerStore.set('mock');
    await render(<g.BrainChip />);
    await click(byTestId('brain-chip'));
    expect(byTestId('brain-menu')).not.toBeNull();
    for (const control of ['brain-menu-effort', 'brain-menu-model', 'brain-menu-model-select', 'brain-menu-active', 'brain-menu-cli-hint']) expect(byTestId(control), control).toBeNull();
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
