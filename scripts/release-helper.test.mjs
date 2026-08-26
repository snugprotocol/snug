// release-helper.test.mjs — TASK-20260826 AC4 (ADR-0060 §§1,5,9). node:test over the PURE parts.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildHelperJson, ghReleaseCommand, helperAssets, helperTag, rustPinSnippet, signingKeyPlan } from './release-helper.mjs';

test('helper tags are helper-<name>-v<semver> and refuse junk', () => {
  assert.equal(helperTag('whatsapp-sidecar', '0.1.0'), 'helper-whatsapp-sidecar-v0.1.0');
  assert.throws(() => helperTag('whatsapp-sidecar', 'v0.1.0'), /not semver/);
  assert.throws(() => helperTag('WhatsApp', '0.1.0'), /lowercase slug/);
});

test('the gh command is a PRE-RELEASE on snugprotocol/snug carrying every asset', () => {
  const cmd = ghReleaseCommand('whatsapp-sidecar', '0.1.0');
  assert.ok(cmd.startsWith('gh release create helper-whatsapp-sidecar-v0.1.0 --repo snugprotocol/snug --prerelease --latest=false '));
  for (const f of helperAssets('whatsapp-sidecar')) assert.ok(cmd.includes(`release-out/${f}`), f);
});

test('helperAssets lists two archives, two sigs and the manifest', () => {
  assert.deepEqual(helperAssets('x'), [
    'x-darwin-aarch64.tar.gz', 'x-darwin-aarch64.tar.gz.sig',
    'x-darwin-x86_64.tar.gz', 'x-darwin-x86_64.tar.gz.sig',
    'helper.json',
  ]);
});

test('helper.json carries name, version, tag, node version and per-arch file/sha256/size', () => {
  const sha = 'a'.repeat(64);
  const m = buildHelperJson({
    name: 'whatsapp-sidecar', version: '0.1.0', nodeVersion: '22.23.2',
    archives: { aarch64: { sha256: sha, size: 10, unpackedSize: 100 }, x86_64: { sha256: sha, size: 11, unpackedSize: 110 } },
  });
  assert.equal(m.tag, 'helper-whatsapp-sidecar-v0.1.0');
  assert.equal(m.assets.aarch64.file, 'whatsapp-sidecar-darwin-aarch64.tar.gz');
  assert.equal(m.assets.x86_64.size, 11);
  assert.equal(m.assets.x86_64.unpackedSize, 110);
  const pin = rustPinSnippet(m);
  assert.ok(pin.includes('tag: "helper-whatsapp-sidecar-v0.1.0"') && pin.includes('unpacked_size: 110') && pin.includes(`sha256: "${sha}"`));
  assert.throws(() => buildHelperJson({ name: 'x', version: '0.1.0', nodeVersion: '22', archives: { aarch64: { sha256: sha, size: 1, unpackedSize: 1 } } }), /no archive for x86_64/);
  assert.throws(() => buildHelperJson({ name: 'x', version: '0.1.0', nodeVersion: '22', archives: { aarch64: { sha256: 'zz', size: 1, unpackedSize: 1 }, x86_64: { sha256: sha, size: 1, unpackedSize: 1 } } }), /bad sha256/);
});

test('no signing key → refused', () => {
  assert.equal(signingKeyPlan({}).ok, false);
  assert.equal(signingKeyPlan({ TAURI_SIGNING_PRIVATE_KEY_PATH: '~/.tauri/snug-updater.key' }).ok, true);
});
