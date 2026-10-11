// access-doors-prompts.test.ts — TASK-20261010-host-broker PR-2 (DS-3, DS-10; D-PR2-10,
// D-PR2-11, D-PR2-17): the three prompt changes the chat door needs, pinned through the
// ACCESSOR the host registers them with (`getToolPrompt` — the generated store, header
// stripped, placeholders rendered), never the source file.
//
//  1. `tools/access-propose.md` (new) — the brain's ask: it grants nothing; call it only when
//     the context has no *From <Source>* section; once per turn; NOT staged is said and the
//     turn carries on; never claim it was allowed; the purpose and the hints parameters.
//  2. `tools/data-query.md` — the tool reaches this app's data AND the shared tables by the exact
//     names shown (`ledger__transactions`, never `Ledger.transactions`); the old "no other app's
//     tables exist from here" sentence, which the chat door makes false, is gone.
//  3. `tools/data-propose-write.md` — never propose a change to a table under *From <Source>*.
//
// The contract pins these sentences literally; whitespace is normalised (the files wrap their
// prose), nothing else. Red until the prompts land AND `gen:content` regenerates the store.

import { describe, expect, it } from 'vitest';

import { getToolPrompt, type ToolPromptName } from '../index.js';

/** One space for every run of whitespace — prompt files wrap their lines. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
const prompt = (name: string): string => flat(getToolPrompt(name as ToolPromptName));

describe('tools/access-propose.md — the brain’s ask (DS-10)', () => {
  const SENTENCES = [
    '## Tool: access propose',
    "Asks the user to let THIS app read another app's data.",
    "It does NOT grant anything: the host shows your ask as a card in this chat, and *review* opens the host's own sheet where the user picks the app, the tables and how long.",
    'Call it only when the user\'s question needs data this app does not hold ("compare this with my ledger", "what\'s in my pantry") and your context has no *From <Source>* section — if one is there, you already have that data: query it with data_query.',
    'Call it once per turn.',
    "If the host answers NOT staged, tell the user why and carry on without the other app's data.",
    'Say what you asked for and that it is waiting for their review; never say it was allowed.',
    '### Parameter: purpose',
    'Required. One line, at most 200 characters, in the user\'s words, saying what you will do with the data: "to compare spending with the ledger".',
    'Never speak as Snug or the host; never claim the user already agreed.',
    '### Parameter: hints',
    'Never shown to another app.',
  ];

  it('is registered and reachable through getToolPrompt', () => {
    expect(() => getToolPrompt('access-propose' as ToolPromptName)).not.toThrow();
    expect(prompt('access-propose').length).toBeGreaterThan(0);
  });

  for (const sentence of SENTENCES) {
    it(`says: ${sentence.slice(0, 72)}…`, () => {
      expect(prompt('access-propose')).toContain(flat(sentence));
    });
  }

  it('the hints parameter names its two lists and their bounds', () => {
    const text = prompt('access-propose');
    expect(text).toContain('`words` (up to 16, each at most 32 characters)');
    expect(text).toContain('`tables` (up to 16 names you expect, like `transactions`)');
  });

  it('never tells the brain it may grant access itself', () => {
    expect(prompt('access-propose')).not.toMatch(/\byou (?:can|may) (?:grant|allow)\b/i);
  });
});

describe('tools/data-query.md — the shared tables by their exact names (DS-3)', () => {
  it('says the tool reaches the From <Source> tables by the exact names shown', () => {
    expect(prompt('data-query')).toContain(
      flat(
        "This tool reaches this app's data — and, when your context has a *From <Source>* section, those tables too, by the exact names shown there (`ledger__transactions`, never `Ledger.transactions`).",
      ),
    );
  });

  it('says nothing else exists from here', () => {
    expect(prompt('data-query')).toContain(flat("Nothing else exists from here: no host tables, no other app's tables beyond the ones listed."));
  });

  it('the sentence the chat door makes false is gone', () => {
    const text = prompt('data-query');
    expect(text).not.toContain('This tool reaches ONLY this app');
    expect(text).not.toContain(flat("No other app's tables and no host tables exist from here — a query naming them fails."));
  });
});

describe('tools/data-propose-write.md — never a change to a shared table (DS-3, D-PR2-17)', () => {
  const SENTENCE = flat(
    "Never propose a change to a table listed under *From <Source>* — those are read-only copies of another app's data; tell the user they can change it in that app.",
  );

  it('carries the sentence', () => {
    expect(prompt('data-propose-write')).toContain(SENTENCE);
  });

  it('right after its first paragraph — before the "smallest set of statements" guidance', () => {
    const text = prompt('data-propose-write');
    const at = text.indexOf(SENTENCE);
    expect(at).toBeGreaterThan(text.indexOf('do not claim it is done.'));
    expect(at).toBeLessThan(text.indexOf('Write the smallest set of statements'));
  });
});
