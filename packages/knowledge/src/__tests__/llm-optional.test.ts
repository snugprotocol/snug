// llm-optional.test.ts — the LLM-optional app doctrine (TASK-20260803-hub-ops AC24,
// ADR-0011).
//
// The KB used to DEFINE a Snug app as one that "thinks through the host's agent at
// runtime". That definition is the doctrine gap: it makes an app that never calls the
// model read as not-a-real-app, so generations bolt on a pointless agent round trip.
// An app is defined by the CONTRACT it honours (single file, sandbox, host-brokered
// storage), not by whether it happens to consult the model.
//
// These assert on the prompt sources, which are the authored artifacts; the generated
// content module is checked for drift separately by content-drift.test.ts.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { promptsDir } from './helpers.js';

const read = (...parts: string[]): string => readFileSync(path.join(promptsDir, ...parts), 'utf8');

const overview = (): string => read('knowledge-base', 'app-authoring', '10-overview-and-contract.md');
const catalog = (): string => read('knowledge-base', 'app-authoring', '50-app-catalog.md');
const builderPreamble = (): string => read('skills', 'builder-preamble.md');

describe('LLM-optional app doctrine (AC24)', () => {
  it('no longer defines an app as one that thinks through the agent', () => {
    // The exact phrasing that encoded the gap, in both places it appeared.
    for (const [name, text] of [
      ['overview', overview()],
      ['builder preamble', builderPreamble()],
    ] as const) {
      expect(text, `${name} still defines an app by agent-dependence`).not.toMatch(
        /thinks? through the host's agent at runtime/i,
      );
    }
  });

  it('states outright that an app need not call the agent', () => {
    const text = overview();
    expect(text).toMatch(/never calls? the agent|without ever calling the agent|need not call the agent/i);
    // And the capability is framed as optional rather than constitutive.
    expect(text).toMatch(/\bMAY\b|optional/);
  });

  it('keeps the rest of the contract intact — the sandbox rules are not softened', () => {
    const text = overview();
    // The things an app genuinely cannot do must survive the doctrine rewrite.
    expect(text).toMatch(/cannot/i);
    expect(text).toContain('fetch');
    expect(text).toMatch(/null origin/i);
    // The hooks are still the whole app-side API.
    expect(text).toContain('useSnugApp');
    expect(text).toContain('usePersistedState');
  });

  it('adds an autonomous / local-only archetype to the catalog', () => {
    const text = catalog();
    expect(text).toMatch(/autonomous|local-only|arcade/i);
    // The catalog table gives every archetype an "Agent's role" — the new row must say
    // explicitly that there is none, rather than inventing one.
    expect(text).toMatch(/\bnone\b/i);
  });

  it('tells the builder how to DECIDE whether a turn needs the model', () => {
    const text = catalog();
    // The decision guidance is the actionable half of AC24: chess = every move,
    // arcade game = never.
    expect(text).toMatch(/every move/i);
    expect(text).toMatch(/never/i);
  });

  it('keeps the nine original archetypes — the row is added, not swapped', () => {
    const text = catalog();
    for (const archetype of [
      'Board games',
      'Card games',
      'Word games',
      'Puzzles',
      'Education',
      'Trackers',
      'Data tools',
      'Creative',
      'Simulations',
    ]) {
      expect(text, `archetype "${archetype}" disappeared`).toContain(archetype);
    }
  });
});
