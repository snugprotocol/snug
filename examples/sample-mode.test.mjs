// sample-mode — TASK-20260819-starter-sample-data.
//
// The four connected starters (Rewind, Trade Copilot, Moodboard, Telepath) must open
// onto a populated, clearly-labelled SAMPLE experience before any connection exists —
// the Ledger pattern (ADR-0038) — without touching connected behaviour. This suite
// locks the structural contract; per-app behaviour lives in the analysis suites.
//
// The contract, per app:
//   1. One `===== <FOLDER>-SAMPLE-BEGIN/END =====` block in app.html holding the
//      sample dataset and any pure helpers over it.
//   2. The block is deterministic and inert: no Math.random / Date.now / argless
//      new Date (renders must not drift between loads), and no SnugBridge / net /
//      db calls (sample mode is render-only — it can never write rows, place
//      requests, or leak into the LLM lane; lesson 2026-08-18 decorate-at-render).
//   3. A visible banner (`.sample-note` with data-sample-banner, wording that says
//      "sample") so the dataset never pretends to be the user's.
//   4. The full Ledger authoring set — vision, requirements, plan, lessons,
//      next-tasks — real prose (ADR-0031 AC9 floor), since these seed the installed
//      app's wiki (ADR-0035).
//   5. README tells prospective users sample mode exists.
//   6. Telepath only: no real WhatsApp JID domains inside the sample block — sample
//      identities must be impossible to confuse with (or feed to) the real scrub
//      and label-map machinery.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const SAMPLE_APPS = ['spotify', 'trade-copilot', 'hue', 'whatsapp'];

// Ledger predates the marker convention (its sample seam is locked by
// ledger-analysis.test.mjs), but its authoring set is the docs floor for everyone.
const DOCS_APPS = [...SAMPLE_APPS, 'ledger'];
const REQUIRED_DOCS = ['vision.md', 'requirements.md', 'plan.md', 'lessons.md', 'next-tasks.md'];

const appHtml = (folder) => readFileSync(join(here, folder, 'app.html'), 'utf8');

function sampleBlock(folder) {
  const html = appHtml(folder);
  const upper = folder.toUpperCase();
  const begin = `===== ${upper}-SAMPLE-BEGIN =====`;
  const end = `===== ${upper}-SAMPLE-END =====`;
  const beginAt = html.indexOf(begin);
  const endAt = html.indexOf(end);
  assert.notEqual(beginAt, -1, `${folder}/app.html: missing "${begin}" marker`);
  assert.notEqual(endAt, -1, `${folder}/app.html: missing "${end}" marker`);
  assert.ok(beginAt < endAt, `${folder}/app.html: sample markers out of order`);
  assert.equal(html.indexOf(begin, beginAt + 1), -1, `${folder}/app.html: duplicate BEGIN marker`);
  assert.equal(html.indexOf(end, endAt + 1), -1, `${folder}/app.html: duplicate END marker`);
  return html.slice(beginAt + begin.length, endAt);
}

for (const folder of SAMPLE_APPS) {
  test(`${folder}: carries a marked sample block`, () => {
    const block = sampleBlock(folder);
    assert.ok(
      block.length >= 1000,
      `${folder}: sample block is ${block.length} chars — too small to be a meaningful dataset`,
    );
  });

  test(`${folder}: sample block is deterministic and render-only`, () => {
    const block = sampleBlock(folder);
    const forbidden = [
      [/Math\.random\s*\(/, 'Math.random() — sample data must be deterministic'],
      [/Date\.now\s*\(/, 'Date.now() — sample data must not drift between loads'],
      [/new Date\s*\(\s*\)/, 'argless new Date() — sample data must not drift between loads'],
      [/SnugBridge/, 'SnugBridge — sample mode is render-only, it must not reach the bridge'],
      [/net\.fetch|netPending/, 'network calls — sample mode must never place requests'],
      [/db\.exec|dbPending/, 'db calls — sample mode must never write rows'],
    ];
    for (const [pattern, why] of forbidden) {
      assert.ok(!pattern.test(block), `${folder}: sample block contains ${why}`);
    }
  });

  test(`${folder}: shows a labelled sample banner`, () => {
    const html = appHtml(folder);
    assert.match(html, /sample-note/, `${folder}: no .sample-note banner styling/markup`);
    assert.match(html, /data-sample-banner/, `${folder}: banner not tagged data-sample-banner`);
    assert.match(html, /sample/i, `${folder}: banner copy never says "sample"`);
  });

  test(`${folder}: README mentions sample mode`, () => {
    const readme = readFileSync(join(here, folder, 'README.md'), 'utf8');
    assert.match(readme, /sample/i, `${folder}/README.md: no mention of sample mode`);
  });
}

test('whatsapp: sample identities can never collide with real WhatsApp identifiers', () => {
  const block = sampleBlock('whatsapp');
  assert.ok(
    !/@s\.whatsapp\.net|@g\.us|@lid\b/.test(block),
    'whatsapp: sample block contains real WhatsApp JID domains — sample identities must be unmistakably fake',
  );
});

for (const folder of DOCS_APPS) {
  test(`${folder}: full authoring docs set (installed-app wiki seed, ADR-0035)`, () => {
    for (const doc of REQUIRED_DOCS) {
      const path = join(here, folder, 'authoring', 'docs', doc);
      assert.ok(existsSync(path), `${folder}: missing authoring/docs/${doc}`);
      const body = readFileSync(path, 'utf8').trim();
      assert.ok(
        body.length >= 40,
        `${folder}: authoring/docs/${doc} is ${body.length} chars — below the ADR-0031 AC9 floor`,
      );
    }
  });
}
