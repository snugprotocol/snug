// availabilityOffers.test.ts — TASK-20261003 R3 S1/S2 (ADR-0072 §4): the kit's REAL platform
// objects through the playground's `offersOf`, and the kit's starter source answering
// `requirement()` synchronously from the index it already ships.
//
// WHY HERE. `offersOf` reads seats, and what a seat IS is decided by the shell that composes
// the platform — `createHostPlatform` for every artifact/chat/file binding, and
// `composeLocalPlatform` for the local runner. A matrix over literal offers (the playground's
// availability.test.ts) proves the derivation; only this proves that what the kit actually
// hands the playground yields those offers. Cut `fetchImpl` from the local composition and
// the playground's suite stays green while Trade Copilot is locked on every runner.
import { createMemoryBackend } from '@snugprotocol/db';
import { afterEach, describe, expect, it } from 'vitest';

import { HOST_OFFERS, availabilityOf, needsOfRequirement, offersOf, type HostOffers } from '@playground/platform/availability';

import type { LocalClient, LocalStatus } from '../local/client.js';
import { brainState, composeLocalPlatform } from '../local/compose-local.js';
import { createHostPlatform } from '../platform-host.js';
import type { Binding, ProbeResult } from '../probe.js';
import type { StartersIndex } from '../starterLoader.js';
import { requirementsOf, starterSource } from '../starterSource.js';

const NOTHING: HostOffers = { network: false, 'native-fetch': false, oauth: false, lan: false, helper: false };
/** The runner, as a LITERAL: connections and a sign-in through the process; no LAN, no helper. */
const RUNNER: HostOffers = { network: true, 'native-fetch': true, oauth: true, lan: false, helper: false };

const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const probe = (binding: Binding): ProbeResult => ({
  binding,
  storage: { backend: createMemoryBackend(), kind: 'memory' },
  brain: { brain: { kind: 'demo' }, legs: { sample: 'detected', complete: 'absent', local: 'absent' } },
});

const client = {
  fetchImpl: async () => new Response('ok'),
  fs: { readFile: async () => undefined, writeFileAtomic: async () => {} },
  status: async () => ({ binding: 'local-host', port: 43127, pages: 1 }),
  events: () => () => {},
} as unknown as LocalClient;
const status = (over: Partial<LocalStatus> = {}): LocalStatus => ({ binding: 'local-host', port: 43127, pages: 1, ...over });

afterEach(() => {
  brainState.current = undefined;
});

describe('createHostPlatform — every binding it serves offers NOTHING an app could need', () => {
  // The host kit inside an artifact, a chat, a static copy or a plain file carries no
  // transport seat at all, and switches the connections surface off. (A loopback static
  // server lands on this composition too — the runner is composed by the other function.)
  it.each(['artifact', 'artifact-static', 'artifact-chat', 'file', 'local-host'] as const)('%s', (binding) => {
    expect(offersOf(createHostPlatform(probe(binding), wasm))).toEqual(NOTHING);
  });

  it('so a connected starter is blocked there, and one that declares nothing is not', () => {
    const offers = offersOf(createHostPlatform(probe('artifact'), wasm));
    const weather = needsOfRequirement({ slot: 'openweather', provider: { name: 'OpenWeather' }, kind: 'api_key', declaredApiHosts: ['api.openweathermap.org'] });
    expect(availabilityOf(weather, offers).ok).toBe(false);
    expect(availabilityOf(needsOfRequirement(undefined), offers)).toEqual({ ok: true });
  });
});

describe('composeLocalPlatform — the runner offers connections through the process', () => {
  it('network, native-fetch and a sign-in; no LAN, no helper', () => {
    const { platform } = composeLocalPlatform(client, status());
    expect(offersOf(platform)).toEqual(RUNNER);
  });

  it('is the row `runsIn` is judged against — the table and the shell cannot drift apart', () => {
    expect(offersOf(composeLocalPlatform(client, status()).platform)).toEqual(HOST_OFFERS.runner);
  });

  it('with a brain wired (the token present) the offers are the same — thinking is not a connection', () => {
    brainState.current = { state: 'ready' };
    expect(offersOf(composeLocalPlatform(client, status(), undefined, undefined, 't').platform)).toEqual(RUNNER);
  });

  it('when another product holds the file, connections go and so does everything that rides them', () => {
    const { platform } = composeLocalPlatform(client, status({ heldBy: 'Snug for Mac' }));
    const offers = offersOf(platform);
    expect(offers.network).toBe(false);
    expect(offers.oauth).toBe(false);
    expect(offers.lan).toBe(false);
    expect(offers.helper).toBe(false);
  });
});

describe('the kit’s starter source — requirement() from the inline index, synchronously', () => {
  const manifest = (requirement: Record<string, unknown>): string => JSON.stringify(requirement);
  const entry = (file: string, inlineManifest?: string) => ({
    file,
    sha384: 'A'.repeat(64),
    bytes: 1,
    inline: inlineManifest === undefined ? {} : { manifest: inlineManifest },
  });
  const index: StartersIndex = {
    format: 'snug-starters-index/1',
    name: '@snugprotocol/starters',
    version: '0.0.0-test',
    starters: {
      chess: entry('chess.js'),
      weather: entry('weather.js', manifest({ slot: 'openweather', provider: { name: 'OpenWeather' }, kind: 'api_key', declaredApiHosts: ['api.openweathermap.org'] })),
      hue: entry('hue.js', manifest({ slot: 'hue', provider: { name: 'Philips Hue' }, kind: 'api_key', lanHost: { class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' } })),
      broken: entry('broken.js', '{ not json'),
      wrong: entry('wrong.js', manifest({ id: 'weather' })),
    },
  };

  it('answers from the index alone — the first paint needs no network and no script', () => {
    const requirement = requirementsOf(index);
    expect(requirement('weather')?.provider.name).toBe('OpenWeather');
    expect(requirement('hue')?.lanHost).toBeDefined();
  });

  it('a starter with no manifest, a malformed one, or one the schema refuses declares nothing — never a throw', () => {
    const requirement = requirementsOf(index);
    expect(requirement('chess')).toBeUndefined();
    expect(requirement('broken')).toBeUndefined();
    expect(requirement('wrong')).toBeUndefined();
    expect(requirement('no-such-folder')).toBeUndefined();
  });

  it('the module the build aliases in answers `undefined` for a starter that declares nothing — synchronously, loading no script', () => {
    // The fixture index (vitest.config.ts): chess declares nothing; weather's manifest is
    // not a requirement. Both must answer `undefined` synchronously, and no script may load.
    // This proves the seat EXISTS and fails soft — not that it reads the index: every answer
    // here is `undefined`, so `requirement: () => undefined` would pass it. The positive half
    // (the real module over manifests that parse) is starterSourceRequirement.test.ts.
    const source = starterSource();
    expect(source.appFolders()).toEqual(['chess', 'weather']);
    expect(source.requirement('chess')).toBeUndefined();
    expect(source.requirement('weather')).toBeUndefined();
    expect(document.head.querySelectorAll('script')).toHaveLength(0);
  });

  it('under an artifact every declared starter is blocked at first paint, each for its own reason', () => {
    const requirement = requirementsOf(index);
    const offers = offersOf(createHostPlatform(probe('artifact'), wasm));
    const titles = Object.fromEntries(
      Object.keys(index.starters).map((folder) => {
        const verdict = availabilityOf(needsOfRequirement(requirement(folder)), offers);
        return [folder, verdict.ok ? 'ok' : verdict.blockers[0]!.title];
      }),
    );
    expect(titles).toEqual({ broken: 'ok', chess: 'ok', hue: 'needs your home network', weather: 'needs live connections', wrong: 'ok' });
  });
});
