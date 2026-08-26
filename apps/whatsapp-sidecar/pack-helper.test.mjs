// pack-helper.test.mjs — TASK-20260826 AC3 (ADR-0060 §2). node:test over the PURE parts,
// wired into root `pnpm test` via `check-pack-helper`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { npmInstallArgs } from './helper-tree.mjs';
import {
  ARCHES,
  checkNodeRuntime,
  checkPackedTree,
  helperArchiveName,
  nodeDownloadUrl,
  sha256Hex,
} from './pack-helper.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pinned = JSON.parse(readFileSync(path.join(here, 'node-runtime.json'), 'utf8'));

test('archive names are per-arch and refuse unknown arches', () => {
  assert.equal(helperArchiveName('whatsapp-sidecar', 'aarch64'), 'whatsapp-sidecar-darwin-aarch64.tar.gz');
  assert.equal(helperArchiveName('whatsapp-sidecar', 'x86_64'), 'whatsapp-sidecar-darwin-x86_64.tar.gz');
  assert.throws(() => helperArchiveName('whatsapp-sidecar', 'arm64'), /unknown arch/);
});

test('Node is fetched from nodejs.org/dist by the pinned version', () => {
  assert.equal(nodeDownloadUrl('22.23.2', 'aarch64'), 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-arm64.tar.gz');
  assert.equal(nodeDownloadUrl('22.23.2', 'x86_64'), 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-x64.tar.gz');
});

test('node-runtime.json pins a 64-hex sha256 for every arch and a 22.x version', () => {
  assert.match(pinned.version, /^22\.\d+\.\d+$/);
  for (const arch of ARCHES) assert.match(pinned.sha256[arch], /^[0-9a-f]{64}$/);
});

test('a tampered Node tarball is refused against the PINNED sum, a matching one accepted', () => {
  const bytes = Buffer.from('not really node');
  const bad = checkNodeRuntime(bytes, pinned, 'aarch64');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /sha256 mismatch/);
  const good = checkNodeRuntime(bytes, { version: 'x', sha256: { aarch64: sha256Hex(bytes) } }, 'aarch64');
  assert.equal(good.ok, true);
  assert.equal(checkNodeRuntime(bytes, { version: 'x', sha256: {} }, 'x86_64').ok, false);
});

test('the release tree omits peers (sharp) while the developer tree keeps them', () => {
  const rel = npmInstallArgs({ baileysRange: '7.0.0-rc14', zodRange: '^4', omitPeers: true });
  assert.ok(rel.includes('--omit=peer') && rel.includes('--omit=optional') && rel.includes('--omit=dev'));
  const dev = npmInstallArgs({ baileysRange: '7.0.0-rc14', zodRange: '^4', omitPeers: false });
  assert.ok(!dev.includes('--omit=peer'));
  assert.ok(dev.includes('baileys@7.0.0-rc14') && dev.includes('zod@^4'));
});

test('checkPackedTree requires the spawn contract and forbids sharp', () => {
  const good = [
    'index.js', 'package.json', 'bin/node', 'router.js',
    'node_modules/baileys/package.json', 'node_modules/zod/package.json',
    'node_modules/@snugprotocol/protocol/package.json',
  ];
  assert.deepEqual(checkPackedTree(good), { ok: true, missing: [], forbidden: [] });
  const noNode = checkPackedTree(good.filter((p) => p !== 'bin/node'));
  assert.equal(noNode.ok, false);
  assert.deepEqual(noNode.missing, ['bin/node']);
  const withSharp = checkPackedTree([...good, 'node_modules/@img/sharp-libvips-darwin-arm64/lib/x.dylib']);
  assert.equal(withSharp.ok, false);
  assert.equal(withSharp.forbidden.length, 1);
  // npm's .bin symlink farm — the shell's extractor admits no symlinks (ADR-0060 §7).
  const withBin = checkPackedTree([...good, { path: 'node_modules/.bin/pino', symlink: true }]);
  assert.equal(withBin.ok, false);
  assert.deepEqual(withBin.forbidden, ['node_modules/.bin/pino', 'node_modules/.bin/pino']);
  const strayLink = checkPackedTree([...good, { path: 'node_modules/foo/link', symlink: true }]);
  assert.equal(strayLink.ok, false);
  assert.deepEqual(strayLink.forbidden, ['node_modules/foo/link']);
});
