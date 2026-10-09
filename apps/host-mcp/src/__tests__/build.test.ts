// L4 — which Snug is this: the version and the build a status leads with.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildId, VERSION } from '../build.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('VERSION', () => {
  it('is this package’s version', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(here, '../../package.json'), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it('is the version the PLUGIN manifest names — a status must not report a different number than the install shows', () => {
    const manifests = readFileSync(path.resolve(here, '../../../../scripts/lib/plugin-manifests.mjs'), 'utf8');
    const plugin = /name: 'snug',\s*version: '([^']+)'/.exec(manifests)?.[1];
    expect(plugin, 'PLUGIN.version moved or changed its spelling in plugin-manifests.mjs').toBeDefined();
    expect(VERSION).toBe(plugin);
  });
});

describe('buildId', () => {
  it('is the first seven hex digits of the sha256 of the file the code is running from', () => {
    const running = readFileSync(path.resolve(here, '../build.ts'));
    expect(buildId()).toBe(createHash('sha256').update(running).digest('hex').slice(0, 7));
  });

  it('is stable for the life of the process', () => {
    expect(buildId()).toBe(buildId());
    expect(buildId()).toMatch(/^[0-9a-f]{7}$/);
  });
});
