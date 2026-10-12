// data-propose-write-scheduled-prompt.test.ts — TASK-20261010-host-broker PR-4 Gate 5, J2 [JOBS-F2, major].
//
// The scheduled agent's `data_propose_write` gets its OWN definition: `prompts/tools/data-propose-write-scheduled.md`
// (`ToolPromptName` `'data-propose-write-scheduled'`). The chat's description told the model to bind values
// with `?` and pass them in `params` (the scheduled tool refuses params, and an unbound `?` binds NULL — J1),
// that a change runs ONLY on the user's approval (false under an armed schedule), and offered an array of
// statements (the scheduled tool takes one). This file pins:
//
//   - the new prompt, through the ACCESSOR the host reads it with (`getToolPrompt`: header stripped) — its
//     heading, its two parameters (never `params`), and what it must teach, by meaning: ONE
//     INSERT/UPDATE/DELETE on this app's own tables, values written in (no params, no placeholder), never a
//     *From <Source>* table, the answer says whether it waits for the user's OK or this schedule may make it
//     on its own, never claim it was made;
//   - its source file's 4-field header (layer `tool`);
//   - the CHAT's prompt is byte-identical to `main` (its source file's SHA-256 as `main` holds it);
//   - `50-scheduled-agent.md`'s blast-radius header rewritten for the armed case (it no longer says the
//     agent's proposals can never change data).
//
// RED until the prompt lands, `ToolPromptName` names it and `gen:content` regenerates the store.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getToolPrompt, type ToolPromptName } from '../index.js';
import { promptsDir } from './helpers.js';

const NAME = 'data-propose-write-scheduled' as ToolPromptName;
const SOURCE = path.join(promptsDir, 'tools', 'data-propose-write-scheduled.md');
const CHAT_SOURCE = path.join(promptsDir, 'tools', 'data-propose-write.md');
const AGENT_LAYER_SOURCE = path.join(promptsDir, 'system', '50-scheduled-agent.md');

/**
 * `shasum -a 256 packages/knowledge/prompts/tools/data-propose-write.md` — re-pinned 2026-10-12 by
 * TASK-20261010-host-broker PR-5 (v2.2 note (e)): D-PR5-15 amends the chat's prompt (a From table
 * marked *can be changed* takes one statement); `access-doors-prompts.test.ts` pins the amendment.
 * Was main @ 76c9262's '8cb20d464ef50d973d32376ad12a68e271105084e0706d236b82fe977d162791'.
 */
const CHAT_PROMPT_SHA256_ON_MAIN = '8a28e853e59c445876bb474ad2664f0412248ed51183d7c9faae5a22f378d89d';

/** One space for every run of whitespace — prompt files wrap their lines. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
const prompt = (): string => flat(getToolPrompt(NAME));

/** The `<!-- … -->` header of a prompt source file, its fields by name. */
function headerOf(file: string): Record<string, string> {
  const content = readFileSync(file, 'utf8');
  const end = content.indexOf('-->');
  const header = content.startsWith('<!--') && end !== -1 ? content.slice(4, end) : '';
  const fields: Record<string, string> = {};
  for (const line of header.split('\n')) {
    const match = /^([a-z-]+):\s*(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) fields[match[1]] = match[2] ?? '';
  }
  return fields;
}

describe('tools/data-propose-write-scheduled.md — registered, headed, two parameters', () => {
  it('the source file exists with the 4-field header, layer tool', () => {
    expect(existsSync(SOURCE)).toBe(true);
    const header = headerOf(SOURCE);
    expect(header.layer).toBe('tool');
    for (const field of ['destination', 'blast-radius', 'source']) expect(header[field]?.length ?? 0, field).toBeGreaterThan(0);
  });

  it('is registered and reachable through getToolPrompt (the ToolPromptName union names it)', () => {
    expect(() => getToolPrompt(NAME)).not.toThrow();
    expect(prompt().length).toBeGreaterThan(0);
  });

  it('is not the chat’s prompt', () => {
    expect(getToolPrompt(NAME)).not.toBe(getToolPrompt('data-propose-write'));
  });

  it('opens with the tool’s heading', () => {
    expect(getToolPrompt(NAME).trimStart().startsWith('## Tool: data propose write')).toBe(true);
  });

  it('documents exactly two parameters — statements and summary — and never params', () => {
    const params = [...getToolPrompt(NAME).matchAll(/^### Parameter: (\S+)/gm)].map((match) => match[1]);
    expect(params).toEqual(['statements', 'summary']);
  });
});

describe('tools/data-propose-write-scheduled.md — what it teaches', () => {
  it('ONE INSERT, UPDATE or DELETE', () => {
    const text = prompt();
    expect(text).toMatch(/\bONE\b/);
    expect(text).toMatch(/INSERT/);
    expect(text).toMatch(/UPDATE/);
    expect(text).toMatch(/DELETE/);
  });

  it('on THIS app’s own data', () => {
    expect(prompt()).toMatch(/this app[’']s (?:own )?(?:data|tables)/i);
  });

  it('values written into the statement — no params, no placeholder', () => {
    const text = prompt();
    expect(text).toMatch(/(?:written|write)\b[^.]*\b(?:into|in)\b[^.]*\bstatement\b|\bliteral/i);
    expect(text).toMatch(/placeholder|`\?`/);
    expect(text).not.toMatch(/\bparams\b/);
    expect(text).not.toMatch(/\bbind values with\b/i);
  });

  it('never a table listed under *From <Source>*', () => {
    expect(prompt()).toMatch(/From <Source>/);
    expect(prompt()).toMatch(/\bnever\b[^.]*From <Source>/i);
  });

  it('the answer says whether it waits for the user’s OK or this schedule may make it on its own', () => {
    const text = prompt();
    expect(text).toMatch(/waits? for the user[’']s OK/i);
    expect(text).toMatch(/on its own/i);
  });

  it('never claim it was made — and never that ONLY the user’s approval runs a change (false under an armed schedule)', () => {
    const text = prompt();
    expect(text).toMatch(/[Nn]ever say a change was made/);
    expect(text).not.toMatch(/only the user/i);
    expect(text).not.toMatch(/does NOT apply them/);
  });

  it('never asks the model to handle a credential', () => {
    expect(prompt()).not.toMatch(/\b(?:paste|include|send|add)\b[^.]*\b(?:token|api key|password|credential)s?\b/i);
  });
});

describe('the chat’s data-propose-write is unchanged since PR-5 (D-PR5-15 amended it)', () => {
  it('its source file’s SHA-256 is main’s', () => {
    expect(createHash('sha256').update(readFileSync(CHAT_SOURCE)).digest('hex')).toBe(CHAT_PROMPT_SHA256_ON_MAIN);
  });

  it('it still teaches the chat’s approval flow (params, the user’s approval) — the scheduled words never leaked into it', () => {
    const chat = flat(getToolPrompt('data-propose-write'));
    expect(chat).toMatch(/only the user's approval runs them/);
    expect(chat).toMatch(/### Parameter: params/);
  });
});

describe('50-scheduled-agent.md — the blast radius is rewritten for an armed schedule (J2)', () => {
  it('no longer claims the agent’s proposals can never change data', () => {
    const blast = headerOf(AGENT_LAYER_SOURCE)['blast-radius'] ?? '';
    expect(blast.length).toBeGreaterThan(0);
    expect(blast).not.toMatch(/it can never make a change itself \(the host decides what is made, after it has finished\), so the risk is a misleading result, not lost data/);
    expect(blast).not.toMatch(/not lost data/);
  });

  it('names the armed case — the host may make what it proposed, on its own', () => {
    expect(headerOf(AGENT_LAYER_SOURCE)['blast-radius']).toMatch(/on its own/);
  });
});
