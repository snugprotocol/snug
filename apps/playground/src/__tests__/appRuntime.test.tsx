// appRuntime.test.tsx — TASK-20261009-scheduling-framework A1 (ADR-0074 §3, §5; feasibility F5):
// the app's runtime composition — its OWN transport, the value-blind net handler bound to the
// HOST-assigned id, the frame's capability bindings — LIFTED out of `RunView` into
// `run/appRuntime.ts` so the scheduler's hidden frame composes the same seams the visible one
// does, with ONE difference it may inject: the confirm gate.
//
// `registerAppHost` is deliberately NOT part of the lift (it stays RunView's — the wizard's
// seam, and the hidden frame must never register as the live host); the source pin below reads
// RunView to prove the lift is consumed rather than copied.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NET_ERROR_CODES } from '@snugprotocol/protocol';
import type { AgentTransport } from '@snugprotocol/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

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
  transportSpy.mockReset();
  transportSpy.mockReturnValue(probe);
  allowsSpy.mockReset();
  allowsSpy.mockImplementation(() => true);
  db = await installTestUserDb();
});

afterEach(() => {
  __resetNetStateForTests();
});

describe('composeAppRuntime — the seams RunView used to compose inline', () => {
  it('the transport is the app’s OWN transport: built for the app id with the mode, provider and the inspector seams', () => {
    const onLlmEvent = (): void => {};
    const onTurnStart = (): void => {};
    const runtime = composeAppRuntime({ appId: 'app-1', mode: 'byok', provider: 'mock', onLlmEvent, onTurnStart, driver: db.driver });
    expect(runtime.transport).toBe(probe);
    expect(transportSpy).toHaveBeenCalledTimes(1);
    expect(transportSpy).toHaveBeenCalledWith('byok', 'mock', onLlmEvent, 'app-1', onTurnStart);
  });

  it('an owned app binds a value-blind net handler to ITS OWN id (host-assigned), and the frame props carry db + net together', () => {
    const runtime = composeAppRuntime({ appId: 'app-1', mode: 'byok', provider: 'mock', driver: db.driver });
    expect(runtime.netHandler).toBeDefined();
    expect(runtime.netAppId).toBe('app-1');
    expect(runtime.frameProps).toEqual({ db: db.driver, dbNamespace: 'app-1', net: runtime.netHandler, netAppId: 'app-1' });
  });

  it('an UNOWNED id (a starter browse, a shared preview) gets no net handler — the frame props carry the db binding only', () => {
    for (const appId of ['starter--chess', 'shared--0b6e5a1c-8d5e-4f13-9a2b-7c1d2e3f4a5b']) {
      const runtime = composeAppRuntime({ appId, mode: 'byok', provider: 'mock', driver: db.driver });
      expect(runtime.netHandler, appId).toBeUndefined();
      expect(runtime.netAppId, appId).toBeUndefined();
      expect(runtime.frameProps, appId).toEqual({ db: db.driver, dbNamespace: appId });
    }
  });

  it('a host that allows no connections gets no handler STRUCTURALLY (host-ready.net is then false, not a flag the app must trust)', () => {
    allowsSpy.mockImplementation((surface) => surface !== 'connections');
    const runtime = composeAppRuntime({ appId: 'app-1', mode: 'byok', provider: 'mock', driver: db.driver });
    expect(runtime.netHandler).toBeUndefined();
    expect(allowsSpy).toHaveBeenCalledWith('connections');
  });

  it('threads `onNetError` with the HOST-assigned id: a net refusal reports (appId, code), never anything the app claimed', async () => {
    const appId = seedConnectedApp();
    const errors: Array<[string, string]> = [];
    const runtime = composeAppRuntime({ appId, mode: 'byok', provider: 'mock', driver: db.driver, onNetError: (id, code) => errors.push([id, code]) });
    const result = await runtime.netHandler!.handle(appId, { ...post('https://not-declared.example.net/x'), method: 'GET' as const, body: undefined } as never);
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
      confirmGate: gate,
      fetchImpl: async (url) => {
        fetched.push(url);
        return new Response('{}', { status: 200 });
      },
    });
    const result = await runtime.netHandler!.handle(appId, post());
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
    expect(fetched).toEqual([]);
    expect(netConfirmStore.get()).toBeNull();
    expect(gate.refused).toEqual([{ host: 'api.example.com', method: 'POST' }]);
  });

  it('without `confirmGate` the page’s ORDINARY gate answers: the same POST parks a confirm for the user (the visible frame is unchanged)', async () => {
    const appId = seedConnectedApp();
    const runtime = composeAppRuntime({ appId, mode: 'byok', provider: 'mock', driver: db.driver, fetchImpl: async () => new Response('{}', { status: 200 }) });
    const pending = runtime.netHandler!.handle(appId, post());
    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    netConfirmStore.get()!.resolve({ granted: false });
    expect(await pending).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
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

  it('`registerAppHost` stays RunView’s — the wizard’s seam, never the runtime’s (the hidden frame must never register as the live host)', () => {
    expect(runView).toMatch(/registerAppHost\(/);
    expect(codeOf('../run/appRuntime.ts')).not.toMatch(/registerAppHost/);
  });
});
