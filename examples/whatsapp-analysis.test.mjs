// Telepath's load-bearing pure core, tested directly (TASK-20260817-telepath, ADR-0034).
//
// Run through the workspace, with the other example gates:
//
//   pnpm --filter examples test
//
// WHY THIS FILE EXISTS AT ALL. `validate.test.mjs` checks the *shape* of every starter —
// single-file, hooks byte-identical, no direct network, honest LLM posture. It cannot check
// whether the privacy boundary holds or the statistics count. Telepath ships functions whose
// failure modes are silent and expensive, so they are extracted from `app.html` and driven
// against hostile fixtures here:
//
//   1. THE PSEUDONYM ROUND-TRIP (the POC's AC12, now bidirectional). Telepath shows real
//      names in the UI — the user already has them — and sends the model ONLY stable labels
//      (YOU, P1, P2 …), scrubbing JIDs and phone numbers from author seats AND bodies. The
//      map PERSISTS, so labels stay stable across incremental re-analyses; the reverse map
//      puts real names back at render time. Each direction failing is silent: a leaked
//      number reaches a model provider third parties never consented to; a wrong reverse
//      mapping attributes a psychological profile to the wrong human being.
//   2. THE REQUEST BUILDER. `snug:app-message` frames ride a 256 KB class, so the analysis
//      payload is byte-budgeted: full history reaches the DB and the charts, a bounded
//      recent window reaches the model, and the truncation is DISCLOSED, never silent.
//   3. THE AGGREGATORS. Every chart is computed locally from these rows; an aggregator that
//      double-counts or drops a bucket renders a confident, wrong picture of real people.
//
// THE EXTRACTION SEAM. The functions live inside the single-file `app.html` (the format is
// the product). The authored region between explicit markers is sliced out of the babel
// script and evaluated — a REAL evaluation of the shipped source, never a copy that could
// drift. The slice is asserted non-empty so a marker rename fails loudly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_HTML = path.join(HERE, 'whatsapp', 'app.html');

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
  assert.ok(source.trim().length > 200, 'the extracted analysis core is substantial, not an empty slice');

  const factory = new Function(
    `${source}\nreturn { extendPseudonymMap, pseudonymizeForLlm, redactIdentifiers, deanonymizeText, emojiFrequency, fallbackLabel, chatDisplayName, buildAnalysisRequest, mergeMessages, statsByParticipant, activityBuckets, responseStats, messagesByMonth };`,
  );
  return factory();
}

const {
  extendPseudonymMap,
  pseudonymizeForLlm,
  redactIdentifiers,
  deanonymizeText,
  emojiFrequency,
  fallbackLabel,
  chatDisplayName,
  buildAnalysisRequest,
  mergeMessages,
  statsByParticipant,
  activityBuckets,
  responseStats,
  messagesByMonth,
} = loadAnalysisModule();

const msg = (id, from, text, ts, extra = {}) => ({ id, from, text, ts, ...extra });

// ---------------------------------------------------------------- the pseudonym map

test('the map is STABLE and MONOTONIC: prior labels survive, new people extend past them', () => {
  const prior = extendPseudonymMap(undefined, [
    { jid: '111@s.whatsapp.net', name: 'Asha Rao' },
    { jid: '222@s.whatsapp.net', name: 'Bo Chen' },
  ]);
  assert.equal(prior.get('111@s.whatsapp.net'), 'P1');
  assert.equal(prior.get('222@s.whatsapp.net'), 'P2');

  // An incremental re-analysis re-extends with the SAME people plus one new arrival:
  // nobody's label moves, and the newcomer takes the next number — a shuffled label
  // would silently reassign a stored profile to a different human being.
  const extended = extendPseudonymMap(Array.from(prior.entries()), [
    { jid: '333@s.whatsapp.net', name: 'Zed' },
    { jid: '111@s.whatsapp.net', name: 'Asha Rao' },
  ]);
  assert.equal(extended.get('111@s.whatsapp.net'), 'P1');
  assert.equal(extended.get('222@s.whatsapp.net'), 'P2');
  assert.equal(extended.get('333@s.whatsapp.net'), 'P3');
});

test('a person maps by BOTH jid and display name — one label, two spellings', () => {
  const map = extendPseudonymMap(undefined, [{ jid: '111@s.whatsapp.net', name: 'Asha Rao' }]);
  assert.equal(map.get('111@s.whatsapp.net'), 'P1');
  assert.equal(map.get('Asha Rao'), 'P1');
});

test('the account owner is YOU, never a P-label', () => {
  const map = extendPseudonymMap(undefined, [
    { jid: 'me@s.whatsapp.net', name: 'Jeetu', isMe: true },
    { jid: '111@s.whatsapp.net', name: 'Asha Rao' },
  ]);
  assert.equal(map.get('me@s.whatsapp.net'), 'YOU');
  assert.equal(map.get('Jeetu'), 'YOU');
  assert.equal(map.get('111@s.whatsapp.net'), 'P1');
});

// ---------------------------------------------------------------- the scrub (LLM-bound)

test('a phone number in a message BODY never reaches the model, whatever its spelling', () => {
  const map = extendPseudonymMap(undefined, [{ jid: '111@s.whatsapp.net', name: 'Asha Rao' }]);
  const rows = pseudonymizeForLlm(
    [
      msg('m1', '111@s.whatsapp.net', 'call me on +91 98765 43210 tonight', 100),
      msg('m2', '111@s.whatsapp.net', 'or (555) 123-4567 after five', 200),
    ],
    map,
  );
  const wire = JSON.stringify(rows);
  assert.ok(!wire.includes('98765'), 'spaced international number scrubbed');
  assert.ok(!wire.includes('123-4567'), 'bracketed US number scrubbed');
  assert.ok(wire.includes('[number]'));
});

test('a JID appearing ONLY in a body is scrubbed by the pattern, not just the map', () => {
  // The dangerous case: a forwarded contact belonging to someone NOT in this thread —
  // no map entry exists for them, so only the primitive stands.
  const map = extendPseudonymMap(undefined, [{ jid: '111@s.whatsapp.net', name: 'Asha Rao' }]);
  const rows = pseudonymizeForLlm([msg('m1', '111@s.whatsapp.net', 'ping 999888777@s.whatsapp.net about it', 100)], map);
  assert.ok(!JSON.stringify(rows).includes('999888777'));
});

test('a participant NAME inside a body becomes their label — the map covers prose too', () => {
  const map = extendPseudonymMap(undefined, [
    { jid: '111@s.whatsapp.net', name: 'Asha Rao' },
    { jid: '222@s.whatsapp.net', name: 'Bo Chen' },
  ]);
  const rows = pseudonymizeForLlm([msg('m1', '222@s.whatsapp.net', 'Asha Rao said she is late', 100)], map);
  assert.ok(!JSON.stringify(rows).includes('Asha'));
  assert.ok(rows[0].text.includes('P1'));
});

test('the author seat carries the label, never the jid or name', () => {
  const map = extendPseudonymMap(undefined, [{ jid: '111@s.whatsapp.net', name: 'Asha Rao' }]);
  const rows = pseudonymizeForLlm(
    [msg('m1', '111@s.whatsapp.net', 'hi', 100), msg('m2', 'me@x', 'yo', 200, { fromMe: true })],
    map,
  );
  assert.equal(rows[0].author, 'P1');
  assert.equal(rows[1].author, 'YOU');
});

test('the scrub does not over-redact ordinary text — quantities and short numbers survive', () => {
  const out = redactIdentifiers('meet at 7, it costs 250, room 1204', new Map());
  assert.equal(out, 'meet at 7, it costs 250, room 1204');
});

// ---------------------------------------------------------------- the reverse map (render-time)

test('deanonymizeText puts real names back, whole-word, preferring display names', () => {
  const map = extendPseudonymMap(undefined, [
    { jid: '111@s.whatsapp.net', name: 'Asha Rao' },
    { jid: '222@s.whatsapp.net' }, // no display name known — the jid is the honest fallback
  ]);
  const out = deanonymizeText('P1 answers fast. P2 goes quiet when YOU joke.', map);
  assert.ok(out.includes('Asha Rao answers fast'));
  assert.ok(out.includes('222@s.whatsapp.net goes quiet'));
  assert.ok(out.includes('You joke'), 'YOU renders as You');
});

test('deanonymizeText never mangles a longer label with a shorter one — P12 is not P1+"2"', () => {
  const entries = [];
  for (let i = 0; i < 12; i += 1) entries.push({ jid: `${i}@s.whatsapp.net`, name: `Person ${i + 1}` });
  const map = extendPseudonymMap(undefined, entries);
  // Label assignment order is the map's own business; the property under test is that the
  // TWO-DIGIT label round-trips as itself, never as the one-digit label plus a stray "2".
  const nameOf = (label) =>
    Array.from(map.entries()).find(([identity, l]) => l === label && !identity.includes('@'))?.[0];
  const out = deanonymizeText('P12 spoke after P1.', map);
  assert.ok(out.includes(`${nameOf('P12')} spoke`), `got: ${out}`);
  assert.ok(out.includes(`after ${nameOf('P1')}.`), `got: ${out}`);
  assert.ok(!out.includes(`${nameOf('P1')}2 spoke`), 'P12 must never render as P1’s name + "2"');
});

test('deanonymizeText leaves unknown labels visible rather than guessing', () => {
  const map = extendPseudonymMap(undefined, [{ jid: '111@s.whatsapp.net', name: 'Asha Rao' }]);
  assert.equal(deanonymizeText('P7 was here', map), 'P7 was here');
});

// ---------------------------------------------------------------- emoji habits

test('emojiFrequency measures the USER’s emoji, most frequent first — nobody else’s', () => {
  const rows = [
    msg('m1', 'me', 'love it 😂😂🙏', 1, { fromMe: true }),
    msg('m2', 'me', 'again 😂', 2, { fromMe: true }),
    msg('m3', '111@s.whatsapp.net', 'their emoji 🎉🎉🎉🎉 must not count', 3),
  ];
  const freq = emojiFrequency(rows);
  assert.deepEqual(freq[0], { emoji: '😂', count: 3 });
  assert.deepEqual(freq[1], { emoji: '🙏', count: 1 });
  assert.ok(!freq.some((row) => row.emoji === '🎉'));
});

test('emojiFrequency returns empty for emoji-free senders, and never counts digits or ascii', () => {
  assert.deepEqual(emojiFrequency([msg('m1', 'me', 'plain text 123 :) x', 1, { fromMe: true })]), []);
});

// ---------------------------------------------------------------- the request builder

test('under budget: every row rides, truncation false, prior analysis included when given', () => {
  const map = extendPseudonymMap(undefined, [{ jid: '111@s.whatsapp.net', name: 'Asha Rao' }]);
  const rows = [msg('m1', '111@s.whatsapp.net', 'hello', 100), msg('m2', 'me', 'hi', 200, { fromMe: true })];
  const request = buildAnalysisRequest({ messages: rows, map, priorAnalysis: { kind: 'profile', people: [] }, byteBudget: 50_000 });
  assert.equal(request.transcript.length, 2);
  assert.equal(request.truncated, false);
  assert.deepEqual(request.prior, { kind: 'profile', people: [] });
});

test('over budget: the OLDEST rows fall away, the newest stay, and the truncation is disclosed', () => {
  const map = extendPseudonymMap(undefined, [{ jid: '111@s.whatsapp.net', name: 'Asha Rao' }]);
  const rows = [];
  for (let i = 0; i < 400; i += 1) {
    rows.push(msg(`m${i}`, '111@s.whatsapp.net', `message number ${i} with some padding text to carry bytes`, i));
  }
  const budget = 8_000;
  const request = buildAnalysisRequest({ messages: rows, map, byteBudget: budget });
  assert.equal(request.truncated, true);
  assert.ok(request.transcript.length > 0);
  assert.ok(request.transcript.length < 400);
  // Newest kept: the LAST source row survives; the first does not.
  const wire = JSON.stringify(request.transcript);
  assert.ok(wire.includes('message number 399'));
  assert.ok(!wire.includes('"message number 0 '));
  assert.ok(wire.length <= budget, `serialized transcript ${wire.length} <= ${budget}`);
});

test('the request builder ships ONLY pseudonymized rows — the budget path is not a scrub bypass', () => {
  const map = extendPseudonymMap(undefined, [{ jid: '111@s.whatsapp.net', name: 'Asha Rao' }]);
  const rows = [msg('m1', '111@s.whatsapp.net', 'reach me at +91 98765 43210', 100)];
  const request = buildAnalysisRequest({ messages: rows, map, byteBudget: 50_000 });
  const wire = JSON.stringify(request);
  assert.ok(!wire.includes('98765'));
  assert.ok(!wire.includes('Asha'));
  assert.ok(!wire.includes('111@s.whatsapp.net'));
});

// ---------------------------------------------------------------- the merge reducer

test('mergeMessages dedupes by id and keeps time order — hint refetches overlap by design', () => {
  const existing = [msg('m1', 'a', 'one', 100), msg('m2', 'b', 'two', 200)];
  const incoming = [msg('m2', 'b', 'two', 200), msg('m3', 'a', 'three', 150)];
  const merged = mergeMessages(existing, incoming);
  assert.deepEqual(merged.map((row) => row.id), ['m1', 'm3', 'm2']);
});

// ---------------------------------------------------------------- the aggregators

test('statsByParticipant counts and shares per author', () => {
  const rows = [
    msg('m1', 'a', 'x', 1),
    msg('m2', 'a', 'y', 2),
    msg('m3', 'b', 'z', 3),
    msg('m4', 'me', 'w', 4, { fromMe: true }),
  ];
  const stats = statsByParticipant(rows);
  const a = stats.find((row) => row.author === 'a');
  assert.equal(a.count, 2);
  assert.ok(Math.abs(a.share - 0.5) < 1e-9);
  assert.equal(stats.find((row) => row.author === 'me').count, 1);
});

test('activityBuckets respects the timezone offset — 23:30 UTC is next-day 00:30 at +60', () => {
  // 2026-08-17 (a Monday) 23:30 UTC.
  const monday2330utc = Date.UTC(2026, 7, 17, 23, 30, 0) / 1000;
  const utc = activityBuckets([msg('m1', 'a', 'x', monday2330utc)], 0);
  assert.equal(utc.hours[23], 1);
  assert.equal(utc.weekdays[0], 1, 'Monday-first indexing: Monday is bucket 0');

  const shifted = activityBuckets([msg('m1', 'a', 'x', monday2330utc)], 60);
  assert.equal(shifted.hours[0], 1);
  assert.equal(shifted.weekdays[1], 1, 'crossed midnight into Tuesday');
});

test('activityBuckets tracks per-author hour profiles', () => {
  const nineAm = Date.UTC(2026, 7, 17, 9, 0, 0) / 1000;
  const buckets = activityBuckets(
    [msg('m1', 'a', 'x', nineAm), msg('m2', 'a', 'y', nineAm + 60), msg('m3', 'b', 'z', nineAm)],
    0,
  );
  assert.equal(buckets.perAuthor.get('a').hours[9], 2);
  assert.equal(buckets.perAuthor.get('b').hours[9], 1);
});

test('responseStats measures the median gap behind a SPEAKER CHANGE, ignoring monologues and stale gaps', () => {
  const rows = [
    msg('m1', 'a', 'q1', 1_000),
    msg('m2', 'b', 'a1', 1_000 + 300), // b answers a in 5 min
    msg('m3', 'b', 'a1b', 1_000 + 400), // monologue continuation — NOT a response
    msg('m4', 'a', 'q2', 1_000 + 400 + 900), // a answers b in 15 min
    msg('m5', 'b', 'late', 1_000 + 400 + 900 + 90_000), // >24h after m4 — ignored
    msg('m6', 'a', 'q3', 1_000 + 400 + 900 + 90_000 + 90_000), // >24h after m5 — ignored too
    msg('m7', 'b', 'a3', 1_000 + 400 + 900 + 90_000 + 90_000 + 540), // b answers in 9 min
  ];
  const stats = responseStats(rows);
  const b = stats.find((row) => row.author === 'b');
  // b's response gaps: 5 min and 9 min → median 7 min.
  assert.equal(b.medianMinutes, 7);
  const a = stats.find((row) => row.author === 'a');
  assert.equal(a.medianMinutes, 15);
});

test('messagesByMonth buckets a trend the chart can draw', () => {
  const jan = Date.UTC(2026, 0, 10) / 1000;
  const feb = Date.UTC(2026, 1, 10) / 1000;
  const buckets = messagesByMonth([msg('m1', 'a', 'x', jan), msg('m2', 'a', 'y', jan + 60), msg('m3', 'b', 'z', feb)]);
  assert.deepEqual(buckets, [
    { month: '2026-01', count: 2 },
    { month: '2026-02', count: 1 },
  ]);
});

// ---------------------------------------------------------------- the live doorbell
//
// THE BRIDGE-ALTITUDE SEAM TEST (plan review F9; eight-seams defect #3's shape). The host
// pump forwards hints via `RunnerHost.notifyEvent('connection-event', …)`, which posts
// `{v: 1, type: 'snug:host-event', event, data}` into the frame. The app's listener is
// extracted VERBATIM from app.html and driven with frames built from the PROTOCOL'S OWN
// constants — so if either side respells the frame, this test reds instead of the doorbell
// going silently deaf on hardware.
import { FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';

function loadDoorbell() {
  const html = readFileSync(APP_HTML, 'utf8');
  const script = /<script type="text\/babel">\n([\s\S]*?)\n\s*<\/script>/.exec(html)?.[1] ?? '';
  const BEGIN = '// ===== LIVE-DOORBELL-BEGIN =====';
  const END = '// ===== LIVE-DOORBELL-END =====';
  const start = script.indexOf(BEGIN);
  const end = script.indexOf(END);
  assert.ok(start >= 0 && end > start, 'app.html carries the LIVE-DOORBELL markers');
  const source = script.slice(start + BEGIN.length, end);
  assert.ok(source.trim().length > 100, 'the extracted doorbell is substantial');

  let handler;
  const windowStub = {
    addEventListener: (type, fn) => {
      assert.equal(type, 'message');
      handler = fn;
    },
  };
  const factory = new Function('window', `${source}\nreturn { liveListeners };`);
  const { liveListeners } = factory(windowStub);
  assert.ok(typeof handler === 'function', 'the doorbell registered a message listener');
  return { handler, liveListeners };
}

/** The frame exactly as packages/runner's notifyEvent constructs it. */
const hostEventFrame = (event, data) => ({
  data: { v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event, ...(data !== undefined ? { data } : {}) },
});

test('doorbell: a pump hint batch reaches subscribers as jids + resync, nothing else', () => {
  const { handler, liveListeners } = loadDoorbell();
  const received = [];
  liveListeners.add((payload) => received.push(payload));
  handler(hostEventFrame('connection-event', {
    slot: 'whatsapp',
    hints: [
      { seq: 1, jid: 'a@g.us', kind: 'message', ts: 10 },
      { seq: 2, jid: 'b@s.whatsapp.net', kind: 'chat-update', ts: 11 },
    ],
  }));
  assert.equal(received.length, 1);
  assert.deepEqual(Array.from(received[0].jids).sort(), ['a@g.us', 'b@s.whatsapp.net']);
  assert.equal(received[0].resync, false);
  assert.deepEqual(Object.keys(received[0]).sort(), ['jids', 'resync'], 'a hint is an invalidation, never a delivery');
});

test('doorbell: resync arrives as its own signal', () => {
  const { handler, liveListeners } = loadDoorbell();
  const received = [];
  liveListeners.add((payload) => received.push(payload));
  handler(hostEventFrame('connection-event', { slot: 'whatsapp', resync: true }));
  assert.equal(received.length, 1);
  assert.equal(received[0].resync, true);
});

test('doorbell: everything off-shape is ignored — wrong slot, wrong event, wrong version, junk hints', () => {
  const { handler, liveListeners } = loadDoorbell();
  const received = [];
  liveListeners.add((payload) => received.push(payload));
  handler(hostEventFrame('connection-event', { slot: 'spotify', hints: [{ jid: 'a@g.us' }] }));
  handler(hostEventFrame('theme-change', { theme: 'dark' }));
  handler({ data: { v: 99, type: FRAME_TYPES.hostEvent, event: 'connection-event', data: { slot: 'whatsapp' } } });
  handler({ data: null });
  assert.equal(received.length, 0);
  // Junk hint rows contribute no jids but never throw.
  handler(hostEventFrame('connection-event', { slot: 'whatsapp', hints: [null, 7, { jid: 42 }, { jid: 'ok@g.us' }] }));
  assert.equal(received.length, 1);
  assert.deepEqual(Array.from(received[0].jids), ['ok@g.us']);
});

// ---------------------------------------------------------------- unknown-identity labels
//
// OWNER-REPORTED (2026-08-17): unknown contacts rendered as "+77771" — digits taken from a
// LID, which is an INTERNAL WhatsApp address belonging to nobody. A confident wrong number
// is worse than an honest blank, because the user has no way to know it is fiction.

test('fallbackLabel renders a real phone jid as a number', () => {
  assert.equal(fallbackLabel('919876543210@s.whatsapp.net'), '+919876543210');
  assert.equal(fallbackLabel('919876543210@c.us'), '+919876543210');
});

test('fallbackLabel NEVER renders a LID as a phone number', () => {
  assert.equal(fallbackLabel('77771@lid'), 'Unknown contact');
  assert.equal(fallbackLabel('123456789@lid'), 'Unknown contact');
});

test('fallbackLabel handles groups, empties and unrecognised address spaces honestly', () => {
  assert.equal(fallbackLabel('123-456@g.us'), 'Group');
  assert.equal(fallbackLabel(''), 'Unknown');
  assert.equal(fallbackLabel(undefined), 'Unknown');
  assert.equal(fallbackLabel('someone@broadcast'), 'Unknown contact');
});

test('fallbackLabel does not put a + on a non-numeric local part', () => {
  // A short or non-numeric local part is not a dialable number either.
  assert.equal(fallbackLabel('status@s.whatsapp.net'), 'status');
  assert.equal(fallbackLabel('123@s.whatsapp.net'), '123');
});

// ------------------------------------------------------------- chat display names
//
// OWNER-REPORTED 2026-08-18: 1:1 chat rows printed the raw jid
// ("…@s.whatsapp.net") because the sidecar's honest placeholder — a chat named by its own
// jid — was rendered VERBATIM: `fallbackLabel` existed but was only applied to message
// senders. `chatDisplayName` is the one place a chat row's label comes from now, and its
// contract is the owner's chosen WhatsApp-Web order: saved name → ~push name → formatted
// number — and NEVER a raw jid.

test('chatDisplayName renders a real name verbatim', () => {
  assert.equal(chatDisplayName({ jid: '111@s.whatsapp.net', name: 'Asha Rao' }), 'Asha Rao');
});

test('chatDisplayName marks a push-sourced name with the ~ convention', () => {
  assert.equal(chatDisplayName({ jid: '222@s.whatsapp.net', name: 'Bo', nameKind: 'push' }), '~Bo');
});

test('chatDisplayName never renders a raw jid — a placeholder falls back to the number', () => {
  assert.equal(
    chatDisplayName({ jid: '919876543210@s.whatsapp.net', name: '919876543210@s.whatsapp.net' }),
    '+919876543210',
  );
});

test('chatDisplayName never renders a LID placeholder as a number', () => {
  assert.equal(chatDisplayName({ jid: '77771@lid', name: '77771@lid' }), 'Unknown contact');
});

test('chatDisplayName treats an empty or missing name as a placeholder too', () => {
  assert.equal(chatDisplayName({ jid: '919876543210@s.whatsapp.net', name: '' }), '+919876543210');
  assert.equal(chatDisplayName({ jid: '123-456@g.us' }), 'Group');
});
