// The desktop's ChatGPT-plan seat (TASK-20261023-siwc-chatgpt-plan D2/D10, ADR-0078 §1–§2;
// AC2, AC10, AC2/15).
//
// `createChatgptPlanSeat()` is what `SnugPlatform.chatgptPlan` carries on the desktop:
//   - `sessionStore` — custody over the three Rust commands. The Rust side treats the payload
//     as opaque bytes, so THIS side owns the shape check: a malformed file reads as `undefined`
//     (never a throw — a corrupt file must not block the sign-in that would overwrite it).
//   - `loopback` — the sign-in's OWN `createDesktopOAuthTransport` (reserved appId
//     `chatgpt-plan`) behind its own port-filtered listener, with error delivery opted in; it
//     never cancels or consumes the connection wizard's flow.
//   - `openExternal` — the https-guarded system-browser opener.
//
// Tauri is absent in vitest: `invoke`, `listen` and the opener are faked at their module seams.
// The transport core is the REAL one from packages/auth, wrapped in a pass-through spy so the
// wiring (`beginFlow` arguments, the `onError` opt-in) is observable without depending on L1's
// core changes landing first.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CallbackDelivery, CallbackErrorDelivery, ChatgptSessionFile, DesktopOAuthTransport } from '@snugprotocol/auth';

import type { ChatgptPlanSeat } from '@playground/platform/platform';

const fake = vi.hoisted(() => {
  const handlers = new Map<string, Set<(e: { payload: string }) => void>>();
  const state = {
    handlers,
    ephemeral: [] as number[],
    cancelled: [] as number[],
    /** What `chatgpt_session_read` answers (a string body, or null for "no file"). */
    sessionBody: null as string | null,
    /** When set, every `chatgpt_session_*` invoke rejects with it. */
    sessionError: null as string | null,
    /** When true, EVERY invoke rejects (a shell whose commands are all failing). */
    allFail: false,
  };
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (state.allFail) throw new Error('ipc unavailable');
    if (cmd === 'plugin:oauth|start') {
      const cfg = args?.config as { ports?: number[] } | undefined;
      return cfg?.ports?.[0] ?? state.ephemeral.shift();
    }
    if (cmd === 'plugin:oauth|cancel') {
      state.cancelled.push(args?.port as number);
      return undefined;
    }
    if (cmd.startsWith('chatgpt_session_')) {
      if (state.sessionError !== null) throw state.sessionError;
      if (cmd === 'chatgpt_session_read') return state.sessionBody;
      return null;
    }
    return new ArrayBuffer(0);
  });
  const listen = vi.fn(async (event: string, handler: (e: { payload: string }) => void) => {
    const set = handlers.get(event) ?? new Set();
    set.add(handler);
    handlers.set(event, set);
    return () => {
      set.delete(handler);
    };
  });
  const openUrl = vi.fn(async (_url: string) => undefined);
  const transports: Array<{ deps: Parameters<typeof import('@snugprotocol/auth').createDesktopOAuthTransport>[0]; transport: DesktopOAuthTransport }> = [];
  return { state, invoke, listen, openUrl, transports };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: fake.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: fake.listen }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: fake.openUrl }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn(async () => new Response('{}')) }));
vi.mock('@snugprotocol/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@snugprotocol/auth')>();
  return {
    ...actual,
    createDesktopOAuthTransport: (deps: Parameters<typeof actual.createDesktopOAuthTransport>[0]) => {
      const real = actual.createDesktopOAuthTransport(deps);
      // Pass-through spies: the core's methods close over their own state, so spreading is safe.
      const transport: DesktopOAuthTransport = {
        ...real,
        beginFlow: vi.fn(real.beginFlow),
        cancel: vi.fn(real.cancel),
        handleCallbackUrl: vi.fn(real.handleCallbackUrl),
      };
      fake.transports.push({ deps, transport });
      return transport;
    },
  };
});

const { createChatgptPlanSeat } = await import('../chatgpt-plan.js');

function emit(url: string): void {
  for (const h of [...(fake.state.handlers.get('oauth://url') ?? [])]) h({ payload: url });
}

/** A `signState`-shaped state: the core's unsigned peek reads the base64url `{appId, flowId}` prefix. */
function stateFor(appId: string, flowId: string): string {
  return `${Buffer.from(JSON.stringify({ appId, flowId, nonce: 'n' })).toString('base64url')}.sig`;
}

const sessionCalls = () => fake.invoke.mock.calls.filter(([cmd]) => String(cmd).startsWith('chatgpt_session_'));

/** The transport the seat built — the newest one created since `mark`. */
function seatTransport(mark: number) {
  const created = fake.transports.slice(mark);
  expect(created, 'the seat builds exactly ONE transport of its own').toHaveLength(1);
  return created[0]!;
}

const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  fake.state.handlers.clear();
  fake.state.ephemeral = [49152, 49153, 49154];
  fake.state.cancelled = [];
  fake.state.sessionBody = null;
  fake.state.sessionError = null;
  fake.state.allFail = false;
  fake.invoke.mockClear();
  fake.listen.mockClear();
  fake.openUrl.mockClear();
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    consoleSpies.push(vi.spyOn(console, m).mockImplementation(() => undefined));
  }
});

afterEach(() => {
  // Restore FIRST, then assert: a throwing assertion must not leave a stale spy behind to fail
  // every later test in the file.
  const logged = consoleSpies.flatMap((spy) => spy.mock.calls);
  for (const spy of consoleSpies) spy.mockRestore();
  consoleSpies.length = 0;
  expect(logged, 'the ChatGPT-plan seat must log nothing (C1 — a session body is a credential)').toEqual([]);
});

const VALID: ChatgptSessionFile = {
  v: 1,
  hostId: 'urn:uuid:7d1f0f8e-0000-4000-8000-000000000001',
  clientId: 'oaiapp_test',
  planGranted: true,
  account: { sub: 'user-1', email: 'a@example.com' },
};

describe('the seat’s shape', () => {
  it('is a ChatgptPlanSeat: a session store, a loopback seat and an opener', () => {
    const seat: ChatgptPlanSeat = createChatgptPlanSeat();
    expect(typeof seat.sessionStore.read).toBe('function');
    expect(typeof seat.sessionStore.write).toBe('function');
    expect(typeof seat.sessionStore.clear).toBe('function');
    expect(typeof seat.loopback.begin).toBe('function');
    expect(typeof seat.loopback.onCallback).toBe('function');
    expect(typeof seat.loopback.cancel).toBe('function');
    expect(typeof seat.openExternal).toBe('function');
  });

  it('building it touches no command — no read, no listener (presence is static, AC1/D10)', () => {
    createChatgptPlanSeat();
    expect(fake.invoke).not.toHaveBeenCalled();
    expect(fake.listen).not.toHaveBeenCalled();
  });
});

describe('sessionStore — custody over chatgpt_session_read | write | clear', () => {
  it('read: no file (Rust answers null) is undefined', async () => {
    fake.state.sessionBody = null;
    await expect(createChatgptPlanSeat().sessionStore.read()).resolves.toBeUndefined();
    expect(sessionCalls().map(([cmd]) => cmd)).toEqual(['chatgpt_session_read']);
  });

  it('read: a well-formed v1 file parses to the ChatgptSessionFile', async () => {
    fake.state.sessionBody = JSON.stringify(VALID);
    await expect(createChatgptPlanSeat().sessionStore.read()).resolves.toEqual(VALID);
  });

  it('read: a malformed file is undefined, never a throw — a corrupt file must not block sign-in', async () => {
    const store = createChatgptPlanSeat().sessionStore;
    for (const body of [
      'not json {{{',
      '',
      'null',
      '[]',
      '"a string"',
      '42',
      JSON.stringify({ ...VALID, v: 2 }),
      JSON.stringify({ ...VALID, v: '1' }),
      JSON.stringify({ planGranted: true, v: 1 }),
      JSON.stringify({ ...VALID, hostId: 7 }),
    ]) {
      fake.state.sessionBody = body;
      await expect(store.read(), body).resolves.toBeUndefined();
    }
  });

  it('write: one invoke of chatgpt_session_write carrying JSON.stringify(file) as `payload`', async () => {
    await createChatgptPlanSeat().sessionStore.write(VALID);
    const calls = sessionCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('chatgpt_session_write');
    expect(calls[0]![1]).toEqual({ payload: JSON.stringify(VALID) });
  });

  it('write → read round-trips through the opaque Rust bytes', async () => {
    const seat = createChatgptPlanSeat();
    await seat.sessionStore.write(VALID);
    fake.state.sessionBody = (sessionCalls()[0]![1] as { payload: string }).payload;
    await expect(seat.sessionStore.read()).resolves.toEqual(VALID);
  });

  it('write: a failed persist REJECTS — the keeper’s crash-safe rotation depends on knowing (D4)', async () => {
    fake.state.sessionError = 'disk full';
    await expect(createChatgptPlanSeat().sessionStore.write(VALID)).rejects.toBeDefined();
  });

  it('clear: one invoke of chatgpt_session_clear', async () => {
    await createChatgptPlanSeat().sessionStore.clear();
    expect(sessionCalls().map(([cmd]) => cmd)).toEqual(['chatgpt_session_clear']);
  });
});

describe('loopback — the sign-in’s OWN transport (D10)', () => {
  it('begin(path) starts an ephemeral loopback flow as appId `chatgpt-plan` with that path', async () => {
    const mark = fake.transports.length;
    const seat = createChatgptPlanSeat();
    const result = await seat.loopback.begin('/auth/callback');
    const { transport } = seatTransport(mark);

    expect(transport.beginFlow).toHaveBeenCalledTimes(1);
    expect(transport.beginFlow).toHaveBeenCalledWith({ posture: 'loopback', appId: 'chatgpt-plan', path: '/auth/callback' });
    const started = fake.invoke.mock.calls.find(([cmd]) => cmd === 'plugin:oauth|start');
    expect((started?.[1] as { config: { ports?: number[] } }).config.ports, 'ephemeral: no fixed port').toBeUndefined();
    // The redirect URI is the transport's recorded string, passed through untouched.
    const recorded = await (vi.mocked(transport.beginFlow).mock.results[0]!.value as Promise<{ redirectUri: string }>);
    expect(result).toEqual({ redirectUri: recorded.redirectUri });
    expect(result.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:49152\//);
  });

  it('a code callback on its port reaches onCallback subscribers', async () => {
    const seat = createChatgptPlanSeat();
    const seen: Array<CallbackDelivery | CallbackErrorDelivery> = [];
    seat.loopback.onCallback((d: CallbackDelivery | CallbackErrorDelivery) => seen.push(d));
    await seat.loopback.begin('/auth/callback');

    const state = stateFor('chatgpt-plan', 'flow-1');
    emit(`http://127.0.0.1:49152/auth/callback?code=the-code&state=${state}`);
    expect(seen).toEqual([expect.objectContaining({ appId: 'chatgpt-plan', flowId: 'flow-1', code: 'the-code', state })]);
  });

  it('an error delivery from its transport reaches onCallback subscribers (a declined consent ends by name)', async () => {
    const mark = fake.transports.length;
    const seat = createChatgptPlanSeat();
    const seen: Array<CallbackDelivery | CallbackErrorDelivery> = [];
    seat.loopback.onCallback((d: CallbackDelivery | CallbackErrorDelivery) => seen.push(d));
    await seat.loopback.begin('/auth/callback');
    const { deps } = seatTransport(mark);

    expect(typeof deps.onError, 'the ChatGPT transport must opt in to error delivery').toBe('function');
    const declined: CallbackErrorDelivery = {
      appId: 'chatgpt-plan',
      flowId: 'flow-2',
      state: stateFor('chatgpt-plan', 'flow-2'),
      error: 'access_denied',
    };
    deps.onError!(declined);
    expect(seen).toEqual([declined]);
  });

  it('the unsubscribe onCallback returns stops deliveries to that subscriber', async () => {
    const seat = createChatgptPlanSeat();
    const seen: unknown[] = [];
    const off = seat.loopback.onCallback((d: CallbackDelivery | CallbackErrorDelivery) => seen.push(d));
    off();
    await seat.loopback.begin('/auth/callback');
    emit(`http://127.0.0.1:49152/auth/callback?code=c&state=${stateFor('chatgpt-plan', 'f')}`);
    expect(seen).toEqual([]);
  });

  it('cancel() tears its own listener down', async () => {
    const mark = fake.transports.length;
    const seat = createChatgptPlanSeat();
    await seat.loopback.begin('/auth/callback');
    await seat.loopback.cancel();
    expect(seatTransport(mark).transport.cancel).toHaveBeenCalled();
    expect(fake.state.cancelled).toEqual([49152]);

    const seen: unknown[] = [];
    seat.loopback.onCallback((d: CallbackDelivery | CallbackErrorDelivery) => seen.push(d));
    emit(`http://127.0.0.1:49152/auth/callback?code=late&state=${stateFor('chatgpt-plan', 'f')}`);
    expect(seen, 'a cancelled sign-in delivers nothing').toEqual([]);
  });
});

describe('the sign-in never touches the connection wizard’s flow (D10, F2/S9)', () => {
  it('both flows live at once; each callback reaches only its own owner; cancelling one leaves the other', async () => {
    fake.state.ephemeral = [51001, 49152];
    const { createDesktopPlatform } = await import('../platform-desktop.js');
    const platform = createDesktopPlatform();

    // The wizard: an ephemeral provider binds at register-screen render.
    const wizardUri = await platform.oauth!.redirectUriFor({ provider: 'Fake IdP', posture: 'loopback' });
    expect(wizardUri).toBe('http://127.0.0.1:51001/callback');
    const wizardChannel = platform.oauth!.channelFor('wizard-flow') as { onmessage: ((e: { data: unknown }) => void) | null };
    const wizardSeen: unknown[] = [];
    wizardChannel.onmessage = (e) => wizardSeen.push(e.data);

    // The ChatGPT sign-in, while the wizard's flow is pending.
    const chatgpt = platform.chatgptPlan!;
    const chatgptSeen: unknown[] = [];
    chatgpt.loopback.onCallback((d) => chatgptSeen.push(d));
    await chatgpt.loopback.begin('/auth/callback');
    expect(fake.state.cancelled, 'beginning the sign-in must not cancel the wizard’s listener').toEqual([]);

    emit(`http://127.0.0.1:49152/auth/callback?code=chatgpt&state=${stateFor('chatgpt-plan', 'cg')}`);
    expect(chatgptSeen).toHaveLength(1);
    expect(wizardSeen, 'the wizard never sees a ChatGPT callback').toEqual([]);

    emit(`http://127.0.0.1:51001/callback?code=idp&state=${stateFor('Fake IdP', 'wizard-flow')}`);
    expect(wizardSeen).toEqual([expect.objectContaining({ appId: 'Fake IdP', flowId: 'wizard-flow', code: 'idp' })]);
    expect(chatgptSeen, 'the sign-in never sees a wizard callback').toHaveLength(1);
  });

  it('cancelling the sign-in stops only its own port', async () => {
    fake.state.ephemeral = [51001, 49152];
    const { createDesktopPlatform } = await import('../platform-desktop.js');
    const platform = createDesktopPlatform();
    await platform.oauth!.redirectUriFor({ provider: 'Fake IdP', posture: 'loopback' });
    await platform.chatgptPlan!.loopback.begin('/auth/callback');
    await platform.chatgptPlan!.loopback.cancel();
    expect(fake.state.cancelled).toEqual([49152]);
  });
});

describe('openExternal — the https-guarded system-browser opener', () => {
  it('opens an https URL in the system browser, verbatim', async () => {
    const url = 'https://auth.openai.com/oauth/authorize?client_id=dynamic_agent_client&state=s';
    await createChatgptPlanSeat().openExternal(url);
    expect(fake.openUrl).toHaveBeenCalledWith(url);
  });

  it('refuses anything that is not https — and opens nothing', async () => {
    const seat = createChatgptPlanSeat();
    for (const url of ['http://auth.openai.com/oauth/authorize', 'javascript:alert(1)', 'file:///etc/passwd', 'snug://s/x']) {
      await expect(seat.openExternal(url), url).rejects.toThrow();
    }
    expect(fake.openUrl).not.toHaveBeenCalled();
  });
});

describe('no logging on the custody path (AC10)', () => {
  it('src/chatgpt-plan.ts contains no console.* call', () => {
    const source = readFileSync(path.resolve(__dirname, '../chatgpt-plan.ts'), 'utf8');
    expect(source).not.toMatch(/\bconsole\s*\./);
  });
});
