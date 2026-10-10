// appRuntime.test.tsx — TASK-20261009-scheduling-framework A1 (ADR-0074 §3, §5; feasibility F5):
// the app's runtime composition — its OWN transport, the value-blind net handler bound to the
// HOST-assigned id, the frame's capability bindings — LIFTED out of `RunView` into
// `run/appRuntime.ts` so the scheduler's hidden frame composes the same seams the visible one
// does, with ONE difference it may inject: the confirm gate.
//
// TASK-20261010-cross-app-access AC20 (ADR-0075): `attended` is REQUIRED — the visible frame says
// `true`, the scheduler's hidden frame `false`, and nothing defaults it — and the composition binds
// the THIRD pair, the access handler and its host-assigned id, only for an owned app where the
// host allows access (a starter browse or a shared preview never gets it).
//
// `registerAppHost` is deliberately NOT part of the lift (it stays RunView's — the wizard's
// seam, and the hidden frame must never register as the live host); the source pin below reads
// RunView to prove the lift is consumed rather than copied.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ACCESS_ERROR_CODES, FRAME_TYPES, NET_ERROR_CODES, PROTOCOL_VERSION, type AccessRequestFrame } from '@snugprotocol/protocol';
import type { AccessHandler, AgentTransport, NetHandler } from '@snugprotocol/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { collectSources } from '../access/consent.js';
import { __setAccessDepsForTests, createGrantFromDecision, readerGeneration, resetAccessSession } from '../access/grants.js';
import type { AppRuntime } from '../run/appRuntime.js';
import { createScheduledConfirmGate } from '../schedule/scheduledConfirmGate.js';
import { __resetNetStateForTests, netConfirmStore } from '../state/net.js';
import { installTestUserDb } from './userdbTestHelper.js';

const transportSpy = vi.fn<(...args: unknown[]) => AgentTransport>();
vi.mock('../agent/transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/transport.js')>();
  return {
    ...actual,
    createAppTransport: (...args: unknown[]) => transportSpy(...args),
  };
});

const allowsSpy = vi.fn<(surface: string) => boolean>(() => true);
vi.mock('../platform/platform.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/platform.js')>();
  return { ...actual, allows: (surface: string) => allowsSpy(surface) };
});

// The access handler factory, spied THROUGH (the real handler is built, so its behaviour is pinned too).
const accessFactorySpy = vi.fn();
vi.mock('../access/accessHandler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../access/accessHandler.js')>();
  return {
    ...actual,
    createAccessHandlerFor: (...args: Parameters<typeof actual.createAccessHandlerFor>) => {
      accessFactorySpy(...args);
      return actual.createAccessHandlerFor(...args);
    },
  };
});

const { composeAppRuntime } = await import('../run/appRuntime.js');

const SLOT = 'example';
const requirement = {
  slot: SLOT,
  kind: 'api_key' as const,
  provider: { name: 'Example' },
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' as const }],
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: ['api.example.com'],
};

let db: UserDb;
const probe: AgentTransport = { send: async () => ({ ok: true, text: '{}' }) };

/** An owned app with an APPROVED connection, so a request reaches the executor's gate. */
function seedConnectedApp(): string {
  const app = db.installApp({ displayName: 'Net App', html: '<p>net</p>' });
  db.setSecret(`auth:${app.appId}:${SLOT}:api_key`, 'stored-key-abc123');
  db.putDeclaredConnection(app.appId, SLOT, requirement, 'inference');
  db.approveConnection(app.appId, SLOT);
  return app.appId;
}

const post = (url = 'https://api.example.com/v1/items') => ({
  v: 1 as const,
  type: 'snug:net-request' as const,
  requestId: 'r1',
  instanceId: 'ins-1',
  url,
  method: 'POST' as const,
  body: '{}',
});

beforeEach(async () => {
  __resetNetStateForTests();
  resetAccessSession();
  accessFactorySpy.mockReset();
  transportSpy.mockReset();
  transportSpy.mockReturnValue(probe);
  allowsSpy.mockReset();
  allowsSpy.mockImplementation(() => true);
  db = await installTestUserDb();
});

afterEach(() => {
  __resetNetStateForTests();
});

/** The net handler an OWNED app's runtime binds — the frame props are its one home (M5). */
const netOf = (runtime: AppRuntime): NetHandler => {
  const net = runtime.frameProps.net;
  if (net === undefined) throw new Error('this runtime binds no net handler');
  return net;
};

describe('composeAppRuntime — the seams RunView used to compose inline', () => {
  it('the transport is the app’s OWN transport: built for the app id with the mode, provider and the inspector seams', () => {
    const onLlmEvent = (): void => {};
    const onTurnStart = (): void => {};
    const runtime = composeAppRuntime({ appId: 'app-1', mode: 'byok', provider: 'mock', onLlmEvent, onTurnStart, driver: db.driver, attended: true, generation: 0 });
    expect(runtime.transport).toBe(probe);
    expect(transportSpy).toHaveBeenCalledTimes(1);
    expect(transportSpy).toHaveBeenCalledWith('byok', 'mock', onLlmEvent, 'app-1', onTurnStart);
  });

  it('an owned app binds a value-blind net handler to ITS OWN id (host-assigned), and the frame props carry db + net together', () => {
    const runtime = composeAppRuntime({ appId: 'app-1', mode: 'byok', provider: 'mock', driver: db.driver, attended: true, generation: 0 });
    expect(runtime.frameProps.net).toBeDefined();
    expect(runtime.frameProps.netAppId).toBe('app-1');
    expect(runtime.frameProps).toEqual({
      db: db.driver,
      dbNamespace: 'app-1',
      net: runtime.frameProps.net,
      netAppId: 'app-1',
      access: runtime.frameProps.access,
      accessAppId: 'app-1',
    });
    // M5: the handler and its id live in the frame props ONLY — nothing is duplicated beside them.
    expect(Object.keys(runtime).sort()).toEqual(['frameProps', 'transport']);
  });

  it('an UNOWNED id (a starter browse, a shared preview) gets no net handler — the frame props carry the db binding only', () => {
    for (const appId of ['starter--chess', 'shared--0b6e5a1c-8d5e-4f13-9a2b-7c1d2e3f4a5b']) {
      const runtime = composeAppRuntime({ appId, mode: 'byok', provider: 'mock', driver: db.driver, attended: true, generation: 0 });
      expect(runtime.frameProps.net, appId).toBeUndefined();
      expect(runtime.frameProps.netAppId, appId).toBeUndefined();
      expect(runtime.frameProps, appId).toEqual({ db: db.driver, dbNamespace: appId });
    }
  });

  it('a host that allows no connections gets no handler STRUCTURALLY (host-ready.net is then false, not a flag the app must trust)', () => {
    allowsSpy.mockImplementation((surface) => surface !== 'connections');
    const runtime = composeAppRuntime({ appId: 'app-1', mode: 'byok', provider: 'mock', driver: db.driver, attended: true, generation: 0 });
    expect(runtime.frameProps.net).toBeUndefined();
    expect(allowsSpy).toHaveBeenCalledWith('connections');
  });

  it('threads `onNetError` with the HOST-assigned id: a net refusal reports (appId, code), never anything the app claimed', async () => {
    const appId = seedConnectedApp();
    const errors: Array<[string, string]> = [];
    const runtime = composeAppRuntime({ appId, mode: 'byok', provider: 'mock', driver: db.driver, attended: true, generation: 0, onNetError: (id, code) => errors.push([id, code]) });
    const result = await netOf(runtime).handle(appId, { ...post('https://not-declared.example.net/x'), method: 'GET' as const, body: undefined } as never);
    expect(result.ok).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]![0]).toBe(appId);
    expect(typeof errors[0]![1]).toBe('string');
  });

  it('threads `confirmGate`: a mutating call through a runtime composed with the REFUSING gate answers NET_CONFIRM_DENIED and parks NO confirm', async () => {
    const appId = seedConnectedApp();
    const fetched: string[] = [];
    const gate = createScheduledConfirmGate();
    const runtime = composeAppRuntime({
      appId,
      mode: 'byok',
      provider: 'mock',
      driver: db.driver,
      attended: false,
      confirmGate: gate,
      fetchImpl: async (url) => {
        fetched.push(url);
        return new Response('{}', { status: 200 });
      },
    });
    const result = await netOf(runtime).handle(appId, post());
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
    expect(fetched).toEqual([]);
    expect(netConfirmStore.get()).toBeNull();
    expect(gate.refused).toEqual([{ host: 'api.example.com', method: 'POST' }]);
  });

  it('without `confirmGate` the page’s ORDINARY gate answers: the same POST parks a confirm for the user (the visible frame is unchanged)', async () => {
    const appId = seedConnectedApp();
    const runtime = composeAppRuntime({ appId, mode: 'byok', provider: 'mock', driver: db.driver, attended: true, generation: 0, fetchImpl: async () => new Response('{}', { status: 200 }) });
    const pending = netOf(runtime).handle(appId, post());
    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    netConfirmStore.get()!.resolve({ granted: false });
    expect(await pending).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
  });
});

/** The access handler an OWNED app's runtime binds — the third pair's one home. */
const accessOf = (runtime: AppRuntime): AccessHandler => {
  const access = runtime.frameProps.access;
  if (access === undefined) throw new Error('this runtime binds no access handler');
  return access;
};

const askToRead = (): AccessRequestFrame => ({
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.accessRequest,
  requestId: 'a1',
  instanceId: 'ins-1',
  op: 'request',
  purpose: 'to show spending by category',
});

describe('composeAppRuntime — the access pair (TASK-20261010-cross-app-access AC20)', () => {
  it('`attended` is REQUIRED: a composition that does not say whether anyone is looking does not type-check', () => {
    // Never called — the pin is the compiler's. A default here would let the hidden frame inherit the visible one's answer.
    const unsaid = (): AppRuntime =>
      // @ts-expect-error — `attended` is required on ComposeAppRuntimeOptions (no default)
      composeAppRuntime({ appId: 'app-1', mode: 'byok', provider: 'mock', driver: db.driver });
    expect(typeof unsaid).toBe('function');
  });

  it('an owned app on a host that allows access binds the handler to ITS OWN id (host-assigned), checking `allows(\'access\')`', () => {
    const runtime = composeAppRuntime({ appId: 'app-1', mode: 'byok', provider: 'mock', driver: db.driver, attended: true, generation: 4 });
    expect(runtime.frameProps.access).toBeDefined();
    expect(runtime.frameProps.accessAppId).toBe('app-1');
    expect(allowsSpy).toHaveBeenCalledWith('access');
    expect(accessFactorySpy).toHaveBeenCalledTimes(1);
    expect(accessFactorySpy).toHaveBeenCalledWith('app-1', { attended: true, generation: 4 });
  });

  it('a starter browse and a shared preview NEVER get the pair — whatever the host allows', () => {
    for (const appId of ['starter--chess', 'shared--0b6e5a1c-8d5e-4f13-9a2b-7c1d2e3f4a5b']) {
      const runtime = composeAppRuntime({ appId, mode: 'byok', provider: 'mock', driver: db.driver, attended: true, generation: 0 });
      expect(runtime.frameProps.access, appId).toBeUndefined();
      expect(runtime.frameProps.accessAppId, appId).toBeUndefined();
      expect('access' in runtime.frameProps, appId).toBe(false);
    }
    expect(accessFactorySpy).not.toHaveBeenCalled();
  });

  it('a host that allows no access gets no pair STRUCTURALLY (host-ready.access is then false) — the net pair is unaffected', () => {
    allowsSpy.mockImplementation((surface) => surface !== 'access');
    const runtime = composeAppRuntime({ appId: 'app-1', mode: 'byok', provider: 'mock', driver: db.driver, attended: true, generation: 0 });
    expect(runtime.frameProps).toEqual({ db: db.driver, dbNamespace: 'app-1', net: runtime.frameProps.net, netAppId: 'app-1' });
    expect(runtime.frameProps.net).toBeDefined();
    expect(accessFactorySpy).not.toHaveBeenCalled();
  });

  it('…and a host that allows access but no connections binds access WITHOUT net — the two pairs are independent', () => {
    allowsSpy.mockImplementation((surface) => surface !== 'connections');
    const runtime = composeAppRuntime({ appId: 'app-1', mode: 'byok', provider: 'mock', driver: db.driver, attended: true, generation: 0 });
    expect(runtime.frameProps).toEqual({ db: db.driver, dbNamespace: 'app-1', access: runtime.frameProps.access, accessAppId: 'app-1' });
  });

  it('a VISIBLE frame must say its generation, and the hidden frame has none — nothing is defaulted (a default 0 would collide with the first epoch)', () => {
    // Never called — the pins are the compiler's.
    const noGeneration = (): AppRuntime =>
      // @ts-expect-error — an attended composition must carry the frame generation it keys on
      composeAppRuntime({ appId: 'app-1', mode: 'byok', provider: 'mock', driver: db.driver, attended: true });
    const hiddenWithGeneration = (): AppRuntime =>
      // @ts-expect-error — the hidden frame has no generation: it owns no session access
      composeAppRuntime({ appId: 'app-1', mode: 'byok', provider: 'mock', driver: db.driver, attended: false, generation: 0 });
    expect([typeof noGeneration, typeof hiddenWithGeneration]).toEqual(['function', 'function']);
  });

  it('the hidden frame (attended: false) composes the handler with NO generation and notes NO reader generation', () => {
    composeAppRuntime({ appId: 'app-1', mode: 'byok', provider: 'mock', driver: db.driver, attended: false });
    expect(accessFactorySpy).toHaveBeenCalledWith('app-1', { attended: false });
    expect(readerGeneration('app-1')).toBeUndefined();
  });

  it('ONE rule at every epoch: a hidden frame never reads (or lists) a session grant made in the open view — at epoch 0, where a defaulted 0 would have matched, and at epoch 1', async () => {
    __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => Date.parse('2026-10-10T09:00:00.000Z') });
    try {
      const budget = db.installApp({ displayName: 'Budget', html: '<p>b</p>' }).appId;
      const ledger = db.installApp({ displayName: 'Ledger', html: '<p>l</p>' }).appId;
      await db.applyAppDdl(ledger, ['CREATE TABLE transactions (amount INTEGER)']);
      for (const epoch of [0, 1]) {
        resetAccessSession();
        composeAppRuntime({ appId: budget, mode: 'byok', provider: 'mock', driver: db.driver, attended: true, generation: epoch });
        const source = (await collectSources(db, budget)).rest.find((candidate) => candidate.appId === ledger)!;
        const session = await createGrantFromDecision(db, {
          readerAppId: budget,
          source,
          tables: ['transactions'],
          duration: 'session',
          unattended: true,
          purpose: 'to show spending',
          provenance: 'app',
          generation: epoch,
          now: Date.parse('2026-10-10T09:00:00.000Z'),
        });
        const hidden = accessOf(composeAppRuntime({ appId: budget, mode: 'byok', provider: 'mock', driver: db.driver, attended: false }));
        const read = await hidden.handle(budget, { v: PROTOCOL_VERSION, type: FRAME_TYPES.accessRequest, requestId: `q${epoch}`, instanceId: 'h', op: 'query', grantId: session.id, sql: 'SELECT 1' });
        expect(read, `epoch ${epoch}`).toMatchObject({ ok: false, code: ACCESS_ERROR_CODES.ACCESS_NOT_GRANTED });
        const listed = await hidden.handle(budget, { v: PROTOCOL_VERSION, type: FRAME_TYPES.accessRequest, requestId: `l${epoch}`, instanceId: 'h', op: 'list' });
        expect(listed, `epoch ${epoch}`).toEqual({ ok: true, op: 'list', grants: [] });
      }
    } finally {
      __setAccessDepsForTests();
    }
  });

  it('the visible frame (attended: true) notes its generation — a session grant made from host chrome binds to it', () => {
    composeAppRuntime({ appId: 'app-1', mode: 'byok', provider: 'mock', driver: db.driver, attended: true, generation: 7 });
    expect(readerGeneration('app-1')).toBe(7);
  });

  it('`attended` is THREADED, not assumed: the same owned app asks — a hidden frame is told nobody is there, a visible one reaches the candidates', async () => {
    const appId = db.installApp({ displayName: 'Budget', html: '<p>budget</p>' }).appId;
    const hidden = await accessOf(composeAppRuntime({ appId, mode: 'byok', provider: 'mock', driver: db.driver, attended: false })).handle(appId, askToRead());
    expect(hidden).toMatchObject({ ok: false, code: ACCESS_ERROR_CODES.ACCESS_UNATTENDED, retryable: true });
    // No other app holds data, so the visible frame's ask ends at "nothing to offer" — past the unattended refusal.
    const visible = await accessOf(composeAppRuntime({ appId, mode: 'byok', provider: 'mock', driver: db.driver, attended: true, generation: 0 })).handle(appId, askToRead());
    expect(visible).toMatchObject({ ok: false, code: ACCESS_ERROR_CODES.ACCESS_NO_SOURCES });
  });
});

describe('the lift is CONSUMED, not copied (A1: RunView reads the runtime from one place)', () => {
  /** Comments out, code kept — a pin on what a module DOES, not on what its header says. */
  const codeOf = (file: string): string =>
    readFileSync(path.resolve(__dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const runView = codeOf('../run/RunView.tsx');

  it('RunView composes its frame through `composeAppRuntime` and no longer calls the transport or net factories itself', () => {
    expect(runView).toMatch(/composeAppRuntime\(/);
    expect(runView).not.toMatch(/\bcreateAppTransport\(/);
    expect(runView).not.toMatch(/\bcreateNetHandlerFor\(/);
  });

  it('RunView composes the VISIBLE frame: `attended: true` and the frame generation it keys its remounts on', () => {
    expect(runView).toMatch(/composeAppRuntime\(\{[^}]*\battended: true\b/);
    expect(runView).toMatch(/composeAppRuntime\(\{[^}]*\bgeneration: frameEpoch\b/);
  });

  it('`registerAppHost` stays RunView’s — the wizard’s seam, never the runtime’s (the hidden frame must never register as the live host)', () => {
    expect(runView).toMatch(/registerAppHost\(/);
    expect(codeOf('../run/appRuntime.ts')).not.toMatch(/registerAppHost/);
  });
});
