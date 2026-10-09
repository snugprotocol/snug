// scheduledGate.test.ts — TASK-20261009-scheduling-framework A5 (ADR-0074 §6; security F2,
// F16): the STANDALONE refusing gate a scheduled run's net handler carries, and the two seams
// `state/net.ts` gains for it — `confirmGate?` threaded into the ONE deps assembly, and
// `onNetCall` counting every call against the day's network ceiling.
//
// The load-bearing negatives: a POST the user REMEMBERED for the session is still refused on
// a scheduled handler; an ARMED standing grant that answers yes on the ordinary gate is still
// refused; neither ever parks a confirm (nobody is at the dialog). MUTATION CHECK (run during
// development, red as predicted): make the scheduled gate delegate to the standing gate →
// "a remembered session grant" and "an armed standing grant" both red.
import { NET_ERROR_CODES } from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { SCHEDULED_REFUSAL_VERB, createScheduledConfirmGate, scheduledRefusalVerb } from '../schedule/scheduledConfirmGate.js';
import { NET_CALL_LIMIT_MESSAGE, __resetNetStateForTests, armStandingApproval, createNetHandlerFor, netConfirmStore, resolveNetConfirm } from '../state/net.js';
import { installTestUserDb } from './userdbTestHelper.js';

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

function seedConnectedApp(): string {
  const app = db.installApp({ displayName: 'Net App', html: '<p>net</p>' });
  db.setSecret(`auth:${app.appId}:${SLOT}:api_key`, 'stored-key-abc123');
  db.putDeclaredConnection(app.appId, SLOT, requirement, 'inference');
  db.approveConnection(app.appId, SLOT);
  return app.appId;
}

const frame = (method: 'GET' | 'POST', url = 'https://api.example.com/v1/items') => ({
  v: 1 as const,
  type: 'snug:net-request' as const,
  requestId: `r-${method}`,
  instanceId: 'ins-1',
  url,
  method,
  ...(method === 'POST' ? { body: '{}' } : {}),
});

/** A recording fetch that answers 200. */
function recordingFetch(): { fetched: string[]; fetchImpl: (url: string, init?: RequestInit) => Promise<Response> } {
  const fetched: string[] = [];
  return {
    fetched,
    fetchImpl: async (url) => {
      fetched.push(url);
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
}

beforeEach(async () => {
  __resetNetStateForTests();
  db = await installTestUserDb();
});

afterEach(() => {
  __resetNetStateForTests();
});

describe('the gate itself — standalone, refusing, recording', () => {
  it('refuses every mutating method synchronously, consults nothing, and records what it refused', () => {
    const gate = createScheduledConfirmGate();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect(gate.confirm({ appId: 'a', host: 'api.github.com', method, url: `https://api.github.com/${method}` }), method).toBe(false);
    }
    expect(gate.refused.map((r) => r.method)).toEqual(['POST', 'PUT', 'PATCH', 'DELETE']);
    expect(gate.refused[0]).toEqual({ host: 'api.github.com', method: 'POST' });
    expect(netConfirmStore.get()).toBeNull();
  });

  it('names what the app tried in the app’s words — the verb `copy.needsYou` reads ("post to api.github.com")', () => {
    expect(scheduledRefusalVerb({ host: 'api.github.com', method: 'POST' })).toBe('post to api.github.com');
    expect(scheduledRefusalVerb({ host: 'hooks.slack.com', method: 'DELETE' })).toBe('delete on hooks.slack.com');
    expect(SCHEDULED_REFUSAL_VERB).toBe('send changes anywhere');
  });
});

describe('the handler with the scheduled gate (A5)', () => {
  it('a remembered session grant does NOT let a scheduled POST through — refused, no fetch, no confirm parked', async () => {
    const appId = seedConnectedApp();
    const ordinary = createNetHandlerFor({ fetchImpl: async () => new Response('{}', { status: 200 }) });
    const first = ordinary.handle(appId, frame('POST'));
    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    resolveNetConfirm({ granted: true, rememberSession: true });
    expect((await first).ok).toBe(true);
    // The grant is live: the ordinary handler lets the second POST through without asking.
    expect((await ordinary.handle(appId, frame('POST'))).ok).toBe(true);
    expect(netConfirmStore.get()).toBeNull();

    const gate = createScheduledConfirmGate();
    const { fetched, fetchImpl } = recordingFetch();
    const scheduled = createNetHandlerFor({ fetchImpl, confirmGate: gate });
    const result = await scheduled.handle(appId, frame('POST'));
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED, retryable: false });
    expect(fetched).toEqual([]);
    expect(netConfirmStore.get()).toBeNull();
    expect(gate.refused).toEqual([{ host: 'api.example.com', method: 'POST' }]);
  });

  it('an armed standing grant does NOT let a scheduled POST through either', async () => {
    const appId = seedConnectedApp();
    armStandingApproval({ appId, slot: SLOT, threadJid: 'friend@s.whatsapp.net', trigger: 'all', maxPerWindow: 10, windowMs: 60_000, armedAt: Date.now(), sends: [] });
    const gate = createScheduledConfirmGate();
    const { fetched, fetchImpl } = recordingFetch();
    const scheduled = createNetHandlerFor({ fetchImpl, confirmGate: gate });
    const result = await scheduled.handle(appId, {
      ...frame('POST', 'https://api.example.com/chats/friend%40s.whatsapp.net/messages'),
      body: JSON.stringify({ jid: 'friend@s.whatsapp.net', text: 'hi' }),
    });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
    expect(fetched).toEqual([]);
    expect(netConfirmStore.get()).toBeNull();
    expect(gate.refused).toHaveLength(1);
  });

  it('a GET succeeds through the scheduled handler and is COUNTED at the handler (`onNetCall`, the host-assigned id)', async () => {
    const appId = seedConnectedApp();
    const counted: Array<[string, string]> = [];
    const { fetched, fetchImpl } = recordingFetch();
    const scheduled = createNetHandlerFor({
      fetchImpl,
      confirmGate: createScheduledConfirmGate(),
      onNetCall: (id, request) => {
        counted.push([id, request.method]);
        return true;
      },
    });
    const result = await scheduled.handle(appId, frame('GET'));
    expect(result.ok).toBe(true);
    expect(fetched).toEqual(['https://api.example.com/v1/items']);
    expect(counted).toEqual([[appId, 'GET']]);
  });

  it('a refused POST is counted too — the attempt spent a call on the handler, whatever the gate said', async () => {
    const appId = seedConnectedApp();
    const counted: string[] = [];
    const scheduled = createNetHandlerFor({
      fetchImpl: recordingFetch().fetchImpl,
      confirmGate: createScheduledConfirmGate(),
      onNetCall: (_id, request) => {
        counted.push(request.method);
        return true;
      },
    });
    await scheduled.handle(appId, frame('POST'));
    expect(counted).toEqual(['POST']);
  });

  it('`onNetCall` answering false refuses the call BEFORE the executor — the daily ceiling, by name, with no fetch', async () => {
    const appId = seedConnectedApp();
    const errors: string[] = [];
    const { fetched, fetchImpl } = recordingFetch();
    const scheduled = createNetHandlerFor({ fetchImpl, confirmGate: createScheduledConfirmGate(), onNetCall: () => false, onNetError: (_id, code) => void errors.push(code) });
    const result = await scheduled.handle(appId, frame('GET'));
    expect(result).toEqual({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED, message: NET_CALL_LIMIT_MESSAGE, retryable: false });
    expect(fetched).toEqual([]);
    expect(errors).toEqual([NET_ERROR_CODES.NET_CONFIRM_DENIED]);
  });

  it('a connected host that echoes the injected credential answers the hidden frame with `***`', async () => {
    // The handler EXACTLY as `appRuntime.composeAppRuntime` builds it for `appRun.ts`'s hidden
    // frame: the standalone refusing gate, the counting seam, the injected fetch. The host
    // echoes every credential header it received into the body AND a whitelisted response
    // header; what the frame reads back must carry `***` and never the stored value — the
    // VALUE scrub (`packages/auth/src/connected-fetch.ts` gate 10, `scrubAuthValues` over the
    // read body and each whitelisted header) is the hidden frame's too (threat model R-54).
    const appId = seedConnectedApp();
    const echoing = async (_url: string, init?: RequestInit): Promise<Response> => {
      const sent = new Headers(init?.headers);
      const echoed = ['Authorization', 'X-Api-Key']
        .map((name) => [name, sent.get(name)] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] !== null);
      return new Response(JSON.stringify({ youSent: Object.fromEntries(echoed) }), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: `"${echoed.map(([, value]) => value).join('+')}"` },
      });
    };
    const scheduled = createNetHandlerFor({ fetchImpl: echoing, confirmGate: createScheduledConfirmGate(), onNetCall: () => true });
    const result = await scheduled.handle(appId, frame('GET'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain('***');
    expect(result.body).not.toContain('stored-key-abc123');
    expect(JSON.parse(result.body)).toEqual({ youSent: { 'X-Api-Key': '***' } }); // the fixture injects X-Api-Key; no Authorization is ever sent for an api_key connection
    expect(result.headers.etag).toBe('"***"');
    expect(JSON.stringify(result)).not.toContain('stored-key-abc123');
  });

  it('the wizard’s probe and the visible frame keep the DEFAULT gate: a handler built without `confirmGate` still parks a confirm', async () => {
    const appId = seedConnectedApp();
    const ordinary = createNetHandlerFor({ fetchImpl: recordingFetch().fetchImpl });
    const pending = ordinary.handle(appId, frame('POST'));
    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    resolveNetConfirm({ granted: false });
    expect(await pending).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
  });
});
