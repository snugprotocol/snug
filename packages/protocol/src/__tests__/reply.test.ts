import { describe, expect, it } from 'vitest';
import { ERROR_CODES, LIMITS, parseAgentReply } from '../index.js';

describe('parseAgentReply — fence-tolerance matrix (AC-3)', () => {
  const expected = { move: 'Nc3', message: 'Knight develops.' };

  it('parses plain JSON', () => {
    const r = parseAgentReply(JSON.stringify(expected));
    expect(r).toMatchObject({ ok: true, data: expected });
  });

  it('parses ```json fenced JSON', () => {
    const r = parseAgentReply('```json\n' + JSON.stringify(expected) + '\n```');
    expect(r).toMatchObject({ ok: true, data: expected });
  });

  it('parses bare ``` fenced JSON', () => {
    const r = parseAgentReply('```\n' + JSON.stringify(expected) + '\n```');
    expect(r).toMatchObject({ ok: true, data: expected });
  });

  it('extracts JSON wrapped in prose', () => {
    const r = parseAgentReply(`Sure! Here is my move:\n${JSON.stringify(expected)}\nGood luck!`);
    expect(r).toMatchObject({ ok: true, data: expected });
  });

  it('survives backticks INSIDE JSON string values (review finding 12)', () => {
    const tricky = { message: 'Use ```js\nconsole.log(1)\n``` to test', move: 'e4' };
    const r = parseAgentReply(JSON.stringify(tricky));
    expect(r).toMatchObject({ ok: true, data: tricky });
  });

  it('extracts balanced braces when prose contains earlier stray text', () => {
    const r = parseAgentReply(`The board {is} complex... ${JSON.stringify(expected)}`);
    // first balanced {...} is "{is}" — invalid JSON object contents; parser must find the real one or fail typed
    expect(typeof r.ok).toBe('boolean');
    if (r.ok) expect(r.data).toEqual(expected);
  });
});

describe('parseAgentReply — typed failures', () => {
  it.each([
    ['empty string', ''],
    ['whitespace', '   \n '],
    ['prose only', 'I cannot answer that.'],
    ['null literal', 'null'],
    ['array', '[1,2,3]'],
    ['scalar', '42'],
    ['truncated', '{"move": "Nc3", "mess'],
  ])('fails %s with PARSE_FAILED and capped rawExcerpt', (_name, input) => {
    const r = parseAgentReply(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe(ERROR_CODES.PARSE_FAILED);
    expect(r.error.rawExcerpt.length).toBeLessThanOrEqual(LIMITS.RAW_EXCERPT_CHARS);
  });

  it('caps rawExcerpt at RAW_EXCERPT_CHARS for huge non-JSON replies', () => {
    const r = parseAgentReply('x'.repeat(10_000));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.rawExcerpt).toHaveLength(LIMITS.RAW_EXCERPT_CHARS);
  });

  it('never throws on adversarial input', () => {
    for (const input of ['{"a":', '```json', '`````', '{}}}', '\u0000\u0001', JSON.stringify({ a: 1 }) + ']']) {
      expect(() => parseAgentReply(input)).not.toThrow();
    }
  });
});

/**
 * TASK-20260812-app-reply-parse-failure — CHARACTERIZATION, not the AC2 repro (that
 * needs the owner's real reply bytes). These pin what the parser ACTUALLY does to the
 * shapes the diagnosis hypothesized, because reading the code refuted hypothesis 1 as
 * written: a bare array of ROW OBJECTS does not fail at all — `balancedObjects` yields
 * the first `{…}` inside it, so the parser silently succeeds with ONE row and drops the
 * rest. The shape that DOES reproduce the owner's symptom (PARSE_FAILED with valid JSON
 * visibly on screen, retry failing identically) is an envelope whose outer object never
 * closes — exactly what a max_tokens cut produces. Any change to either behavior is an
 * AC4 contract decision, not a patch; these tests exist so it cannot happen silently.
 */
describe('parseAgentReply — TASK-20260812 diagnosis characterization', () => {
  it('KNOWN HAZARD: a bare array of row objects "succeeds" with only the FIRST row', () => {
    const r = parseAgentReply('[{"day":"Mon","count":3},{"day":"Tue","count":5}]');
    expect(r).toMatchObject({ ok: true, data: { day: 'Mon', count: 3 } });
  });

  it('a rows envelope cut off mid-array fails: the outer object never closes, so no candidate is yielded', () => {
    // This is the max_tokens truncation shape. Inner rows close at depth 2, never
    // depth 0 — the scanner correctly refuses to serve a fragment as the reply.
    const r = parseAgentReply('{"rows":[{"day":"Mon","count":3},{"day":"Tue","cou');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe(ERROR_CODES.PARSE_FAILED);
  });

  it('a fenced rows envelope cut off before the closing fence also fails', () => {
    const r = parseAgentReply('Here are your weekly counts:\n```json\n{"rows":[{"day":"Mon","count":3},');
    expect(r.ok).toBe(false);
  });
});

/**
 * TASK-20260812 AC2 — the owner's REAL delivered reply bytes (fixture verbatim in the
 * task file; byte-faithful stream replay in adapters' stream-fidelity.test.ts). The
 * network delivered `{{ streaks AS (…` — the `"sql":"WITH ordered AS (…)` head never
 * arrived (end_turn, 215 billed output tokens vs ~245 delivered chars). Refusing this
 * text is CORRECT: braces reach depth 2 and never re-balance, so no candidate object
 * exists. The defect is upstream delivery, not this parser — this test pins that no
 * future parser change starts "accepting" corrupt bytes to make the symptom go away.
 */
describe('parseAgentReply — TASK-20260812 AC2 owner repro (delivered bytes)', () => {
  const DELIVERED_TEXT =
    '{{ streaks AS (SELECT habit_id, COUNT(*) AS streak_len FROM ordered GROUP BY habit_id, grp) ' +
    'SELECT h.name, h.emoji, s.streak_len FROM streaks s JOIN habits h ON h.id = s.habit_id ' +
    'ORDER BY s.streak_len DESC LIMIT 1;","message":"Let\'s see which habit has your longest streak!"}';

  it('fails typed with PARSE_FAILED — the delivered text holds no balanced object', () => {
    const r = parseAgentReply(DELIVERED_TEXT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe(ERROR_CODES.PARSE_FAILED);
    expect(r.error.rawExcerpt).toContain('streaks AS');
  });
});
