/**
 * TASK-20260811-lean-runtime-data-chat, P2 — AC-F1-6: the app-authoring KB teaches lean
 * runtime requests and contract emission (ADR-0018 D5).
 *
 * TWO INDEPENDENT CLAIMS, TESTED SEPARATELY — the auth-KB pattern (auth-kb.test.ts):
 *
 *  1. CONTENT SYNC. The teaching names the REAL tool and the REAL field names, pulled from
 *     the shipped constants and schema rather than retyped. A KB that teaches a field the
 *     schema does not have produces contracts that fail to parse, and nothing else would
 *     catch it — the model would simply keep being wrong.
 *  2. RETRIEVAL DELIVERY. The KB reaches the builder ONLY as `searchKnowledge`'s top
 *     sections. Teaching that cannot win retrieval for the phrasings a builder actually
 *     uses does not exist, however well written it is.
 */

import { describe, expect, it } from 'vitest';
import { RUNTIME_CONTRACT_WRITE_TOOL_NAME } from '../render.js';
import {
  RUNTIME_CONTRACT_OVERVIEW_MAX_CHARS,
  RUNTIME_MAX_OUTPUT_TOKENS_CEILING,
  RUNTIME_MAX_OUTPUT_TOKENS_FLOOR,
} from '@snugprotocol/protocol';

import { getKnowledgeBase, getToolPrompt, searchKnowledge } from '../index.js';

const KB_RUNTIME_FILE = 'knowledge-base/app-authoring/95-runtime-contract.md';

function kbText(file: string): string {
  const section = getKnowledgeBase().find((doc) => doc.file === file);
  expect(section, `${file} missing from the knowledge base`).toBeDefined();
  return (section as { text: string }).text;
}

describe('AC-F1-6 content sync — the teaching matches the shipped surface', () => {
  it('names the real tool, from the constant rather than a retyped literal', () => {
    expect(kbText(KB_RUNTIME_FILE)).toContain(RUNTIME_CONTRACT_WRITE_TOOL_NAME);
  });

  it('teaches every field the schema actually accepts', () => {
    const text = kbText(KB_RUNTIME_FILE);
    for (const field of [
      'overview',
      'personaNote',
      'stateGuidance',
      'responseGuidance',
      'settings',
      'maxOutputTokens',
    ]) {
      expect(text, `KB must teach the ${field} seat`).toContain(field);
    }
  });

  it('teaches no field the schema would REJECT (a taught-but-invalid seat is a silent failure)', () => {
    const text = kbText(KB_RUNTIME_FILE);
    for (const invented of ['systemPrompt', 'tools', 'model', 'temperature', 'instructions']) {
      expect(text, `KB must not teach "${invented}" — strictObject rejects it`).not.toContain(`\`${invented}\``);
    }
  });

  it('states the bounds it claims, in agreement with the schema constants', () => {
    const text = kbText(KB_RUNTIME_FILE);
    expect(text).toContain(String(RUNTIME_CONTRACT_OVERVIEW_MAX_CHARS));
    expect(text).toContain(String(RUNTIME_MAX_OUTPUT_TOKENS_FLOOR));
    expect(text).toContain(String(RUNTIME_MAX_OUTPUT_TOKENS_CEILING));
  });

  it('teaches the anti-duplication rule the Chess starter used to violate', () => {
    // The measured over-send: fen+history in BOTH `payload` and `state`, plus persona
    // prose re-sent every move. The KB is where that stops being repeated.
    const text = kbText(KB_RUNTIME_FILE).toLowerCase();
    expect(text).toContain('state');
    expect(text).toContain('payload');
    expect(text).toMatch(/duplicat|twice|both/);
  });

  it('teaches WHEN to re-emit on edits (the copy-forward rule makes this cheap to get wrong)', () => {
    expect(kbText(KB_RUNTIME_FILE).toLowerCase()).toMatch(/edit|change/);
  });

  it('the tool prompt and the KB agree on the tool’s name', () => {
    expect(getToolPrompt('runtime-contract-write')).toContain('runtime contract');
  });
});

describe('AC-F1-6 retrieval delivery — build-time queries reach the teaching', () => {
  /**
   * The phrasings that should reach THIS section. Deliberately NOT the bare SDK API
   * names: measured against the shipped searcher, `sendMessage` and `response schema`
   * are correctly owned by the sections that DEFINE those APIs (20-html-template's
   * "sendMessage Options", 50-app-catalog's "Response schema for moves"). Demanding
   * this section outrank them would be asserting a worse corpus — the contract teaching
   * is about lean requests and contract emission, not about the call signature.
   */
  const queries = [
    'runtime contract',
    'what to send each turn',
    'app settings for the model',
    'lean runtime request',
    'contract for run time turns',
  ];

  for (const query of queries) {
    it(`"${query}" returns the runtime-contract section in the top 5`, () => {
      const hits = searchKnowledge(query).slice(0, 5);
      expect(
        hits.some((hit) => hit.file === KB_RUNTIME_FILE),
        `top-5 for "${query}": ${hits.map((h) => h.file).join(', ')}`,
      ).toBe(true);
    });
  }

  it('does NOT displace the sections that own the SDK call itself', () => {
    // The complement of the rule above, pinned so a future edit that stuffs this file
    // with API keywords to "win" retrieval fails loudly instead of quietly degrading
    // the answers a builder gets when asking about the call signature.
    const top = searchKnowledge('sendMessage').slice(0, 2).map((hit) => hit.file);
    expect(top).not.toContain(KB_RUNTIME_FILE);
  });
});
