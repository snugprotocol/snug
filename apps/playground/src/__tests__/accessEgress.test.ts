// accessEgress.test.ts — TASK-20261010-cross-app-access AC15 (ADR-0075 §8): "where Budget can
// send what it reads" is DERIVED, never written, and complete.
//
// THE BRAIN PIN. `readerAdapterKind(db, appId)` must name the brain the app's transport would
// actually route the next turn to. A parallel re-derivation would lie exactly where it
// matters (the 2026-08-26 lesson behind `adapterKindFor`), so this file does not compare it
// with a hand-written expectation alone: every arm drives the REAL `resolveAppTransport` →
// `createDirectAppTransport` send path with `createTurnAdapter` replaced by a recorder, and
// pins `readerAdapterKind` equal to `adapterKindFor(routeOf(<the config the transport
// built>))` over the same stores — including the keyless pin that silently routes to the
// demo brain (*key missing*), the `byok && provider !== 'mock'` guard on the per-app pin, and
// the subscription short-circuit (recorded at `createHttpTransport`, which a direct route
// never reaches). Key presence is read from the FILE's secret rows — the rows the send path
// reads — never the synchronous presence store, which can be stale (a row below pins it).
//
// THE CONNECTION LINES run on a real memory UserDb (installTestUserDb) with declared,
// approved and revoked rows and the WhatsApp helper's symbolic host.
//
// TASK-20261010-host-broker PR-2 (AC14; D-PR2-12) — THE CHAT DOOR'S DISCLOSURE. The chat beside
// an ATTACHED app routes identically to the app transport (measured at PR-2 Gate 2), and the
// chooser's memo in `useBuilderChat.ts` is NOT rewired — so `chatBrainRoute(db, appId)` is
// pinned, arm by arm, equal to the config the REAL `createDirectBuilder` send path hands
// `createTurnAdapter` (the same recorder as the transport pin above), with the memo's arm
// choice for an attached app mirrored in `chatBuilderForAttachedApp` (useBuilderChat.ts — the
// webllm, demo and host arms, then subscription → `createServerBuilder`, else
// `createDirectBuilder` with the app's id and no fresh pick). `chatDoorOpen(route)` is open
// only for a keyed BYOK or a local route; the sheet's `chat` line sits right after the brain
// line for an owned reader exactly where the door opens; the `away` line names the reader's
// scheduled *ask <Reader>'s AI*. RED until `chatBrainRoute`, `chatDoorOpen`, `EGRESS.chat` and
// the amended `EGRESS.away` land.
import { LOCAL_DEFAULT_BASE_URL } from '@snugprotocol/adapters';
import { SIDECAR_SYMBOLIC_HOST } from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TurnAdapterConfig } from '../agent/adapter.js';
import type { Brain } from '../state/webllm.js';
import { installTestUserDb } from './userdbTestHelper.js';

const h = vi.hoisted(() => ({
  brain: { kind: 'settings' } as { kind: string } & Record<string, unknown>,
  connectionsAllowed: true,
  routes: [] as Array<{ kind: 'direct'; config: unknown } | { kind: 'server' }>,
}));

vi.mock('../state/webllm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/webllm.js')>();
  return { ...actual, currentBrain: () => h.brain as unknown as Brain };
});

vi.mock('../platform/platform.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/platform.js')>();
  return {
    ...actual,
    allows: (surface: Parameters<typeof actual.allows>[0]) => (surface === 'connections' ? h.connectionsAllowed : actual.allows(surface)),
  };
});

vi.mock('../agent/adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/adapter.js')>();
  return {
    ...actual,
    createTurnAdapter: (config: unknown) => {
      h.routes.push({ kind: 'direct', config });
      return { complete: async () => ({ ok: false as const, code: 'TEST_STOP', message: 'recorded', retryable: false }) };
    },
  };
});

vi.mock('@snugprotocol/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@snugprotocol/adapters')>();
  return {
    ...actual,
    createHttpTransport: () => ({
      send: async () => {
        h.routes.push({ kind: 'server' });
        return { ok: false as const, code: 'TEST_STOP', message: 'recorded', retryable: false };
      },
    }),
  };
});

// Imported AFTER the mocks are declared (vitest hoists vi.mock; these bind to the mocked graph).
import { adapterKindFor, routeOf } from '../agent/adapter.js';
import { resolveAppTransport } from '../agent/transport.js';
import { chatBrainRoute, chatDoorOpen, egressFor, readerAdapterKind, type EgressLine } from '../access/egress.js';
import { EGRESS } from '../access/copy.js';
import type { ArtifactSink } from '../agent/artifactSink.js';
import { createDirectBuilder, createServerBuilder, type BuilderAgent } from '../agent/builder.js';
import { appModelStore, appProviderStore, setAppPin } from '../state/appModel.js';
import {
  byokKeyPresenceStore,
  endpointsNeedConfirmStore,
  localUrlStore,
  modeStore,
  providerChoiceStore,
  providerStore,
  setByokKey,
} from '../state/mode.js';

const APP = 'budget-app';
const SOURCE_NAME = 'Ledger';

let db: UserDb;

beforeEach(async () => {
  db = await installTestUserDb();
  db.installApp({ appId: APP, displayName: 'Budget', html: '<p>budget</p>' });
  h.brain = { kind: 'settings' };
  h.connectionsAllowed = true;
  h.routes = [];
  modeStore.set('byok');
  providerChoiceStore.set(undefined);
  providerStore.set('mock');
  byokKeyPresenceStore.set({ anthropic: false, openai: false });
  appModelStore.set({});
  appProviderStore.set({});
  endpointsNeedConfirmStore.set(false);
  localUrlStore.set(LOCAL_DEFAULT_BASE_URL);
});

/**
 * The route the app's REAL transport takes for one send, as the kind the brain chip would
 * name it: `subscription` when the server transport was reached, otherwise the ONE
 * derivation over the config `createDirectAppTransport` handed to `createTurnAdapter`.
 */
async function routeTheTransportTakes(): Promise<string> {
  h.routes = [];
  await resolveAppTransport(modeStore.get(), providerStore.get(), undefined, APP).send('{}', { signal: new AbortController().signal });
  expect(h.routes).toHaveLength(1);
  const route = h.routes[0]!;
  if (route.kind === 'server') return 'subscription';
  return adapterKindFor(routeOf(route.config as TurnAdapterConfig));
}

async function pinArm(expected: string): Promise<void> {
  const routed = await routeTheTransportTakes();
  expect(routed).toBe(expected);
  expect(readerAdapterKind(db, APP)).toBe(routed);
}

const brainLine = (): EgressLine => egressFor(db, APP, { unattended: false, sourceName: SOURCE_NAME })[0]!;

describe('readerAdapterKind — pinned equal to the route the app transport takes (AC15)', () => {
  it('byok · anthropic with its key → anthropic', async () => {
    providerStore.set('anthropic');
    await setByokKey('anthropic', 'sk-ant-test');
    await pinArm('anthropic');
    expect(brainLine()).toEqual({ kind: 'brain', text: 'its AI — Claude (Anthropic), with your key' });
  });

  it('byok · openai with its key → openai', async () => {
    providerStore.set('openai');
    await setByokKey('openai', 'sk-test');
    await pinArm('openai');
    expect(brainLine()).toEqual({ kind: 'brain', text: 'its AI — GPT (OpenAI), with your key' });
  });

  it('byok · anthropic WITHOUT a key → the demo brain, said as *(key missing)*', async () => {
    providerStore.set('anthropic');
    await pinArm('demo');
    expect(brainLine()).toEqual({ kind: 'brain', text: 'its AI — Claude (key missing)' });
  });

  it('byok · the mock provider → the demo brain', async () => {
    await pinArm('demo');
    expect(brainLine()).toEqual({ kind: 'brain', text: 'its AI — the demo brain, which answers here and sends nothing out' });
  });

  it('the per-app pin is IGNORED under a mock default — the transport’s `provider !== mock` guard', async () => {
    await setByokKey('anthropic', 'sk-ant-test');
    providerStore.set('mock');
    setAppPin(APP, { provider: 'anthropic', model: 'claude-test' });
    await pinArm('demo');
  });

  it('the per-app pin wins over a keyed default', async () => {
    providerStore.set('anthropic');
    await setByokKey('anthropic', 'sk-ant-test');
    await setByokKey('openai', 'sk-test');
    setAppPin(APP, { provider: 'openai', model: 'gpt-test' });
    await pinArm('openai');
    expect(brainLine().text).toBe('its AI — GPT (OpenAI), with your key');
  });

  it('a per-app pin whose key is gone → the demo brain, said as the PINNED provider’s *(key missing)*', async () => {
    providerStore.set('anthropic');
    await setByokKey('anthropic', 'sk-ant-test');
    setAppPin(APP, { provider: 'openai', model: 'gpt-test' });
    await pinArm('demo');
    expect(brainLine().text).toBe('its AI — GPT (key missing)');
  });

  it('a per-app pin to the mock provider → the demo brain', async () => {
    providerStore.set('anthropic');
    await setByokKey('anthropic', 'sk-ant-test');
    setAppPin(APP, { provider: 'mock', model: 'demo' });
    await pinArm('demo');
  });

  it('local mode → the local model, named by the address the user set', async () => {
    modeStore.set('local');
    await pinArm('local');
    expect(brainLine()).toEqual({ kind: 'brain', text: 'its AI — your own model at localhost:11434' });
    localUrlStore.set('http://10.0.0.7:8080/v1');
    expect(brainLine().text).toBe('its AI — your own model at 10.0.0.7:8080');
  });

  it('local mode never reads a key — a keyless keyed provider is NOT "(key missing)" there', async () => {
    modeStore.set('local');
    providerStore.set('anthropic');
    await pinArm('local');
    expect(brainLine().text).toBe('its AI — your own model at localhost:11434');
  });

  it('subscription mode → the hub, reached through the server transport and never a direct adapter', async () => {
    modeStore.set('subscription');
    await pinArm('subscription');
    expect(brainLine()).toEqual({ kind: 'brain', text: 'its AI — through your Snug hub' });
  });

  it('the webllm brain outranks the configured mode', async () => {
    h.brain = { kind: 'webllm', model: 'test-model' };
    providerStore.set('anthropic');
    await setByokKey('anthropic', 'sk-ant-test');
    await pinArm('webllm');
    expect(brainLine()).toEqual({ kind: 'brain', text: 'its AI — a model running in this tab, on this device' });
  });

  it('the demo brain override outranks a keyed provider', async () => {
    h.brain = { kind: 'demo', reason: 'no-webgpu' };
    providerStore.set('anthropic');
    await setByokKey('anthropic', 'sk-ant-test');
    await pinArm('demo');
    expect(brainLine().text).toBe('its AI — the demo brain, which answers here and sends nothing out');
  });

  it('the platform-pinned host brain outranks everything, named by its label', async () => {
    h.brain = { kind: 'host', label: 'Claude Code on this Mac', streaming: true, tools: false };
    modeStore.set('subscription');
    await pinArm('host');
    expect(brainLine()).toEqual({ kind: 'brain', text: 'its AI — Claude Code on this Mac, the AI this host provides' });
  });

  it('a STALE key-presence store never names a keyed brain the transport will not route to — presence is read from the file', async () => {
    providerStore.set('anthropic');
    // The presence store says a key exists; the file holds none (no setByokKey) — the send path reads the file.
    byokKeyPresenceStore.set({ anthropic: true, openai: false });
    await pinArm('demo');
    expect(brainLine()).toEqual({ kind: 'brain', text: 'its AI — Claude (key missing)' });
  });

  it('every store is read at the CALL — a change after one call shows in the next', async () => {
    providerStore.set('anthropic');
    expect(readerAdapterKind(db, APP)).toBe('demo');
    await setByokKey('anthropic', 'sk-ant-test');
    expect(readerAdapterKind(db, APP)).toBe('anthropic');
    modeStore.set('local');
    expect(readerAdapterKind(db, APP)).toBe('local');
  });
});

// ---------------------------------------------------------------------------------------------
// The connection lines, on a real memory UserDb
// ---------------------------------------------------------------------------------------------

function apiKeyRequirement(slot: string, provider: string, hosts: string[]): Parameters<UserDb['putDeclaredConnection']>[2] {
  return {
    slot,
    kind: 'api_key' as const,
    provider: { name: provider },
    fields: [{ key: 'api_key', label: 'API key', type: 'secret' as const }],
    request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
    declaredApiHosts: hosts,
  } as Parameters<UserDb['putDeclaredConnection']>[2];
}

function seedConnections(): void {
  db.putDeclaredConnection(APP, 'orbit', apiKeyRequirement('orbit', 'Orbit Books', ['api.orbitbooks.com', 'uploads.orbitbooks.com']), 'inference');
  db.approveConnection(APP, 'orbit');
  db.putDeclaredConnection(APP, 'fintrack', apiKeyRequirement('fintrack', 'Fintrack', ['bridge.fintrack.io']), 'inference');
  db.putDeclaredConnection(APP, 'paylane', apiKeyRequirement('paylane', 'Paylane', ['api.paylane.io']), 'inference');
  db.approveConnection(APP, 'paylane');
  db.revokeConnection(APP, 'paylane');
}

const OPEN_URL: EgressLine = { kind: 'open-url', text: 'any link it asks you to open — you see the address first' };
const CLOSING: EgressLine = { kind: 'closing', text: 'the copy is made here, on this device; Ledger keeps a history of its reads' };
const DEMO_BRAIN: EgressLine = { kind: 'brain', text: 'its AI — the demo brain, which answers here and sends nothing out' };

describe('egressFor — every place the reader can send what it reads (AC15)', () => {
  it('names every APPROVED connection by provider, once per host; every DECLARED one as not connected yet; a revoked one not at all', () => {
    seedConnections();
    expect(egressFor(db, APP, { unattended: false, sourceName: SOURCE_NAME })).toEqual([
      DEMO_BRAIN,
      { kind: 'approved', text: 'Orbit Books (api.orbitbooks.com) — a connection you approved' },
      { kind: 'approved', text: 'Orbit Books (uploads.orbitbooks.com) — a connection you approved' },
      { kind: 'declared', text: 'Fintrack (bridge.fintrack.io) — declared, not connected yet' },
      OPEN_URL,
      CLOSING,
    ]);
  });

  it('the revoked row is absent by provider AND by host', () => {
    seedConnections();
    const text = egressFor(db, APP, { unattended: false, sourceName: SOURCE_NAME })
      .map((line) => line.text)
      .join('\n');
    expect(text).not.toContain('Paylane');
    expect(text).not.toContain('api.paylane.io');
  });

  it('the WhatsApp helper’s symbolic host is the helper by name, never the host string', () => {
    db.putDeclaredConnection(APP, 'whatsapp', { slot: 'whatsapp', provider: { name: 'WhatsApp' }, kind: 'linked_device', declaredApiHosts: [SIDECAR_SYMBOLIC_HOST] } as Parameters<UserDb['putDeclaredConnection']>[2], 'starter');
    db.approveConnection(APP, 'whatsapp');
    const lines = egressFor(db, APP, { unattended: false, sourceName: SOURCE_NAME });
    expect(lines).toContainEqual({ kind: 'helper', text: 'the WhatsApp helper on this Mac' });
    expect(lines.map((line) => line.text).join('\n')).not.toContain(SIDECAR_SYMBOLIC_HOST);
  });

  it('a DECLARED helper says it is not connected yet', () => {
    db.putDeclaredConnection(APP, 'whatsapp', { slot: 'whatsapp', provider: { name: 'WhatsApp' }, kind: 'linked_device', declaredApiHosts: [SIDECAR_SYMBOLIC_HOST] } as Parameters<UserDb['putDeclaredConnection']>[2], 'starter');
    expect(egressFor(db, APP, { unattended: false, sourceName: SOURCE_NAME })).toContainEqual({
      kind: 'helper',
      text: 'the WhatsApp helper on this Mac — declared, not connected yet',
    });
  });

  it('ALWAYS carries the open-url line for an owned reader — even with no connections at all', () => {
    expect(egressFor(db, APP, { unattended: false, sourceName: SOURCE_NAME })).toEqual([
      DEMO_BRAIN,
      { kind: 'no-connections', text: 'no connections of its own' },
      OPEN_URL,
      CLOSING,
    ]);
  });

  it('where the app may not reach the network: ONE line "no connections of its own" — the rows are not listed, and "no network" is never said', () => {
    seedConnections();
    h.connectionsAllowed = false;
    const lines = egressFor(db, APP, { unattended: false, sourceName: SOURCE_NAME });
    expect(lines).toEqual([DEMO_BRAIN, { kind: 'no-connections', text: 'no connections of its own' }, OPEN_URL, CLOSING]);
    expect(lines.filter((line) => line.kind === 'no-connections')).toHaveLength(1);
    expect(lines.map((line) => line.text).join('\n')).not.toMatch(/no network/i);
  });

  it('an unowned id (a starter preview) has no open-url line and no connections of its own', () => {
    const lines = egressFor(db, 'starter--weather', { unattended: false, sourceName: SOURCE_NAME });
    expect(lines.map((line) => line.kind)).toEqual(['brain', 'no-connections', 'closing']);
  });

  it('adds the away line when *also while I’m away* is ticked, before the closing sentence', () => {
    const lines = egressFor(db, APP, { unattended: true, sourceName: SOURCE_NAME });
    // PR-2 (D-PR2-12, DS-7): the away line also names the reader's scheduled *ask <Reader>'s AI* — the contract's literal.
    expect(lines.slice(-2)).toEqual([
      { kind: 'away', text: 'also while you’re away — on a schedule it can read and send with no one watching, and so can a scheduled *ask Budget’s AI*' },
      CLOSING,
    ]);
    expect(egressFor(db, APP, { unattended: false, sourceName: SOURCE_NAME }).some((line) => line.kind === 'away')).toBe(false);
  });

  it('closes with the source’s name: the copy is made here, and the source keeps the history', () => {
    const lines = egressFor(db, APP, { unattended: false, sourceName: 'Pantry' });
    expect(lines.at(-1)).toEqual({ kind: 'closing', text: 'the copy is made here, on this device; Pantry keeps a history of its reads' });
  });

  it('never says the data stays on this device under a list of places it can go', () => {
    seedConnections();
    const text = egressFor(db, APP, { unattended: true, sourceName: SOURCE_NAME })
      .map((line) => line.text)
      .join('\n');
    expect(text).not.toMatch(/stays on this device/i);
  });
});

// ---------------------------------------------------------------------------------------------
// TASK-20261010-host-broker PR-2 — the chat door's route and its line (AC14; D-PR2-12)
// ---------------------------------------------------------------------------------------------

function testSink(): ArtifactSink {
  return {
    write: () => Promise.resolve({ id: APP, displayName: 'unused', version: 1 }),
    ensureTargetId: () => Promise.resolve(APP),
  };
}

/** A fetch that records that the hub was reached and answers a refusal (the subscription arm). */
const serverFetch = (): Promise<Response> => {
  h.routes.push({ kind: 'server' });
  return Promise.resolve(new Response(JSON.stringify({ code: 'TEST_STOP', message: 'recorded' }), { status: 500 }));
};

/**
 * The chat agent `useBuilderChat`'s memo builds for a thread ATTACHED to `APP` — mirrored arm for
 * arm (the brain overrides first: webllm, demo, host; then subscription → the server builder;
 * else the direct builder with the app's id — a fresh pick is ignored once an app is attached).
 */
function chatBuilderForAttachedApp(): BuilderAgent {
  const brain = h.brain;
  const mode = modeStore.get();
  const provider = providerStore.get();
  const localUrl = localUrlStore.get();
  const sink = testSink();
  if (brain.kind === 'webllm') return createDirectBuilder({ mode: 'webllm', provider, sink, localUrl });
  if (brain.kind === 'demo') return createDirectBuilder({ mode: 'byok', provider: 'mock', sink, localUrl });
  if (brain.kind === 'host') return createDirectBuilder({ mode: 'host', provider, sink, localUrl, appId: APP });
  if (mode === 'subscription') return createServerBuilder('thread-1', serverFetch);
  return createDirectBuilder({ mode, provider, sink, appId: APP, localUrl });
}

/** What the REAL send path of the chat beside `APP` hands the adapter (or that it reached the hub). */
async function routeTheChatTakes(): Promise<{ kind: 'direct'; config: TurnAdapterConfig } | { kind: 'server' }> {
  h.routes = [];
  await chatBuilderForAttachedApp().send('hello', {}, new AbortController().signal);
  expect(h.routes).toHaveLength(1);
  const route = h.routes[0]!;
  return route.kind === 'server' ? route : { kind: 'direct', config: route.config as TurnAdapterConfig };
}

interface ChatArm {
  name: string;
  setup(): Promise<void>;
  kind: string;
  doorOpen: boolean;
}

/** The SAME arms the transport pin above walks. */
const CHAT_ARMS: readonly ChatArm[] = [
  {
    name: 'byok · anthropic with its key',
    setup: async () => {
      providerStore.set('anthropic');
      await setByokKey('anthropic', 'sk-ant-test');
    },
    kind: 'anthropic',
    doorOpen: true,
  },
  {
    name: 'byok · openai with its key',
    setup: async () => {
      providerStore.set('openai');
      await setByokKey('openai', 'sk-test');
    },
    kind: 'openai',
    doorOpen: true,
  },
  {
    name: 'byok · anthropic WITHOUT a key (key missing → the demo brain)',
    setup: async () => {
      providerStore.set('anthropic');
    },
    kind: 'demo',
    doorOpen: false,
  },
  { name: 'byok · the mock provider', setup: async () => {}, kind: 'demo', doorOpen: false },
  {
    name: 'the per-app pin is IGNORED under a mock default',
    setup: async () => {
      await setByokKey('anthropic', 'sk-ant-test');
      providerStore.set('mock');
      setAppPin(APP, { provider: 'anthropic', model: 'claude-test' });
    },
    kind: 'demo',
    doorOpen: false,
  },
  {
    name: 'the per-app pin wins over a keyed default',
    setup: async () => {
      providerStore.set('anthropic');
      await setByokKey('anthropic', 'sk-ant-test');
      await setByokKey('openai', 'sk-test');
      setAppPin(APP, { provider: 'openai', model: 'gpt-test' });
    },
    kind: 'openai',
    doorOpen: true,
  },
  {
    name: 'a per-app pin whose key is gone',
    setup: async () => {
      providerStore.set('anthropic');
      await setByokKey('anthropic', 'sk-ant-test');
      setAppPin(APP, { provider: 'openai', model: 'gpt-test' });
    },
    kind: 'demo',
    doorOpen: false,
  },
  {
    name: 'a per-app pin to the mock provider',
    setup: async () => {
      providerStore.set('anthropic');
      await setByokKey('anthropic', 'sk-ant-test');
      setAppPin(APP, { provider: 'mock', model: 'demo' });
    },
    kind: 'demo',
    doorOpen: false,
  },
  {
    name: 'local mode',
    setup: async () => {
      modeStore.set('local');
    },
    kind: 'local',
    doorOpen: true,
  },
  {
    name: 'local mode with a keyless keyed provider',
    setup: async () => {
      modeStore.set('local');
      providerStore.set('anthropic');
    },
    kind: 'local',
    doorOpen: true,
  },
  {
    name: 'subscription mode',
    setup: async () => {
      modeStore.set('subscription');
    },
    kind: 'subscription',
    doorOpen: false,
  },
  {
    name: 'the webllm brain',
    setup: async () => {
      h.brain = { kind: 'webllm', model: 'test-model' };
      providerStore.set('anthropic');
      await setByokKey('anthropic', 'sk-ant-test');
    },
    kind: 'webllm',
    doorOpen: false,
  },
  {
    name: 'the demo brain override',
    setup: async () => {
      h.brain = { kind: 'demo', reason: 'no-webgpu' };
      providerStore.set('anthropic');
      await setByokKey('anthropic', 'sk-ant-test');
    },
    kind: 'demo',
    doorOpen: false,
  },
  {
    name: 'the platform-pinned host brain',
    setup: async () => {
      h.brain = { kind: 'host', label: 'Claude Code on this Mac', streaming: true, tools: false };
      modeStore.set('subscription');
    },
    kind: 'host',
    doorOpen: false,
  },
  {
    name: 'a STALE key-presence store (the file holds no key)',
    setup: async () => {
      providerStore.set('anthropic');
      byokKeyPresenceStore.set({ anthropic: true, openai: false });
    },
    kind: 'demo',
    doorOpen: false,
  },
];

const isKeyedProvider = (provider: string): boolean => provider === 'anthropic' || provider === 'openai';

describe('chatBrainRoute — pinned equal to the config the REAL createDirectBuilder send path builds for an attached app (AC14)', () => {
  it.each(CHAT_ARMS)('$name', async (arm) => {
    await arm.setup();
    const taken = await routeTheChatTakes();
    const route = chatBrainRoute(db, APP);
    if (taken.kind === 'server') {
      expect(route.kind).toBe('subscription');
    } else {
      const { config } = taken;
      expect(route.kind).toBe(adapterKindFor(routeOf(config)));
      expect(route.provider).toBe(config.provider);
      expect(route.keyMissing).toBe(config.mode === 'byok' && isKeyedProvider(config.provider) && config.key === undefined);
    }
    expect(route.kind).toBe(arm.kind);
    // One derivation: the chat beside the app and the app's own transport name the same brain.
    expect(route.kind).toBe(readerAdapterKind(db, APP));
  });
});

describe('chatDoorOpen — the chat door exists only where the data lane runs: a keyed BYOK or a local route (D-PR2-10/12)', () => {
  it.each(CHAT_ARMS)('$name → open: $doorOpen', async (arm) => {
    await arm.setup();
    expect(chatDoorOpen(chatBrainRoute(db, APP))).toBe(arm.doorOpen);
  });
});

describe('egressFor — the chat line (AC14; D-PR2-12)', () => {
  it.each(CHAT_ARMS)('$name → the chat line right after the brain line exactly when the door is open', async (arm) => {
    await arm.setup();
    const lines = egressFor(db, APP, { unattended: false, sourceName: SOURCE_NAME });
    const chatLines = lines.filter((line) => (line.kind as string) === 'chat');
    if (arm.doorOpen) {
      expect(chatLines).toEqual([{ kind: 'chat', text: EGRESS.chat('Budget') }]);
      expect(lines[0]?.kind).toBe('brain');
      expect(lines[1]).toEqual({ kind: 'chat', text: EGRESS.chat('Budget') });
    } else {
      expect(chatLines).toEqual([]);
    }
  });

  it('the chat line names the reader and its data: the chat beside Budget — the same AI', async () => {
    providerStore.set('anthropic');
    await setByokKey('anthropic', 'sk-ant-test');
    expect(egressFor(db, APP, { unattended: false, sourceName: SOURCE_NAME })[1]).toEqual({
      kind: 'chat',
      text: 'the chat beside Budget — the same AI — whenever you ask it about Budget’s data',
    });
  });

  it('an UNOWNED reader (a starter preview) has no chat line even under a keyed brain', async () => {
    providerStore.set('anthropic');
    await setByokKey('anthropic', 'sk-ant-test');
    const lines = egressFor(db, 'starter--weather', { unattended: false, sourceName: SOURCE_NAME });
    expect(lines.map((line) => line.kind)).toEqual(['brain', 'no-connections', 'closing']);
  });

  it('under a keyed brain with *also while I’m away* ticked: brain · chat · … · away · closing, the away line naming the reader', async () => {
    providerStore.set('anthropic');
    await setByokKey('anthropic', 'sk-ant-test');
    const lines = egressFor(db, APP, { unattended: true, sourceName: SOURCE_NAME });
    expect(lines.map((line) => line.kind)).toEqual(['brain', 'chat', 'no-connections', 'open-url', 'away', 'closing']);
    expect(lines.at(-2)).toEqual({ kind: 'away', text: EGRESS.away('Budget') });
  });
});
