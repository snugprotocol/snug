// brainChip — TASK-20260826-demo-brain-clarity AC3/AC4 (ADR-0059 rules 1/4).
//
// AC3: the chip renders on every brain state, labeled from the ONE live derivation
// (state/activeBrain.ts), never disappears, and flips WITHOUT a reload when the
// feeding stores change (adding a key re-resolves the provider — the chip must
// follow). Accessible name pinned: on-screen text is an API (lessons 2026-08-18).
//
// AC4: clicking opens a popover with one honest sentence for the current brain and
// the switch affordances — settings link always; "use ollama now" ONLY when the
// probe actually found models (the DesktopWelcome rule: never offer a button that
// cannot work). The load-bearing honesty copy is byte-pinned here: the demo body
// names the mechanism, and the BYOK invitation claims exactly what the code
// vouches for — key in the user's file, sent only to the chosen provider, never to
// Snug's servers. Esc/outside-click close with focus restore (IdentityChip contract).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrainChip, BYOK_HONESTY_COPY, DEMO_BRAIN_BODY } from '../views/BrainChip.js';
import { builderPickStore } from '../state/builderModel.js';
import { byokKeyPresenceStore, modeStore, providerStore } from '../state/mode.js';
import * as mode from '../state/mode.js';
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

function render(node: ReactElement): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
}

const chip = (): HTMLButtonElement => {
  const el = document.querySelector('[data-testid="brain-chip"]');
  if (!(el instanceof HTMLButtonElement)) throw new Error('brain chip not rendered');
  return el;
};

const menu = (): HTMLElement | null => document.querySelector('[data-testid="brain-menu"]');

beforeEach(async () => {
  // The ollama action persists the mode via the page user DB — a memory-backed
  // double keeps jsdom away from sql.js's browser wasm resolution.
  await installTestUserDb();
  modeStore.set('byok');
  providerStore.set('mock');
  byokKeyPresenceStore.set({ anthropic: false, openai: false });
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  ollamaStore.set('unknown');
  builderPickStore.set(undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  vi.restoreAllMocks();
});

describe('the brain chip (AC3)', () => {
  it('names the demo brain on the zero-key default, with the demo marker', () => {
    render(<BrainChip />);
    expect(chip().textContent).toContain('demo brain');
    expect(chip().dataset.brain).toBe('demo');
    // The accessible name carries the state even when CSS compacts the label.
    expect(chip().getAttribute('aria-label')).toBe('what’s thinking: demo brain — scripted, no AI service');
  });

  it('flips to the real provider without a reload when a key lands', () => {
    render(<BrainChip />);
    expect(chip().dataset.brain).toBe('demo');
    act(() => {
      byokKeyPresenceStore.set({ anthropic: true, openai: false });
      providerStore.set('anthropic');
    });
    expect(chip().dataset.brain).toBe('anthropic');
    expect(chip().textContent).toContain('claude');
  });

  it('renders every non-demo state without the demo marker', () => {
    render(<BrainChip />);
    act(() => modeStore.set('local'));
    expect(chip().dataset.brain).toBe('local');
    act(() => modeStore.set('subscription'));
    expect(chip().dataset.brain).toBe('subscription');
    act(() => {
      webllmFlagStore.set(true);
      webgpuStore.set('yes');
    });
    expect(chip().dataset.brain).toBe('webllm');
  });
});

describe('the brain menu (AC4)', () => {
  it('opens with the pinned demo body and the pinned BYOK honesty copy', () => {
    render(<BrainChip />);
    act(() => chip().click());
    const opened = menu();
    expect(opened).not.toBeNull();
    expect(opened!.textContent).toContain(DEMO_BRAIN_BODY);
    expect(opened!.textContent).toContain(BYOK_HONESTY_COPY);
    // The claims themselves, byte-pinned — editing them is a decision, not a tweak.
    expect(DEMO_BRAIN_BODY).toBe(
      'a tiny script inside this page fakes the AI so you can try the flow — no AI model or service is called.',
    );
    expect(BYOK_HONESTY_COPY).toBe(
      'your key is saved in your Snug file on this device and sent only to the AI provider you choose — never to Snug’s servers.',
    );
    // The overclaim this task forbids must not creep back in any spelling.
    expect(opened!.textContent!.toLowerCase()).not.toContain('never leaves your device');
  });

  it('always offers the settings route; the demo state phrases it as the key invitation', () => {
    render(<BrainChip />);
    act(() => chip().click());
    const keyLink = document.querySelector('[data-testid="brain-menu-settings"]');
    expect(keyLink).toBeInstanceOf(HTMLAnchorElement);
    expect((keyLink as HTMLAnchorElement).getAttribute('href')).toBe('/settings');
    expect(keyLink!.textContent).toContain('use your own AI key');
  });

  it('hides "use ollama now" while the webllm override is active — setMode would be inert there', () => {
    // Gate-5 review: under ?webllm=1 the brain override outranks the configured mode
    // entirely (ADR-0015), so the shortcut's setMode('local') would visibly do
    // nothing while silently persisting a mode write. The DesktopWelcome rule —
    // never offer a button that cannot work — applies to the menu too.
    act(() => {
      webllmFlagStore.set(true);
      webgpuStore.set('no'); // demo fallback: the chip still says demo…
      ollamaStore.set({ running: true, models: ['llama3.2'] });
    });
    render(<BrainChip />);
    expect(chip().dataset.brain).toBe('demo');
    act(() => chip().click());
    expect(menu()).not.toBeNull();
    // …but the one-gesture switch is withheld; the settings door remains.
    expect(document.querySelector('[data-testid="brain-menu-ollama"]')).toBeNull();
    expect(document.querySelector('[data-testid="brain-menu-settings"]')).not.toBeNull();
  });

  it('offers "use ollama now" ONLY when the probe found models, and it switches the mode', () => {
    render(<BrainChip />);
    act(() => chip().click());
    expect(document.querySelector('[data-testid="brain-menu-ollama"]')).toBeNull();

    act(() => ollamaStore.set({ running: true, models: ['llama3.2', 'qwen3'] }));
    const setModeSpy = vi.spyOn(mode, 'setMode');
    const ollamaButton = document.querySelector('[data-testid="brain-menu-ollama"]');
    expect(ollamaButton).toBeInstanceOf(HTMLButtonElement);
    expect(ollamaButton!.textContent).toContain('2 models');
    act(() => (ollamaButton as HTMLButtonElement).click());
    expect(setModeSpy).toHaveBeenCalledWith('local');
    // Acting on the menu closes it.
    expect(menu()).toBeNull();
  });

  it('closes on Escape and outside click, restoring focus to the chip', () => {
    render(<BrainChip />);
    act(() => chip().click());
    expect(menu()).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(chip());

    act(() => chip().click());
    expect(menu()).not.toBeNull();
    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(menu()).toBeNull();
  });

  it('a real-provider state gets its own honest sentence, not the demo pitch', () => {
    act(() => {
      byokKeyPresenceStore.set({ anthropic: true, openai: false });
      providerStore.set('anthropic');
    });
    render(<BrainChip />);
    act(() => chip().click());
    const opened = menu();
    expect(opened!.textContent).not.toContain(DEMO_BRAIN_BODY);
    expect(opened!.textContent).toContain('browser-direct to Anthropic');
    // The settings route stays reachable after switching — the chip never nags,
    // but it keeps being the door.
    expect(document.querySelector('[data-testid="brain-menu-settings"]')).not.toBeNull();
  });
});

// =====================================================================================
// THE BRAIN SWITCHER (TASK-20261003 R4 — B6, B8; ADR-0071 §4). On a host whose platform
// carries `brainSwitch` — the local runner, where the brain is one of the user's OWN agents —
// the chip is the switcher: what is answering now, `auto`, one row per agent with its state
// and its remedy, the answering agent's model and thinking level, and "check again". Every
// other platform's chip is the status chip above, unchanged.
//
// The platform is set once per module graph, so each case takes a fresh one (the
// hostCapabilities pattern). The seat is a fake: the runner's composition is the real one
// (apps/host composeLocal.test.ts); the chip must render ANY seat honestly.
// =====================================================================================

describe('the brain switcher — a host that carries brainSwitch (B6, B8)', () => {
  type Platform = import('../platform/platform.js').SnugPlatform;
  type Seat = import('../platform/platform.js').BrainSwitchSeat;
  type State = import('../platform/platform.js').BrainSwitchState;
  type Option = import('../platform/platform.js').BrainOptionView;

  const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
  const CLAUDE: Option = {
    id: 'claude',
    name: 'Claude',
    via: 'your Claude Code CLI',
    state: 'ready',
    verified: true,
    efforts: FIVE,
    models: [
      { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', efforts: FIVE },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', efforts: [] },
    ],
  };
  const CODEX: Option = {
    id: 'codex',
    name: 'Codex',
    via: 'your Codex CLI',
    state: 'ready',
    verified: false,
    efforts: ['minimal', 'low', 'medium', 'high'],
    models: [{ id: 'gpt-5.5', name: 'GPT-5.5', efforts: ['low', 'high'] }],
  };
  const CODEX_REMEDY = 'Your Codex CLI is not logged in — run `codex login`, then check again.';
  const CLAUDE_REMEDY = 'Your Claude CLI is not logged in — run `claude` and `/login`, then check again.';
  const loggedOut = (brain: Option, detail: string): Option => ({ ...brain, state: 'logged-out', detail });

  interface FakeSeat extends Seat {
    chosen: string[];
    rechecks: number;
    efforts_: (string | undefined)[];
    /** Move the state as the runner's composition would. */
    set(next: Partial<State>): void;
    /** End a re-check in flight. */
    landed(): void;
  }

  /** A seat over a store. `choose` resolves like the composition: a pin answers if ready, auto is the default brain. */
  async function fakeSeat(initial: Partial<State> = {}): Promise<FakeSeat> {
    const { createStore } = await import('../state/store.js');
    const store = createStore<State>({ choice: 'auto', active: 'claude', brains: [CLAUDE, CODEX], checking: false, ...initial });
    const chosen: string[] = [];
    const efforts_: (string | undefined)[] = [];
    let landed = (): void => undefined;
    const seat: FakeSeat = {
      chosen,
      efforts_,
      rechecks: 0,
      note: 'Thinking itself is never shown. A switch takes effect on your next think and spends nothing.',
      state: { get: store.get, subscribe: store.subscribe },
      set: (next) => store.set({ ...store.get(), ...next }),
      landed: () => landed(),
      choose: (choice) => {
        chosen.push(choice);
        const { model: _m, effort: _e, ...rest } = store.get();
        store.set({ ...rest, choice, active: choice === 'auto' ? 'claude' : choice });
      },
      setModel: (model) => store.set({ ...store.get(), model }),
      setEffort: (effort) => {
        efforts_.push(effort);
        store.set({ ...store.get(), effort });
      },
      recheck: () => {
        seat.rechecks += 1;
        store.set({ ...store.get(), checking: true });
        return new Promise<void>((resolve) => {
          landed = () => {
            store.set({ ...store.get(), checking: false });
            resolve();
          };
        });
      },
    };
    return seat;
  }

  const idle = { complete: async () => ({ ok: true as const, text: '{}', toolCalls: [], stopReason: 'end' as const }) };

  /** The runner's platform: the brain is a LIVE getter over the seat — the host arm while a brain answers, the demo brain otherwise. */
  async function mount(seat: FakeSeat): Promise<{ bump(): void }> {
    vi.resetModules();
    const platformModule = await import('../platform/platform.js');
    const { hostPlatform } = await import('./fixtures/hostPlatform.js');
    const signals = await import('../platform/signals.js');
    const label = (): string => {
      const state = seat.state.get();
      const answering = state.brains.find((brain) => brain.id === state.active);
      const model = answering?.models.find((listed) => listed.id === state.model)?.name ?? state.model;
      return `${answering?.name ?? '?'} · ${model ?? 'your CLI'}`;
    };
    const host = { kind: 'host' as const, adapter: idle, streaming: true, tools: false, get label() { return label(); } };
    const platform: Platform = hostPlatform({ binding: 'local-host', brainSwitch: seat });
    Object.defineProperty(platform, 'brain', { enumerable: true, get: () => (seat.state.get().active === undefined ? { kind: 'demo' } : host) });
    // What the composition does on every change of what answers.
    seat.state.subscribe(() => signals.bumpBrainRevision());
    platformModule.setPlatform(platform);
    const helper = await import('./userdbTestHelper.js');
    await helper.installTestUserDb();
    const chipModule = await import('../views/BrainChip.js');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <chipModule.BrainChip />
        </MemoryRouter>,
      );
    });
    return { bump: () => signals.bumpBrainRevision() };
  }

  const byId = (id: string): HTMLElement | null => container?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
  const need = (id: string): HTMLElement => {
    const found = byId(id);
    if (found === null) throw new Error(`no [data-testid="${id}"]`);
    return found;
  };
  const press = async (el: HTMLElement): Promise<void> => {
    await act(async () => {
      el.click();
    });
  };
  const open = async (): Promise<void> => press(need('brain-chip'));
  const text = (id: string): string => need(id).textContent ?? '';

  afterEach(() => {
    vi.resetModules();
  });

  describe('what is answering NOW', () => {
    it('the header names the brain and model the next think carries; the chip says the same', async () => {
      await mount(await fakeSeat({ model: 'claude-sonnet-5-5', effort: 'low' }));
      expect(need('brain-chip').dataset.brain).toBe('host');
      expect(need('brain-chip').querySelector('.brain-chip-label')?.textContent).toBe('Claude · Sonnet 5.5');
      await open();
      expect(need('brain-menu').getAttribute('role')).toBe('group');
      expect(text('brain-dock-now')).toBe('answering nowClaude · Sonnet 5.5');
      expect(byId('brain-dock-standin'), 'nothing is standing in for anything').toBeNull();
    });

    it('the answering row says "answering" — in a WORD, not only a colour — and no other row does', async () => {
      await mount(await fakeSeat());
      await open();
      const claude = need('brain-option-claude');
      expect(claude.dataset.answering).toBe('true');
      expect(claude.querySelector('.brain-row-state')?.textContent).toBe('answering');
      expect(need('brain-option-codex').dataset.answering).toBe('false');
      expect(need('brain-option-codex').querySelector('.brain-row-state')?.textContent).toBe('ready');
    });

    it('under auto the CHOICE and the ANSWER are on different rows: auto is pressed, Claude is answering', async () => {
      await mount(await fakeSeat());
      await open();
      expect(need('brain-switch-auto').getAttribute('aria-pressed')).toBe('true');
      expect(need('brain-option-claude').getAttribute('aria-pressed')).toBe('false');
      expect(need('brain-option-claude').dataset.answering).toBe('true');
    });

    it('names what ANSWERED, never what was asked: a chosen model is not "thinking on" until a think comes back on it', async () => {
      const seat = await fakeSeat({ model: 'claude-sonnet-5-5' });
      await mount(seat);
      await open();
      // MIGRATED in R4's round-2 fix: this pinned "thinking on Claude's default model" with
      // Sonnet chosen — untrue, the next think carries Sonnet. Asked-for is said as asked-for.
      expect(text('brain-menu-active')).toBe('next think asks for Sonnet 5.5, level default — what answers is shown here after it');
      await act(async () => seat.set({ answered: { brain: 'claude', model: 'claude-sonnet-5-5[1m]' }, effort: 'high' }));
      expect(text('brain-menu-active')).toBe('thinking on claude-sonnet-5-5[1m], level high');
    });

    it('what ANOTHER brain answered on is not this brain’s: after a pin the line starts over', async () => {
      const seat = await fakeSeat({ answered: { brain: 'claude', model: 'claude-sonnet-5-5' } });
      await mount(seat);
      await open();
      await press(need('brain-option-codex'));
      expect(text('brain-menu-active')).toBe('thinking on Codex’s default model (known after the first think), level default');
    });
  });

  describe('auto, first', () => {
    it('is the first row, and says in one plain line what auto means here', async () => {
      await mount(await fakeSeat());
      await open();
      const rows = [...need('brain-menu').querySelectorAll('.brain-dock-list > [data-testid]')].map((row) => row.getAttribute('data-testid'));
      expect(rows).toEqual(['brain-switch-auto', 'brain-option-claude', 'brain-option-codex']);
      expect(text('brain-switch-auto')).toBe('autoanswers on Claude — and never switches to another agent by itself.');
    });

    it('with the default agent not ready it says WHICH — never "nothing is ready" above a row that says ready — and that auto will not go to another agent on its own', async () => {
      // MIGRATED (R4 fix): this pinned "nothing is ready…" while the Codex row two lines
      // below it read "ready" (found by looking at the built page).
      const { active: _none, ...state } = (await fakeSeat({ brains: [loggedOut(CLAUDE, CLAUDE_REMEDY), CODEX] })).state.get();
      const seat = await fakeSeat();
      await mount({ ...seat, state: { get: () => state, subscribe: seat.state.subscribe } });
      await open();
      expect(text('brain-switch-auto')).toBe('autoClaude is not ready, so the demo brain answers — auto never switches to another agent by itself.');
      expect(need('brain-option-codex').querySelector('.brain-row-state')?.textContent).toBe('ready');
      expect(need('brain-menu').textContent).not.toMatch(/nothing is ready|no agent is ready/);
    });

    it('while a brain is pinned it says what choosing it would do; choosing it reaches the seat', async () => {
      const seat = await fakeSeat({ choice: 'codex', active: 'codex' });
      await mount(seat);
      await open();
      expect(need('brain-switch-auto').getAttribute('aria-pressed')).toBe('false');
      expect(text('brain-switch-auto')).toBe('autoyour default agent when it is ready, the demo brain when it is not — never another agent.');
      await press(need('brain-switch-auto'));
      expect(seat.chosen).toEqual(['auto']);
      expect(need('brain-switch-auto').getAttribute('aria-pressed')).toBe('true');
    });

    it('is NEVER shown as an unverified brain — even if a seat said one was active under auto', async () => {
      await mount(await fakeSeat({ active: 'codex' }));
      await open();
      expect(text('brain-switch-auto')).not.toContain('Codex');
    });
  });

  describe('one row per brain', () => {
    it('name, whose it is, and a state mark that is a word', async () => {
      await mount(await fakeSeat({ brains: [CLAUDE, loggedOut(CODEX, CODEX_REMEDY), { ...CODEX, id: 'hermes', name: 'Hermes', via: 'your Hermes gateway', state: 'absent', verified: true }] }));
      await open();
      const row = (id: string): string[] => [
        need(`brain-option-${id}`).querySelector('.brain-row-name')?.textContent ?? '',
        need(`brain-option-${id}`).querySelector('.brain-row-via')?.textContent ?? '',
        need(`brain-option-${id}`).querySelector('.brain-row-state')?.textContent ?? '',
        need(`brain-option-${id}`).dataset.mark ?? '',
      ];
      expect(row('claude')).toEqual(['Claude', 'your Claude Code CLI', 'answering', 'ready']);
      expect(row('codex')).toEqual(['Codex', 'your Codex CLI', 'needs attention', 'attention']);
      expect(row('hermes')).toEqual(['Hermes', 'your Hermes gateway', 'not installed', 'absent']);
      // The mark itself is decoration: the word beside it is what is read.
      expect(need('brain-option-codex').querySelector('.brain-mark')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('a READY brain’s row is a real control that pins it — and the popover stays open on the new brain’s controls', async () => {
      const seat = await fakeSeat();
      await mount(seat);
      await open();
      const codex = need('brain-option-codex');
      expect(codex).toBeInstanceOf(HTMLButtonElement);
      expect(codex.getAttribute('aria-disabled')).toBe('false');
      await press(codex);
      expect(seat.chosen).toEqual(['codex']);
      expect(need('brain-option-codex').getAttribute('aria-pressed')).toBe('true');
      expect(need('brain-option-codex').dataset.answering).toBe('true');
      expect(need('brain-switch-auto').getAttribute('aria-pressed')).toBe('false');
      expect(byId('brain-menu')).not.toBeNull();
      expect(text('brain-dock-now')).toBe('answering nowCodex · your CLI');
    });

    it('pressing the row that is already the choice does nothing', async () => {
      const seat = await fakeSeat({ choice: 'codex', active: 'codex' });
      await mount(seat);
      await open();
      await press(need('brain-option-codex'));
      expect(seat.chosen).toEqual([]);
    });

    it('a NOT-READY row cannot be picked: aria-disabled, still focusable, and its remedy is visible text with the command as code', async () => {
      const seat = await fakeSeat({ brains: [CLAUDE, loggedOut(CODEX, CODEX_REMEDY)] });
      await mount(seat);
      await open();
      const codex = need('brain-option-codex');
      expect(codex.getAttribute('aria-disabled')).toBe('true');
      // `aria-disabled`, NOT `disabled`: a disabled button leaves the tab order, and the
      // remedy inside it is what a keyboard user came for.
      expect((codex as HTMLButtonElement).disabled).toBe(false);
      codex.focus();
      expect(document.activeElement).toBe(codex);
      await press(codex);
      expect(seat.chosen, 'no dead pin').toEqual([]);

      const remedy = need('brain-remedy-codex');
      expect(remedy.textContent).toBe('Your Codex CLI is not logged in — run codex login, then check again.');
      expect([...remedy.querySelectorAll('code')].map((code) => code.textContent)).toEqual(['codex login']);
      // …and it is the row's description, so it is read with the row.
      expect(codex.getAttribute('aria-describedby')?.split(' ').map((id) => document.getElementById(id)?.textContent).join(' | ')).toBe(
        `needs attention | ${remedy.parentElement?.textContent}`,
      );
      expect(codex.getAttribute('aria-labelledby')?.split(' ').map((id) => document.getElementById(id)?.textContent)).toEqual(['Codex']);
    });

    it('a ready brain shows no remedy', async () => {
      await mount(await fakeSeat());
      await open();
      expect(byId('brain-remedy-claude')).toBeNull();
      expect(byId('brain-remedy-codex')).toBeNull();
    });

    it('a brain with no sentence from the runner still says its state in words', async () => {
      await mount(await fakeSeat({ brains: [CLAUDE, { ...CODEX, state: 'outdated' }] }));
      await open();
      expect(text('brain-remedy-codex')).toBe('Codex is out of date.');
    });

    it('a STATE this build has never heard of renders as unknown, with its detail — never as ready', async () => {
      const seat = await fakeSeat({ brains: [CLAUDE, { ...CODEX, state: 'rate-limited', detail: 'Codex is rate-limited until noon.' }] });
      await mount(seat);
      await open();
      const codex = need('brain-option-codex');
      expect(codex.dataset.state).toBe('unknown');
      expect(codex.dataset.mark).toBe('attention');
      expect(codex.querySelector('.brain-row-state')?.textContent).toBe('needs attention');
      expect(text('brain-remedy-codex')).toBe('Codex is rate-limited until noon.');
      expect(codex.getAttribute('aria-disabled')).toBe('true');
      await press(codex);
      expect(seat.chosen).toEqual([]);
    });
  });

  describe('an UNVERIFIED brain is honest about it (B6, ADR-0071 §2)', () => {
    it('its row says "experimental — not yet verified on this machine" and, in one sentence, what that means', async () => {
      await mount(await fakeSeat());
      await open();
      expect(text('brain-experimental-codex')).toBe(
        'experimental — not yet verified on this machine its tools are switched off by flags and a tripwire, and nobody has yet proven that on a logged-in run here.',
      );
      expect(byId('brain-experimental-claude'), 'a verified brain carries no such label').toBeNull();
    });

    it('is selectable ONLY by its own row: nothing else in the popover pins it', async () => {
      const seat = await fakeSeat();
      await mount(seat);
      await open();
      for (const control of [...need('brain-menu').querySelectorAll<HTMLElement>('button, select')]) {
        if (control.dataset.testid === 'brain-option-codex' || control instanceof HTMLSelectElement) continue;
        await press(control);
      }
      expect(seat.chosen.includes('codex')).toBe(false);
      await press(need('brain-option-codex'));
      expect(seat.chosen).toContain('codex');
    });

    it('the CHIP says experimental while it answers — in words, and in its accessible name', async () => {
      await mount(await fakeSeat({ choice: 'codex', active: 'codex', effort: 'low' }));
      const chip = need('brain-chip');
      expect(chip.dataset.experimental).toBe('true');
      expect(text('brain-chip-experimental')).toBe('experimental');
      expect(text('brain-chip-effort')).toBe('thinking · low');
      expect(chip.getAttribute('aria-label')).toBe('what’s thinking: Codex · your CLI (experimental — not yet verified on this machine), thinking level low');
    });

    it('a verified brain’s chip does not', async () => {
      await mount(await fakeSeat());
      expect(need('brain-chip').dataset.experimental).toBe('false');
      expect(byId('brain-chip-experimental')).toBeNull();
    });

    it('experimental AND not ready: both are said', async () => {
      await mount(await fakeSeat({ brains: [CLAUDE, loggedOut(CODEX, CODEX_REMEDY)] }));
      await open();
      expect(byId('brain-experimental-codex')).not.toBeNull();
      expect(byId('brain-remedy-codex')).not.toBeNull();
    });
  });

  describe('the model and the thinking level are the ANSWERING brain’s, in its own words', () => {
    it('the levels offered are the brain’s own — Codex’s are not Claude’s', async () => {
      await mount(await fakeSeat({ choice: 'codex', active: 'codex' }));
      await open();
      const select = need('brain-menu-effort') as HTMLSelectElement;
      expect([...select.options].map((option) => option.value)).toEqual(['', 'minimal', 'low', 'medium', 'high']);
      expect([...(need('brain-menu-model-select') as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(['Codex’s default', 'GPT-5.5']);
    });

    it('…and the CHOSEN MODEL’s own: fewer levels for a model that lists fewer', async () => {
      await mount(await fakeSeat({ choice: 'codex', active: 'codex', model: 'gpt-5.5' }));
      await open();
      expect([...(need('brain-menu-effort') as HTMLSelectElement).options].map((option) => option.value)).toEqual(['', 'low', 'high']);
    });

    it('a model with NO levels has no level control at all, and the chip names no level', async () => {
      await mount(await fakeSeat({ model: 'claude-haiku-4-5-20251001' }));
      expect(byId('brain-chip-effort')).toBeNull();
      await open();
      expect(byId('brain-menu-effort')).toBeNull();
      expect(text('brain-menu-active')).toBe('next think asks for Haiku 4.5 — what answers is shown here after it');
    });

    it('nothing chosen and nothing answered yet: the default model, said as unknown until a think comes back', async () => {
      await mount(await fakeSeat());
      await open();
      expect(text('brain-menu-active')).toBe('thinking on Claude’s default model (known after the first think), level default');
    });

    it('a model typed by hand that the catalogue does not list is named by what was typed', async () => {
      await mount(await fakeSeat({ model: 'claude-opus-5-5' }));
      await open();
      expect(text('brain-menu-active')).toBe('next think asks for claude-opus-5-5, level default — what answers is shown here after it');
    });

    it('up to six levels are ONE row of segments: every level is one tap, "default" clears, and the chosen one is marked', async () => {
      const seat = await fakeSeat({ effort: 'high' });
      await mount(seat);
      await open();
      const segments = [...need('brain-menu').querySelectorAll<HTMLElement>('.brain-dock-segment')];
      expect(segments.map((segment) => segment.textContent)).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
      expect(segments.filter((segment) => segment.dataset.selected === 'true').map((segment) => segment.textContent)).toEqual(['high']);
      await press(need('brain-level-max'));
      expect(seat.efforts_).toEqual(['max']);
      expect(need('brain-level-max').dataset.selected).toBe('true');
      expect((need('brain-menu-effort') as HTMLSelectElement).value, 'the segments and the select are ONE control').toBe('max');
      expect(document.activeElement, 'the keyboard continues from the real control').toBe(need('brain-menu-effort'));
      await press(need('brain-level-default'));
      expect(seat.efforts_).toEqual(['max', undefined]);
      expect(need('brain-level-default').dataset.selected).toBe('true');
    });

    it('the segments are a pointer affordance only: hidden from assistive technology, the select is what is named', async () => {
      await mount(await fakeSeat());
      await open();
      expect(need('brain-menu').querySelector('.brain-dock-segments')?.getAttribute('aria-hidden')).toBe('true');
      expect(need('brain-menu-effort').getAttribute('aria-label')).toBe('thinking level');
      expect(need('brain-menu').querySelector('.brain-dock-levels')?.getAttribute('data-segmented')).toBe('true');
    });

    it('past six levels it is the plain dropdown — a row that long does not fit a phone', async () => {
      const seven = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      await mount(await fakeSeat({ brains: [{ ...CLAUDE, efforts: seven, models: [] }] }));
      await open();
      expect(need('brain-menu').querySelector('.brain-dock-segments')).toBeNull();
      expect(need('brain-menu').querySelector('.brain-dock-levels')?.getAttribute('data-segmented')).toBe('false');
      expect([...(need('brain-menu-effort') as HTMLSelectElement).options]).toHaveLength(8);
    });

    it('the standing note is the seat’s own, shown under the controls', async () => {
      await mount(await fakeSeat());
      await open();
      expect(text('brain-menu-cli-hint')).toBe('Thinking itself is never shown. A switch takes effect on your next think and spends nothing.');
    });
  });

  describe('the demo brain is standing in — the chip and the popover say WHY, and what to do', () => {
    const standingIn = async (brains: Option[], over: Partial<State> = {}): Promise<FakeSeat> => {
      const seat = await fakeSeat();
      const { active: _none, ...state } = { ...seat.state.get(), brains, ...over };
      return { ...seat, state: { get: () => state as State, subscribe: seat.state.subscribe } };
    };

    it('the chip: demo brain, with the reason under it and in its accessible name', async () => {
      await mount(await standingIn([loggedOut(CLAUDE, CLAUDE_REMEDY), CODEX]));
      const chip = need('brain-chip');
      expect(chip.dataset.brain).toBe('demo');
      expect(chip.querySelector('.brain-chip-label-full')?.textContent).toBe('demo brain');
      expect(chip.querySelector('.brain-chip-label-short')?.textContent).toBe('demo');
      expect(text('brain-chip-why')).toBe('Claude · not logged in');
      expect(chip.getAttribute('aria-label')).toBe('what’s thinking: demo brain — Claude · not logged in');
    });

    it('the popover: the demo brain is named, the reason leads, the remedy is on the brain’s row — and never "nothing to configure"', async () => {
      await mount(await standingIn([loggedOut(CLAUDE, CLAUDE_REMEDY), CODEX]));
      await open();
      expect(text('brain-dock-now')).toBe('answering nowthe demo brain');
      // MIGRATED in R4's round-2 fix: this pinned "…until one of your agents is ready" two
      // rows above a Codex marked ready. The sentence now names the agent and the way out.
      expect(text('brain-dock-standin')).toBe('Claude · not logged in. a tiny script inside this page answers until Claude is ready, or you pick a ready agent below — no AI model or service is called.');
      expect(text('brain-remedy-claude')).toBe('Your Claude CLI is not logged in — run claude and /login, then check again.');
      expect([...need('brain-remedy-claude').querySelectorAll('code')].map((code) => code.textContent)).toEqual(['claude', '/login']);
      expect(need('brain-menu').textContent).not.toMatch(/nothing to configure|no host brain wired/);
      // A ready alternative is one click away — and it is the USER's click.
      expect(need('brain-option-codex').getAttribute('aria-disabled')).toBe('false');
    });

    it('a pinned brain that stopped being ready: the reason is the PIN’s, though another brain is ready', async () => {
      await mount(await standingIn([CLAUDE, loggedOut(CODEX, CODEX_REMEDY)], { choice: 'codex' }));
      expect(text('brain-chip-why')).toBe('Codex · not logged in');
      await open();
      expect(need('brain-option-codex').getAttribute('aria-pressed'), 'it is still the user’s choice').toBe('true');
      expect(need('brain-option-codex').dataset.answering).toBe('false');
      expect(need('brain-option-claude').dataset.answering, 'and nothing else answers in its place').toBe('false');
    });

    it('the stand-in sentence with NO ready agent anywhere: it waits for one of them', async () => {
      await mount(await standingIn([loggedOut(CLAUDE, CLAUDE_REMEDY), loggedOut(CODEX, CODEX_REMEDY)]));
      await open();
      expect(text('brain-dock-standin')).toBe('Claude · not logged in. a tiny script inside this page answers until one of your agents is ready — no AI model or service is called.');
    });

    it('the stand-in sentence when the reason is about no ONE agent and one is ready: it answers meanwhile, and the remedy follows', async () => {
      await mount(await standingIn([CLAUDE, CODEX]));
      await open();
      expect(text('brain-dock-standin')).toBe('no agent is answering. a tiny script inside this page answers meanwhile — no AI model or service is called. check again, or pick an agent below.');
    });

    it('there are no model or level controls while no brain answers (AC8) — and no dead "thinking on" line', async () => {
      await mount(await standingIn([loggedOut(CLAUDE, CLAUDE_REMEDY)]));
      await open();
      for (const id of ['brain-dock-controls', 'brain-menu-model', 'brain-menu-model-select', 'brain-menu-effort', 'brain-menu-active', 'brain-menu-cli-hint']) expect(byId(id), id).toBeNull();
    });

    it('EMPTY — no brain reported yet: the chip says it is looking, the list holds its place, auto is still there', async () => {
      await mount(await standingIn([]));
      expect(text('brain-chip-why')).toBe('looking for your agents');
      await open();
      expect(text('brain-dock-standin')).toContain('the runner has not said yet which of your agents can answer.');
      expect(text('brain-dock-empty')).toBe('your agents will be listed here.');
      expect(byId('brain-switch-auto')).not.toBeNull();
      expect(byId('brain-recheck')).not.toBeNull();
    });

    it('a pinned brain the runner no longer lists: it says so, and how to get out', async () => {
      await mount(await standingIn([CLAUDE], { choice: 'hermes' }));
      expect(text('brain-chip-why')).toBe('the agent you picked is gone');
      await open();
      expect(text('brain-dock-standin')).toContain('the agent you picked (hermes) is not on this computer any more — choose auto, or another agent.');
    });

    it('REFUSED — a think the runner could not place: the sentence is shown though no brain has controls to show it under', async () => {
      await mount(await standingIn([loggedOut(CLAUDE, CLAUDE_REMEDY)], { refusal: 'No brain is ready — the demo brain answers until one is.' }));
      await open();
      expect(text('brain-menu-cli-note')).toBe('No brain is ready — the demo brain answers until one is.');
    });

    it('flips to the brain without a reload when the runner’s status says it is ready', async () => {
      const seat = await fakeSeat({ brains: [loggedOut(CLAUDE, CLAUDE_REMEDY)] });
      const { active: _none, ...standing } = seat.state.get();
      let state: State = standing;
      const live: FakeSeat = { ...seat, state: { get: () => state, subscribe: seat.state.subscribe } };
      await mount(live);
      expect(need('brain-chip').dataset.brain).toBe('demo');
      await open();
      await act(async () => {
        state = { choice: 'auto', active: 'claude', brains: [CLAUDE], checking: false };
        seat.set({ checking: false, brains: [CLAUDE] });
      });
      expect(need('brain-chip').dataset.brain).toBe('host');
      expect(text('brain-dock-now')).toBe('answering nowClaude · your CLI');
      expect(byId('brain-dock-standin')).toBeNull();
      expect(byId('brain-remedy-claude')).toBeNull();
    });
  });

  describe('“check again”', () => {
    it('asks the seat once, shows progress, takes no second press while checking, and comes back', async () => {
      const seat = await fakeSeat();
      await mount(seat);
      await open();
      const button = need('brain-recheck');
      expect(button.textContent).toBe('check again');
      expect(button.getAttribute('aria-busy')).toBe('false');
      await press(button);
      expect(seat.rechecks).toBe(1);
      expect(need('brain-recheck').textContent).toBe('checking…');
      expect(need('brain-recheck').getAttribute('aria-busy')).toBe('true');
      expect(need('brain-menu').dataset.checking).toBe('true');
      await press(need('brain-recheck'));
      expect(seat.rechecks, 'not re-entrant from the button').toBe(1);
      await act(async () => seat.landed());
      expect(need('brain-recheck').textContent).toBe('check again');
      expect(need('brain-recheck').getAttribute('aria-busy')).toBe('false');
    });

    it('LOADING, first seconds of a page: a brain not checked yet reads "checking…" while the check runs — not "needs attention"', async () => {
      // The runner looks at its brains when the first page asks, never before; until that
      // look comes back every brain is `unknown`, and the page is checking.
      const pending: Option = { ...CLAUDE, state: 'unknown', detail: 'Snug is still checking this brain.' };
      const seat = await fakeSeat({ brains: [pending, loggedOut(CODEX, CODEX_REMEDY)], checking: true });
      const { active: _none, ...state } = seat.state.get();
      let live: State = state;
      await mount({ ...seat, state: { get: () => live, subscribe: seat.state.subscribe } });
      expect(text('brain-chip-why')).toBe('Claude · not checked yet');
      await open();
      expect(need('brain-option-claude').querySelector('.brain-row-state')?.textContent).toBe('checking…');
      expect(text('brain-remedy-claude')).toBe('Snug is still checking this brain.');
      expect(need('brain-option-claude').getAttribute('aria-disabled'), 'and it cannot be picked meanwhile').toBe('true');
      // A brain whose state IS known keeps its own word while the check runs.
      expect(need('brain-option-codex').querySelector('.brain-row-state')?.textContent).toBe('needs attention');
      // The check over and the brain still not told: now it does need the user's attention.
      await act(async () => {
        live = { ...state, checking: false };
        seat.set({ checking: false });
      });
      expect(need('brain-option-claude').querySelector('.brain-row-state')?.textContent).toBe('needs attention');
    });

    it('a brain whose check came back UNREADABLE is not called "not checked yet" — it was checked', async () => {
      const untold: Option = { ...CLAUDE, state: 'unknown', detail: 'Your Claude CLI did not answer the startup check in time.' };
      const seat = await fakeSeat({ brains: [untold, loggedOut(CODEX, CODEX_REMEDY)] });
      const { active: _none, ...state } = seat.state.get();
      await mount({ ...seat, state: { get: () => state, subscribe: seat.state.subscribe } });
      expect(text('brain-chip-why')).toBe('Claude · could not be checked');
      await open();
      expect(text('brain-dock-standin')).toContain('Claude · could not be checked.');
      expect(text('brain-remedy-claude')).toBe('Your Claude CLI did not answer the startup check in time.');
    });

    it('LOADING keeps every row where it was — the list is not replaced by a spinner', async () => {
      const seat = await fakeSeat({ brains: [CLAUDE, loggedOut(CODEX, CODEX_REMEDY)] });
      await mount(seat);
      await open();
      const before = need('brain-menu').querySelector('.brain-dock-list')?.textContent;
      await press(need('brain-recheck'));
      expect(need('brain-menu').querySelector('.brain-dock-list')?.textContent).toBe(before);
      // The button sits in the HEAD, above everything that can grow: a remedy appearing or
      // leaving cannot move it from under the pointer.
      expect(need('brain-recheck').parentElement?.className).toBe('brain-dock-head');
    });
  });

  describe('the popover behaves like the other header popovers', () => {
    it('Escape closes it and returns focus to the chip', async () => {
      await mount(await fakeSeat());
      await open();
      expect(byId('brain-menu')).not.toBeNull();
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(byId('brain-menu')).toBeNull();
      expect(document.activeElement).toBe(need('brain-chip'));
    });

    it('everything in it is reachable by Tab, in reading order: check again, auto, each brain, the model, the level', async () => {
      await mount(await fakeSeat({ brains: [CLAUDE, loggedOut(CODEX, CODEX_REMEDY)] }));
      await open();
      const stops = [...need('brain-menu').querySelectorAll<HTMLElement>('button, select, input, a[href], [tabindex]')]
        .filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled)
        .map((el) => el.dataset.testid);
      expect(stops).toEqual(['brain-recheck', 'brain-switch-auto', 'brain-option-claude', 'brain-option-codex', 'brain-menu-model-select', 'brain-menu-effort']);
    });

    it('the D15 doors stay shut: no settings link, no key invitation, no ollama shortcut', async () => {
      await mount(await fakeSeat());
      await open();
      for (const id of ['brain-menu-settings', 'brain-menu-ollama', 'brain-menu-tier']) expect(byId(id), id).toBeNull();
      expect(need('brain-menu').textContent).not.toContain(BYOK_HONESTY_COPY);
    });
  });

  describe('the stylesheet (S6)', () => {
    // jsdom applies no stylesheet, so these read the SOURCE: what the dock's look is allowed
    // to be made of. The look itself is reviewed by screenshot (the task's S6).
    const css = (file: string): string => readFileSync(resolve(process.cwd(), 'src', 'theme', file), 'utf8');
    const code = (file: string): string => css(file).replace(/\/\*[\s\S]*?\*\//g, ' ');

    it('uses ONLY the theme’s tokens for colour — no hex, no rgb(), no named colour of its own', () => {
      const dock = code('brain-dock.css');
      expect(dock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(dock).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
      const colours = [...dock.matchAll(/(?:^|[\s;{])(?:color|background|background-color|border-color|border-right-color|outline|box-shadow|border|border-left|border-top)\s*:\s*([^;]+);/g)].map((match) => match[1]!.trim());
      expect(colours.length).toBeGreaterThan(20);
      for (const value of colours) {
        const bare = value.replace(/var\(--[a-z0-9-]+\)/g, '').replace(/color-mix\(in srgb,\s*,?\s*\d+%\s*,\s*(transparent)?\s*\)/g, '');
        expect(bare, `"${value}" names a colour that is not a token`).not.toMatch(/\b(white|black|red|green|blue|orange|yellow|gray|grey|silver|gold)\b/);
      }
    });

    it('is imported ONCE, from app.css — which holds none of the dock’s rules and none of the old CLI control’s', () => {
      const app = css('app.css');
      expect(app.match(/@import\s+['"]\.\/brain-dock\.css['"]/g)).toHaveLength(1);
      expect(code('app.css')).not.toMatch(/\.brain-dock|\.brain-row|\.brain-menu-cli/);
    });

    it('fits a phone and honours reduced motion: 24px of gutter, the header as its anchor below 760px, no animation when asked', () => {
      const dock = code('brain-dock.css');
      expect(dock).toMatch(/max-width:\s*calc\(100vw - 24px\)/);
      expect(dock).toMatch(/@media \(max-width: 760px\)\s*\{[\s\S]*\.identity-menu-wrap\.brain-dock-wrap\s*\{\s*position:\s*static/);
      expect(dock).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*animation:\s*none/);
      // Rows are tap targets; the level segments and the fields are 40px controls.
      expect(dock).toMatch(/\.brain-row\s*\{[\s\S]*?min-height:\s*var\(--tap\)/);
    });
  });

  describe('every OTHER platform’s chip is unchanged', () => {
    it('a host without brainSwitch (the artifact kit) renders the status chip: no rows, no "check again"', async () => {
      vi.resetModules();
      const platformModule = await import('../platform/platform.js');
      const { hostPlatform } = await import('./fixtures/hostPlatform.js');
      platformModule.setPlatform(hostPlatform());
      const helper = await import('./userdbTestHelper.js');
      await helper.installTestUserDb();
      const chipModule = await import('../views/BrainChip.js');
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root!.render(
          <MemoryRouter>
            <chipModule.BrainChip />
          </MemoryRouter>,
        );
      });
      await open();
      expect(need('brain-menu').textContent).toContain(chipModule.HOST_NO_BRAIN_HEADLINE);
      for (const id of ['brain-switch-auto', 'brain-recheck', 'brain-dock-now']) expect(byId(id), id).toBeNull();
      expect(need('brain-menu').className).toBe('identity-menu brain-menu');
    });

    it('web: the same — the switcher is the runner’s alone', () => {
      render(<BrainChip />);
      act(() => chip().click());
      expect(menu()!.className).toBe('identity-menu brain-menu');
      expect(document.querySelector('[data-testid="brain-switch-auto"]')).toBeNull();
      expect(document.querySelector('[data-testid="brain-recheck"]')).toBeNull();
    });
  });
});
