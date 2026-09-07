// The suggestion chips + build template come from the knowledge store's ui layer.

import { describe, expect, it } from 'vitest';

import { APP_BUILDER_TOOL_NAME, getUiPrompt } from '@snugprotocol/knowledge';

import { buildUserMessage, parseBuildPrompt } from '../agent/chips.js';
import { buildsToolFree, INLINE_DELIVERY_MIN_CAP_BYTES, knowledgeDeliveryFor } from '../agent/knowledgeDelivery.js';

const parseBuildPromptSource = (): string => getUiPrompt('build-app-prompt');

describe('parseBuildPrompt', () => {
  it('extracts exactly six suggestion chips from the ui prompt', () => {
    const prompt = parseBuildPrompt();
    expect(prompt.chips).toHaveLength(6);
    for (const chip of prompt.chips) expect(chip.length).toBeGreaterThan(4);
  });

  it('keeps the runtime {{appIdea}} placeholder in every template', () => {
    const prompt = parseBuildPrompt();
    for (const delivery of ['tool', 'inline', 'none'] as const) {
      expect(prompt.templates[delivery], delivery).toContain('{{appIdea}}');
    }
    expect(prompt.templates.tool).toContain('Build me a Snug app');
  });
});

describe('buildUserMessage', () => {
  it('substitutes the idea into the template', () => {
    const message = buildUserMessage('a haiku generator', parseBuildPrompt().templates.tool);
    expect(message).toContain('Build me a Snug app: a haiku generator');
    expect(message).not.toContain('{{appIdea}}');
  });

  it('substitutes into a provided parsed prompt (chips are valid ideas)', () => {
    const prompt = parseBuildPrompt();
    const chip = prompt.chips[0] as string;
    expect(buildUserMessage(chip, prompt.templates.tool)).toContain(chip);
  });
});

// TASK-20260906-tool-free-kb-inlining: the USER slot cited the tool too ("Use the
// `snug_app_builder` knowledge base first") — found by the AC5 e2e reading the wire, not by
// any unit test over the system assembly. One template per knowledge delivery, and the view
// picks it from THE one derivation the system slot uses (Gate-5 fold: the inline wording had
// been sent to webllm, whose system slot disclaims the knowledge base).
describe('one user message per knowledge delivery (TASK-20260906, ADR-0066)', () => {
  const prompt = parseBuildPrompt();

  it('the three templates are distinct and each carries the idea placeholder', () => {
    const set = new Set(Object.values(prompt.templates));
    expect(set.size).toBe(3);
  });

  it('the tool-free templates name no tool; the tooled one still names the tool', () => {
    for (const delivery of ['inline', 'none'] as const) {
      const message = buildUserMessage('a haiku generator', prompt.templates[delivery]);
      expect(message, delivery).toContain('a haiku generator');
      expect(message, delivery).not.toContain(APP_BUILDER_TOOL_NAME);
      expect(message, delivery).not.toContain('{{appIdea}}');
    }
    expect(buildUserMessage('a haiku generator', prompt.templates.tool)).toContain(APP_BUILDER_TOOL_NAME);
  });

  it("each template describes only what its system slot carries: 'inline' points at the rules in the instructions, 'none' says there is no knowledge base", () => {
    expect(prompt.templates.inline).toMatch(/in your instructions/i);
    expect(prompt.templates.none).toMatch(/no knowledge base/i);
    expect(prompt.templates.none).not.toMatch(/mandatory template|bridge hooks|CDN table/i);
  });

  it('a missing or placeholder-less section THROWS rather than yielding an empty wire message', () => {
    const source = parseBuildPromptSource();
    expect(() => parseBuildPrompt(source.replace('## User Message Template (unaided)', '## User Message Template (renamed)'))).toThrow(/unaided/);
    expect(() => parseBuildPrompt(source.replace('Build me a small app: {{appIdea}}', 'Build me a small app.'))).toThrow(/placeholder/);
    // CRLF source parses the same as LF (headings are matched as whole lines).
    expect(parseBuildPrompt(source.replace(/\n/g, '\r\n')).templates.inline.replace(/\r/g, '')).toBe(prompt.templates.inline);
  });

  it('knowledgeDeliveryFor: webllm → none; a tool-less host brain → inline, or none when its declared cap cannot hold the core; everything else → tool', () => {
    expect(knowledgeDeliveryFor({ kind: 'webllm' })).toBe('none');
    expect(knowledgeDeliveryFor({ kind: 'host', tools: false })).toBe('inline');
    expect(knowledgeDeliveryFor({ kind: 'host', tools: false, maxPromptBytes: 65_536 })).toBe('inline');
    expect(knowledgeDeliveryFor({ kind: 'host', tools: false, maxPromptBytes: INLINE_DELIVERY_MIN_CAP_BYTES })).toBe('inline');
    expect(knowledgeDeliveryFor({ kind: 'host', tools: false, maxPromptBytes: INLINE_DELIVERY_MIN_CAP_BYTES - 1 })).toBe('none');
    expect(knowledgeDeliveryFor({ kind: 'host', tools: true })).toBe('tool');
    expect(knowledgeDeliveryFor({ kind: 'settings' })).toBe('tool');
    expect(knowledgeDeliveryFor({ kind: 'demo' })).toBe('tool');
    expect(buildsToolFree({ kind: 'webllm' })).toBe(true);
    expect(buildsToolFree({ kind: 'host', tools: true })).toBe(false);
  });
});
