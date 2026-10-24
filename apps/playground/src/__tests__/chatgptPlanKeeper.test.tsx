// chatgptPlanKeeper.test.tsx — TASK-20261023-siwc-chatgpt-plan Gate 3, L4 (plan §11 L4-11, L4-6;
// §4 rows 5 and the bearer adaptation; ADR-0078 §2, §4, §5).
//
// `state/chatgptPlan.ts` is the page's ONE ChatGPT-plan keeper: built at boot from the
// platform's custody seat (`getPlatform().chatgptPlan`), mirrored into a store every surface
// reads, and adapted to the adapters' `BearerSource` seam so the Responses adapter never sees
// a key. Pinned here, each with the mutation it catches:
//   - the keeper is built ONCE, from the seat's store + loopback (a second keeper, or one built
//     from anything else, is a second custody path);
//   - `'unknown'` means WAIT: `chatgptPlanReady()` stays pending until the first store read
//     answers (a ready that resolves early lets a launch catch-up refuse a valid session — F9);
//   - without a seat (web, the host kit) nothing is ever built, the status is
//     `{ signedIn: false, registered: false }` and ready resolves at once (L4-11's recorded
//     deviation from §2: `'unknown'` on web would wait forever);
//   - the acts delegate to the keeper, results passed through (an unconfirmed revocation must
//     reach the UI — D7);
//   - `chatgptBearerSource()`: `get` → `getAccessToken` per call (no cached token), every
//     `ChatgptPlanError` mapped BY NAME to a `BearerResult` (never a throw), `refresh(stale)` →
//     `refreshNow(stale)`, and `redact` masks EVERY token the source handed out — two different
//     tokens over two calls, the `Bearer <token>` form, a refreshed one — and nothing else.
//
// Fresh module graph per test (`vi.resetModules()` + `setPlatform`), the modeCoercion pattern:
// the platform is set once per graph, and the keeper is page-wide state.
//
// RED until `state/chatgptPlan.ts` exists (every import below fails the file).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatgptPlanErrorCode, ChatgptPlanStatus } from '@snugprotocol/auth';

import type { SnugPlatform } from '../platform/platform.js';
import {
  NOT_GRANTED,
  READY,
  SIGNED_OUT,
  chatgptDesktopPlatform,
  fakeChatgptSession,
  recordingFactory,
  settle,
  type FakeChatgptSession,
} from './chatgptPlanTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Keeper = typeof import('../state/chatgptPlan.js');
type AuthModule = typeof import('@snugprotocol/auth');

/**
 * The `ChatgptPlanError` class of the CURRENT module graph. `vi.resetModules()` gives each test a
 * fresh `@snugprotocol/auth` instance, so an error built from a statically imported class would
 * fail an `instanceof` the keeper is entitled to use — the error must come from the keeper's graph.
 */
let auth: AuthModule;

async function fresh(platform?: SnugPlatform): Promise<{ keeper: Keeper; platform: SnugPlatform | undefined }> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const keeper = await import('../state/chatgptPlan.js');
  auth = await import('@snugprotocol/auth');
  keeper.resetChatgptPlanForTests();
  return { keeper, platform };
}

/** A desktop graph whose keeper is booted on `session` (status already answered unless it starts `'unknown'`). */
async function booted(session: FakeChatgptSession): Promise<{ keeper: Keeper; seatPlatform: SnugPlatform; created: ReturnType<typeof recordingFactory>['created'] }> {
  const seatPlatform = chatgptDesktopPlatform();
  const { keeper } = await fresh(seatPlatform);
  const factory = recordingFactory(session);
  const boot = keeper.bootChatgptPlan(factory.create);
  if (session.status() !== 'unknown') await boot;
  else await settle();
  return { keeper, seatPlatform, created: factory.created };
}

/** Whether `promise` has settled after the queue drains — without ever awaiting a pending one. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await settle();
  return done;
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// The one keeper (L4-11)
// ---------------------------------------------------------------------------------------------

describe('bootChatgptPlan — ONE keeper per page, built from the platform seat (L4-11)', () => {
  it('builds the keeper once, handing it the seat’s custody store and its own loopback — never anything else', async () => {
    const session = fakeChatgptSession(READY);
    const { keeper, seatPlatform, created } = await booted(session);
    expect(created).toHaveLength(1);
    expect(created[0]?.store).toBe(seatPlatform.chatgptPlan?.sessionStore);
    expect(created[0]?.loopback).toBe(seatPlatform.chatgptPlan?.loopback);

    // StrictMode's second effect run (and the recover/restore chains) find the same keeper.
    const again = recordingFactory(fakeChatgptSession(SIGNED_OUT));
    await keeper.bootChatgptPlan(again.create);
    expect(again.created).toHaveLength(0);
    expect(keeper.chatgptPlanStatus()).toEqual(READY);
  });

  it('mirrors the keeper’s status into the store on every notification', async () => {
    const session = fakeChatgptSession(READY);
    const { keeper } = await booted(session);
    expect(keeper.chatgptPlanStatus()).toEqual(READY);
    expect(keeper.chatgptPlanStore.get()).toEqual(READY);

    session.setStatus(SIGNED_OUT);
    expect(keeper.chatgptPlanStatus()).toEqual(SIGNED_OUT);
    expect(keeper.chatgptPlanStore.get()).toEqual(SIGNED_OUT);

    session.setStatus(NOT_GRANTED);
    expect(keeper.chatgptPlanStore.get()).toEqual(NOT_GRANTED);
  });

  it('useChatgptPlan() re-renders when the account state flips', async () => {
    const session = fakeChatgptSession(READY);
    const { keeper } = await booted(session);
    function Probe(): React.ReactElement {
      const status: ChatgptPlanStatus = keeper.useChatgptPlan();
      return <span data-testid="plan">{status === 'unknown' ? 'unknown' : status.signedIn ? `in:${String(status.planGranted)}` : 'out'}</span>;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe />);
    });
    expect(container.textContent).toBe('in:true');
    await act(async () => {
      session.setStatus(SIGNED_OUT);
    });
    expect(container.textContent).toBe('out');
  });
});

describe('`unknown` means WAIT (F9, L4-6): ready resolves only when the first store read answers', () => {
  it('while the first read is out, the status is unknown and chatgptPlanReady() stays pending', async () => {
    const session = fakeChatgptSession('unknown');
    const { keeper, created } = await booted(session);
    expect(created).toHaveLength(1);
    expect(keeper.chatgptPlanStatus()).toBe('unknown');
    const ready = keeper.chatgptPlanReady();
    expect(await settled(ready)).toBe(false);

    session.resolveFirstRead(READY);
    await expect(ready).resolves.toBeUndefined();
    expect(keeper.chatgptPlanStatus()).toEqual(READY);
  });

  it('a first read that answers signed-out ALSO releases the wait — it is an answer, not an absence', async () => {
    const session = fakeChatgptSession('unknown');
    const { keeper } = await booted(session);
    const ready = keeper.chatgptPlanReady();
    session.resolveFirstRead(SIGNED_OUT);
    await expect(ready).resolves.toBeUndefined();
    expect(keeper.chatgptPlanStatus()).toEqual(SIGNED_OUT);
  });

  it('once answered, a later chatgptPlanReady() resolves at once', async () => {
    const session = fakeChatgptSession(READY);
    const { keeper } = await booted(session);
    expect(await settled(keeper.chatgptPlanReady())).toBe(true);
  });
});

describe('no seat → no keeper (web, the host kit): signed out, nothing registered, ready at once (L4-11 deviation)', () => {
  it('the web default: bootChatgptPlan builds nothing; status { signedIn: false, registered: false }; ready resolves', async () => {
    const { keeper } = await fresh();
    const factory = recordingFactory(fakeChatgptSession(READY));
    await keeper.bootChatgptPlan(factory.create);
    expect(factory.created).toHaveLength(0);
    expect(keeper.chatgptPlanStatus()).toEqual({ signedIn: false, registered: false });
    expect(await settled(keeper.chatgptPlanReady())).toBe(true);
  });

  it('ready resolves at once on web even when nothing booted the keeper — nothing will ever arrive there', async () => {
    const { keeper } = await fresh({ kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false } });
    expect(await settled(keeper.chatgptPlanReady())).toBe(true);
    expect(keeper.chatgptPlanStatus()).toEqual({ signedIn: false, registered: false });
  });

  it('a desktop WITHOUT the seat builds nothing either — presence of the seat IS the capability', async () => {
    const { keeper } = await fresh({ kind: 'desktop', capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true } });
    const factory = recordingFactory(fakeChatgptSession(READY));
    await keeper.bootChatgptPlan(factory.create);
    expect(factory.created).toHaveLength(0);
    expect(keeper.chatgptPlanStatus()).toEqual({ signedIn: false, registered: false });
  });
});

describe('the acts delegate to the keeper, results passed through (AC2, AC3, AC9, D7)', () => {
  it('signInToChatgpt forwards prompt=consent (the "allow plan usage" re-consent) and answers the keeper’s result', async () => {
    const session = fakeChatgptSession(NOT_GRANTED, { signInResult: { ok: true, status: READY } });
    const { keeper } = await booted(session);
    await expect(keeper.signInToChatgpt({ prompt: 'consent' })).resolves.toEqual({ ok: true, status: READY });
    expect(session.calls.signIn).toEqual([{ prompt: 'consent' }]);
  });

  it('cancelChatgptSignIn — the visible cancel while the browser is open', async () => {
    const session = fakeChatgptSession(SIGNED_OUT);
    const { keeper } = await booted(session);
    await keeper.cancelChatgptSignIn();
    expect(session.calls.cancelSignIn).toBe(1);
  });

  it('signOutOfChatgpt answers the revocation outcome — an UNCONFIRMED revocation reaches the caller to be told', async () => {
    const session = fakeChatgptSession(READY, { revocation: 'unconfirmed' });
    const { keeper } = await booted(session);
    await expect(keeper.signOutOfChatgpt()).resolves.toEqual({ revocation: 'unconfirmed' });
    expect(session.calls.signOut).toBe(1);
  });

  it('forgetChatgptRegistration reaches the keeper’s forgetRegistration', async () => {
    const session = fakeChatgptSession(SIGNED_OUT);
    const { keeper } = await booted(session);
    await keeper.forgetChatgptRegistration();
    expect(session.calls.forgetRegistration).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// The bearer adaptation (L4-11; plan §2 BearerSource; D3, D5)
// ---------------------------------------------------------------------------------------------

describe('chatgptBearerSource() — the keeper as the Responses adapter’s BearerSource', () => {
  it('get() answers the keeper’s access token, asked PER CALL — the page caches no long-lived token (D2)', async () => {
    const session = fakeChatgptSession(READY);
    const { keeper } = await booted(session);
    session.nextAccessToken('eyJhbGciOiJSUzI1NiJ9.first.sig');
    session.nextAccessToken('eyJhbGciOiJSUzI1NiJ9.second.sig');
    const source = keeper.chatgptBearerSource();
    await expect(source.get()).resolves.toEqual({ ok: true, token: 'eyJhbGciOiJSUzI1NiJ9.first.sig' });
    await expect(source.get()).resolves.toEqual({ ok: true, token: 'eyJhbGciOiJSUzI1NiJ9.second.sig' });
    expect(session.calls.getAccessToken).toBe(2);
  });

  const MAPPED: ReadonlyArray<readonly [ChatgptPlanErrorCode, boolean]> = [
    ['sign_in_needed', false],
    ['plan_not_granted', false],
    ['network', true],
    ['refresh_not_ready', true],
    ['usage_unavailable', true],
  ];

  for (const [code, retryable] of MAPPED) {
    it(`a ChatgptPlanError '${code}' (retryable ${String(retryable)}) is the BearerResult { ok: false, code: '${code}', retryable: ${String(retryable)} } — never a throw`, async () => {
      const session = fakeChatgptSession(READY);
      const { keeper } = await booted(session);
      session.nextAccessToken(new auth.ChatgptPlanError(`the keeper said ${code}`, code, retryable));
      await expect(keeper.chatgptBearerSource().get()).resolves.toEqual({ ok: false, code, retryable });
    });
  }

  it('an unexpected throw from the keeper is still a RESULT (ok: false), never a rejection the adapter must catch — and it is `network`, retryable, never a usage sentence (G5-A8)', async () => {
    const session = fakeChatgptSession(READY);
    const { keeper } = await booted(session);
    session.nextAccessToken(new Error('something nobody named'));
    // A write IPC error, a thrown string — a fault on THIS side of the wire, not the plan's usage.
    await expect(keeper.chatgptBearerSource().get()).resolves.toEqual({ ok: false, code: 'network', retryable: true });
  });

  it('invalidate(stale) → the keeper’s reportRejected(stale): the route refused the retry’s bearer, so the status stops saying signed in (G5-C4 / S1 / A2)', async () => {
    const session = fakeChatgptSession(READY);
    const { keeper } = await booted(session);
    const source = keeper.chatgptBearerSource();
    expect(source.invalidate, 'the optional seam is implemented by the page').toBeTypeOf('function');
    await source.invalidate?.('eyJhbGciOiJSUzI1NiJ9.rejected-twice.sig');
    expect(session.calls.reportRejected).toEqual(['eyJhbGciOiJSUzI1NiJ9.rejected-twice.sig']);
    expect(keeper.chatgptPlanStatus()).toEqual({ signedIn: false, registered: true });
  });

  it('with no keeper (web) invalidate() is a no-op that resolves', async () => {
    const { keeper } = await fresh();
    await expect(keeper.chatgptBearerSource().invalidate?.('x')).resolves.toBeUndefined();
  });

  it('refresh(stale) is the keeper’s forced refreshNow(stale), answering the rotated token', async () => {
    const session = fakeChatgptSession(READY);
    const { keeper } = await booted(session);
    session.nextRefresh('eyJhbGciOiJSUzI1NiJ9.rotated.sig');
    await expect(keeper.chatgptBearerSource().refresh('eyJhbGciOiJSUzI1NiJ9.stale.sig')).resolves.toEqual({ ok: true, token: 'eyJhbGciOiJSUzI1NiJ9.rotated.sig' });
    expect(session.calls.refreshNow).toEqual(['eyJhbGciOiJSUzI1NiJ9.stale.sig']);
  });

  it('a refresh that ends the session is sign_in_needed by name (AC6)', async () => {
    const session = fakeChatgptSession(READY);
    const { keeper } = await booted(session);
    session.nextRefresh(new auth.ChatgptPlanError('refresh token reused', 'sign_in_needed'));
    await expect(keeper.chatgptBearerSource().refresh('eyJhbGciOiJSUzI1NiJ9.stale.sig')).resolves.toEqual({ ok: false, code: 'sign_in_needed', retryable: false });
  });

  it('redact() masks EVERY token the source handed out — two different gets, the Bearer form, a refreshed one — and nothing else', async () => {
    const session = fakeChatgptSession(READY);
    const { keeper } = await booted(session);
    const first = 'eyJhbGciOiJSUzI1NiJ9.handed-out-first.sigAAAA';
    const second = 'eyJhbGciOiJSUzI1NiJ9.handed-out-second.sigBBBB';
    const rotated = 'eyJhbGciOiJSUzI1NiJ9.handed-out-rotated.sigCCCC';
    session.nextAccessToken(first);
    session.nextAccessToken(second);
    session.nextRefresh(rotated);
    const source = keeper.chatgptBearerSource();
    await source.get();
    await source.get();
    await source.refresh(second);

    const echoed = `Incorrect API key provided: ${first}. Also ${second}. Header: Authorization: Bearer ${first}; after rotation ${rotated}`;
    const redacted = source.redact(echoed);
    expect(redacted).not.toContain(first);
    expect(redacted).not.toContain(second);
    expect(redacted).not.toContain(rotated);
    expect(redacted).toContain('Incorrect API key provided:');
    // An exact-value scrub, not a blanket one: text holding no handed-out token is untouched.
    expect(source.redact('the plan route said no')).toBe('the plan route said no');
  });

  it('a source taken BEFORE a token was minted still redacts it — the redaction set is the page’s, not a snapshot', async () => {
    const session = fakeChatgptSession(READY);
    const { keeper } = await booted(session);
    const early = keeper.chatgptBearerSource();
    const token = 'eyJhbGciOiJSUzI1NiJ9.minted-through-another-source.sigDDDD';
    session.nextAccessToken(token);
    await keeper.chatgptBearerSource().get();
    expect(early.redact(`echo ${token}`)).not.toContain(token);
  });

  it('with no keeper (web) get() is sign_in_needed by name — a result, never a fall-through', async () => {
    const { keeper } = await fresh();
    await expect(keeper.chatgptBearerSource().get()).resolves.toEqual({ ok: false, code: 'sign_in_needed', retryable: false });
  });
});

// ---------------------------------------------------------------------------------------------
// Gate 5 — the bounded wait (G5-C1 / A1), the remembered limit (G5-C3 / ST1) and the one model view (ST2)
// ---------------------------------------------------------------------------------------------

describe('chatgptPlanReadyBounded(wait) — every boot/restore chain waits for the first read, but never for ever (G5-C1)', () => {
  it('a first read that never answers (a hung IPC, an unreadable file nobody settled) releases the wait once the bound elapses', async () => {
    const session = fakeChatgptSession('unknown');
    const { keeper } = await booted(session);
    const waits: number[] = [];
    const wait = (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    };
    await expect(keeper.chatgptPlanReadyBounded(wait)).resolves.toBeUndefined();
    expect(waits).toEqual([keeper.CHATGPT_READY_BOUND_MS]);
    expect(keeper.CHATGPT_READY_BOUND_MS).toBe(3_000);
    // The status is still unknown: the caller proceeds and the scheduled gate refuses BY NAME, never hangs.
    expect(keeper.chatgptPlanStatus()).toBe('unknown');
    // The unbounded wait is untouched — it still pins F9 for the gate.
    expect(await settled(keeper.chatgptPlanReady())).toBe(false);
  });

  it('a read that answers first wins the race — the bound is never the thing that releases a healthy launch', async () => {
    const session = fakeChatgptSession('unknown');
    const { keeper } = await booted(session);
    let release: (() => void) | undefined;
    const wait = (): Promise<void> => new Promise((r) => (release = r));
    const bounded = keeper.chatgptPlanReadyBounded(wait);
    expect(await settled(bounded)).toBe(false);
    session.resolveFirstRead(READY);
    await expect(bounded).resolves.toBeUndefined();
    release?.();
  });

  it('without a seat it resolves at once and never starts a timer', async () => {
    const { keeper } = await fresh();
    const wait = vi.fn(() => new Promise<void>(() => undefined));
    await expect(keeper.chatgptPlanReadyBounded(wait)).resolves.toBeUndefined();
    expect(wait).not.toHaveBeenCalled();
  });
});

describe('the remembered limit — chatgptLimitStore overlays the mirrored status (G5-C3 / ST1)', () => {
  const okResult = { ok: true as const, text: '{}', toolCalls: [], stopReason: 'end' as const };
  const failed = (code: string) => ({ ok: false as const, code, message: 'x', retryable: false });
  const adapterAnswering = (results: Array<ReturnType<typeof failed> | typeof okResult>) => ({
    complete: async () => results.shift() ?? okResult,
  });
  const request = { system: 's', messages: [{ role: 'user' as const, content: 'hi' }] };

  it('a result coded CHATGPT_USAGE_LIMIT sets { at, code: usage_limit } and the status carries it; the next ok result clears it', async () => {
    const { keeper } = await booted(fakeChatgptSession(READY));
    const adapters = await import('@snugprotocol/adapters');
    const observed = keeper.withChatgptLimitObserver(adapterAnswering([failed(adapters.CHATGPT_ERROR_CODES.USAGE_LIMIT), okResult]), () => 1_700_000_000_000);
    await observed.complete(request);
    expect(keeper.chatgptLimitStore.get()).toEqual({ at: 1_700_000_000_000, code: 'usage_limit' });
    const status = keeper.chatgptPlanStatus();
    expect(status !== 'unknown' && status.signedIn ? status.limit : undefined).toEqual({ at: 1_700_000_000_000, code: 'usage_limit' });
    await observed.complete(request);
    expect(keeper.chatgptLimitStore.get()).toBeUndefined();
    const cleared = keeper.chatgptPlanStatus();
    expect(cleared !== 'unknown' && cleared.signedIn ? cleared.limit : 'no').toBeUndefined();
  });

  it('CHATGPT_USAGE_UNAVAILABLE is remembered as usage_unavailable; any other failure leaves the limit alone', async () => {
    const { keeper } = await booted(fakeChatgptSession(READY));
    const adapters = await import('@snugprotocol/adapters');
    const observed = keeper.withChatgptLimitObserver(adapterAnswering([failed(adapters.CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE), failed('HOST_ERROR')]), () => 5);
    await observed.complete(request);
    expect(keeper.chatgptLimitStore.get()).toEqual({ at: 5, code: 'usage_unavailable' });
    await observed.complete(request);
    expect(keeper.chatgptLimitStore.get(), 'a HOST_ERROR is not a limit and does not clear one').toEqual({ at: 5, code: 'usage_unavailable' });
  });

  it('the overlay rides only a signed-in status; the test seam reset clears it', async () => {
    const session = fakeChatgptSession(READY);
    const { keeper } = await booted(session);
    keeper.chatgptLimitStore.set({ at: 1, code: 'usage_limit' });
    session.setStatus(SIGNED_OUT);
    expect(keeper.chatgptPlanStatus()).toEqual(SIGNED_OUT);
    keeper.resetChatgptPlanForTests();
    expect(keeper.chatgptLimitStore.get()).toBeUndefined();
  });
});

describe('chatgptModelView(status, stored, pin?) — the ONE model choice every surface renders (G5-ST2)', () => {
  it('signed in: the account’s models in server order; the default is the stored row, else the first; the resolved model and its levels', async () => {
    const { keeper } = await booted(fakeChatgptSession(READY));
    const view = keeper.chatgptModelView(READY, undefined);
    expect(view.models.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6.1-mini']);
    expect(view.defaultId).toBe('gpt-6.1-sol');
    expect(view.defaultName).toBe('GPT-6.1 Sol');
    expect(view.resolved?.id).toBe('gpt-6.1-sol');
    expect(view.levels).toEqual(['low', 'medium', 'high', 'ultra']);
    expect(view.unlisted).toBeUndefined();

    const stored = keeper.chatgptModelView(READY, 'gpt-6.1-mini');
    expect(stored.defaultId).toBe('gpt-6.1-mini');
    expect(stored.defaultName).toBe('GPT-6.1 mini');
    expect(stored.levels).toEqual([]);
  });

  it('a stored or pinned id the plan does not list is said, never hidden: unlisted, no levels, the default name falls back to the id', async () => {
    const { keeper } = await booted(fakeChatgptSession(READY));
    const stored = keeper.chatgptModelView(READY, 'gpt-5-retired');
    expect(stored.unlisted).toBe('gpt-5-retired');
    expect(stored.defaultName).toBe('gpt-5-retired');
    expect(stored.resolved).toBeUndefined();
    expect(stored.levels).toEqual([]);
    // A per-app pin wins over the stored default for what a think would run on.
    const pinned = keeper.chatgptModelView(READY, 'gpt-6.1-sol', 'gpt-6.1-mini');
    expect(pinned.resolved?.id).toBe('gpt-6.1-mini');
    expect(pinned.defaultId, 'the default is still the stored row — it is what the inherit option names').toBe('gpt-6.1-sol');
    expect(keeper.chatgptModelView(READY, undefined, 'gpt-5-retired').unlisted).toBe('gpt-5-retired');
  });

  it('signed out or unknown: no models, no resolved model, no levels', async () => {
    const { keeper } = await booted(fakeChatgptSession(SIGNED_OUT));
    for (const status of [SIGNED_OUT, 'unknown' as const]) {
      const view = keeper.chatgptModelView(status, 'gpt-6.1-sol');
      expect(view.models).toEqual([]);
      expect(view.defaultId).toBe('gpt-6.1-sol');
      expect(view.resolved).toBeUndefined();
      expect(view.levels).toEqual([]);
    }
  });

  it('ONE default label: chatgptDefaultLabel names the default model, or the plan’s choice when none is known', async () => {
    const { keeper } = await booted(fakeChatgptSession(READY));
    expect(keeper.chatgptDefaultLabel(keeper.chatgptModelView(READY, undefined))).toBe('default (GPT-6.1 Sol)');
    expect(keeper.chatgptDefaultLabel(keeper.chatgptModelView(SIGNED_OUT, undefined))).toBe('default (your plan’s choice)');
  });

  it('resolveChatgptModel and chatgptEffortFor live here now: the level is sent only when the resolved model offers it (G5-A3 / ST12)', async () => {
    const { keeper } = await booted(fakeChatgptSession(READY));
    const mode = await import('../state/mode.js');
    mode.chatgptModelStore.set(undefined);
    expect(keeper.resolveChatgptModel('gpt-6.1-mini')).toBe('gpt-6.1-mini');
    expect(keeper.resolveChatgptModel(undefined)).toBe('gpt-6.1-sol');
    mode.chatgptModelStore.set('gpt-6.1-mini');
    expect(keeper.resolveChatgptModel(undefined)).toBe('gpt-6.1-mini');

    mode.chatgptEffortStore.set('ultra');
    expect(keeper.chatgptEffortFor('gpt-6.1-sol', false)).toBe('ultra');
    expect(keeper.chatgptEffortFor('gpt-6.1-mini', false), 'mini has no level axis — nothing is sent').toBeUndefined();
    expect(keeper.chatgptEffortFor('gpt-5-retired', false), 'an unlisted model offers nothing we can check — nothing is sent').toBeUndefined();
    mode.chatgptEffortStore.set('galactic');
    expect(keeper.chatgptEffortFor('gpt-6.1-sol', false), 'a level the model lacks is not sent').toBeUndefined();
    // Unattended: the model's own default, never the stored one.
    mode.chatgptEffortStore.set('ultra');
    expect(keeper.chatgptEffortFor('gpt-6.1-sol', true)).toBe('medium');
    expect(keeper.chatgptEffortFor('gpt-6.1-mini', true)).toBeUndefined();
  });
});
