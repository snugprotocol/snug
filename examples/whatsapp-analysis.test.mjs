// The WhatsApp Twin starter's two load-bearing pure functions, tested directly.
//
// Run through the workspace, with the other example gates:
//
//   pnpm --filter examples test
//
// WHY THIS FILE EXISTS AT ALL. `validate.test.mjs` checks the *shape* of every starter —
// single-file, hooks byte-identical, no direct network, honest LLM posture. It cannot check
// whether a parser parses. Twin ships two functions whose failure modes are silent and
// expensive, so they are extracted from `app.html` and driven against fixtures here:
//
//   1. `parseWhatsAppExport` (AC13) — every per-person statistic, every persona profile and
//      every mimic reply is computed FROM its output. A parser that splits one multiline
//      message into four does not crash; it quietly reports that someone sends four times as
//      many messages as they do, and the psychologist-grade profile downstream is confidently
//      wrong. The fixtures below are therefore hostile to the MECHANISM (bidi controls, a
//      body containing a timestamp-shaped line, locale-dotted dates), not merely to the
//      happy path.
//   2. `pseudonymizeForLlm` (AC12/B4) — the new-reader scrub. Twin sends OTHER PEOPLE's
//      private messages to a third-party model provider under the user's own key. Those
//      people never consented and are not Snug users. `scrubAuthValues` does not cover this:
//      it scrubs injected CREDENTIALS on the way INTO the iframe, a different reader at a
//      different altitude (lessons.md:40 — when the consumer class changes, re-derive the
//      scrub per reader).
//
// THE EXTRACTION SEAM. Both functions live inside the single-file `app.html` (the format is
// the product — a starter is one file a user can read end to end). To test them we slice the
// authored region out of the babel script and evaluate just those two declarations. That is
// deliberately a REAL evaluation of the shipped source: a copy of the functions in this file
// would pass forever after `app.html` drifted, which is the failure this seam exists to
// prevent. The slice is asserted non-empty below, so a rename that breaks extraction fails
// loudly rather than silently testing nothing (lessons.md 2026-08-06: a suite that does not
// run is not a suite that passes).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_HTML = path.join(HERE, 'whatsapp', 'app.html');

/**
 * Pull the named function declarations out of the shipped app and evaluate them.
 *
 * Extraction is by explicit begin/end markers rather than a brace-counting parse: a regex
 * that tried to find the end of a function body would be a second, worse JS parser living in
 * a test file, and it would break on the first nested brace in a template literal.
 */
function loadAnalysisModule() {
  const html = readFileSync(APP_HTML, 'utf8');
  const script = /<script type="text\/babel">\n([\s\S]*?)\n\s*<\/script>/.exec(html)?.[1] ?? '';
  assert.ok(script.length > 0, 'the babel script was found');

  const BEGIN = '// ===== ANALYSIS-CORE-BEGIN =====';
  const END = '// ===== ANALYSIS-CORE-END =====';
  const start = script.indexOf(BEGIN);
  const end = script.indexOf(END);
  assert.ok(start >= 0, 'app.html carries the ANALYSIS-CORE-BEGIN marker');
  assert.ok(end > start, 'app.html carries the ANALYSIS-CORE-END marker after the begin marker');

  const source = script.slice(start + BEGIN.length, end);
  // Non-vacuity: an empty slice would make every assertion below pass against nothing.
  assert.ok(source.trim().length > 200, 'the extracted analysis core is substantial, not an empty slice');

  const factory = new Function(`${source}\nreturn { parseWhatsAppExport, pseudonymizeForLlm, buildPseudonymMap };`);
  return factory();
}

const { parseWhatsAppExport, pseudonymizeForLlm, buildPseudonymMap } = loadAnalysisModule();

// ---------------------------------------------------------------------------------------
// AC13 — export parser, fixtures hostile to the mechanism
// ---------------------------------------------------------------------------------------

test('parses the iOS bracketed shape', () => {
  const out = parseWhatsAppExport('[12/03/2025, 21:04:11] Priya: on my way\n[12/03/2025, 21:05:02] Sam: cool');
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].author, 'Priya');
  assert.equal(out.messages[0].text, 'on my way');
  assert.equal(out.messages[1].author, 'Sam');
});

test('parses the Android dashed shape', () => {
  const out = parseWhatsAppExport('12/03/2025, 21:04 - Priya: on my way\n12/03/2025, 21:05 - Sam: cool');
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].author, 'Priya');
  assert.equal(out.messages[1].text, 'cool');
});

test('parses the US 12-hour shape', () => {
  const out = parseWhatsAppExport('3/12/25, 9:04 PM - Priya: evening\n3/12/25, 9:05 PM - Sam: hi');
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].author, 'Priya');
  assert.equal(out.messages[0].text, 'evening');
});

test('parses the dot-separated locale shape', () => {
  const out = parseWhatsAppExport('12.03.2025, 21:04 - Priya: hallo\n12.03.2025, 21:05 - Sam: hei');
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].author, 'Priya');
});

test('parses lines carrying bidi control characters (U+200E / U+202F)', () => {
  // WhatsApp's own iOS export writes LRM before the bracket and NNBSP before AM/PM. A parser
  // that anchors on a literal '[' sees a non-matching line and drops the entire export.
  const out = parseWhatsAppExport('‎[12/03/2025, 9:04:11 PM] Priya: with marks\n‎[12/03/2025, 9:05:02 PM] Sam: also');
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].author, 'Priya');
  assert.equal(out.messages[0].text, 'with marks');
});

test('a multiline body attaches to its parent message rather than splitting', () => {
  // THE BUG THAT SILENTLY CORRUPTS EVERY PER-PERSON STATISTIC. Four continuation lines
  // becoming four messages would triple Priya's apparent message count and flatten her
  // apparent message length — and nothing would ever error.
  const out = parseWhatsAppExport(
    '[12/03/2025, 21:04:11] Priya: first line\nsecond line\nthird line\n[12/03/2025, 21:06:00] Sam: reply',
  );
  assert.equal(out.messages.length, 2, 'continuation lines do not become their own messages');
  assert.equal(out.messages[0].text, 'first line\nsecond line\nthird line');
  assert.equal(out.messages[1].author, 'Sam');
});

test('a body CONTAINING a timestamp-shaped line stays one message', () => {
  // Someone quoting a schedule into chat. The continuation line looks like a header to a
  // naive line-by-line scan, so the quote is torn into a separate message attributed to
  // nobody — or worse, to a fabricated author.
  const out = parseWhatsAppExport(
    '[12/03/2025, 21:04:11] Priya: the plan is\n[12/03/2025, 21:04:11] Sam: this is quoted text, not a real header\nstill me',
  );
  assert.equal(out.messages.length, 2, 'a quoted timestamp line is still parsed as a header when well-formed');
  assert.equal(out.messages[1].author, 'Sam');
  assert.equal(out.messages[1].text, 'this is quoted text, not a real header\nstill me');
});

test('system lines never become messages', () => {
  const out = parseWhatsAppExport(
    '[12/03/2025, 21:00:00] Messages and calls are end-to-end encrypted. No one outside of this chat can read them.\n'
      + '[12/03/2025, 21:04:11] Priya: real message',
  );
  assert.equal(out.messages.length, 1, 'the encryption notice is not a message');
  assert.equal(out.messages[0].author, 'Priya');
  assert.equal(out.systemLines, 1);
});

test('media-omitted lines and deletion tombstones never become messages', () => {
  const out = parseWhatsAppExport(
    '[12/03/2025, 21:04:11] Priya: <Media omitted>\n'
      + '[12/03/2025, 21:05:00] Sam: This message was deleted\n'
      + '[12/03/2025, 21:06:00] Priya: actual words',
  );
  assert.equal(out.messages.length, 1, 'only the real message survives');
  assert.equal(out.messages[0].text, 'actual words');
  assert.equal(out.skipped, 2);
});

test('a DM export and a group export are both parsed, and group participants are collected', () => {
  const group = parseWhatsAppExport(
    '[12/03/2025, 21:04:11] Priya: a\n[12/03/2025, 21:05:00] Sam: b\n[12/03/2025, 21:06:00] Ravi: c',
  );
  assert.deepEqual([...group.authors].sort(), ['Priya', 'Ravi', 'Sam']);
});

test('an unparseable blob yields zero messages rather than throwing', () => {
  // The user uploads the wrong file. A parser that throws takes the whole app down with it.
  const out = parseWhatsAppExport('this is not a whatsapp export at all\njust some prose');
  assert.equal(out.messages.length, 0);
  assert.ok(out.unparsedLines >= 2, 'the unparsed lines are counted and can be disclosed');
});

test('export-derived and live-derived identities are never silently merged', () => {
  // Export lines carry a DISPLAY NAME; the live socket carries a JID. Two participants
  // sharing a display name are two people, and merging them would attribute one person's
  // words — and psychology — to another.
  const out = parseWhatsAppExport('[12/03/2025, 21:04:11] Priya: a\n[12/03/2025, 21:05:00] Priya: b');
  assert.equal(out.messages[0].source, 'export');
  assert.equal(out.messages[0].authorJid, undefined, 'an export line never invents a JID');
});

// ---------------------------------------------------------------------------------------
// AC12 / BLOCKER B4 — the new-reader scrub
// ---------------------------------------------------------------------------------------

test('a phone number in a real-shaped export never appears in the LLM-bound payload', () => {
  // THE LOAD-BEARING NEGATIVE. Driven through the real parser, not a hand-built object, so
  // it exercises the path the app actually takes.
  const raw = '[12/03/2025, 21:04:11] +91 98765 43210: call me on +91 98765 43210\n'
    + '[12/03/2025, 21:05:00] Priya: ok';
  const parsed = parseWhatsAppExport(raw);
  const map = buildPseudonymMap(parsed);
  const payload = pseudonymizeForLlm(parsed.messages, map);
  const serialized = JSON.stringify(payload);

  assert.doesNotMatch(serialized, /98765/, 'no fragment of the phone number survives');
  assert.doesNotMatch(serialized, /\+91/, 'no dialing prefix survives');
  assert.ok(serialized.length > 0, 'the payload is not empty — the scrub redacts, it does not delete');
});

test('a JID never appears in the LLM-bound payload', () => {
  const messages = [
    { author: '919876543210@s.whatsapp.net', authorJid: '919876543210@s.whatsapp.net', text: 'hi', ts: 1, source: 'live' },
  ];
  const map = buildPseudonymMap({ messages, authors: new Set(['919876543210@s.whatsapp.net']) });
  const serialized = JSON.stringify(pseudonymizeForLlm(messages, map));
  assert.doesNotMatch(serialized, /@s\.whatsapp\.net/, 'no JID domain survives');
  assert.doesNotMatch(serialized, /919876543210/, 'no JID user part survives');
});

test('a JID appearing only in a message BODY is scrubbed by the pattern, not by the name map', () => {
  // FIXTURE NOTE, and the reason this test exists beside the one above. In that test the JID
  // is the AUTHOR, so the pseudonym map replaces it by exact name and `JID_PATTERN` is never
  // reached — deleting the pattern entirely leaves that test green. It measures the map, not
  // the pattern. The dangerous shape is a JID belonging to SOMEONE NOT IN THIS THREAD,
  // forwarded into the body: no map entry can match it, so the primitive is the only thing
  // standing between it and the model. (lessons.md 2026-08-04: a refusal's fixture must pass
  // every sibling refusal and fail only on the guard under test.)
  const messages = [{ author: 'Priya', text: 'here is his contact 447700900999@s.whatsapp.net', ts: 1, source: 'live' }];
  const map = buildPseudonymMap({ messages, authors: new Set(['Priya']) });
  const serialized = JSON.stringify(pseudonymizeForLlm(messages, map));
  assert.doesNotMatch(serialized, /@s\.whatsapp\.net/, 'the JID domain is scrubbed from the body');
  assert.doesNotMatch(serialized, /447700900999/, 'the JID user part is scrubbed from the body');
});

test('a phone number written INSIDE a message body is scrubbed, not just the author field', () => {
  // Scrubbing only the author seat would leave the body — where numbers are actually
  // shared — untouched. The reader is the LLM, and it reads the body.
  const messages = [{ author: 'Priya', text: 'my new number is +44 7700 900123, save it', ts: 1, source: 'export' }];
  const map = buildPseudonymMap({ messages, authors: new Set(['Priya']) });
  const serialized = JSON.stringify(pseudonymizeForLlm(messages, map));
  assert.doesNotMatch(serialized, /7700\s*900123/, 'an in-body number is scrubbed');
  assert.doesNotMatch(serialized, /\+44/, 'an in-body dialing prefix is scrubbed');
});

test('pseudonyms are STABLE per thread — arrival order cannot change anyone\'s label', () => {
  // FIXTURE NOTE: building the map twice from the SAME array proves nothing — insertion
  // order is identical either way, so an unsorted map passes it (verified: deleting the
  // sort left that version green). What `sort()` actually defends against is the SAME
  // people arriving in a DIFFERENT order — a later history page, a re-analysis after new
  // messages — which is exactly when a shuffled label would silently re-attribute one
  // person's psychology to another.
  const early = parseWhatsAppExport('[12/03/2025, 21:04:11] Priya: a\n[12/03/2025, 21:05:00] Sam: b');
  const reordered = parseWhatsAppExport('[12/03/2025, 21:04:11] Sam: b\n[12/03/2025, 21:05:00] Priya: a');

  const labelFor = (parsed, author) => {
    const map = buildPseudonymMap(parsed);
    return map.get(author);
  };
  assert.equal(labelFor(early, 'Priya'), labelFor(reordered, 'Priya'), 'Priya keeps her label');
  assert.equal(labelFor(early, 'Sam'), labelFor(reordered, 'Sam'), 'Sam keeps his label');
  assert.notEqual(labelFor(early, 'Priya'), labelFor(early, 'Sam'), 'two people get two different labels');
});

test('pseudonyms are DISTINCT per person — two people never collapse to one label', () => {
  const parsed = parseWhatsAppExport(
    '[12/03/2025, 21:04:11] Priya: a\n[12/03/2025, 21:05:00] Sam: b\n[12/03/2025, 21:06:00] Ravi: c',
  );
  const payload = pseudonymizeForLlm(parsed.messages, buildPseudonymMap(parsed));
  assert.equal(new Set(payload.map((m) => m.author)).size, 3, 'three people, three labels');
});

test('the scrub preserves the message text that is not identifying', () => {
  // A scrub that redacted everything would pass every negative above and make the app
  // useless. This is the sibling assertion that keeps the negatives honest.
  const parsed = parseWhatsAppExport('[12/03/2025, 21:04:11] Priya: the tone here matters a lot');
  const payload = pseudonymizeForLlm(parsed.messages, buildPseudonymMap(parsed));
  assert.match(payload[0].text, /the tone here matters a lot/);
});
