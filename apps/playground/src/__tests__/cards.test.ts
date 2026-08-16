/**
 * TASK-20260815-inline-cards AC1 — the card model: strict, bounded, fail-closed.
 *
 * A card is model-authored UI, so the schema is the whole admission story: an unknown
 * key, an oversized body, a one-option non-choice — each must die at parse, because
 * whatever parses WILL render as host chrome the user trusts.
 */

import { describe, expect, it } from 'vitest';

import { buildPresentCardTool, chatCardSchema, metaToCard, parseChatCard, sanitizeCardText } from '../agent/cards.js';

const VALID = {
  body: 'Which playlist should the set build from?',
  options: [
    { id: 'top', label: 'Top tracks' },
    { id: 'recent', label: 'Recent finds', description: 'the last month of saves' },
  ],
};

describe('AC1 — chatCardSchema admits questions, not documents', () => {
  it('accepts a well-formed card', () => {
    expect(chatCardSchema.parse(VALID).options).toHaveLength(2);
  });

  it('refuses oversized bodies, missing options, and single-option non-choices', () => {
    expect(parseChatCard({ ...VALID, body: 'x'.repeat(601) })).toBeUndefined();
    expect(parseChatCard({ body: 'pick' })).toBeUndefined();
    expect(parseChatCard({ ...VALID, options: [VALID.options[0]] })).toBeUndefined();
    expect(parseChatCard({ ...VALID, options: [] })).toBeUndefined();
  });

  it('is STRICT at every level — unknown keys are rejections', () => {
    expect(parseChatCard({ ...VALID, href: 'https://evil.example' })).toBeUndefined();
    expect(
      parseChatCard({ ...VALID, options: [...VALID.options, { id: 'x', label: 'y', onClick: 'alert(1)' }] }),
    ).toBeUndefined();
  });

  it('caps option count at 5', () => {
    const options = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, label: `option ${i}` }));
    expect(parseChatCard({ ...VALID, options })).toBeUndefined();
  });

  it('refuses duplicate option ids IN THE SCHEMA — rehydration is a validation site (Gate-5 B MINOR-3)', () => {
    const dupes = { ...VALID, options: [{ id: 'a', label: 'keep everything' }, { id: 'a', label: 'delete everything' }] };
    expect(parseChatCard(dupes)).toBeUndefined();
    // The crafted-row path dies too: a tap on either option could otherwise record —
    // and send — the FIRST option's label whichever the user actually chose.
    expect(metaToCard({ card: dupes })).toBeUndefined();
  });

  it('sanitizeCardText strips bidi overrides and control characters (Gate-5 B MINOR-4)', () => {
    expect(sanitizeCardText('pay‮ 001$‬ now')).toBe('pay 001$ now');
    expect(sanitizeCardText('a⁦b⁩cd')).toBe('abcd');
    expect(sanitizeCardText('plain label')).toBe('plain label');
  });
});

describe('AC2 — metaToCard re-validates on every read', () => {
  it('rebuilds a pending card and carries messageRowId', () => {
    const state = metaToCard({ card: { ...VALID, messageRowId: 42 } });
    expect(state?.options).toHaveLength(2);
    expect(state?.messageRowId).toBe(42);
    expect(state?.resolution).toBeUndefined();
  });

  it('rebuilds a resolved card only when the resolution points at a REAL option', () => {
    const good = metaToCard({ card: { ...VALID, resolution: { kind: 'selected', optionId: 'top', label: 'ignored' } } });
    expect(good?.resolution).toEqual({ kind: 'selected', optionId: 'top', label: 'Top tracks' });

    // A phantom pick (imported/crafted row) renders as PENDING, never as a lie.
    const phantom = metaToCard({ card: { ...VALID, resolution: { kind: 'selected', optionId: 'ghost', label: 'x' } } });
    expect(phantom?.resolution).toBeUndefined();
  });

  it('drops a drifted card shape entirely — no card beats a wrong card', () => {
    expect(metaToCard({ card: { ...VALID, body: 42 } })).toBeUndefined();
    expect(metaToCard({ card: 'not an object' })).toBeUndefined();
    expect(metaToCard({})).toBeUndefined();
    expect(metaToCard(undefined)).toBeUndefined();
  });
});

describe('AC1/AC4 — the present_card tool stages ONE card per turn', () => {
  const runTool = (onCard: (card: unknown) => boolean | void, input: unknown): Promise<string> => {
    const tool = buildPresentCardTool({ onCard: onCard as never });
    return tool.run(input as Record<string, unknown>) as Promise<string>;
  };

  it('stages a valid card and tells the model the user will answer next turn', async () => {
    const staged: unknown[] = [];
    const result = await runTool((card) => {
      staged.push(card);
      return true;
    }, VALID);
    expect(staged).toHaveLength(1);
    expect(result).toContain('next message');
  });

  it('refuses a second card in the same turn, in-band', async () => {
    const result = await runTool(() => false, VALID);
    expect(result).toContain('NOT shown');
  });

  it('refuses malformed cards and duplicate option ids without staging', async () => {
    const staged: unknown[] = [];
    const bad = await runTool((card) => {
      staged.push(card);
    }, { body: 'x' });
    const dupes = await runTool(
      (card) => {
        staged.push(card);
      },
      { ...VALID, options: [{ id: 'a', label: 'one' }, { id: 'a', label: 'two' }] },
    );
    expect(staged).toHaveLength(0);
    expect(bad).toContain('Error');
    expect(dupes).toContain('unique');
  });
});
