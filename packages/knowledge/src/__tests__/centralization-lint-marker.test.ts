// Pins PROMPT_MARKER's behaviour for the centralization lint (ADR-0004).
// TASK-20260824-centralization-lint-false-positive AC2..AC5.
//
// The lint in `centralization-lint.test.ts` walks the repo; this file pins the PREDICATE
// that walk applies, on named fixtures, so a future tightening or loosening of the marker
// has to break a row with a rationale attached to it.
//
// The marker is imported, never retyped -- a fence that restates its data cannot test it
// (lessons.md 2026-08-13).
//
// FIXTURES CARRY THEIR BACKTICKS. `TEMPLATE_LITERAL` matches include the surrounding
// backticks, so the predicate is handed "`You are ...`", not "You are ...". Testing the
// unwrapped text would pin a string the lint never actually sees -- and would have hidden
// the very gap AC2 exists for (a \n-only anchor misses a prompt at a literal's start).
import { describe, expect, it } from 'vitest';

import { MAX_LITERAL_CHARS, PROMPT_MARKER } from './helpers.js';

/** Pad to over MAX_LITERAL_CHARS so the fixture is realistic for the length gate too. */
function padded(body: string): string {
  const filler = ' Lorem ipsum dolor sit amet, consectetur adipiscing elit.'.repeat(12);
  return `\`${body}${filler}\``;
}

interface Fixture {
  readonly name: string;
  readonly body: string;
  readonly trips: boolean;
  readonly ac: string;
}

const FIXTURES: readonly Fixture[] = [
  // --- AC2: a real system prompt at the literal's START (marker at index 1, after the
  // opening backtick -- neither at ^ nor after a newline). The case a \n-only anchor
  // misses, i.e. the most natural spelling of a system prompt in this codebase.
  {
    name: 'system prompt opening the literal (backtick-adjacent)',
    body: 'You are Snug, a host that builds single-file micro apps for one person.',
    trips: true,
    ac: 'AC2',
  },

  // --- AC3: a real system prompt anchored mid-literal, with and without indentation.
  {
    name: 'system prompt on its own line mid-literal',
    body: 'Preamble text for the layer.\nYou are Snug, the app builder.',
    trips: true,
    ac: 'AC3',
  },
  {
    name: 'system prompt on an indented line mid-literal',
    body: 'Preamble text for the layer.\n  You are Snug, the app builder.',
    trips: true,
    ac: 'AC3',
  },

  // --- AC4: second-person PROSE mid-sentence. The eula.ts false positive, in both cases
  // (the marker stays /i, so the capitalized spelling must stay clear too).
  {
    name: 'legal prose, lowercase mid-sentence (the eula.ts case)',
    body:
      'UPDATE CHECK. The desktop app checks github.com for a new version each time it ' +
      'starts. That request tells GitHub your IP address, the time, and the version ' +
      'you are running. You can turn it off in Settings.',
    trips: false,
    ac: 'AC4',
  },
  {
    name: 'prose, capitalized mid-sentence',
    body: 'That request tells GitHub the time, and the version You are running.',
    trips: false,
    ac: 'AC4',
  },
  {
    name: 'prose contraction ("you aren\'t") does not trip the \\b anchor',
    body: 'Nothing installs by itself, so you aren\'t asked to approve an update twice.',
    trips: false,
    ac: 'AC4',
  },

  // --- AC5: the three non-`You are` markers are untouched -- unanchored, any position.
  // They do not occur in ordinary prose, so they need no anchor.
  {
    name: 'MUST respond marker, mid-sentence',
    body: 'The model MUST respond with exactly one fenced HTML block and nothing else.',
    trips: true,
    ac: 'AC5',
  },
  {
    name: 'CRITICAL marker, mid-sentence',
    body: 'Read the envelope first. CRITICAL: never emit an Authorization header.',
    trips: true,
    ac: 'AC5',
  },
  {
    name: 'system prompt marker, mid-sentence',
    body: 'This paragraph is appended to the system prompt at load time by the host.',
    trips: true,
    ac: 'AC5',
  },
];

describe('centralization lint PROMPT_MARKER (ADR-0004)', () => {
  for (const f of FIXTURES) {
    const verb = f.trips ? 'trips' : 'does not trip';
    it(`${f.ac}: ${verb} on ${f.name}`, () => {
      const literal = padded(f.body);
      // Guard the fixture itself: a body under the length gate would make the row
      // vacuous against the real lint, which checks length BEFORE the marker.
      expect(literal.length).toBeGreaterThan(MAX_LITERAL_CHARS);
      expect(PROMPT_MARKER.test(literal)).toBe(f.trips);
    });
  }

  it('anchors `You are` but leaves the other three markers unanchored', () => {
    // The asymmetry is the whole point of the fix, so it gets its own claim rather than
    // living implicitly across the rows above.
    const source = PROMPT_MARKER.source;
    expect(source).toMatch(/You are/);
    for (const unanchored of ['MUST respond', 'CRITICAL', 'system prompt']) {
      expect(PROMPT_MARKER.test(padded(`prose ahead of it. ${unanchored} appears here.`))).toBe(
        true,
      );
    }
  });
});
