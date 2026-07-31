// The suggestion chips + build template come from the knowledge store's ui layer.

import { describe, expect, it } from 'vitest';

import { buildUserMessage, parseBuildPrompt } from '../agent/chips.js';

describe('parseBuildPrompt', () => {
  it('extracts exactly six suggestion chips from the ui prompt', () => {
    const prompt = parseBuildPrompt();
    expect(prompt.chips).toHaveLength(6);
    for (const chip of prompt.chips) expect(chip.length).toBeGreaterThan(4);
  });

  it('keeps the runtime {{appIdea}} placeholder in the template', () => {
    const prompt = parseBuildPrompt();
    expect(prompt.template).toContain('{{appIdea}}');
    expect(prompt.template).toContain('Build me a Snug app');
  });
});

describe('buildUserMessage', () => {
  it('substitutes the idea into the template', () => {
    const message = buildUserMessage('a haiku generator');
    expect(message).toContain('Build me a Snug app: a haiku generator');
    expect(message).not.toContain('{{appIdea}}');
  });

  it('substitutes into a provided parsed prompt (chips are valid ideas)', () => {
    const prompt = parseBuildPrompt();
    const chip = prompt.chips[0] as string;
    expect(buildUserMessage(chip, prompt)).toContain(chip);
  });
});
