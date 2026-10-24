// chatgptPlan.ts — the page's ONE ChatGPT-plan keeper (TASK-20261023-siwc-chatgpt-plan, plan §11
// L4-11; ADR-0078 §2, §4, §5).
//
// WHAT LIVES HERE. The desktop shell keeps the session file (`0600`, outside the user file — D2) and
// hands the page a custody seat (`getPlatform().chatgptPlan`); `@snugprotocol/auth`'s keeper runs the
// protocol over that seat. This module builds exactly ONE keeper per page from the seat, mirrors its
// status into a store every surface reads, delegates the acts (sign in, cancel, sign out, forget),
// and adapts the keeper to the Responses adapter's `BearerSource` seam — so the adapter asks for a
// bearer per attempt and never sees a key, and no token ever enters `TurnAdapterConfig`, a URL, a log
// or the inspector (C1). A second keeper would be a second custody path; a keeper built from anything
// but the seat would be a token outside the shell's custody.
//
// `'unknown'` MEANS WAIT (Gate-2 finding F9). The keeper's first store read has not answered yet; a
// launch catch-up step that read "signed out" instead would refuse a valid session. `chatgptPlanReady()`
// resolves only when the status leaves `'unknown'` — a signed-OUT answer releases it too (an answer,
// not an absence). Where no seat exists (web, the hosted build, the host kit) nothing will ever arrive,
// so the status is `{ signedIn: false, registered: false }` and ready resolves at once — the recorded
// deviation from §2's "`'unknown'` on platforms without the seat".
//
// THE PERSIST IN FLIGHT (D4; §11 "L4-11 addition"). A refresh rotates the refresh token: once the POST
// succeeded, the OLD token is dead server-side and the NEW one exists only until the keeper writes it.
// A window close landing in that gap signs the user out for good. The desktop's close-requested flush
// therefore awaits `chatgptPlanFlush()`, which waits for every `write`/`clear` the seat's store has in
// flight. The tracking rides the seat's OWN store object (patched once) rather than a wrapper around it:
// the keeper must be handed the seat's store itself — one custody path, pinned by the keeper test — so a
// wrapper would be a second object standing between the keeper and the shell.
//
// No `console.*` anywhere on this path: a status or an error here can sit beside a token.

import type { BearerFailureCode, BearerResult, BearerSource } from '@snugprotocol/adapters';
import {
  ChatgptPlanError,
  createChatgptPlanSession,
  scrubAuthValues,
  type ChatgptModel,
  type ChatgptPlanErrorCode,
  type ChatgptPlanSession,
  type ChatgptPlanSessionDeps,
  type ChatgptPlanStatus,
  type ChatgptSessionStore,
  type SignInResult,
} from '@snugprotocol/auth';

import { getPlatform } from '../platform/platform.js';
import { createStore, useStore } from './store.js';

/** The keeper's constructor, injectable so the suites drive the page with a fake behind the real interface. */
export type CreateChatgptPlanSession = (deps: ChatgptPlanSessionDeps) => ChatgptPlanSession;

/** No seat on this platform: signed out, nothing registered, and nothing will ever change that here. */
const NO_SEAT_STATUS: ChatgptPlanStatus = { signedIn: false, registered: false };

/** The sentence an act answers where no seat exists — the plan is the desktop's; nothing else can sign in. */
const NO_SEAT_MESSAGE = 'Signing in with ChatGPT needs the Snug desktop app — this build has no place to keep the session.';

/**
 * How many distinct tokens `redact` remembers. Tokens rotate about hourly, so this covers a page
 * session far longer than any shell keeps a window open; the oldest ones it forgets are long expired.
 */
const HANDED_OUT_RING = 16;

/** The keeper's status as every surface reads it; `'unknown'` until the first store read answers. */
export const chatgptPlanStore = createStore<ChatgptPlanStatus>('unknown');

/**
 * A sign-in is out in the system browser (L5-1; AC2). ONE flag for every surface that can start a
 * sign-in — the Welcome card and the Settings card — so each shows the awaiting hint and the
 * visible cancel for the same window, and neither offers a second "Continue" while one is open.
 */
export const chatgptSignInPendingStore = createStore<boolean>(false);

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let session: ChatgptPlanSession | undefined;
let unsubscribe: (() => void) | undefined;
let booting: Promise<void> | undefined;
let ready = deferred();
/** Every bearer this page handed an adapter, most recent last — what `redact` scrubs (exact values). */
const handedOut: string[] = [];
/** The seat store's persists not yet settled — what `chatgptPlanFlush` waits for. */
const persistsInFlight = new Set<Promise<unknown>>();
/** Stores already carrying the tracking, so a re-boot (tests, StrictMode) never wraps a wrapper. */
const trackedStores = new WeakSet<ChatgptSessionStore>();

const hasSeat = (): boolean => getPlatform().chatgptPlan !== undefined;

/** The store's value, with "no seat" read as the signed-out, unregistered state it is. */
function statusOf(stored: ChatgptPlanStatus): ChatgptPlanStatus {
  return stored === 'unknown' && !hasSeat() ? NO_SEAT_STATUS : stored;
}

/** The keeper's status into the store; the first answer releases every `chatgptPlanReady()` waiter. */
function mirror(): void {
  if (session === undefined) return;
  const status = session.status();
  chatgptPlanStore.set(status);
  if (status !== 'unknown') ready.resolve();
}

function track<T>(persist: Promise<T>): Promise<T> {
  persistsInFlight.add(persist);
  const drop = (): void => void persistsInFlight.delete(persist);
  persist.then(drop, drop);
  return persist;
}

/** Remember every `write`/`clear` the seat's store has in flight — on the store object itself (see the header). */
function trackPersists(store: ChatgptSessionStore): void {
  if (trackedStores.has(store)) return;
  trackedStores.add(store);
  const write = store.write.bind(store);
  const clear = store.clear.bind(store);
  store.write = (file) => track(write(file));
  store.clear = () => track(clear());
}

/**
 * Build the page's keeper from the platform seat — once. A second call (StrictMode's second effect
 * run, the recover/restore chains) finds the first keeper. Resolves when the keeper's first store
 * read has answered; without a seat, at once.
 */
export function bootChatgptPlan(create: CreateChatgptPlanSession = createChatgptPlanSession): Promise<void> {
  if (booting !== undefined) return booting;
  const seat = getPlatform().chatgptPlan;
  if (seat === undefined) {
    chatgptPlanStore.set(NO_SEAT_STATUS);
    ready.resolve();
    booting = ready.promise;
    return booting;
  }
  trackPersists(seat.sessionStore);
  // The platform fetch is the ONE choke point the shell's native transport rides (adapter.ts does the
  // same for every provider adapter); the web default is the page's own fetch.
  const platformFetch = getPlatform().fetchImpl;
  session = create({
    store: seat.sessionStore,
    loopback: seat.loopback,
    openExternal: (url) => seat.openExternal(url),
    fetch: platformFetch ?? ((input, init) => fetch(input, init)),
  });
  unsubscribe = session.subscribe(mirror);
  mirror();
  booting = ready.promise;
  return booting;
}

/** Resolves once the keeper's status is no longer `'unknown'` — at once where no seat exists. */
export function chatgptPlanReady(): Promise<void> {
  if (session === undefined && !hasSeat()) return Promise.resolve();
  return ready.promise;
}

/** Non-hook read for factories and gates (the `currentBrain()` precedent). */
export function chatgptPlanStatus(): ChatgptPlanStatus {
  return statusOf(chatgptPlanStore.get());
}

/** Store-reactive read for the chip, Settings and the Welcome card. */
export function useChatgptPlan(): ChatgptPlanStatus {
  return statusOf(useStore(chatgptPlanStore));
}

/** Whether a sign-in is out in the browser right now (the awaiting hint + cancel render on it). */
export function useChatgptSignInPending(): boolean {
  return useStore(chatgptSignInPendingStore);
}

/**
 * Refresh the account's model list from the server (AC8: "refreshed on Settings open"). The
 * keeper fails soft to its last list and notifies the store; nothing to do while signed out, and
 * a failure here is the keeper's to report through its status — never a throw into a render.
 */
export function refreshChatgptModels(): Promise<void> {
  if (session === undefined) return Promise.resolve();
  const status = session.status();
  if (status === 'unknown' || !status.signedIn) return Promise.resolve();
  return session.listModels(true).then(
    () => undefined,
    () => undefined,
  );
}

/** The plan's cached model list (server order) — empty while signed out or unknown. */
export function chatgptModels(): readonly ChatgptModel[] {
  const status = chatgptPlanStatus();
  return status !== 'unknown' && status.signedIn ? status.models : [];
}

/**
 * The level a model runs on when nobody chose one — the account's own default for it (ADR-0078 §8:
 * unattended steps run on this, never the stored top level). `undefined` for a model the list does
 * not know, or one with no level axis.
 */
export function chatgptDefaultEffortFor(modelId: string | undefined): string | undefined {
  if (modelId === undefined) return undefined;
  return chatgptModels().find((model) => model.id === modelId)?.defaultEffort;
}

// ---------------------------------------------------------------------------------------------
// The acts — delegated, results passed through (an unconfirmed revocation must reach the UI — D7)
// ---------------------------------------------------------------------------------------------

export function signInToChatgpt(opts?: { prompt?: 'consent' }): Promise<SignInResult> {
  if (session === undefined) return Promise.resolve({ ok: false, code: 'sign_in_needed', message: NO_SEAT_MESSAGE });
  // The pending flag brackets the keeper's own promise: set before the browser opens, cleared when
  // the flow ends by any name (success, cancel, a named failure) — so the visible cancel never
  // outlives the flow it would cancel, and never goes before it.
  chatgptSignInPendingStore.set(true);
  const settle = (): void => chatgptSignInPendingStore.set(false);
  const result = session.signIn(opts);
  result.then(settle, settle);
  return result;
}

export function cancelChatgptSignIn(): Promise<void> {
  return session === undefined ? Promise.resolve() : session.cancelSignIn();
}

export function signOutOfChatgpt(): Promise<{ revocation: 'confirmed' | 'unconfirmed' | 'none' }> {
  return session === undefined ? Promise.resolve({ revocation: 'none' }) : session.signOut();
}

export function forgetChatgptRegistration(): Promise<void> {
  return session === undefined ? Promise.resolve() : session.forgetRegistration();
}

// ---------------------------------------------------------------------------------------------
// The bearer adaptation (plan §2 `BearerSource`; D3, D5)
// ---------------------------------------------------------------------------------------------

/**
 * The keeper's codes in the adapter's vocabulary. Five pass through by name; the identity failures
 * (a client or subject that does not match, an ID token that did not check out, an unfinished
 * registration) all mean the session cannot be trusted and the remedy is to sign in again; a
 * revocation outcome never reaches a bearer fetch, and reads the same way if it ever did.
 */
function bearerCodeOf(code: ChatgptPlanErrorCode): BearerFailureCode {
  switch (code) {
    case 'sign_in_needed':
    case 'plan_not_granted':
    case 'network':
    case 'refresh_not_ready':
    case 'usage_unavailable':
      return code;
    case 'usage_limit':
      return 'usage_unavailable';
    case 'client_mismatch':
    case 'registration_incomplete':
    case 'id_token_invalid':
    case 'subject_mismatch':
    case 'revocation_unconfirmed':
      return 'sign_in_needed';
  }
}

/**
 * A failure as a RESULT, never a rejection the adapter must catch (the `hostBrainGone` pattern).
 * A throw the keeper did not name is "unavailable right now, try again": the honest sentence for a
 * fault on this side, and retryable because nothing says the next attempt would meet it.
 */
function toBearerFailure(err: unknown): BearerResult {
  if (err instanceof ChatgptPlanError) return { ok: false, code: bearerCodeOf(err.code), retryable: err.retryable };
  return { ok: false, code: 'usage_unavailable', retryable: true };
}

/** A token on its way to an adapter: remembered for `redact`, most recent last, distinct, bounded. */
function handed(token: string): BearerResult {
  const seen = handedOut.indexOf(token);
  if (seen >= 0) handedOut.splice(seen, 1);
  handedOut.push(token);
  if (handedOut.length > HANDED_OUT_RING) handedOut.shift();
  return { ok: true, token };
}

const NO_KEEPER: BearerResult = { ok: false, code: 'sign_in_needed', retryable: false };

/**
 * The keeper as the Responses adapter's `BearerSource`. `get` asks the keeper PER CALL — the page caches
 * no long-lived token (D2); `refresh(stale)` is the keeper's forced, single-flight refresh (D4);
 * `redact` is the auth side's exact-value scrub over every token this page handed out — the page's
 * set, not a snapshot, so a source taken before a token was minted still masks it.
 */
export function chatgptBearerSource(): BearerSource {
  return {
    get: () => (session === undefined ? Promise.resolve(NO_KEEPER) : session.getAccessToken().then(handed, toBearerFailure)),
    refresh: (stale) => (session === undefined ? Promise.resolve(NO_KEEPER) : session.refreshNow(stale).then(handed, toBearerFailure)),
    redact: (text) => (handedOut.length === 0 ? text : scrubAuthValues(text, Object.fromEntries(handedOut.map((token, i) => [`bearer-${i}`, token])))),
  };
}

// ---------------------------------------------------------------------------------------------
// The close-requested flush (D4)
// ---------------------------------------------------------------------------------------------

/**
 * Resolves once every persist the seat's store has in flight has settled — a write that failed is
 * settled too (the close must never have to catch this; the keeper handles its own failures). A
 * persist chained while waiting (the keeper's serial queue) is waited for as well.
 */
export async function chatgptPlanFlush(): Promise<void> {
  while (persistsInFlight.size > 0) await Promise.allSettled([...persistsInFlight]);
}

/** Test seam: drop the keeper so the next `bootChatgptPlan` builds afresh against the current platform. */
export function resetChatgptPlanForTests(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  session = undefined;
  booting = undefined;
  ready = deferred();
  chatgptPlanStore.set('unknown');
  chatgptSignInPendingStore.set(false);
  handedOut.length = 0;
  persistsInFlight.clear();
}
