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
  EULA_LINE_BUDGET,
  EULA_MAX_COLUMNS,
  checkEulaText,
  verifyDmgCarriesEula,
  checkUniversalArchs,
  appleSigningPlan,
  checkStapleOutput,
  checkSpctlOutput,
  pinnedHelperTags,
  pinnedHelperIsPublished,
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

// ---------------------------------------------------------------- TASK-20260823-legal-terms-privacy-eula AC10/AC11

test('checkEulaText: ASCII only, short lines, under budget — and it refuses each violation by name', () => {
  const good = 'Snug for macOS - License Agreement\n\nLICENSE. Free software.\n';
  assert.deepEqual(checkEulaText(good), { ok: true });
  const curly = checkEulaText(good.replace('-', '—'));
  assert.equal(curly.ok, false);
  assert.match(curly.reason, /non-ASCII/);
  const long = checkEulaText(`${good}${'x'.repeat(EULA_MAX_COLUMNS + 1)}\n`);
  assert.equal(long.ok, false);
  assert.match(long.reason, /columns/);
  const tall = checkEulaText(`${good}${'a\n'.repeat(EULA_LINE_BUDGET)}`);
  assert.equal(tall.ok, false);
  assert.match(tall.reason, /lines/);
  assert.equal(checkEulaText('').ok, false);
  assert.equal(checkEulaText('   \n').ok, false);
});

test('the REAL src-tauri/EULA.txt passes checkEulaText (the release script runs this before it builds)', () => {
  const eula = readFileSync(path.join(ROOT, 'apps', 'desktop', 'src-tauri', 'EULA.txt'), 'utf8');
  assert.deepEqual(checkEulaText(eula), { ok: true });
});

test('verifyDmgCarriesEula: decodes the SLA resource out of a REAL udifderez dump and matches the FULL text', () => {
  // Captured from `hdiutil udifderez -xml` over a DMG built WITH bundle.licenseFile
  // (lesson 2026-08-24: pin the parser to the platform's real output, keep the sample).
  const withSla = readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'udifderez-with-sla.xml'), 'utf8');
  const eula = readFileSync(path.join(ROOT, 'apps', 'desktop', 'src-tauri', 'EULA.txt'), 'utf8');
  assert.deepEqual(verifyDmgCarriesEula(withSla, eula), { ok: true });
  // A DIFFERENT text is refused — full-text compare, so a stale EULA with the same
  // title cannot ride (Gate-5 review F6); the reason still names the first lines.
  const wrong = verifyDmgCarriesEula(withSla, 'Some Other Product - License Agreement');
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /first line/);
  const stale = verifyDmgCarriesEula(withSla, `${eula}\nOne extra clause.\n`);
  assert.equal(stale.ok, false);
});

test('verifyDmgCarriesEula: a REAL dump of a DMG built WITHOUT licenseFile is refused (no SLA at all)', () => {
  const noSla = readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'udifderez-no-sla.xml'), 'utf8');
  const verdict = verifyDmgCarriesEula(noSla, 'Snug for macOS - License Agreement');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no SLA|LPic/);
  // …and names the deprecation, so the day udifrez/udifderez vanish the failure is diagnosable.
  assert.match(verdict.reason, /udifderez/);
});

test('verifyDmgCarriesEula: garbage in → a named refusal, never a throw', () => {
  assert.equal(verifyDmgCarriesEula('', 'x').ok, false);
  assert.equal(verifyDmgCarriesEula('not xml at all', 'x').ok, false);
});

// ---------------------------------------------------------------- TASK-20260824-first-signed-release

test('checkUniversalArchs: only a binary carrying BOTH arm64 and x86_64 passes', () => {
  // Real `lipo -archs` output is a single space-separated line (captured on macOS 26).
  assert.deepEqual(checkUniversalArchs('x86_64 arm64\n'), { ok: true });
  assert.deepEqual(checkUniversalArchs('arm64 x86_64'), { ok: true });
  // THE bug this whole check exists to catch: an Intel-only build shipped as
  // "universal" (the owner's stated worry, 2026-08-24). Apple Silicon users get a
  // Rosetta-or-nothing binary and nothing in the pipeline would have noticed.
  const intelOnly = checkUniversalArchs('x86_64\n');
  assert.equal(intelOnly.ok, false);
  assert.match(intelOnly.reason, /arm64/);
  const armOnly = checkUniversalArchs('arm64\n');
  assert.equal(armOnly.ok, false);
  assert.match(armOnly.reason, /x86_64/);
  // arm64e is NOT arm64 — /bin/ls reports `x86_64 arm64e`, and a substring check
  // would wave that through. Distribution binaries are arm64; arm64e is Apple's
  // pointer-authentication ABI and is not what tauri emits.
  const arm64e = checkUniversalArchs('x86_64 arm64e');
  assert.equal(arm64e.ok, false);
  assert.match(arm64e.reason, /arm64/);
  // Broken tooling must FAIL, not silently pass (the release-gate's positive-control
  // doctrine: a parser that can only succeed proves nothing).
  assert.equal(checkUniversalArchs('').ok, false);
  assert.equal(checkUniversalArchs('fatal error: can\'t figure out the architecture').ok, false);
  assert.equal(checkUniversalArchs(undefined).ok, false);
  assert.equal(checkUniversalArchs(null).ok, false);
});

test('appleSigningPlan: signed, unsigned, and the REFUSED half-configured states', () => {
  // Fully configured → sign + notarize. Tauri's bundler reads the APPLE_ID trio (or
  // the API-key trio); a notarytool KEYCHAIN PROFILE is not one of its inputs — the
  // first real build (2026-08-24) proved that by warning "skipping app notarization"
  // with a profile set. That miss is exactly what this test now pins.
  const signed = appleSigningPlan({
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Jitendra Maker (2KC5X47563)',
    APPLE_ID: 'jeetumaker@gmail.com',
    APPLE_PASSWORD: 'abcd-efgh-ijkl-mnop',
    APPLE_TEAM_ID: '2KC5X47563',
  });
  assert.equal(signed.mode, 'signed');
  assert.equal(signed.notarization, 'apple-id');
  // The App Store Connect API key trio is the other accepted shape.
  const viaApi = appleSigningPlan({
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Jitendra Maker (2KC5X47563)',
    APPLE_API_KEY: 'ABC123',
    APPLE_API_ISSUER: 'issuer-uuid',
    APPLE_API_KEY_PATH: '/keys/AuthKey_ABC123.p8',
  });
  assert.equal(viaApi.mode, 'signed');
  assert.equal(viaApi.notarization, 'api-key');
  // A KEYCHAIN PROFILE alone is NOT notarization credentials for the bundler — it
  // must be refused, not accepted as configured. This is the regression that shipped
  // a signed-but-un-notarized DMG on the first attempt.
  const profileOnly = appleSigningPlan({
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Jitendra Maker (2KC5X47563)',
    APPLE_KEYCHAIN_PROFILE: 'snug',
  });
  assert.equal(profileOnly.mode, 'refused');
  assert.match(profileOnly.reason, /APPLE_ID|keychain profile does NOT work/i);
  // A PARTIAL trio is not a trio — missing the team id must not read as configured.
  const partial = appleSigningPlan({
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Jitendra Maker (2KC5X47563)',
    APPLE_ID: 'jeetumaker@gmail.com',
    APPLE_PASSWORD: 'abcd-efgh-ijkl-mnop',
  });
  assert.equal(partial.mode, 'refused');
  // Nothing set → the honest unsigned path (a cert-less machine must still build).
  const unsigned = appleSigningPlan({});
  assert.equal(unsigned.mode, 'unsigned');
  assert.match(unsigned.reason, /APPLE_SIGNING_IDENTITY/);
  // HALF-configured is the dangerous middle: it looks configured to a human but
  // produces a signed-yet-un-notarized DMG that Gatekeeper still blocks. Refuse it
  // rather than silently downgrading to unsigned.
  const noProfile = appleSigningPlan({ APPLE_SIGNING_IDENTITY: 'Developer ID Application: X (Y)' });
  assert.equal(noProfile.mode, 'refused');
  assert.match(noProfile.reason, /notarization credentials|APPLE_ID/);
  const noIdentity = appleSigningPlan({
    APPLE_ID: 'a@b.c',
    APPLE_PASSWORD: 'p',
    APPLE_TEAM_ID: 'T',
  });
  assert.equal(noIdentity.mode, 'refused');
  assert.match(noIdentity.reason, /APPLE_SIGNING_IDENTITY/);
  // An identity that is not a Developer ID Application cert cannot notarize —
  // "Apple Development" signs locally and passes codesign, then fails notarization
  // at the far end of a slow build.
  const wrongKind = appleSigningPlan({
    APPLE_SIGNING_IDENTITY: 'Apple Development: Jitendra Maker (2KC5X47563)',
    APPLE_ID: 'a@b.c',
    APPLE_PASSWORD: 'p',
    APPLE_TEAM_ID: 'T',
  });
  assert.equal(wrongKind.mode, 'refused');
  assert.match(wrongKind.reason, /Developer ID Application/);
  // Whitespace-only is empty, not configured.
  assert.equal(appleSigningPlan({ APPLE_SIGNING_IDENTITY: '   ' }).mode, 'unsigned');
});

test('checkStapleOutput: only a real staple acceptance passes', () => {
  assert.deepEqual(checkStapleOutput('Processing: Snug.dmg\nThe staple and validate action worked!\n'), { ok: true });
  // The exact refusal a never-notarized artifact produces (captured from a real run
  // against an un-stapled app). This is the silent failure the check exists for: a
  // notarization that succeeded but was never STAPLED still fails first launch on a
  // machine that is offline or that Apple's CDN cannot answer for.
  const noTicket = checkStapleOutput('Processing: Snug.dmg\nSnug.dmg does not have a ticket stapled to it.');
  assert.equal(noTicket.ok, false);
  assert.match(noTicket.reason, /ticket/i);
  assert.equal(checkStapleOutput('Error 65').ok, false);
  assert.equal(checkStapleOutput('').ok, false);
  assert.equal(checkStapleOutput(undefined).ok, false);
});

test('checkSpctlOutput: Gatekeeper acceptance, and the notarization-specific rejection', () => {
  // Real `spctl -a -vvv -t install` output for an accepted notarized artifact.
  const ok = checkSpctlOutput('Snug.dmg: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Jitendra Maker (2KC5X47563)\n');
  assert.deepEqual(ok, { ok: true });
  // Signed but NOT notarized — the precise state this task exists to leave behind.
  const unnotarized = checkSpctlOutput('Snug.dmg: rejected\nsource=Developer ID\norigin=Developer ID Application: Jitendra Maker (2KC5X47563)\n');
  assert.equal(unnotarized.ok, false);
  assert.match(unnotarized.reason, /rejected/i);
  // "accepted" must come from NOTARIZATION, not from an ad-hoc/store source: a
  // substring match on "accepted" alone would pass an artifact Gatekeeper only
  // tolerates for another reason.
  const wrongSource = checkSpctlOutput('Snug.dmg: accepted\nsource=Mac App Store\n');
  assert.equal(wrongSource.ok, false);
  assert.match(wrongSource.reason, /Notarized/i);
  assert.equal(checkSpctlOutput('').ok, false);
  assert.equal(checkSpctlOutput(undefined).ok, false);
});

test('the desktop release refuses when a pinned helper tag is unpublished (ADR-0060 §10)', () => {
  const pinned = JSON.parse(readFileSync(path.join(ROOT, 'apps', 'desktop', 'src-tauri', 'helpers.json'), 'utf8')).helpers;
  const tags = pinnedHelperTags(pinned);
  assert.ok(tags.length >= 1 && tags.every((t) => /^helper-[a-z0-9-]+-v\d+\.\d+\.\d+$/.test(t)), JSON.stringify(tags));
  // published and byte-equal to the pin → ok
  assert.equal(pinnedHelperIsPublished(pinned, (tag) => pinned.find((h) => h.tag === tag)).ok, true);
  const missing = pinnedHelperIsPublished(pinned, () => undefined);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /not published/);
  // published but a DIFFERENT build than the pin → refused (cross-file review finding 1)
  const drifted = pinnedHelperIsPublished(pinned, (tag) => {
    const h = structuredClone(pinned.find((x) => x.tag === tag));
    h.assets.aarch64.sha256 = 'f'.repeat(64);
    return h;
  });
  assert.equal(drifted.ok, false);
  assert.match(drifted.reason, /does not match the shell's pin/);
});
