// The reply a starter teaches, said once (TASK-20261003-host-bindings-complete C7).
//
// An agent-driven starter describes its reply to the model TWICE on every think: its runtime
// contract's `responseGuidance` (rendered into the system text under "What To Reply") and the
// `responseSchema` its app sends with the request (`RESPONSE_SCHEMA` in app.html). Measured
// 2026-10-03 in claude.ai (the owner's probe report `musuyx9k`, the kit's real 4,576-byte chess
// turn on `sample`): tier `quick` answered `{"from":"e7","to":"e5","message":…}` — the
// CONTRACT's squares at the top level — while tier `default` answered the SCHEMA's
// `{"move":{"from":"e7","to":"e5"},"message":…}`. Chess's reader looked only at `d.move`, so on
// the tier the artifact binding uses for every app reply it played a random legal move and said
// "it answered off-script". Two shapes reaching the model is the defect; this file fails it.
//
// THE RULE, top level only — the reader's first lookup. (These schemas are informal: a nested
// shape often lives inside a prose string, which no parser here can read honestly.)
//   1. Every key a JSON example in the guidance names is a key of the schema: a key the schema
//      lacks is one the app's reader never looks at.
//   2. Every key the schema marks always-present — the template's "(ALWAYS include)"
//      (20-html-template.md), or a JSON-Schema `required` — is named by some example: guidance
//      that leaves it out teaches the model to drop what the reader needs.
//   Optional and lane-only keys may be missing from an example (trade-copilot's one example is
//   one lane; whatsapp's two examples are its two lanes).
// NOT COMPARED, and pinned as such below: an app with no schema (LLM-free), and guidance with
// no parseable JSON example (`{kind,headline,…}` shorthand) — there is nothing to compare, and
// reading shorthand as keys would make this check claim what it cannot know.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The catalogue rule (starterSource.ts, build-starters-pkg.mjs): a folder IS a starter iff it has an app.html. */
const STARTERS = readdirSync(HERE)
  .filter((name) => existsSync(path.join(HERE, name, 'app.html')))
  .sort();

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The index just past the `}` closing the `{` at `start`, or -1. Quote-aware, so a brace inside
 * a string never counts; `quotes` names the string delimiters of the language being read.
 */
function closingBrace(text, start, quotes) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quotes.includes(ch)) {
      for (i += 1; i < text.length && text[i] !== ch; i += 1) if (text[i] === '\\') i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}' && (depth -= 1) === 0) return i + 1;
  }
  return -1;
}

/** Every JSON object written out in the guidance — outermost only (an example's own nested objects are part of it). */
function jsonExamples(guidance) {
  const examples = [];
  let at = guidance.indexOf('{');
  while (at !== -1) {
    const end = closingBrace(guidance, at, '"');
    let parsed;
    try {
      parsed = end === -1 ? undefined : JSON.parse(guidance.slice(at, end));
    } catch {
      parsed = undefined; // shorthand such as `{kind, message}` — not an example
    }
    if (isObject(parsed)) examples.push(parsed);
    at = guidance.indexOf('{', isObject(parsed) ? end : at + 1);
  }
  return examples;
}

/**
 * The app's `RESPONSE_SCHEMA` value, or `null` (LLM-free). The schema is a JavaScript literal —
 * single quotes, bare keys — not JSON, so it is evaluated, alone, in an empty context: that reads
 * it exactly, where a hand-written parser would guess.
 */
function responseSchemaOf(html) {
  const declared = /const RESPONSE_SCHEMA = /.exec(html);
  assert.ok(declared, 'declares RESPONSE_SCHEMA (ADR-0011: every starter states its posture)');
  const start = declared.index + declared[0].length;
  if (html.startsWith('null;', start)) return null;
  const end = closingBrace(html, start, `"'\``);
  assert.ok(html[start] === '{' && end !== -1, 'RESPONSE_SCHEMA is an object literal');
  return vm.runInNewContext(`(${html.slice(start, end)})`, {}, { timeout: 1000 });
}

/** The schema's top-level reply keys, and those it marks always-present. */
function schemaShape(schema) {
  if (schema.type === 'object' && isObject(schema.properties)) {
    // JSON-Schema form (gmail's): the reply's keys are `properties`, the always-present ones `required`.
    return { keys: Object.keys(schema.properties), always: Array.isArray(schema.required) ? [...schema.required] : [] };
  }
  // The template's descriptor form: each value describes its key, and "(ALWAYS include)" marks one the reader needs.
  const keys = Object.keys(schema);
  return { keys, always: keys.filter((key) => typeof schema[key] === 'string' && schema[key].includes('(ALWAYS include)')) };
}

/** `{ compared: false, reason }`, or `{ compared: true, problems }` — the rule above, as data. */
function compareReplyShapes(guidance, schema) {
  if (schema === null) return { compared: false, reason: 'no response schema (LLM-free)' };
  const examples = jsonExamples(guidance ?? '');
  if (examples.length === 0) return { compared: false, reason: 'no JSON example in responseGuidance' };
  const { keys, always } = schemaShape(schema);
  const taught = new Set(examples.flatMap((example) => Object.keys(example)));
  const problems = [
    ...[...taught].filter((key) => !keys.includes(key)).map((key) => `guidance names "${key}", which the schema does not`),
    ...always.filter((key) => !taught.has(key)).map((key) => `the schema always wants "${key}", which no guidance example names`),
  ];
  return { compared: true, problems };
}

function verdictOf(folder) {
  const contractFile = path.join(HERE, folder, 'runtime-contract.json');
  const guidance = existsSync(contractFile) ? JSON.parse(readFileSync(contractFile, 'utf8')).responseGuidance : undefined;
  return compareReplyShapes(guidance, responseSchemaOf(readFileSync(path.join(HERE, folder, 'app.html'), 'utf8')));
}

/**
 * Starters this check cannot compare, by name and reason — so a starter that drops out of the
 * comparison (its example made unparseable, its schema deleted) is a red test, never a silent pass.
 */
const NOT_COMPARED = {
  'flying-pig': 'no response schema (LLM-free)',
  gmail: 'no JSON example in responseGuidance',
  ledger: 'no JSON example in responseGuidance',
};

/**
 * KNOWN DRIFT — findings of this check on starters outside C7's scope, recorded rather than
 * fixed here (each is its own starter release). Pinned EXACTLY: fixing one, or drifting further,
 * fails until this entry is removed or rewritten.
 *  - adventure-quest: its reader reads `narration`/`hpDelta`/`goldDelta`, so a reply in the
 *    guidance's shape is narrated by the local guide ("the storyteller is away"). Its own wiki
 *    already lists it (authoring/docs/next-tasks.md).
 *  - quiz-me: the top level misses `message`; below it — which this check does not read — the
 *    guidance's `{q, choices, answer}` per question is what `validateQuiz` REJECTS (it reads
 *    `question`/`answerIndex`), so a reply in that shape loads the practice bank instead.
 */
const KNOWN_DRIFT = {
  'adventure-quest': [
    'guidance names "story", which the schema does not',
    'guidance names "hearts", which the schema does not',
    'guidance names "gold", which the schema does not',
    'the schema always wants "narration", which no guidance example names',
  ],
  'quiz-me': ['the schema always wants "message", which no guidance example names'],
};

for (const folder of STARTERS) {
  test(`C7: ${folder} teaches one reply shape — its contract's guidance against its app's schema, top level`, (t) => {
    const verdict = verdictOf(folder);
    if (!verdict.compared) {
      assert.equal(verdict.reason, NOT_COMPARED[folder], `${folder} is not compared (${verdict.reason}) — name it in NOT_COMPARED, or give its guidance a JSON example`);
      t.diagnostic(`${folder}: not compared — ${verdict.reason}`);
      return;
    }
    assert.equal(NOT_COMPARED[folder], undefined, `${folder} is compared now — remove it from NOT_COMPARED`);
    if (KNOWN_DRIFT[folder] !== undefined) {
      assert.deepEqual(verdict.problems, KNOWN_DRIFT[folder], `${folder}'s drift changed — fixed? remove it from KNOWN_DRIFT; worse? that is a new finding`);
      t.diagnostic(`${folder}: KNOWN drift (a finding, not fixed here): ${verdict.problems.join('; ')}`);
      return;
    }
    assert.deepEqual(verdict.problems, [], `${folder}: its runtime contract and its app teach two reply shapes`);
  });
}

test('C7: every name in NOT_COMPARED and KNOWN_DRIFT is a starter on the shelf', () => {
  for (const folder of [...Object.keys(NOT_COMPARED), ...Object.keys(KNOWN_DRIFT)]) {
    assert.ok(STARTERS.includes(folder), `${folder} is not a starter`);
  }
});

test('C7: chess teaches exactly what its reader reads — {"move":{"from","to"},"message"}', () => {
  const contract = JSON.parse(readFileSync(path.join(HERE, 'chess', 'runtime-contract.json'), 'utf8'));
  const examples = jsonExamples(contract.responseGuidance);
  assert.equal(examples.length, 1, 'one example');
  // Below the top level too — chess's reader is known: a move is `d.move.from`/`d.move.to`.
  assert.deepEqual(Object.keys(examples[0]).sort(), ['message', 'move']);
  assert.deepEqual(Object.keys(examples[0].move).sort(), ['from', 'to']);
  // …and that IS the reader (app.html, `requestAgentMove` → `replyMove`, `d.move` first). If
  // these lines move, re-read the guidance. MIGRATED (R5 fix round 2, C7): this pinned the
  // one-line `d.move ? [sqIndex(d.move.from), …] : null` reader, which v3 replaced with
  // `replyMove` — the same lookup first, plus the top-level squares `quick` was measured sending.
  const html = readFileSync(path.join(HERE, 'chess', 'app.html'), 'utf8');
  assert.match(html, /const wanted = replyMove\(d\);/);
  assert.match(html, /const squares = isObject\(d\.move\) \? d\.move : d;/);
  assert.match(html, /typeof d\.message === 'string' && d\.message\.trim\(\) \? d\.message\.trim\(\)/);
});

/** Chess's reply reader and its square helpers, sliced from the shipped app.html and EVALUATED — never copied. */
function chessReader() {
  const html = readFileSync(path.join(HERE, 'chess', 'app.html'), 'utf8');
  const start = html.indexOf("const FILES = 'abcdefgh';");
  const end = html.indexOf('const colorOf = ');
  assert.ok(start !== -1 && end > start, 'the square helpers sit between FILES and colorOf');
  return new Function(`${html.slice(start, end)}\nreturn { replyMove, sqIndex };`)();
}

// The guidance is one half of C7; the reader is the other. Measured 2026-10-03 (the owner's
// probe report `musuyx9k`, the kit's real chess turn on `sample`; the recorded replies are
// committed in apps/host/src/__tests__/fixtures/sample-0.2.67/chess-app-turn.musuyx9k.json):
// `default` answered the schema's nested move, `quick` — told the v2 guidance's shape — the
// squares at the top level. Both are a move. Reading both keeps an answer on-script whichever
// one a tier sends, and makes v3 an html release: the update act as v3 first met it landed a
// release's runtime contract only beside new html, so the contract-only v3 left every
// installed, unedited copy on v2's guidance (R5 verification, round 2).
test('C7: chess reads the agent’s move in both shapes measured on sample — the schema’s nested move and quick’s top-level squares', () => {
  const { replyMove, sqIndex } = chessReader();
  const e7e5 = [sqIndex('e7'), sqIndex('e5')];
  // `default`, bare — the reply as the graduated parser hands it to the app.
  assert.deepEqual(replyMove({ move: { from: 'e7', to: 'e5' }, message: "Classic for a classic beatdown. Let's dance.", gameOver: false }), e7e5);
  // `quick`, fenced — unfenced by the parser before the app sees it.
  assert.deepEqual(replyMove({ from: 'e7', to: 'e5', message: "Classic. Let's see what you've got." }), e7e5);
  // The nested move wins when both are present: it is the schema's.
  assert.deepEqual(replyMove({ move: { from: 'e7', to: 'e5' }, from: 'd7', to: 'd5' }), e7e5);
  // No squares → no move: the caller plays a legal one for it and says "off-script".
  for (const d of [{}, { message: 'pinned reply' }, { move: {} }, { move: 'e7e5' }, { from: 'e7' }, { from: 7, to: 5 }, { move: null, from: 'e7' }]) {
    assert.equal(replyMove(d), null, JSON.stringify(d));
  }
  // Squares that are not on the board are still a SUGGESTION — an illegal one, said as such.
  assert.deepEqual(replyMove({ from: 'z9', to: 'e5' }), [-1, sqIndex('e5')]);
});

// The rule itself, on inputs built to break it — a green run over compliant starters cannot tell
// a working comparison from one that compares nothing.
test('C7: the comparison fails the measured chess defect, and only real differences', () => {
  const chessSchema = {
    move: { from: 'string', to: 'string' },
    message: 'string: table talk (ALWAYS include)',
    gameOver: 'boolean (optional)',
  };
  // v2's guidance, verbatim: the shape `quick` followed on 2026-10-03.
  assert.deepEqual(compareReplyShapes('Reply {"from":"e7","to":"e5","say":"one short line of banter"} using squares from `yourLegalMoves`.', chessSchema).problems, [
    'guidance names "from", which the schema does not',
    'guidance names "to", which the schema does not',
    'guidance names "say", which the schema does not',
    'the schema always wants "message", which no guidance example names',
  ]);
  assert.deepEqual(compareReplyShapes('Reply {"move":{"from":"e7","to":"e5"},"message":"hi"}.', chessSchema).problems, [], 'an optional key may be left out');
  // Two lanes, two examples: the union is what is taught.
  const lanes = { kind: 'string', text: "string (kind 'draft')", people: [{ label: 'string' }] };
  assert.deepEqual(compareReplyShapes('profile: {"kind":"profile","people":[]}. draft: {"kind":"draft","text":"…"}.', lanes).problems, []);
  // JSON-Schema form: `required` is the always-present list.
  const jsonSchema = { type: 'object', properties: { kind: { type: 'string' }, answer: { type: 'string' } }, required: ['kind'] };
  assert.deepEqual(compareReplyShapes('Reply {"answer":"…"}.', jsonSchema).problems, ['the schema always wants "kind", which no guidance example names']);
  // Shorthand is not an example; a brace inside a string is not a brace.
  assert.deepEqual(compareReplyShapes('digest → {kind,headline,summary}.', jsonSchema), { compared: false, reason: 'no JSON example in responseGuidance' });
  assert.deepEqual(jsonExamples('see {kind, x} then {"a":"}{","b":{"c":1}} and {"d":2}'), [{ a: '}{', b: { c: 1 } }, { d: 2 }]);
  assert.deepEqual(compareReplyShapes('Reply {"a":1}.', null), { compared: false, reason: 'no response schema (LLM-free)' });
});
