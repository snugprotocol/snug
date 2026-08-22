// AC5 — the website docs-sync checker: a hash manifest maps every derived website
// page to its source documents; when a source changes, the gate goes red NAMING the
// affected pages. Mutation-tested here with disposable fixtures (never the real
// manifest — lessons 2026-08-21: mutate only state you can restore by construction).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-website-sync.mjs');

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Build a fixture repo: one source doc, one derived page, a matching manifest. */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'website-sync-'));
  const sourceRel = 'docs/spec-drafts/SPEC-TEST.md';
  const pageRel = 'apps/website/src/content/docs/docs/spec/part.md';
  mkdirSync(join(root, dirname(sourceRel)), { recursive: true });
  mkdirSync(join(root, dirname(pageRel)), { recursive: true });
  const sourceText = '# Part I\nnormative text\n';
  writeFileSync(join(root, sourceRel), sourceText);
  writeFileSync(join(root, pageRel), '---\ntitle: Part I\n---\nrendered\n');
  const manifest = {
    entries: [
      { page: pageRel, kind: 'generated', sources: [{ path: sourceRel, sha256: sha256(sourceText) }] },
    ],
  };
  const manifestPath = join(root, 'docs-sync.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { root, manifestPath, sourceRel, pageRel, manifest };
}

function run(root, manifestPath) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, '--root', root, '--manifest', manifestPath], {
      encoding: 'utf8',
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

test('green when every source hash matches', () => {
  const { root, manifestPath } = makeFixture();
  const result = run(root, manifestPath);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /verified/);
  rmSync(root, { recursive: true, force: true });
});

test('a drifted source goes red and NAMES the derived page', () => {
  const { root, manifestPath, sourceRel, pageRel } = makeFixture();
  writeFileSync(join(root, sourceRel), '# Part I\nnormative text CHANGED\n');
  const result = run(root, manifestPath);
  assert.equal(result.code, 1);
  assert.ok(result.output.includes(pageRel), `output must name the page:\n${result.output}`);
  assert.ok(result.output.includes(sourceRel), `output must name the source:\n${result.output}`);
  assert.match(result.output, /sync-website|sync-docs/, 'output must name the remedy');
  rmSync(root, { recursive: true, force: true });
});

test('a missing source fails loudly, never silently passes', () => {
  const { root, manifestPath, sourceRel } = makeFixture();
  rmSync(join(root, sourceRel));
  const result = run(root, manifestPath);
  assert.equal(result.code, 1);
  assert.ok(result.output.includes(sourceRel));
  assert.match(result.output, /missing/i);
  rmSync(root, { recursive: true, force: true });
});

test('a missing derived page fails', () => {
  const { root, manifestPath, pageRel } = makeFixture();
  rmSync(join(root, pageRel));
  const result = run(root, manifestPath);
  assert.equal(result.code, 1);
  assert.ok(result.output.includes(pageRel));
  rmSync(root, { recursive: true, force: true });
});

test('C4 guard — a manifest source under internal/ is refused outright', () => {
  const { root, manifestPath, manifest } = makeFixture();
  const forbiddenRel = 'internal/LAUNCH_NOTES.md';
  mkdirSync(join(root, 'internal'), { recursive: true });
  writeFileSync(join(root, forbiddenRel), 'secret strategy');
  manifest.entries[0].sources.push({ path: forbiddenRel, sha256: sha256('secret strategy') });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const result = run(root, manifestPath);
  assert.equal(result.code, 1);
  assert.match(result.output, /internal\//);
  assert.match(result.output, /C4|refused/i);
  rmSync(root, { recursive: true, force: true });
});

test('an unreadable manifest is an error, not a pass', () => {
  const { root } = makeFixture();
  const result = run(root, join(root, 'nope.json'));
  assert.equal(result.code, 1);
  rmSync(root, { recursive: true, force: true });
});

test('the REAL manifest verifies against the real repo (wiring check)', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const result = run(repoRoot, join(repoRoot, 'apps/website/docs-sync.json'));
  assert.equal(result.code, 0, `real manifest must be green:\n${result.output}`);
});
