// release-desktop.test.mjs — TASK-20260821-hardening-polish AC11.
//
// node:test over the release script's PURE parts, wired into root `pnpm test` via
// `check-release-desktop` (a node:test file nothing runs is dead coverage —
// plan-review finding 15). The impure half (gate, tauri build, staging) is exercised
// by real release runs; what these tests pin is every refusal and every emitted shape.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SEMVER,
  STABLE_ASSETS,
  buildLatestJson,
  bumpedCargoToml,
  bumpedJsonConfig,
  changelogEntryFor,
  ghReleaseCommand,
} from './release-desktop.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('changelogEntryFor accepts only a matching NEWEST entry', () => {
  const raw = JSON.stringify({
    releases: [
      { version: '0.2.0', date: '2026-09-01', sections: [{ title: 't', items: ['i'] }] },
      { version: '0.1.0', date: '2026-08-21', sections: [{ title: 't', items: ['i'] }] },
    ],
  });
  assert.equal(changelogEntryFor(raw, '0.2.0').version, '0.2.0');
  // An OLDER entry existing is not enough — notes-first means newest-first.
  assert.throws(() => changelogEntryFor(raw, '0.1.0'), /newest entry is v0\.2\.0/);
  assert.throws(() => changelogEntryFor(raw, '0.3.0'), /newest entry is v0\.2\.0/);
  assert.throws(() => changelogEntryFor('{}', '0.1.0'), /no releases/);
  assert.throws(() => changelogEntryFor('not json', '0.1.0'), /not valid JSON/);
});

test('the REAL bundled desktop-releases.json parses and its newest entry is well-formed', () => {
  const raw = readFileSync(
    path.join(ROOT, 'apps', 'playground', 'src', 'desktop', 'desktop-releases.json'),
    'utf8',
  );
  const data = JSON.parse(raw);
  const newest = data.releases[0];
  assert.match(newest.version, SEMVER);
  assert.ok(Array.isArray(newest.sections) && newest.sections.length > 0);
  // The entry the script would accept for its own version:
  assert.equal(changelogEntryFor(raw, newest.version).version, newest.version);
});

test('bumpedJsonConfig sets version and preserves the rest', () => {
  const out = bumpedJsonConfig('{\n  "name": "desktop",\n  "version": "0.1.0"\n}\n', '0.2.0');
  const data = JSON.parse(out);
  assert.equal(data.version, '0.2.0');
  assert.equal(data.name, 'desktop');
  assert.ok(out.endsWith('\n'));
});

test('bumpedCargoToml bumps ONLY the [package] version line', () => {
  const toml = '[package]\nname = "snug-desktop"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1" }\n';
  const out = bumpedCargoToml(toml, '0.2.0');
  assert.match(out, /^version = "0\.2\.0"$/m);
  assert.match(out, /serde = \{ version = "1" \}/);
  assert.throws(() => bumpedCargoToml('[package]\nname = "x"\n', '0.2.0'), /no version line/);
});

test('buildLatestJson: both darwin keys point at the ONE versioned universal artifact', () => {
  const latest = buildLatestJson({ version: '0.1.0', pubDate: '2026-08-21T00:00:00Z', signature: 'SIG' });
  const url = 'https://github.com/snugprotocol/snug/releases/download/v0.1.0/Snug.app.tar.gz';
  assert.deepEqual(latest.platforms['darwin-aarch64'], { signature: 'SIG', url });
  assert.deepEqual(latest.platforms['darwin-x86_64'], { signature: 'SIG', url });
  assert.equal(latest.version, '0.1.0');
  // Exactly the two macOS keys — a windows/linux key appearing means the ADR-0021 D8
  // platform decision leaked into the manifest.
  assert.deepEqual(Object.keys(latest.platforms).sort(), ['darwin-aarch64', 'darwin-x86_64']);
  assert.throws(() => buildLatestJson({ version: 'nope', pubDate: '', signature: 'SIG' }), /semver/);
  assert.throws(() => buildLatestJson({ version: '0.1.0', pubDate: '', signature: '' }), /signature/);
});

test('the stable asset plan and the single-homed URLs agree', () => {
  // releaseChannel.ts is TS — pin the two literals it must keep serving by reading the
  // source (the byte-compare discipline, lessons 2026-07-31: one contract, one home,
  // and every other spelling pinned against it).
  const channel = readFileSync(
    path.join(ROOT, 'apps', 'playground', 'src', 'desktop', 'releaseChannel.ts'),
    'utf8',
  );
  for (const asset of ['latest.json', 'Snug.dmg', 'desktop-releases.json']) {
    assert.ok(STABLE_ASSETS.includes(asset), `${asset} missing from STABLE_ASSETS`);
    assert.ok(
      channel.includes(`releases/latest/download/${asset}`),
      `releaseChannel.ts must serve ${asset} from the stable latest/download path`,
    );
  }
});

test('ghReleaseCommand names every stable asset and never auto-runs', () => {
  const cmd = ghReleaseCommand('0.1.0');
  assert.match(cmd, /^gh release create v0\.1\.0 --repo snugprotocol\/snug /);
  for (const asset of STABLE_ASSETS) assert.ok(cmd.includes(`release-out/${asset}`), asset);
});
