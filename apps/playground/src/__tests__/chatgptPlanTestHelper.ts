// chatgptPlanTestHelper.ts — the shared fakes for the L4 "Use my ChatGPT plan" suites
// (TASK-20261023-siwc-chatgpt-plan Gate 3, plan §11 L4-11).
//
// A FAKE keeper behind the real `ChatgptPlanSession` interface (`@snugprotocol/auth`, L0), so
// the page's `state/chatgptPlan.ts` is driven exactly as it drives L1's real one — through
// `status()` + `subscribe()`, `getAccessToken()` / `refreshNow()` and the sign-in/out acts —
// and a test can flip the account state, script a bearer, and hold the FIRST store read open
// to prove `'unknown'` means WAIT (Gate-2 finding F9).
//
// The seams this helper assumes `state/chatgptPlan.ts` builds to (named in the Gate-3 report):
//   - `bootChatgptPlan(create)` calls `create(deps)` ONCE with the platform seat's
//     `sessionStore` as `deps.store` and its `loopback` as `deps.loopback`, and mirrors
//     `session.status()` into `chatgptPlanStore` on every `subscribe` notification;
//   - `chatgptPlanReady()` resolves once `status()` is no longer `'unknown'`.
// The fake starts at `initial`; with `'unknown'`, `resolveFirstRead(status)` is the store's
// first answer arriving (it sets the status and notifies, as L1's keeper does after its read).

import type { ChatgptLoopbackSeat, ChatgptModel, ChatgptPlanSession, ChatgptPlanStatus, ChatgptSessionFile, ChatgptSessionStore, SignInResult } from '@snugprotocol/auth';
import { ChatgptPlanError } from '@snugprotocol/auth';

import type { ChatgptPlanSeat, SnugPlatform } from '../platform/platform.js';

// ------------------------------------------------------------------------------ fixtures

/** Two models in the server's order, shaped as L1 maps `/v1/models` (slug → id, levels → efforts). */
export const PLAN_MODELS: readonly ChatgptModel[] = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high', 'ultra'], defaultEffort: 'medium' },
  { id: 'gpt-6.1-mini', name: 'GPT-6.1 mini', efforts: [] },
];

export const READY: ChatgptPlanStatus = { signedIn: true, planGranted: true, email: 'ada@example.com', name: 'Ada', models: PLAN_MODELS };
export const SIGNED_OUT: ChatgptPlanStatus = { signedIn: false, registered: true };
export const NOT_GRANTED: ChatgptPlanStatus = { signedIn: true, planGranted: false, email: 'ada@example.com', models: [] };
export const LIMITED: ChatgptPlanStatus = {
  signedIn: true,
  planGranted: true,
  email: 'ada@example.com',
  models: PLAN_MODELS,
  limit: { at: Date.parse('2026-10-23T08:00:00.000Z'), code: 'usage_limit' },
};

/** The four keeper states the behavioural matrix crosses (plan §4 row 4/6). */
export const MATRIX_STATUSES: ReadonlyArray<readonly [string, ChatgptPlanStatus]> = [
  ['ready', READY],
  ['signed out', SIGNED_OUT],
  ['plan not granted', NOT_GRANTED],
  ['limited', LIMITED],
];

/** The named refusals of plan §11 L4-6, verbatim — never the keyless/demo sentence. */
export const SIGNED_OUT_REFUSAL = 'Sign in to ChatGPT to run this step — it runs on your ChatGPT plan.';
export const NOT_GRANTED_REFUSAL = 'Allow plan usage for Snug in Settings to run this step.';

/** The D9 data-use sentence, verbatim (task file D9; ADR-0078 §9). */
export const D9_DATA_USE =
  "In this mode your requests go to OpenAI under your ChatGPT account. OpenAI's documents don't say which data policy covers them, so assume your ChatGPT data controls ('Improve the model for everyone') apply. Snug and the app can't see your ChatGPT conversations or memories.";

// ------------------------------------------------------------------------- the fake keeper

export interface FakeChatgptSessionCalls {
  signIn: Array<{ prompt?: 'consent' } | undefined>;
  cancelSignIn: number;
  signOut: number;
  forgetRegistration: number;
  getAccessToken: number;
  refreshNow: string[];
  listModels: Array<boolean | undefined>;
}

export interface FakeChatgptSession extends ChatgptPlanSession {
  readonly calls: FakeChatgptSessionCalls;
  /** Flip the account state and notify every subscriber (what L1's keeper does after each mutation). */
  setStatus(next: ChatgptPlanStatus): void;
  /** The store's first read answering — `'unknown'` → `next`. Same as `setStatus`, named for the WAIT tests. */
  resolveFirstRead(next: ChatgptPlanStatus): void;
  /** Script `getAccessToken`: a token to answer, or an error to throw (e.g. a `ChatgptPlanError`). */
  nextAccessToken(answer: string | Error): void;
  /** Script `refreshNow`: a token to answer, or an error to throw. */
  nextRefresh(answer: string | Error): void;
  /** How many listeners are subscribed right now. */
  listenerCount(): number;
}

export interface FakeChatgptSessionOptions {
  /** What `signOut()` answers (default `confirmed`). */
  revocation?: 'confirmed' | 'unconfirmed' | 'none';
  /** What `signIn()` answers (default `{ ok: true, status }`). */
  signInResult?: SignInResult;
}

export function fakeChatgptSession(initial: ChatgptPlanStatus, opts: FakeChatgptSessionOptions = {}): FakeChatgptSession {
  let current: ChatgptPlanStatus = initial;
  const listeners = new Set<() => void>();
  const tokenAnswers: Array<string | Error> = [];
  const refreshAnswers: Array<string | Error> = [];
  let minted = 0;
  const calls: FakeChatgptSessionCalls = {
    signIn: [],
    cancelSignIn: 0,
    signOut: 0,
    forgetRegistration: 0,
    getAccessToken: 0,
    refreshNow: [],
    listModels: [],
  };
  const setStatus = (next: ChatgptPlanStatus): void => {
    current = next;
    for (const listener of [...listeners]) listener();
  };
  const answer = (queue: Array<string | Error>, fallback: () => string): Promise<string> => {
    const next = queue.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? fallback());
  };
  const defaultToken = (): string => {
    if (current === 'unknown' || !current.signedIn) throw new ChatgptPlanError('sign in to ChatGPT', 'sign_in_needed');
    if (!current.planGranted) throw new ChatgptPlanError('plan usage is not allowed', 'plan_not_granted');
    minted += 1;
    return `eyJhbGciOiJSUzI1NiJ9.fake-access-${minted}.signature-${minted}`;
  };
  return {
    calls,
    setStatus,
    resolveFirstRead: setStatus,
    nextAccessToken: (a) => void tokenAnswers.push(a),
    nextRefresh: (a) => void refreshAnswers.push(a),
    listenerCount: () => listeners.size,
    status: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    signIn(signInOpts) {
      calls.signIn.push(signInOpts);
      return Promise.resolve(opts.signInResult ?? { ok: true, status: current });
    },
    cancelSignIn() {
      calls.cancelSignIn += 1;
      return Promise.resolve();
    },
    signOut() {
      calls.signOut += 1;
      return Promise.resolve({ revocation: opts.revocation ?? 'confirmed' });
    },
    forgetRegistration() {
      calls.forgetRegistration += 1;
      return Promise.resolve();
    },
    getAccessToken() {
      calls.getAccessToken += 1;
      try {
        return answer(tokenAnswers, defaultToken);
      } catch (err) {
        return Promise.reject(err);
      }
    },
    refreshNow(previousToken) {
      calls.refreshNow.push(previousToken);
      return answer(refreshAnswers, () => {
        minted += 1;
        return `eyJhbGciOiJSUzI1NiJ9.fake-refreshed-${minted}.signature-${minted}`;
      });
    },
    listModels(force) {
      calls.listModels.push(force);
      return Promise.resolve(current !== 'unknown' && current.signedIn ? current.models : []);
    },
  };
}

/**
 * A `create` for `bootChatgptPlan(create)` that hands back `session` and records every `deps`
 * it was called with. Typed loosely on purpose: the real deps type is L1's, and a factory taking
 * a supertype of it is assignable wherever the real one is expected.
 */
export function recordingFactory(session: ChatgptPlanSession): {
  create: (deps: { store: ChatgptSessionStore; loopback: ChatgptLoopbackSeat }) => ChatgptPlanSession;
  created: Array<{ store: ChatgptSessionStore; loopback: ChatgptLoopbackSeat }>;
} {
  const created: Array<{ store: ChatgptSessionStore; loopback: ChatgptLoopbackSeat }> = [];
  return {
    created,
    create: (deps) => {
      created.push(deps);
      return session;
    },
  };
}

// ------------------------------------------------------------------- the platform seat

/** An in-memory custody seat + a loopback that never opens a port — nothing here touches a token. */
export function fakeChatgptSeat(): ChatgptPlanSeat & { opened: string[] } {
  let file: ChatgptSessionFile | undefined;
  const opened: string[] = [];
  return {
    opened,
    sessionStore: {
      read: () => Promise.resolve(file),
      write: (next) => {
        file = next;
        return Promise.resolve();
      },
      clear: () => {
        file = undefined;
        return Promise.resolve();
      },
    },
    loopback: {
      begin: (path) => Promise.resolve({ redirectUri: `http://127.0.0.1:1455${path}` }),
      onCallback: () => () => undefined,
      cancel: () => Promise.resolve(),
    },
    openExternal: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
  };
}

/** The desktop platform WITH the custody seat — the only place the third mode exists (AC1). */
export function chatgptDesktopPlatform(overrides: Partial<SnugPlatform> = {}): SnugPlatform {
  return {
    kind: 'desktop',
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    chatgptPlan: fakeChatgptSeat(),
    ...overrides,
  };
}

/** Settle queued microtasks and one macrotask turn — for "still pending?" checks. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
