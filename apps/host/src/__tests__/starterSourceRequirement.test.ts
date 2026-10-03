// starterSourceRequirement.test.ts — TASK-20261003 R3 S2 (ADR-0072 §4): the kit's REAL
// `starterSource()` answers `requirement()` from the index the build bakes in.
//
// WHY ITS OWN FILE. `availabilityOffers.test.ts` proves `requirementsOf(index)` over a
// hand-made index, and proves that the module the build aliases in still carries the seat —
// but over the suite's FIXTURE index, whose one manifest (`{"id":"weather"}`) is not a
// requirement, so every answer there is `undefined`. That left the one line that hands the
// baked index to the seat unguarded: with `requirement: () => undefined` in its place the
// host's types and all 315 of its tests stayed green (the round-1 verifier's mutant,
// 2026-10-03), and the kit would have ENABLED every connected starter under an artifact —
// the bug this range exists to fix. The only other guard is a browser spec.
//
// So this file swaps the virtual module for an index built the way the build builds it —
// each starter's `connection.json`, byte for byte, as `inline.manifest`
// (`scripts/build-starters-pkg.mjs`) — and asks the real module. Reading the shipped
// manifests rather than restating them means a manifest edit moves the kit's shelf here by
// name, exactly as it moves the web shelf in the playground's `availability.test.ts`.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { createMemoryBackend } from '@snugprotocol/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOST_OFFERS, availabilityOf, needsOfRequirement, offersOf, type HostOffers } from '@playground/platform/availability';

import { createHostPlatform } from '../platform-host.js';
import type { ProbeResult } from '../probe.js';
import { STARTERS_INDEX_FORMAT, type StartersIndex } from '../starterLoader.js';
import type { StarterSource } from '../starterSource.js';

/** apps/host → repo root → examples (vitest runs each project from its own package root). */
const EXAMPLES = path.resolve(process.cwd(), '../../examples');

/** The index as the build bakes it: every folder that ships an app, its manifest inline when it has one. */
function shippedIndex(): StartersIndex {
  const starters: StartersIndex['starters'] = {};
  for (const folder of readdirSync(EXAMPLES).sort((a, b) => a.localeCompare(b))) {
    if (!existsSync(path.join(EXAMPLES, folder, 'app.html'))) continue;
    const manifest = path.join(EXAMPLES, folder, 'connection.json');
    starters[folder] = {
      file: `${folder}.js`,
      sha384: 'A'.repeat(64),
      bytes: 1,
      inline: existsSync(manifest) ? { manifest: readFileSync(manifest, 'utf8') } : {},
    };
  }
  return { format: STARTERS_INDEX_FORMAT, name: '@snugprotocol/starters', version: '0.0.0-test', starters };
}

const KEEPERS = ['adventure-quest', 'chess', 'flying-pig', 'quiz-me'];

const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const artifactProbe: ProbeResult = {
  binding: 'artifact',
  storage: { backend: createMemoryBackend(), kind: 'memory' },
  brain: { brain: { kind: 'demo' }, legs: { sample: 'detected', complete: 'absent', local: 'absent' } },
};

/** The real module the build aliases in, over the shipped manifests instead of the fixture. */
async function kitStarterSource(): Promise<StarterSource> {
  vi.resetModules();
  vi.doMock('virtual:snug-starters-index', () => ({ default: shippedIndex() }));
  const { starterSource } = await import('../starterSource.js');
  return starterSource();
}

/** folder → 'ok', or the title a blocked tile would read. */
function shelf(source: Pick<StarterSource, 'appFolders' | 'requirement'>, offers: HostOffers): Record<string, string> {
  return Object.fromEntries(
    source.appFolders().map((folder) => {
      const verdict = availabilityOf(needsOfRequirement(source.requirement(folder)), offers);
      return [folder, verdict.ok ? 'ok' : verdict.blockers[0]!.title];
    }),
  );
}

// The swap is this file's alone: nothing after a test may still see the shipped index.
afterEach(() => {
  vi.doUnmock('virtual:snug-starters-index');
  vi.resetModules();
});

describe('the kit’s starterSource() — requirement() over the index the build bakes in', () => {
  it('answers each connected starter’s requirement synchronously, and loads no script to do it', async () => {
    const source = await kitStarterSource();
    expect(source.appFolders()).toHaveLength(12);

    expect(source.requirement('weather')?.provider.name).toBe('OpenWeather');
    expect(source.requirement('weather')?.kind).toBe('api_key');
    expect(source.requirement('hue')?.lanHost).toBeDefined();
    expect(source.requirement('whatsapp')?.kind).toBe('linked_device');
    expect(source.requirement('gmail')?.kind).toBe('oauth2_auth_code');
    expect(source.requirement('trade-copilot')?.provider.name).toBe('Coinbase');
    for (const folder of KEEPERS) expect(source.requirement(folder), folder).toBeUndefined();

    // First paint: the answer came from the inline index — no wrapper was fetched for it.
    expect(document.head.querySelectorAll('script')).toHaveLength(0);
  });

  it('under an artifact the kit’s own shelf blocks exactly the eight connected starters, each for its reason', async () => {
    const source = await kitStarterSource();
    const offers = offersOf(createHostPlatform(artifactProbe, wasm));
    expect(shelf(source, offers)).toEqual({
      'adventure-quest': 'ok',
      chess: 'ok',
      'flying-pig': 'ok',
      github: 'needs live connections',
      gmail: 'needs live connections',
      hue: 'needs your home network',
      ledger: 'needs live connections',
      'quiz-me': 'ok',
      spotify: 'needs live connections',
      'trade-copilot': 'needs live connections',
      weather: 'needs live connections',
      whatsapp: 'needs the phone helper',
    });
  });

  it('under the runner it blocks only the two device starters — Trade Copilot is enabled', async () => {
    // `HOST_OFFERS.runner` is pinned to the real local composition by availabilityOffers.test.ts.
    const source = await kitStarterSource();
    const blocked = Object.entries(shelf(source, HOST_OFFERS.runner)).filter(([, title]) => title !== 'ok');
    expect(blocked).toEqual([
      ['hue', 'needs your home network'],
      ['whatsapp', 'needs the phone helper'],
    ]);
  });
});
