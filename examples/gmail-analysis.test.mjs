// Inbox Copilot's load-bearing pure core, tested directly
// (TASK-20260819-gmail-starter, ADR-0039).
//
// Run through the workspace, with the other example gates: pnpm --filter examples test
//
// WHY. `validate.test.mjs` checks every starter's SHAPE; it cannot check whether the
// never-replied flag actually excludes the receipts, whether the unsubscribe ranker
// routes a mailto: differently from an https link, or whether a cleanup batch stays
// inside the trash-only ceiling. Those fail silently and expensively: this app asks a
// person to approve a bulk action on their real mail, so a wrong flag is a wrong
// deletion recommendation with a confirm button next to it. Same extraction seam as
// ledger-analysis / whatsapp-analysis: the authored region between explicit markers is
// sliced out of the shipped app.html and EVALUATED, never copied.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_HTML = path.join(HERE, 'gmail', 'app.html');

function loadCore() {
  const html = readFileSync(APP_HTML, 'utf8');
  const script = /<script type="text\/babel">\n([\s\S]*?)\n\s*<\/script>/.exec(html)?.[1] ?? '';
  assert.ok(script.length > 0, 'the babel script was found');
  const BEGIN = '// ===== GMAIL-CORE-BEGIN =====';
  const END = '// ===== GMAIL-CORE-END =====';
  const start = script.indexOf(BEGIN);
  const end = script.indexOf(END);
  assert.ok(start >= 0, 'app.html carries the GMAIL-CORE-BEGIN marker');
  assert.ok(end > start, 'app.html carries the GMAIL-CORE-END marker after the begin marker');
  const source = script.slice(script.indexOf('\n', start), end);
  assert.ok(source.trim().length > 400, 'the extracted core is substantial, not an empty slice');
  const factory = new Function(
    `${source}\nreturn { mulberry32, buildSampleInbox, senderKey, senderStats, neverRepliedFlags, unsubscribeCandidates, unsubscribeChannel, safeUnsubUrl, volumeByWeek, topSenders, categoryMix, planCleanupBatch, BATCH_MODIFY_LIMIT, SAMPLE_SENDERS };`,
  );
  return factory();
}

const core = loadCore();
// Fixed clock — the sample inbox is deterministic and the suite must not drift with the
// wall clock (sample-mode.test.mjs forbids a live clock inside the sample block too).
const NOW = new Date(2026, 7, 18, 12, 0, 0);
const NOW_MS = NOW.getTime();
const DAY = 86_400_000;

/** A message shaped like the app's normalized Gmail metadata row. */
function msg(overrides = {}) {
  return {
    id: `m-${Math.abs(Math.round(overrides.at ?? 0))}-${overrides.from ?? 'x'}`,
    from: 'news@example.com',
    fromName: 'Example',
    at: NOW_MS - DAY,
    labels: ['INBOX'],
    listUnsubscribe: null,
    subject: 'Hello',
    fromMe: false,
    ...overrides,
  };
}

/** N received messages from one sender, one per day walking back from `now`. */
function received(from, count, extra = {}) {
  return Array.from({ length: count }, (_, i) =>
    msg({ from, at: NOW_MS - (i + 1) * DAY, ...extra }),
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// AC6 — the never-replied flag
// ───────────────────────────────────────────────────────────────────────────────

test('AC6: flags a sender with 3+ received and no replies from the user', () => {
  const flags = core.neverRepliedFlags(received('blast@marketing.example', 6), { now: NOW_MS });
  const flagged = flags.map((f) => f.sender);
  assert.ok(
    flagged.includes('blast@marketing.example'),
    'six one-way messages is exactly the pattern this flag exists to surface',
  );
});

test('AC6: two received messages stay below the floor — a new correspondent is not a problem', () => {
  const flags = core.neverRepliedFlags(received('new@person.example', 2), { now: NOW_MS });
  assert.equal(flags.length, 0, 'the ≥3 floor keeps a brand-new sender out of the flag list');
});

test('AC6: a single reply from the user clears the flag permanently', () => {
  const thread = [
    ...received('colleague@work.example', 8),
    // The user answered once, months ago. That is a relationship, not a broadcast.
    msg({ from: 'me@example.com', fromMe: true, at: NOW_MS - 90 * DAY, to: 'colleague@work.example' }),
  ];
  const flags = core.neverRepliedFlags(thread, { now: NOW_MS });
  assert.ok(
    !flags.some((f) => f.sender === 'colleague@work.example'),
    'a sender the user has ever replied to must never be flagged as ignorable',
  );
});

test('AC6 NEGATIVE: transactional senders are excluded — receipts are one-way BY NATURE', () => {
  // The load-bearing exclusion. Nobody replies to a receipt, an invoice, or an order
  // confirmation, so a naive never-replied rule flags exactly the mail a person most
  // needs to keep — their bank, their airline, their pharmacy. Being unanswered is not
  // evidence of being unwanted when the sender never asked for an answer.
  const receipts = [
    ...received('receipts@bank.example', 5, { subject: 'Your receipt for August' }),
    ...received('noreply@airline.example', 4, { subject: 'Order confirmation #55812' }),
    ...received('billing@utility.example', 4, { subject: 'Invoice available' }),
  ];
  const flags = core.neverRepliedFlags(receipts, { now: NOW_MS });
  assert.equal(
    flags.length,
    0,
    `transactional senders must be excluded; got: ${flags.map((f) => f.sender).join(', ')}`,
  );
});

test('AC6 NEGATIVE: a starred or important sender is excluded even with zero replies', () => {
  // The user's own signal outranks the heuristic. Someone who stars a newsletter is
  // telling us it matters more clearly than our inference says it does not.
  const starred = received('digest@favourite.example', 7, { labels: ['INBOX', 'STARRED'] });
  const flags = core.neverRepliedFlags(starred, { now: NOW_MS });
  assert.equal(flags.length, 0, 'a starred sender is user-endorsed — never flag it');
});

test('AC6: each flag carries the evidence a person needs to judge it', () => {
  const flags = core.neverRepliedFlags(received('blast@marketing.example', 9), { now: NOW_MS });
  const flag = flags.find((f) => f.sender === 'blast@marketing.example');
  assert.ok(flag, 'the flag exists');
  assert.equal(flag.received, 9, 'the count is reported, not just the verdict');
  assert.equal(flag.replied, 0);
  assert.ok(flag.lastAt > 0, 'the flag says when this sender last wrote');
});

// ───────────────────────────────────────────────────────────────────────────────
// AC7 — unsubscribe candidates and their channels
// ───────────────────────────────────────────────────────────────────────────────

test('AC7: a frequent never-replied sender WITH List-Unsubscribe outranks a quiet one', () => {
  const messages = [
    ...received('loud@shop.example', 20, { listUnsubscribe: '<mailto:stop@shop.example>' }),
    ...received('quiet@shop.example', 3, { listUnsubscribe: '<mailto:stop@quiet.example>' }),
  ];
  const ranked = core.unsubscribeCandidates(messages, { now: NOW_MS });
  assert.ok(ranked.length >= 2, 'both senders are candidates');
  assert.equal(ranked[0].sender, 'loud@shop.example', 'twenty beats three — volume ranks first');
});

test('AC7: a sender with no List-Unsubscribe header is not offered a one-click unsubscribe', () => {
  const ranked = core.unsubscribeCandidates(received('nolist@shop.example', 12), { now: NOW_MS });
  const entry = ranked.find((c) => c.sender === 'nolist@shop.example');
  if (entry) {
    assert.equal(
      entry.channel,
      'none',
      'without the header there is nothing to click — the app must not invent an endpoint',
    );
  }
});

test('AC7: mailto: List-Unsubscribe routes to the send channel', () => {
  const channel = core.unsubscribeChannel('<mailto:unsub@shop.example?subject=unsubscribe>');
  assert.equal(channel.kind, 'mailto');
  assert.equal(channel.to, 'unsub@shop.example');
  assert.equal(channel.subject, 'unsubscribe', 'the subject the sender asked for is preserved');
});

test('AC7: https List-Unsubscribe routes to the open-url channel, never to fetch', () => {
  // The channel split is a sandbox fact, not a preference: an arbitrary unsubscribe host
  // is outside the frozen gmail.googleapis.com ceiling, so the app can never call it.
  // Handing the link to the system browser is the honest move.
  const channel = core.unsubscribeChannel('<https://shop.example/unsub?u=abc>');
  assert.equal(channel.kind, 'open-url');
  assert.equal(channel.url, 'https://shop.example/unsub?u=abc');
});

test('AC7: when a header offers BOTH, the mailto is preferred — it needs no browser trip', () => {
  const channel = core.unsubscribeChannel(
    '<mailto:unsub@shop.example>, <https://shop.example/unsub?u=abc>',
  );
  assert.equal(channel.kind, 'mailto');
});

test('AC7 NEGATIVE: the URL gate rejects non-https, userinfo, and javascript: links', () => {
  // Ledger's safeCancelUrl precedent. The open-url bridge hands a URL to the real
  // browser, so a hostile List-Unsubscribe header is an injection surface: userinfo
  // (https://gmail.com@evil.example) is the classic phishing disguise.
  assert.equal(core.safeUnsubUrl('http://shop.example/unsub'), null, 'plain http refused');
  assert.equal(core.safeUnsubUrl('javascript:alert(1)'), null, 'javascript: refused');
  assert.equal(core.safeUnsubUrl('https://gmail.com@evil.example/x'), null, 'userinfo refused');
  assert.equal(core.safeUnsubUrl('data:text/html,x'), null, 'data: refused');
  assert.equal(
    core.safeUnsubUrl('https://shop.example/unsub?u=abc'),
    'https://shop.example/unsub?u=abc',
    'a plain https link passes through unchanged',
  );
});

// ───────────────────────────────────────────────────────────────────────────────
// AC9 — the chart reducers
// ───────────────────────────────────────────────────────────────────────────────

test('AC9: volumeByWeek buckets messages into contiguous weeks, oldest first', () => {
  const messages = [
    ...received('a@example.com', 3), // this week
    msg({ from: 'b@example.com', at: NOW_MS - 10 * DAY }),
    msg({ from: 'b@example.com', at: NOW_MS - 12 * DAY }),
  ];
  const weeks = core.volumeByWeek(messages, { now: NOW_MS, weeks: 4 });
  assert.equal(weeks.length, 4, 'the window is honoured exactly');
  assert.ok(
    weeks.every((w, i) => i === 0 || w.start > weeks[i - 1].start),
    'weeks ascend — a chart drawn from a shuffled series lies about the trend',
  );
  assert.equal(
    weeks.reduce((sum, w) => sum + w.count, 0),
    5,
    'every message inside the window lands in exactly one bucket',
  );
});

test('AC9: volumeByWeek drops messages older than the window rather than piling them into week 0', () => {
  const messages = [...received('a@example.com', 2), msg({ from: 'old@example.com', at: NOW_MS - 400 * DAY })];
  const weeks = core.volumeByWeek(messages, { now: NOW_MS, weeks: 4 });
  assert.equal(
    weeks.reduce((sum, w) => sum + w.count, 0),
    2,
    'a year-old message must not inflate the oldest bucket',
  );
});

test('AC9: topSenders ranks by volume and respects its limit', () => {
  const messages = [
    ...received('a@example.com', 9),
    ...received('b@example.com', 4),
    ...received('c@example.com', 7),
  ];
  const top = core.topSenders(messages, { limit: 2 });
  assert.deepEqual(
    top.map((s) => s.sender),
    ['a@example.com', 'c@example.com'],
    'ordered by count, truncated to the limit',
  );
  assert.equal(top[0].count, 9);
});

test('AC9: categoryMix totals every message exactly once', () => {
  const messages = [
    ...received('news@shop.example', 4, { listUnsubscribe: '<mailto:x@shop.example>' }),
    ...received('receipts@bank.example', 3, { subject: 'Your receipt' }),
    ...received('friend@person.example', 2),
  ];
  const mix = core.categoryMix(messages);
  const total = mix.reduce((sum, slice) => sum + slice.count, 0);
  assert.equal(total, messages.length, 'the donut must account for the whole inbox, not a subset');
  assert.ok(
    mix.every((slice) => slice.count > 0),
    'empty slices are omitted rather than drawn as zero-width wedges',
  );
});

test('AC9: the reducers never mutate their input', () => {
  const messages = received('a@example.com', 5);
  const snapshot = JSON.stringify(messages);
  core.volumeByWeek(messages, { now: NOW_MS, weeks: 4 });
  core.topSenders(messages, { limit: 3 });
  core.categoryMix(messages);
  core.neverRepliedFlags(messages, { now: NOW_MS });
  assert.equal(JSON.stringify(messages), snapshot, 'reducers are pure — the lanes share one array');
});

// ───────────────────────────────────────────────────────────────────────────────
// AC8 — the cleanup batch planner
// ───────────────────────────────────────────────────────────────────────────────

test('AC8: a plan states exactly what it will touch, in counts and senders', () => {
  const messages = received('blast@marketing.example', 30);
  const plan = core.planCleanupBatch({
    action: 'trash',
    messages,
    senders: ['blast@marketing.example'],
  });
  assert.equal(plan.action, 'trash');
  assert.equal(plan.messageIds.length, 30, 'the plan carries the real ids it will act on');
  assert.deepEqual(plan.senders, ['blast@marketing.example']);
  assert.match(plan.summary, /30/, 'the confirm copy names the count a person is approving');
});

test('AC8: trash is expressed as a TRASH label move, never as a delete', () => {
  // The structural claim of ADR-0039 D3, asserted at the planner: the pinned scopes
  // cannot permanently delete, so the plan must ride batchModify's label mechanics.
  const plan = core.planCleanupBatch({
    action: 'trash',
    messages: received('blast@marketing.example', 4),
    senders: ['blast@marketing.example'],
  });
  assert.deepEqual(plan.body.addLabelIds, ['TRASH']);
  assert.equal(plan.method, 'POST');
  assert.match(plan.path, /batchModify/, 'bulk trash rides batchModify — there is no batchTrash');
  assert.ok(!/delete/i.test(JSON.stringify(plan)), 'no plan may mention deletion');
});

test('AC8: a batch larger than the API limit is split into conformant chunks', () => {
  // Gmail refuses more than 1000 ids per batchModify call. A 2,500-message cleanup is
  // exactly the hero moment this app promises, so the split has to be real.
  const messages = received('blast@marketing.example', 2500);
  const plans = core.planCleanupBatch({
    action: 'trash',
    messages,
    senders: ['blast@marketing.example'],
  }).chunks;
  assert.equal(plans.length, 3, '2500 ids split across three calls');
  assert.ok(
    plans.every((chunk) => chunk.length <= core.BATCH_MODIFY_LIMIT),
    'no chunk exceeds the documented ceiling',
  );
  assert.equal(plans.flat().length, 2500, 'every id survives the split exactly once');
});

test('AC8: blocking a sender is planned as a Gmail FILTER, not a per-message op', () => {
  const plan = core.planCleanupBatch({
    action: 'block',
    messages: [],
    senders: ['blast@marketing.example'],
  });
  assert.match(plan.path, /settings\/filters/, 'blocking is a settings resource');
  assert.equal(plan.body.criteria.from, 'blast@marketing.example');
  assert.deepEqual(
    plan.body.action.addLabelIds,
    ['TRASH'],
    'future mail is auto-trashed — still never deleted',
  );
});

test('AC8: the spam plan says "move to spam" — it does not claim to train the classifier', () => {
  // Honesty in the confirm copy: adding the SPAM label moves the mail, but it is not the
  // same signal Gmail's own "Report spam" button sends. Overclaiming here would teach a
  // user to expect protection the app cannot deliver.
  const plan = core.planCleanupBatch({
    action: 'spam',
    messages: received('phish@bad.example', 3),
    senders: ['phish@bad.example'],
  });
  assert.deepEqual(plan.body.addLabelIds, ['SPAM']);
  assert.match(plan.summary, /move/i);
  assert.ok(!/report|train/i.test(plan.summary), 'the copy must not overclaim');
});

test('AC8 NEGATIVE: an empty selection produces no plan — a confirm dialog with nothing behind it is a trap', () => {
  const plan = core.planCleanupBatch({ action: 'trash', messages: [], senders: [] });
  assert.equal(plan, null, 'nothing selected means nothing to approve');
});

// ───────────────────────────────────────────────────────────────────────────────
// AC5 — the sample inbox that sells the app before anyone connects
// ───────────────────────────────────────────────────────────────────────────────

test('AC5: the sample inbox is deterministic — same seed, byte-identical result', () => {
  const a = core.buildSampleInbox(NOW_MS);
  const b = core.buildSampleInbox(NOW_MS);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'a seeded PRNG, never Math.random');
});

test('AC5: the sample inbox is substantial enough for every lane to have something to show', () => {
  const inbox = core.buildSampleInbox(NOW_MS);
  assert.ok(inbox.length > 300, `sample inbox is ${inbox.length} messages — too thin to look real`);
  const weeks = core.volumeByWeek(inbox, { now: NOW_MS, weeks: 12 });
  assert.ok(weeks.every((w) => w.count > 0), 'every week in the trend chart has data');
  assert.ok(core.neverRepliedFlags(inbox, { now: NOW_MS }).length >= 3, 'the attention lane is populated');
  assert.ok(core.unsubscribeCandidates(inbox, { now: NOW_MS }).length >= 3, 'the unsubscribe lane is populated');
});

test('AC5: sample senders are unmistakably fake — no real-looking brand can be mistaken for the user\'s own mail', () => {
  const inbox = core.buildSampleInbox(NOW_MS);
  for (const message of inbox) {
    assert.match(
      message.from,
      /\.example$|@example\.(com|org)$/,
      `sample sender ${message.from} must sit in a reserved example domain (RFC 2606)`,
    );
  }
});

test('AC5: the sample inbox demonstrates BOTH unsubscribe channels', () => {
  // The demo has to show the mailto path and the browser path, because the split is one
  // of the things a prospective installer is being asked to trust.
  const inbox = core.buildSampleInbox(NOW_MS);
  const channels = new Set(
    core
      .unsubscribeCandidates(inbox, { now: NOW_MS })
      .map((candidate) => candidate.channel),
  );
  assert.ok(channels.has('mailto'), 'sample data includes a mailto: unsubscribe');
  assert.ok(channels.has('open-url'), 'sample data includes an https unsubscribe');
});
