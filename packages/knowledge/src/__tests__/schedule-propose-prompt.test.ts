// schedule-propose-prompt.test.ts — TASK-20261010-host-broker PR-4 Gate 6 (ADR-0076 §9; the PR-4 fold and
// Gate-5 U3).
//
// `prompts/tools/schedule-propose.md` — the description the host registers for the builder's and the
// `schedule` lane's schedule-propose tool — pinned through the ACCESSOR the host reads it with
// (`getToolPrompt`: the generated store, header stripped, placeholders rendered), never the source file.
//
// GET-only is NOT read-only: an API can act on a GET, and what the AI asks can carry data. So the step that
// *may look things up* (`"tools":true`) may not promise the app's AI reads its connections *read only*; it
// says the AI can only ask them with GET and that some services act on a GET, so it fetches only what the
// question needs. Pinned by meaning (a regex per idea, whitespace flattened). No earlier pin in this package
// covered this prompt, so there is nothing to invert here.
//
// RED until the prompt's wording lands AND `gen:content` regenerates the store.

import { describe, expect, it } from 'vitest';

import { getToolPrompt, type ToolPromptName } from '../index.js';

/** One space for every run of whitespace — prompt files wrap their lines. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
const NAME: ToolPromptName = 'schedule-propose';
const prompt = (): string => flat(getToolPrompt(NAME));

const READ_ONLY_PROMISE = /only reads|read[- ]only|cannot change anything|can.t change anything/i;
const ACTS_ON_A_GET = /act on a GET|act on GET|change something on a GET/i;

/** The `"tools":true` step's bullet — from its JSON shape up to the next step's bullet (whitespace flattened). */
const lookUpStep = (): string => {
  const match = /- `\{"kind":"app-think","prompt":"…","tools":true\}`(.*?)(?= - `\{|$)/.exec(prompt());
  expect(match, 'the prompt documents the `"tools":true` app-think step as its own bullet').not.toBeNull();
  return match?.[1] ?? '';
};

describe('tools/schedule-propose.md — GET-only is not read-only (PR-4 Gate 6)', () => {
  it('is registered and reachable through getToolPrompt', () => {
    expect(() => getToolPrompt(NAME)).not.toThrow();
    expect(prompt().length).toBeGreaterThan(0);
  });

  it('NEGATIVE: nowhere promises a look-up only reads, is read-only, or cannot change anything', () => {
    expect(prompt()).not.toMatch(READ_ONLY_PROMISE);
  });

  it('NEGATIVE: the look-up step no longer says its connection reads are “— read only”', () => {
    expect(lookUpStep()).not.toMatch(/—\s*read[- ]only/i);
  });

  it('the look-up step says the app’s AI can only ask its connections with GET', () => {
    expect(lookUpStep()).toMatch(/\bGET\b/);
  });

  it('the look-up step says some services act on a GET — so it fetches only what the question needs', () => {
    expect(lookUpStep()).toMatch(ACTS_ON_A_GET);
  });
});
