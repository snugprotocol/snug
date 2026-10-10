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
import { egressFor, readerAdapterKind, type EgressLine } from '../access/egress.js';
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
    expect(lines.slice(-2)).toEqual([{ kind: 'away', text: 'also while you’re away — on a schedule it can read and send with no one watching' }, CLOSING]);
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
