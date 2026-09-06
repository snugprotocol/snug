// The suggestion chips + build template come from the knowledge store's ui layer.

import { describe, expect, it } from 'vitest';

import { APP_BUILDER_TOOL_NAME } from '@snugprotocol/knowledge';

import { buildUserMessage, parseBuildPrompt } from '../agent/chips.js';
import { buildsToolFree } from '../state/webllm.js';

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

// TASK-20260906-tool-free-kb-inlining: the USER slot cited the tool too ("Use the
// `snug_app_builder` knowledge base first") — found by the AC5 e2e reading the wire, not by
// any unit test over the system assembly. The template has a tool-free twin, and the view
// picks it from THE one derivation of "this build is tool-free".
describe('the tool-free user message (TASK-20260906)', () => {
  it('parses a tool-free template beside the tooled one; both carry the idea placeholder', () => {
    const prompt = parseBuildPrompt();
    expect(prompt.templateToolFree).toContain('{{appIdea}}');
    expect(prompt.templateToolFree).toContain('Build me a Snug app');
    expect(prompt.templateToolFree).not.toBe(prompt.template);
  });

  it('the tool-free message names no tool and points at the rules the prompt carries; the tooled one still names the tool', () => {
    const toolFree = buildUserMessage('a haiku generator', undefined, true);
    expect(toolFree).toContain('Build me a Snug app: a haiku generator');
    expect(toolFree).not.toContain(APP_BUILDER_TOOL_NAME);
    expect(toolFree).not.toContain('{{appIdea}}');
    expect(toolFree).toMatch(/instructions/i);
    const tooled = buildUserMessage('a haiku generator');
    expect(tooled).toContain(APP_BUILDER_TOOL_NAME);
    expect(buildUserMessage('a haiku generator', undefined, false)).toBe(tooled);
  });

  it('buildsToolFree: webllm and a tool-less host brain build tool-free; settings, demo and a tooled host brain do not', () => {
    expect(buildsToolFree({ kind: 'webllm', model: 'm' })).toBe(true);
    expect(buildsToolFree({ kind: 'host', label: 'h', streaming: true, tools: false })).toBe(true);
    expect(buildsToolFree({ kind: 'host', label: 'h', streaming: true, tools: true })).toBe(false);
    expect(buildsToolFree({ kind: 'settings' })).toBe(false);
    expect(buildsToolFree({ kind: 'demo', reason: 'host' })).toBe(false);
  });
});
