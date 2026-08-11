// infer-connection.test.mjs — TASK-20260810-p4-starters, P4-AC8 (RED).
//
// HOMED IN `examples/`, NOT `scripts/`, and the reason is mechanical rather than
// aesthetic: the plan names the entry point `pnpm --filter examples infer-connection
// <folder>`, and only `examples/` carries the workspace dep on `@snugprotocol/protocol`.
// Authored in `scripts/` first, this file died at module load with
// `ERR_MODULE_NOT_FOUND: Cannot find package '@snugprotocol/protocol'` — the root package
// has no such dep — which is a blunt failure that would have told the implementer nothing
// about the eight properties below. Same package as the manifests it generates, same
// turbo `test → build → ^build` chain that makes the schema import resolve.
//
// THE DEV-TIME INFERENCE SCRIPT. R4 says a new starter's auth requirement is inferred at
// DEVELOPMENT time — by this script, or by Claude Code running the same inferrer seam —
// and baked into the shipped `connection.json`, where it is human-reviewed in the PR like
// any other first-party content.
//
// WHY DEV-TIME AND NOT RUNTIME, restated here because this file is where the rule is
// enforced: P3 REMOVED run-time inference. An app must never be able to propose a
// connection while it is running. Moving inference to the author's machine keeps the
// capability (nobody hand-writes a Coinbase header template correctly) while removing the
// attack surface (the artifact that ships is a reviewed constant, not a live negotiation).
//
// WHAT THIS TEST PINS, and it is deliberately narrow: that the script EXISTS, that it
// produces a SCHEMA-VALID requirement for a folder, and that the requirement it produces
// would survive the same gates a shipped manifest passes. It does NOT pin the wording of
// any inferred label — that is a model output and pinning it would make every prompt
// tweak a red test. The property that matters is that the output is admissible, because
// an inference script whose output the manifest gate rejects is a script nobody can use.
//
// NO NETWORK, NO MODEL CALL. The script takes an injectable `complete` seam (the same
// shape `ConnectionRequirementInferrerDeps` uses), so this test drives it with a
// deterministic stub. A dev-time tool that could only be tested by calling a model would
// be untested in CI, which is where it would rot.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { connectionRequirementSchema } from '@snugprotocol/protocol';

import { inferConnectionForFolder } from './infer-connection.mjs';

/** A folder that reaches CoinGecko through the governed seam — the crypto-portfolio shape. */
function fixtureFolder() {
  const dir = mkdtempSync(path.join(tmpdir(), 'snug-infer-'));
  const folder = path.join(dir, 'crypto-portfolio');
  mkdirSync(folder);
  writeFileSync(
    path.join(folder, 'app.html'),
    [
      '<!DOCTYPE html>',
      '<html><head><title>crypto portfolio</title></head><body>',
      '<div id="root"></div>',
      '<script type="text/babel">',
      '// 5. RESPONSE SCHEMA',
      'const RESPONSE_SCHEMA = null;',
      'const api = useConnectedFetch();',
      'const res = await api.fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin");',
      '</script></body></html>',
      '',
    ].join('\n'),
    'utf8',
  );
  return folder;
}

/**
 * A deterministic stand-in for the model rung. Returns the JSON an inferrer would emit
 * for the fixture above — including the seats that made this rewrite necessary
 * (`fields`, `registration`), so the assertion below proves the script CARRIES them
 * through rather than collapsing to a generic single-field shape.
 */
const stubComplete = async () =>
  JSON.stringify({
    slot: 'coingecko',
    provider: { name: 'CoinGecko', docsUrl: 'https://docs.coingecko.com/reference/simple-price' },
    kind: 'api_key',
    fields: [{ key: 'api_key', label: 'CoinGecko API key', type: 'secret' }],
    registration: {
      consoleUrl: 'https://www.coingecko.com/en/developers/dashboard',
      instructions: ['Create a CoinGecko account.', 'Generate a Demo API key and paste it below.'],
    },
    request: { headerTemplate: { 'x-cg-demo-api-key': '{{api_key}}' } },
    declaredApiHosts: ['api.coingecko.com'],
  });

test('P4-AC8: the dev-time inference script exists and is executable as a module', () => {
  const script = fileURLToPath(new URL('./infer-connection.mjs', import.meta.url));
  assert.ok(statSync(script).isFile(), 'examples/infer-connection.mjs must exist');
  assert.equal(typeof inferConnectionForFolder, 'function', 'it exports a callable folder entry point');
});

test('P4-AC8: it is reachable as `pnpm --filter examples infer-connection` (the plan\'s entry point)', () => {
  // A dev-time tool nobody can invoke is a module, not a script. The plan names this
  // exact command, so the package script is part of the contract — not an afterthought
  // the author discovers is missing when they try to add the seventh starter.
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));
  assert.ok(pkg.scripts?.['infer-connection'], 'examples/package.json must expose the infer-connection script');
});

test('P4-AC8: it produces a SCHEMA-VALID requirement for a folder', () => {
  return inferConnectionForFolder(fixtureFolder(), { complete: stubComplete }).then((result) => {
    assert.ok(result.ok, `inference failed: ${result.message ?? ''}`);
    const parsed = connectionRequirementSchema.safeParse(result.requirement);
    assert.ok(parsed.success, `not schema-valid: ${JSON.stringify(parsed.error?.issues ?? [], null, 2)}`);
  });
});

test('P4-AC8: the requirement carries the seats a static kind needs', () => {
  // The founding defect at the authoring end. A script that emitted a valid-but-generic
  // requirement would pass the schema check above and still leave every static-kind
  // starter with one nameless input.
  return inferConnectionForFolder(fixtureFolder(), { complete: stubComplete }).then((result) => {
    assert.ok(result.ok);
    assert.ok((result.requirement.fields ?? []).length > 0, 'a static kind declares its fields');
    assert.ok(result.requirement.registration?.consoleUrl, 'it says where to get the key');
    assert.deepEqual(result.requirement.declaredApiHosts, ['api.coingecko.com']);
  });
});

test('P4-AC8: the declared hosts match the hosts the app actually calls', () => {
  // The check a human reviewer would otherwise have to do by eye, and the one that
  // matters: a requirement declaring a host the app never dials widens the ceiling for
  // nothing, and one MISSING a host the app dials ships a starter that cannot work.
  return inferConnectionForFolder(fixtureFolder(), { complete: stubComplete }).then((result) => {
    assert.ok(result.ok);
    assert.ok(
      (result.observedHosts ?? []).includes('api.coingecko.com'),
      'the script reports the hosts it found in the source, so the PR review can compare',
    );
    for (const host of result.observedHosts ?? []) {
      assert.ok(result.requirement.declaredApiHosts.includes(host), `${host} is dialed but not declared`);
    }
  });
});

test('P4-AC8: a model emitting an INVALID requirement is refused, never written', () => {
  // Dev-time does not mean unchecked. The script writes a file into the repo that the
  // install act later copies into a user's DB — so a malformed emission must fail loudly
  // at the author's terminal rather than land as a manifest the validate suite catches
  // later (or worse, as one that parses but declares the wrong host).
  const badComplete = async () => JSON.stringify({ providerName: 'CoinGecko', kindHint: 'api_key' });
  return inferConnectionForFolder(fixtureFolder(), { complete: badComplete }).then((result) => {
    assert.equal(result.ok, false, 'an unparseable emission must be refused');
  });
});

test('P4-AC8: --write emits the manifest into the folder, pretty-printed and parseable', () => {
  const folder = fixtureFolder();
  return inferConnectionForFolder(folder, { complete: stubComplete, write: true }).then((result) => {
    assert.ok(result.ok);
    const written = readFileSync(path.join(folder, 'connection.json'), 'utf8');
    // Human-reviewed in a PR means human-READABLE in a diff: one line per seat.
    assert.ok(written.includes('\n'), 'the manifest is pretty-printed for review');
    assert.ok(connectionRequirementSchema.safeParse(JSON.parse(written)).success, 'the written bytes re-parse');
  });
});

test('P4-AC8: a refused inference writes NOTHING', () => {
  const folder = fixtureFolder();
  const badComplete = async () => 'not json at all';
  return inferConnectionForFolder(folder, { complete: badComplete, write: true }).then((result) => {
    assert.equal(result.ok, false);
    assert.throws(
      () => statSync(path.join(folder, 'connection.json')),
      'a failed run must not leave a half-written manifest behind',
    );
  });
});
