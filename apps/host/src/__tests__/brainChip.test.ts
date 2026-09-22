// brainChip.test.ts — TASK-20260922 S5 (AC5/AC8): the brain chip on Binding B becomes a
// CONTROL, without ceasing to be a remedy. The five states `brainLabel` has always rendered
// keep their words; the control appears ONLY where the brain is `ready`, because a picker on a
// brain that cannot think is a dead control (AC8 — the ADR-0067 rule, and ADR-0036 rule 4 for
// the same reason on the other binding).
import { describe, expect, it } from 'vitest';

import { brainChipSeat, brainLabel } from '../local/compose-local.js';
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
