// Ledger's load-bearing pure core, tested directly (TASK-20260818-ledger-starter, ADR-0038).
//
// Run through the workspace, with the other example gates: pnpm --filter examples test
//
// WHY. `validate.test.mjs` checks every starter's SHAPE; it cannot check whether the
// subscription radar counts, the net-worth walk reconstructs, or the cancelled-watcher
// verifies. These fail silently and expensively — a radar that misses the overlap is a
// demo with no hero moment; a wrong reconstruction is a confident lie about someone's
// money. Same extraction seam as whatsapp-analysis: the authored region between
// explicit markers is sliced from the shipped app.html and EVALUATED, never copied.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_HTML = path.join(HERE, 'ledger', 'app.html');

function loadCore() {
  const html = readFileSync(APP_HTML, 'utf8');
  const script = /<script type="text\/babel">\n([\s\S]*?)\n\s*<\/script>/.exec(html)?.[1] ?? '';
  assert.ok(script.length > 0, 'the babel script was found');
  const BEGIN = '// ===== LEDGER-CORE-BEGIN =====';
  const END = '// ===== LEDGER-CORE-END =====';
  const start = script.indexOf(BEGIN);
  const end = script.indexOf(END);
  assert.ok(start >= 0, 'app.html carries the LEDGER-CORE-BEGIN marker');
  assert.ok(end > start, 'app.html carries the LEDGER-CORE-END marker after the begin marker');
  const source = script.slice(script.indexOf('\n', start), end);
  assert.ok(source.trim().length > 400, 'the extracted core is substantial, not an empty slice');
  const factory = new Function(
    `${source}\nreturn { categorize, mulberry32, buildSampleData, merchantKey, detectRecurring, median, monthKey, cashFlowByMonth, spendByCategory, netWorthSeries, projectForward, heatmapDays, cancelVerdicts, SAMPLE_SUBS };`,
  );
  return factory();
}

const core = loadCore();
const NOW = new Date(2026, 7, 18, 12, 0, 0); // fixed — the sample data is deterministic
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

const sampleRows = core.buildSampleData(NOW).map((t) => ({
  ...t,
  category: core.categorize(t.description, []),
}));

// ---------------------------------------------------------------------------
// The AC7 floor: the bundled sample feed gives the money-leaks view its hero moment.
// ---------------------------------------------------------------------------

test('the radar finds the PLANTED leaks in the sample feed — at least 3 flaggable (owner amendment)', () => {
  const leaks = core.detectRecurring(sampleRows, NOW_SEC);
  const flaggable = leaks.filter((l) => l.overlap || l.priceCreep || l.lapsed);
  assert.ok(
    flaggable.length >= 3,
    `expected >=3 flaggable subscriptions, found ${flaggable.length}: ${JSON.stringify(leaks.map((l) => l.merchant))}`,
  );
});

test('the streaming overlap is found by name group, and the price creep by amount history', () => {
  const leaks = core.detectRecurring(sampleRows, NOW_SEC);
  const overlapping = leaks.filter((l) => l.overlap === 'streaming video');
  assert.ok(overlapping.length >= 3, 'netflix + hulu + disney+ all carry the overlap flag');
  const creep = leaks.find((l) => l.merchant.includes('fitstream'));
  assert.ok(creep, 'fitstream is detected as recurring');
  assert.equal(creep.priceCreep, true, 'the 9.99 → 14.99 climb is flagged');
});

test('every planted subscription is detected as recurring at monthly cadence', () => {
  const leaks = core.detectRecurring(sampleRows, NOW_SEC);
  for (const sub of core.SAMPLE_SUBS) {
    const key = core.merchantKey(sub.desc);
    const hit = leaks.find((l) => l.merchant === key);
    assert.ok(hit, `expected ${key} in the radar`);
    assert.equal(hit.cadence, 'monthly');
  }
});

// ---------------------------------------------------------------------------
// The radar's refusals — what it must NOT call a subscription.
// ---------------------------------------------------------------------------

const day = 86400;
const txn = (id, posted, amount, description, pending = 0) => ({ id, posted, amount, description, pending, category: '' });

test('irregular spending at a merchant is NOT a subscription', () => {
  const rows = [
    txn('a', NOW_SEC - 90 * day, -40, 'CORNER GROCER'),
    txn('b', NOW_SEC - 71 * day, -35, 'CORNER GROCER'),
    txn('c', NOW_SEC - 60 * day, -90, 'CORNER GROCER'),
    txn('d', NOW_SEC - 10 * day, -12, 'CORNER GROCER'),
  ];
  assert.equal(core.detectRecurring(rows, NOW_SEC).length, 0);
});

test('two charges are never enough; three at a monthly gap are', () => {
  const two = [txn('a', NOW_SEC - 60 * day, -10, 'SVC X'), txn('b', NOW_SEC - 30 * day, -10, 'SVC X')];
  assert.equal(core.detectRecurring(two, NOW_SEC).length, 0);
  const three = [...two, txn('c', NOW_SEC - 1 * day, -10, 'SVC X')];
  const found = core.detectRecurring(three, NOW_SEC);
  assert.equal(found.length, 1);
  assert.equal(found[0].monthly, 10);
});

test('a yearly charge is detected and amortized to a monthly figure', () => {
  const rows = [
    txn('a', NOW_SEC - 740 * day, -120, 'DOMAIN RENEWAL CO'),
    txn('b', NOW_SEC - 372 * day, -120, 'DOMAIN RENEWAL CO'),
    txn('c', NOW_SEC - 6 * day, -120, 'DOMAIN RENEWAL CO'),
  ];
  const found = core.detectRecurring(rows, NOW_SEC);
  assert.equal(found.length, 1);
  assert.equal(found[0].cadence, 'yearly');
  assert.equal(found[0].monthly, 10);
});

test('a monthly subscription with no charge for 60 days is flagged lapsed', () => {
  const rows = [
    txn('a', NOW_SEC - 150 * day, -8, 'OLDMAG SUBSCRIPTION'),
    txn('b', NOW_SEC - 120 * day, -8, 'OLDMAG SUBSCRIPTION'),
    txn('c', NOW_SEC - 90 * day, -8, 'OLDMAG SUBSCRIPTION'),
    txn('d', NOW_SEC - 60 * day, -8, 'OLDMAG SUBSCRIPTION'),
  ];
  const found = core.detectRecurring(rows, NOW_SEC);
  assert.equal(found.length, 1);
  assert.equal(found[0].lapsed, true);
});

test('pending and income rows never feed the radar; store numbers collapse to one merchant', () => {
  const rows = [
    txn('a', NOW_SEC - 90 * day, -12, 'STREAMY #4451'),
    txn('b', NOW_SEC - 60 * day, -12, 'STREAMY #9022'),
    txn('c', NOW_SEC - 30 * day, -12, 'STREAMY #1188'),
    txn('p', NOW_SEC - 1 * day, -12, 'STREAMY #0001', 1),
    txn('i', NOW_SEC - 15 * day, 500, 'STREAMY REFUND'),
  ];
  const found = core.detectRecurring(rows, NOW_SEC);
  assert.equal(found.length, 1);
  assert.equal(found[0].count, 3, 'the pending row did not count');
  assert.equal(core.merchantKey('TARGET 0442'), core.merchantKey('TARGET 0871'));
});

// ---------------------------------------------------------------------------
// Cash flow, reconstruction, projection — the chart math.
// ---------------------------------------------------------------------------

test('cashFlowByMonth splits income and spend and EXCLUDES transfers and pending', () => {
  const may = Math.floor(new Date(2026, 4, 10).getTime() / 1000);
  const rows = [
    { id: 'a', posted: may, amount: 3000, description: 'PAYROLL', pending: 0, category: 'income' },
    { id: 'b', posted: may + day, amount: -1000, description: 'RENT', pending: 0, category: 'housing' },
    { id: 'c', posted: may + 2 * day, amount: -600, description: 'TRANSFER TO SAVINGS', pending: 0, category: 'transfers' },
    { id: 'd', posted: may + 3 * day, amount: -50, description: 'PENDING CARD', pending: 1, category: 'dining' },
  ];
  const flows = core.cashFlowByMonth(rows);
  assert.equal(flows.length, 1);
  assert.equal(flows[0].income, 3000);
  assert.equal(flows[0].spend, 1000);
  assert.equal(flows[0].net, 2000);
});

test('netWorthSeries walks today\'s total BACKWARD through the log', () => {
  const accounts = [{ balance: 1000 }];
  const today = Math.floor(NOW_SEC / day) * day + 3600; // an hour into today
  const rows = [
    { id: 'a', posted: today, amount: 200, description: 'PAY', pending: 0, category: 'income' },
    { id: 'b', posted: today - day, amount: -100, description: 'SHOP', pending: 0, category: 'shopping' },
  ];
  const series = core.netWorthSeries(accounts, rows, NOW_SEC, 4);
  assert.equal(series.length, 4);
  assert.equal(series[3].value, 1000, 'today ends at the live total');
  assert.equal(series[2].value, 800, 'yesterday = 1000 − today\'s +200 = 800');
  assert.equal(series[1].value, 900, 'two days ago = 800 − (−100) = 900');
});

test('projectForward extends the median of the last six CLOSED months, plus the scenario delta', () => {
  const flows = [
    { key: '2026-01', net: 100 }, { key: '2026-02', net: 900 }, { key: '2026-03', net: 500 },
    { key: '2026-04', net: 500 }, { key: '2026-05', net: 500 }, { key: '2026-06', net: 500 },
    { key: '2026-07', net: 500 }, { key: '2026-08', net: -9999 /* current month, must be ignored */ },
  ];
  const base = core.projectForward(10_000, flows, 3, 0);
  assert.equal(base.baseMonthly, 500);
  assert.deepEqual(base.points.map((p) => p.value), [10_500, 11_000, 11_500]);
  const scenario = core.projectForward(10_000, flows, 2, -200);
  assert.deepEqual(scenario.points.map((p) => p.value), [10_300, 10_600]);
});

// ---------------------------------------------------------------------------
// The verified-cancelled watcher — the feed itself is the proof.
// ---------------------------------------------------------------------------

test('a marked cancellation with a LATER charge reads still-charging, never verified', () => {
  const marked = NOW_SEC - 50 * day;
  const cancels = [{ merchant: 'streamy', marked_at: marked, monthly_cost: 12, verified: 0 }];
  const rows = [txn('x', marked + 20 * day, -12, 'STREAMY')];
  const [v] = core.cancelVerdicts(cancels, rows, NOW_SEC);
  assert.equal(v.stillCharging, true);
  assert.equal(v.verifiedNow, false);
});

test('41 quiet days after the mark IS verification; 30 is still watching', () => {
  const cancels = (agoDays) => [{ merchant: 'streamy', marked_at: NOW_SEC - agoDays * day, monthly_cost: 12, verified: 0 }];
  assert.equal(core.cancelVerdicts(cancels(41), [], NOW_SEC)[0].verifiedNow, true);
  assert.equal(core.cancelVerdicts(cancels(30), [], NOW_SEC)[0].verifiedNow, false);
});

// ---------------------------------------------------------------------------
// Determinism — the demo must be byte-stable across installs.
// ---------------------------------------------------------------------------

test('the sample generator is deterministic for a fixed date', () => {
  const a = core.buildSampleData(NOW);
  const b = core.buildSampleData(NOW);
  assert.deepEqual(a, b);
  assert.ok(a.length > 300, `a year of household data is substantial (got ${a.length} rows)`);
});

test('every sample row categorizes away from "other" often enough to feel curated', () => {
  const other = sampleRows.filter((t) => t.category === 'other');
  assert.ok(other.length / sampleRows.length < 0.05, `uncategorized fraction ${(other.length / sampleRows.length).toFixed(3)} stays under 5%`);
});
