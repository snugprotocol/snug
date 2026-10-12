// fetch-connection-prompt.test.ts — TASK-20261010-host-broker PR-4 (AC30; contract v2 D-PR4-13).
//
// `prompts/tools/fetch-connection.md` — the description the host registers for the scheduled agent's
// `fetch_connection` tool — pinned through the ACCESSOR the host reads it with (`getToolPrompt`: the
// generated store, header stripped, placeholders rendered), never the source file. Its header, its
// three parameters (and no fourth), and what it must teach:
//
//   - GET only: it can only ask with GET, and there is no method to choose — not even by asking; but
//     GET-only is NOT read-only (ADR-0076 §9, PR-4 Gate 6): some services act on a GET, so it never
//     promises it *only reads* or *cannot change anything*, and it fetches only what the question needs;
//   - the path is RELATIVE to the connection (the host owns the address; no full URL, no host);
//   - the taint rule: after reading another app's data in a run, no more fetching.
//
// The contract gives the rule, not the sentences, so the teaching rows are pinned by meaning (a
// regex per idea, whitespace flattened); the header and the parameter headings are pinned literally.
// RED until the prompt lands AND `gen:content` regenerates the store.

import { describe, expect, it } from 'vitest';

import { getToolPrompt, type ToolPromptName } from '../index.js';

/** One space for every run of whitespace — prompt files wrap their lines. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
const prompt = (): string => flat(getToolPrompt('fetch-connection' as ToolPromptName));

describe('tools/fetch-connection.md — registered, headed, three parameters', () => {
  it('is registered and reachable through getToolPrompt (the ToolPromptName union names it)', () => {
    const name: ToolPromptName = 'fetch-connection';
    expect(() => getToolPrompt(name)).not.toThrow();
    expect(prompt().length).toBeGreaterThan(0);
  });

  it('opens with its tool heading', () => {
    expect(getToolPrompt('fetch-connection' as ToolPromptName).trimStart().startsWith('## Tool: fetch connection')).toBe(true);
  });

  it('documents exactly the three parameters — connection, path, query', () => {
    const text = getToolPrompt('fetch-connection' as ToolPromptName);
    const params = [...text.matchAll(/^### Parameter: (\S+)/gm)].map((match) => match[1]);
    expect(params).toEqual(['connection', 'path', 'query']);
  });

  it('documents no method, body, headers or url parameter', () => {
    const text = getToolPrompt('fetch-connection' as ToolPromptName);
    expect(text).not.toMatch(/^### Parameter: (?:method|body|headers|url)\b/m);
  });
});

describe('tools/fetch-connection.md — what it teaches', () => {
  // INVERTED by PR-4 Gate-6 (GET-only is not read-only) — ADR-0076's PR-4 fold and Gate-5 U3: an API can
  // act on a GET, and what the AI asks can carry data, so the prompt may not promise the tool only reads.
  // Was:
  //   it('GET only — it reads', () => {
  //     const text = prompt();
  //     expect(text).toMatch(/\bGET\b/);
  //     expect(text).toMatch(/\bread(?:s|-only| only)?\b/i);
  //   });
  it('GET only — it can only ask with GET (INVERTED by PR-4 Gate-6: GET-only is not read-only)', () => {
    expect(prompt()).toMatch(/\bGET\b/);
  });

  it('there is no method to choose', () => {
    expect(prompt()).toMatch(/\b(?:no|never|not|cannot|can’t|can't)\b[^.]*\bmethods?\b|\bmethods?\b[^.]*\b(?:no|never|not|cannot|can’t|can't)\b/i);
  });

  it('it never offers a write verb as something to send', () => {
    expect(prompt()).not.toMatch(/\b(?:use|send|choose)\s+(?:a\s+)?(?:POST|PUT|PATCH|DELETE)\b/);
  });

  it('the path is relative to the connection — starting with “/”, never a host or a full URL', () => {
    const text = prompt();
    expect(text).toMatch(/\brelative\b/i);
    expect(text).toMatch(/\bstarts? with\b[^.]*`?\/`?|\bbegins? with\b[^.]*`?\/`?/i);
  });

  it('the taint rule: after reading another app’s data in this run, it does not fetch', () => {
    const text = prompt();
    expect(text).toMatch(/another app[’']s data/i);
    expect(text).toMatch(/\bafter\b/i);
  });

  it('the connection is named by its slot', () => {
    expect(prompt()).toMatch(/\bslot\b|\bconnection name\b/i);
  });

  it('never asks the model to handle a credential', () => {
    expect(prompt()).not.toMatch(/\b(?:paste|include|send|add)\b[^.]*\b(?:token|api key|password|credential)s?\b/i);
  });
});

// TASK-20261010-host-broker PR-4 Gate 6 — ADR-0076's PR-4 fold and Gate-5 U3: GET-only is NOT read-only (an API
// can act on a GET; what the AI asks can carry data). No model-facing surface may promise the fetch tool only
// reads or cannot change anything; it says the tool can only ask with GET and that some services act on a GET,
// so it fetches only what the question needs. Pinned by meaning, whitespace flattened.
describe('tools/fetch-connection.md — GET-only is not read-only (PR-4 Gate 6)', () => {
  const READ_ONLY_PROMISE = /only reads|read[- ]only|cannot change anything|can.t change anything/i;
  const ACTS_ON_A_GET = /act on a GET|act on GET|change something on a GET/i;

  it('NEGATIVE: never promises it only reads, is read-only, or cannot change anything', () => {
    expect(prompt()).not.toMatch(READ_ONLY_PROMISE);
  });

  it('says it can only ask with GET', () => {
    expect(prompt()).toMatch(/\bGET\b/);
  });

  it('says some services act on a GET — so it fetches only what the question needs', () => {
    expect(prompt()).toMatch(ACTS_ON_A_GET);
  });
});
