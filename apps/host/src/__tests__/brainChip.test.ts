// brainChip.test.ts — TASK-20260922 S5 (AC5/AC8): the brain chip on Binding B is a CONTROL
// without ceasing to be a remedy. The control appears ONLY where a brain can think, because a
// picker on a brain that cannot is a dead control (AC8 — the ADR-0067 rule, and ADR-0036 rule 4
// for the same reason on the other binding).
//
// MIGRATED 2026-10-03 (TASK-20261003 R4 — `cliModel` → `brainSwitch`, named in the plan),
// claim by claim. Three functions carried these claims — `brainLabel(state)` (five sentences
// about Claude), `brainChipSeat` and `cliModelSeat` (present only while Claude was ready).
// What the chip reads now is ONE seat, `platform.brainSwitch`, present whatever answers, and
// the words for a state are the playground's (`platform/copy.ts`) over the runner's own
// sentence. Each describe keeps its title; each test says where its claim is made now.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { brainLevels, brainRemedy, brainStateWords, demoStandIn } from '@playground/platform/copy';
import type { BrainSwitchSeat, BrainSwitchState, SnugPlatform } from '@playground/platform/platform';

import { BRAIN_CHOICE_STORAGE_KEY } from '../brains/brainChoiceStore.js';
import type { BrainWire, LocalClient, LocalStatus } from '../local/client.js';
import { applyRunnerStatus, brainLabel, composeLocalPlatform } from '../local/compose-local.js';

const client: LocalClient = {
  fetchImpl: async () => new Response('ok'),
  fs: { readFile: async () => undefined, writeFileAtomic: async () => {} },
  events: () => () => {},
  reportHandIn: async () => {},
  recheckBrain: async () => {},
  stopped: { get: () => false, subscribe: () => () => {} },
};

const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE: BrainWire = {
  id: 'claude',
  name: 'Claude',
  via: 'your Claude Code CLI',
  state: 'ready',
  verified: true,
  streaming: true,
  efforts: FIVE,
  models: [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', efforts: FIVE },
    { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', efforts: [] },
  ],
};
const claude = (over: Partial<BrainWire> = {}): BrainWire => ({ ...CLAUDE, ...over });

/** The runner's own sentence per state — each driver writes its remedy (ADR-0071 §6). */
const REMEDY: Record<string, string> = {
  'logged-out': 'Your Claude CLI is not logged in — run `claude` and `/login`, then check again.',
  absent: 'No Claude CLI was found — install Claude Code (code.claude.com), then run `claude` and `/login`.',
  outdated: 'Your Claude CLI is out of date — run `claude update`, then check again.',
  unknown: 'Your Claude CLI did not answer the startup check in time.',
};

const status = (over: Partial<LocalStatus> = {}): LocalStatus => ({ binding: 'local-host', port: 43127, pages: 1, brains: [], ...over });
const READY: Partial<LocalStatus> = { active: 'claude', brains: [CLAUDE] };
const inState = (state: string): Partial<LocalStatus> => ({ brains: [claude({ state, detail: REMEDY[state] ?? 'something else is wrong' })] });

const compose = (over: Partial<LocalStatus> = READY): { platform: SnugPlatform; seat: BrainSwitchSeat; state: () => BrainSwitchState } => {
  const { platform } = composeLocalPlatform(client, status(over), undefined, undefined, 't');
  const seat = platform.brainSwitch;
  if (seat === undefined) throw new Error('the runner’s platform carries no brainSwitch');
  return { platform, seat, state: () => seat.state.get() };
};

/** One think through the host arm, answered by a stub in the shim's real shape. */
async function thinkOnce(platform: SnugPlatform, respond: () => Response): Promise<void> {
  vi.stubGlobal('fetch', async () => respond());
  const brain = platform.brain as unknown as { adapter: { complete(request: unknown): Promise<unknown> } };
  await brain.adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
}
const answered = (model: string): Response => {
  const base = { id: 'c', object: 'chat.completion.chunk', created: 1 };
  return new Response(
    `data: ${JSON.stringify({ ...base, model: 'claude', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ ...base, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream', 'x-snug-brain': 'claude' } },
  );
};
const refused = (message: string): Response =>
  new Response(JSON.stringify({ error: { message } }), { status: 502, headers: { 'content-type': 'application/json', 'x-snug-brain': 'claude' } });

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the five states keep their remedies — a control never replaces one', () => {
  // WAS `brainLabel({ state })`, five sentences about Claude written on the page. The
  // sentence is the RUNNER's now and reaches the user verbatim; the page adds a few words
  // for the chip, and says the state itself when the runner sent no sentence.
  it.each([
    ['logged-out', /\/login/, 'Claude · not logged in', 'Claude is not logged in.'],
    ['absent', /code\.claude\.com/, 'Claude · not installed', 'Claude is not installed.'],
    ['outdated', /claude update/, 'Claude · out of date', 'Claude is out of date.'],
    // MIGRATED (R4 fix): the chip said "not checked yet" beside a sentence saying the check
    // had timed out. With the runner's sentence for a check that RAN, it could not be checked;
    // "not checked yet" is for a brain nobody has looked at (no sentence, or the runner's own
    // "still checking" one — pinned in oneKit.test.ts).
    ['unknown', /did not answer/, 'Claude · could not be checked', 'Claude has not been checked yet.'],
  ])('names the remedy for a CLI that is %s', (state, remedy, why, plain) => {
    const standIn = demoStandIn(compose(inState(state)).state());
    expect(standIn?.remedy).toMatch(remedy);
    expect(standIn?.remedy).toBe(REMEDY[state]);
    expect(standIn?.why).toBe(why);
    expect(brainRemedy({ name: 'Claude', state })).toBe(plain);
  });

  it('a state this build has never heard of needs attention, with the runner’s own detail — it is never read as ready', () => {
    expect(brainStateWords({ state: 'rate-limited' })).toBe('needs attention');
    expect(brainRemedy({ name: 'Codex', state: 'rate-limited', detail: 'try again at noon' })).toBe('try again at noon');
    expect(brainRemedy({ name: 'Codex', state: 'rate-limited' })).toBe('Codex needs attention.');
    // A state named like an object member is a state like any other, not a lookup into one.
    expect(brainStateWords({ state: 'constructor' })).toBe('needs attention');
  });

  it('is the plain label when the CLI is ready', () => {
    expect(brainLabel(CLAUDE, undefined)).toBe('Claude · your CLI');
    expect(demoStandIn(compose().state())).toBeUndefined();
  });
});

describe('no dead control (AC8)', () => {
  for (const state of ['logged-out', 'absent', 'outdated', 'unknown'] as const) {
    it(`offers NO control while the brain is ${state} — the remedy stands alone`, () => {
      // WAS `brainChipSeat(…) === undefined`. The seat stays (it carries the remedy); what
      // is absent is everything a control would be built from.
      const { platform, state: read } = compose(inState(state));
      expect(platform.brain).toEqual({ kind: 'demo' });
      expect(read().active).toBeUndefined();
      expect('model' in read() || 'effort' in read()).toBe(false);
    });
  }

  it('offers no control before the probe has answered — absence is not a claim the CLI works', () => {
    const { state: read } = compose({});
    expect(read()).toEqual({ choice: 'auto', brains: [], checking: false });
  });

  it('offers the control once the brain is ready — with the levels the RUNNER lists for it, none of the page’s own', () => {
    const { state: read } = compose();
    expect(read().active).toBe('claude');
    expect(read().brains[0]?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // The same seat under another brain's vocabulary: the page holds no list to fall back on.
    applyRunnerStatus({ active: 'claude', brains: [claude({ efforts: ['shallow', 'deep'], models: [] })] });
    expect(read().brains[0]?.efforts).toEqual(['shallow', 'deep']);
  });
});

describe('the chip shows what is ACTIVE, not what was asked (AC5)', () => {
  it('says nothing has answered until a think has — the model is the brain’s own default until one is chosen', () => {
    // WAS "says the model is the CLI’s own default until one is chosen" (the word "default"
    // in a label string). The seat states the two facts the chip words it from.
    const { state: read } = compose();
    expect(read().answered).toBeUndefined();
    expect(read().model).toBeUndefined();
  });

  it('does not name a model as answering merely because one was CHOSEN — only one that answered', () => {
    const { seat, state: read } = compose();
    seat.setModel('haiku');
    expect(read().model).toBe('haiku');
    expect(read().answered).toBeUndefined();
  });

  it('names the RESOLVED model once a think has answered on it', async () => {
    const { platform, seat, state: read } = compose();
    seat.setModel('haiku');
    await thinkOnce(platform, () => answered('claude-haiku-4-5-20251001'));
    expect(read().answered).toEqual({ brain: 'claude', model: 'claude-haiku-4-5-20251001' });
  });

  it('says a refusal IN WORDS rather than silently showing the old model alone', async () => {
    const { platform, state: read } = compose();
    await thinkOnce(platform, () => refused('There’s an issue with the selected model (nope-not-a-model).'));
    expect(read().refusal).toBe('There’s an issue with the selected model (nope-not-a-model).');
  });

  it('names the chosen effort, which needs no round trip to be true', () => {
    const { seat, state: read } = compose();
    seat.setEffort('max');
    expect(read().effort).toBe('max');
  });

  it('says thinking is not shown, so the control is honest about what it does (Q4)', () => {
    expect(compose().seat.note).toMatch(/thinking/i);
  });

  it('says a switch lands on the next think and costs a warm child (Q5)', () => {
    expect(compose().seat.note).toMatch(/next think/i);
    expect(compose().seat.note).toMatch(/started again/);
  });
});

describe('the default is NAMED once the CLI has told us what it is (S8)', () => {
  // Measured 2026-09-22: with no --model, `init` still reports the real id
  // (claude-opus-5[1m]). So "the default" is a placeholder only until the first think
  // answers; after that the chip can name the actual model. Effort has no such report — the
  // CLI echoes it nowhere — so it stays unnamed rather than invented.
  it('names the model the CLI actually ran, even though the user chose none', async () => {
    const { platform, state: read } = compose();
    await thinkOnce(platform, () => answered('claude-opus-5[1m]'));
    expect(read().answered?.model).toBe('claude-opus-5[1m]');
    expect(read().model, 'what answered is not what was chosen').toBeUndefined();
  });

  it('still names what ANSWERED over what was chosen, when they differ', async () => {
    const { platform, seat, state: read } = compose();
    seat.setModel('opus');
    await thinkOnce(platform, () => answered('claude-opus-5[1m]'));
    expect(read()).toMatchObject({ model: 'opus', answered: { brain: 'claude', model: 'claude-opus-5[1m]' } });
  });

  it('never invents an effort — the CLI reports none, so an unchosen level stays unnamed', async () => {
    const { platform, state: read } = compose();
    await thinkOnce(platform, () => answered('claude-opus-5[1m]'));
    expect('effort' in read()).toBe(false);
  });
});

describe('the seat the chip actually renders (S7)', () => {
  it('is on the PLATFORM wherever the runner’s page opens — and carries no control while the brain cannot think', () => {
    // WAS "is undefined wherever the brain cannot think, so the platform carries no dead
    // control". No dead control still; no missing remedy either.
    for (const state of ['logged-out', 'absent', 'outdated', 'unknown']) {
      const { seat, state: read } = compose(inState(state));
      expect(seat).toBeDefined();
      expect(read().active).toBeUndefined();
    }
  });

  it('returns a STABLE state reference while nothing changes — useSyncExternalStore loops otherwise', () => {
    const { seat } = compose();
    expect(seat.state.get()).toBe(seat.state.get());
  });

  it('gives the chip a new state, and notifies, when the user switches', () => {
    const { seat, state: read } = compose();
    let notified = 0;
    seat.state.subscribe(() => void (notified += 1));
    const before = read();
    seat.setEffort('max');
    expect(notified).toBe(1);
    expect(read()).not.toBe(before);
    expect(read().effort).toBe('max');
  });

  it('carries what ANSWERED and any standing refusal, for the chip to show verbatim', async () => {
    const { platform, state: read } = compose();
    await thinkOnce(platform, () => answered('claude-haiku-4-5-20251001'));
    expect(read().answered).toEqual({ brain: 'claude', model: 'claude-haiku-4-5-20251001' });
    await thinkOnce(platform, () => refused('refused: bad'));
    expect(read().refusal).toBe('refused: bad');
    expect(read().answered, 'a refused think ran on nothing').toEqual({ brain: 'claude', model: 'claude-haiku-4-5-20251001' });
  });

  it('setModel writes through to the store the brain reads — per machine, per brain, versioned', () => {
    compose().seat.setModel('opus');
    expect(JSON.parse(localStorage.getItem(BRAIN_CHOICE_STORAGE_KEY) ?? 'null')).toEqual({ v: 2, choice: 'auto', prefs: { claude: { model: 'opus' } } });
  });
});

describe('the model dropdown comes from the CLI’s catalogue (S9)', () => {
  it('offers what the process read, with exact ids', () => {
    expect(compose().state().brains[0]?.models.map((model) => model.id)).toEqual(['claude-opus-5-5', 'claude-haiku-4-5-20251001']);
  });

  it('offers NO models when the catalogue could not be read — free text is the fallback, not an empty list', () => {
    expect(compose({ active: 'claude', brains: [claude({ models: [] })] }).state().brains[0]?.models).toEqual([]);
  });

  it('says a chosen model has NO effort axis, so the chip offers no level for it (AC8)', () => {
    // WAS `effortApplies === false`. The levels are per model on the wire now; none listed
    // is no control — and a level stored earlier is not shown for it either.
    const { seat, state: read } = compose();
    seat.setEffort('high');
    seat.setModel('claude-haiku-4-5-20251001');
    expect(brainLevels(CLAUDE, 'claude-haiku-4-5-20251001')).toEqual([]);
    expect('effort' in read()).toBe(false);
  });

  it('says effort DOES apply for a model that has the axis, and when none is chosen', () => {
    expect(brainLevels(CLAUDE, 'claude-opus-5-5')).toEqual(FIVE);
    expect(brainLevels(CLAUDE, undefined)).toEqual(FIVE);
  });

  it('assumes effort applies for a model typed by hand that the catalogue does not list', () => {
    expect(brainLevels(CLAUDE, 'some-future-model')).toEqual(FIVE);
    const { seat, state: read } = compose();
    seat.setModel('some-future-model');
    seat.setEffort('max');
    expect(read().effort).toBe('max');
  });
});

describe('the chip label names the model, not "your CLI" (S11, owner 2026-10-02)', () => {
  it('names the model by its catalogue name when the CLI is ready', () => {
    expect(brainLabel(CLAUDE, 'claude-opus-5-5')).toBe('Claude · Opus 5.5');
  });

  it('keeps "your CLI" when there is no model to name yet', () => {
    expect(brainLabel(CLAUDE, undefined)).toBe('Claude · your CLI');
  });

  it('never trades a REMEDY for a model name — a broken CLI is not "Claude · Opus 5.5"', () => {
    // WAS `brainLabel({ state }, 'Sonnet 5')` still returning the remedy. With a model
    // selected and the CLI broken, the platform's brain is the demo brain — there is no
    // host label to read at all — and the stand-in gives the remedy.
    for (const state of ['logged-out', 'outdated', 'absent', 'unknown']) {
      const { platform, seat, state: read } = compose();
      seat.setModel('claude-opus-5-5');
      applyRunnerStatus(inState(state));
      expect(platform.brain).toEqual({ kind: 'demo' });
      expect(demoStandIn(read())?.remedy).toBe(REMEDY[state]);
    }
  });

  it('names nothing before the probe answers — absence is not a claim the CLI works', () => {
    localStorage.setItem(BRAIN_CHOICE_STORAGE_KEY, JSON.stringify({ model: 'claude-opus-5-5' }));
    const { platform, state: read } = compose({});
    expect(platform.brain).toEqual({ kind: 'demo' });
    expect(demoStandIn(read())?.why).toBe('looking for your agents');
  });
});
