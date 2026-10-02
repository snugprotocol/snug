// brainChip.test.ts — TASK-20260922 S5 (AC5/AC8): the brain chip on Binding B becomes a
// CONTROL, without ceasing to be a remedy. The five states `brainLabel` has always rendered
// keep their words; the control appears ONLY where the brain is `ready`, because a picker on a
// brain that cannot think is a dead control (AC8 — the ADR-0067 rule, and ADR-0036 rule 4 for
// the same reason on the other binding).
import { describe, expect, it } from 'vitest';

import { brainChipSeat, brainLabel, cliModelSeat } from '../local/compose-local.js';
import { createBrainChoiceStore } from '../brains/brainChoiceStore.js';

const store = () => createBrainChoiceStore({ storage: undefined });

describe('the five states keep their remedies — a control never replaces one', () => {
  it('names the remedy for a logged-out CLI', () => {
    expect(brainLabel({ state: 'logged-out' })).toMatch(/\/login/);
  });
  it('names the remedy for an absent CLI', () => {
    expect(brainLabel({ state: 'absent' })).toMatch(/code\.claude\.com/);
  });
  it('names the remedy for an outdated CLI', () => {
    expect(brainLabel({ state: 'outdated' })).toMatch(/claude update/);
  });
  it('says so when the probe could not check', () => {
    expect(brainLabel({ state: 'unknown' })).toMatch(/could not check/);
  });
  it('is the plain label when the CLI is ready', () => {
    expect(brainLabel({ state: 'ready' })).toBe('Claude · your CLI');
  });
});

describe('no dead control (AC8)', () => {
  for (const state of ['logged-out', 'absent', 'outdated', 'unknown'] as const) {
    it(`offers NO control while the brain is ${state} — the remedy stands alone`, () => {
      expect(brainChipSeat({ brain: { state }, choices: store() })).toBeUndefined();
    });
  }

  it('offers no control before the probe has answered — absence is not a claim the CLI works', () => {
    expect(brainChipSeat({ brain: undefined, choices: store() })).toBeUndefined();
  });

  it('offers the control once the brain is ready', () => {
    const seat = brainChipSeat({ brain: { state: 'ready' }, choices: store() });
    expect(seat).toBeDefined();
    expect(seat?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('the chip shows what is ACTIVE, not what was asked (AC5)', () => {
  it('says the model is the CLI’s own default until one is chosen', () => {
    const seat = brainChipSeat({ brain: { state: 'ready' }, choices: store() });
    expect(seat?.activeLabel).toMatch(/default/i);
  });

  it('does not name a model merely because one was CHOSEN — only one that answered', () => {
    const choices = store();
    choices.setModel('haiku');
    const seat = brainChipSeat({ brain: { state: 'ready' }, choices });
    expect(seat?.activeLabel).not.toMatch(/haiku/);
  });

  it('names the RESOLVED model once a think has answered on it', () => {
    const choices = store();
    choices.setModel('haiku');
    choices.markAnswered('claude-haiku-4-5-20251001');
    expect(brainChipSeat({ brain: { state: 'ready' }, choices })?.activeLabel).toMatch(/claude-haiku-4-5-20251001/);
  });

  it('says a refusal IN WORDS rather than silently showing the old model alone', () => {
    const choices = store();
    choices.markRefused('nope-not-a-model', 'There’s an issue with the selected model (nope-not-a-model).');
    expect(brainChipSeat({ brain: { state: 'ready' }, choices })?.activeLabel).toMatch(/nope-not-a-model/);
  });

  it('names the chosen effort, which needs no round trip to be true', () => {
    const choices = store();
    choices.setEffort('max');
    expect(brainChipSeat({ brain: { state: 'ready' }, choices })?.activeLabel).toMatch(/max/);
  });

  it('says thinking is not shown, so the control is honest about what it does (Q4)', () => {
    expect(brainChipSeat({ brain: { state: 'ready' }, choices: store() })?.note).toMatch(/thinking/i);
  });

  it('says a switch lands on the next think and costs a warm child (Q5)', () => {
    expect(brainChipSeat({ brain: { state: 'ready' }, choices: store() })?.note).toMatch(/next think/i);
  });
});

describe('the default is NAMED once the CLI has told us what it is (S8)', () => {
  // Measured 2026-09-22: with no --model, `init` still reports the real id
  // (claude-opus-5[1m]). So "the CLI's default" is a placeholder only until the first
  // think answers; after that the chip can name the actual model. Effort has no such
  // report — the CLI echoes it nowhere — so it stays unnamed rather than invented.
  it('names the model the CLI actually ran, even though the user chose none', () => {
    const choices = store();
    choices.markAnswered('claude-opus-5[1m]');
    const seat = brainChipSeat({ brain: { state: 'ready' }, choices });
    expect(seat?.activeLabel).toContain('claude-opus-5[1m]');
    expect(seat?.activeLabel).not.toMatch(/default model/);
  });

  it('says the default is the CLI\u2019s own, and marks it as not yet known, before any think', () => {
    const seat = brainChipSeat({ brain: { state: 'ready' }, choices: store() });
    expect(seat?.activeLabel).toMatch(/default/i);
  });

  it('still names what ANSWERED over what was chosen, when they differ', () => {
    const choices = store();
    choices.setModel('opus');
    choices.markAnswered('claude-opus-5[1m]');
    expect(brainChipSeat({ brain: { state: 'ready' }, choices })?.activeLabel).toContain('claude-opus-5[1m]');
  });

  it('never invents an effort name \u2014 the CLI reports none, so an unchosen level stays unnamed', () => {
    const choices = store();
    choices.markAnswered('claude-opus-5[1m]');
    const label = brainChipSeat({ brain: { state: 'ready' }, choices })?.activeLabel ?? '';
    // No level word may appear unless the user picked one.
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(label).not.toMatch(new RegExp(`effort ${level}\\b`));
    }
  });
});

describe('the seat the chip actually renders (S7)', () => {
  it('is undefined wherever the brain cannot think, so the platform carries no dead control', () => {
    for (const state of ['logged-out', 'absent', 'outdated', 'unknown'] as const) {
      expect(cliModelSeat({ brain: { state }, choices: store() })).toBeUndefined();
    }
    expect(cliModelSeat({ brain: undefined, choices: store() })).toBeUndefined();
  });

  it('offers the CLI’s five efforts and the chip’s standing note', () => {
    const seat = cliModelSeat({ brain: { state: 'ready' }, choices: store() });
    expect(seat?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(seat?.note).toMatch(/thinking/i);
  });

  it('returns a STABLE state reference while nothing changes — useSyncExternalStore loops otherwise', () => {
    const seat = cliModelSeat({ brain: { state: 'ready' }, choices: store() });
    expect(seat?.state.get()).toBe(seat?.state.get());
  });

  it('gives the chip a new state, and notifies, when the user switches', () => {
    const choices = store();
    const seat = cliModelSeat({ brain: { state: 'ready' }, choices });
    let notified = 0;
    seat?.state.subscribe(() => { notified += 1; });
    const before = seat?.state.get();
    seat?.setEffort('max');
    expect(notified).toBe(1);
    expect(seat?.state.get()).not.toBe(before);
    expect(seat?.state.get().effort).toBe('max');
  });

  it('carries what ANSWERED and any standing refusal, for the chip to show verbatim', () => {
    const choices = store();
    choices.markAnswered('claude-haiku-4-5-20251001');
    const seat = cliModelSeat({ brain: { state: 'ready' }, choices });
    expect(seat?.state.get().activeModel).toBe('claude-haiku-4-5-20251001');
    choices.markRefused('bad', 'refused: bad');
    expect(seat?.state.get().refusal).toMatch(/bad/);
  });

  it('setModel writes through to the store the brain reads', () => {
    const choices = store();
    cliModelSeat({ brain: { state: 'ready' }, choices })?.setModel('opus');
    expect(choices.choice().model).toBe('opus');
  });
});

describe('the model dropdown comes from the CLI’s catalogue (S9)', () => {
  const MODELS = [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', effort: true },
    { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', effort: false },
  ];

  it('offers what the process read, with exact ids', () => {
    const seat = cliModelSeat({ brain: { state: 'ready' }, choices: store(), models: MODELS });
    expect(seat?.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-haiku-4-5-20251001']);
  });

  it('offers NO models when the catalogue could not be read — free text is the fallback, not an empty list', () => {
    expect(cliModelSeat({ brain: { state: 'ready' }, choices: store(), models: [] })?.models).toEqual([]);
    expect(cliModelSeat({ brain: { state: 'ready' }, choices: store() })?.models).toEqual([]);
  });

  it('says a chosen model has NO effort axis, so the chip can disable that control (AC8)', () => {
    const choices = store();
    choices.setModel('claude-haiku-4-5-20251001');
    expect(cliModelSeat({ brain: { state: 'ready' }, choices, models: MODELS })?.effortApplies).toBe(false);
  });

  it('says effort DOES apply for a model that has the axis, and when none is chosen', () => {
    const chosen = store();
    chosen.setModel('claude-opus-5-5');
    expect(cliModelSeat({ brain: { state: 'ready' }, choices: chosen, models: MODELS })?.effortApplies).toBe(true);
    expect(cliModelSeat({ brain: { state: 'ready' }, choices: store(), models: MODELS })?.effortApplies).toBe(true);
  });

  it('assumes effort applies for a model typed by hand that the catalogue does not list', () => {
    const choices = store();
    choices.setModel('some-future-model');
    expect(cliModelSeat({ brain: { state: 'ready' }, choices, models: MODELS })?.effortApplies).toBe(true);
  });
});

describe('the chip label names the model, not "your CLI" (S11, owner 2026-10-02)', () => {
  it('names the model it is given when the CLI is ready', () => {
    expect(brainLabel({ state: 'ready' }, 'Sonnet 5')).toBe('Claude · Sonnet 5');
  });

  it('keeps "your CLI" when there is no model to name yet', () => {
    expect(brainLabel({ state: 'ready' }, undefined)).toBe('Claude · your CLI');
  });

  it('never trades a REMEDY for a model name — a broken CLI is not "Claude · Sonnet 5"', () => {
    expect(brainLabel({ state: 'logged-out' }, 'Sonnet 5')).toMatch(/\/login/);
    expect(brainLabel({ state: 'outdated' }, 'Sonnet 5')).toMatch(/claude update/);
    expect(brainLabel({ state: 'absent' }, 'Sonnet 5')).toMatch(/code\.claude\.com/);
    expect(brainLabel({ state: 'unknown' }, 'Sonnet 5')).toMatch(/could not check/);
  });

  it('names nothing before the probe answers — absence is not a claim the CLI works', () => {
    expect(brainLabel(undefined, 'Sonnet 5')).toBe('Claude · your CLI');
  });
});
