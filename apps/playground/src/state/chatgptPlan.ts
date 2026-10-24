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
// THE MODEL CHOICE IS WORKED OUT ONCE HERE TOO (Gate 5 ST2): which models the account offers, which
// one a think runs on (a per-app pin → the plan's own `providerModel:chatgpt` row → the account list's
// first, in the server's order — AC8; NEVER the global `model` row, which names an Ollama or hub
// model), which levels that model has and which level is sent (only one the model offers — ST12; an
// unattended step runs on the model's own default — ADR-0078 §8). The adapter arm, the transports, the
// scheduled agent, Settings, the chip and the two selectors all read `chatgptModelView` /
// `resolveChatgptModel` / `chatgptEffortFor` instead of each deriving their own.
//
// `'unknown'` MEANS WAIT (Gate-2 finding F9). The keeper's first store read has not answered yet; a
// launch catch-up step that read "signed out" instead would refuse a valid session. `chatgptPlanReady()`
// resolves only when the status leaves `'unknown'` — a signed-OUT answer releases it too (an answer,
// not an absence). Where no seat exists (web, the hosted build, the host kit) nothing will ever arrive,
// so the status is `{ signedIn: false, registered: false }` and ready resolves at once — the recorded
// deviation from §2's "`'unknown'` on platforms without the seat". BUT NEVER FOR EVER (Gate 5 G5-C1 /
// A1): a hung IPC or a read nobody settles must not stall the desktop, so every boot, restore and
// scheduler chain waits through `chatgptPlanReadyBounded()` — the first read, or the bound — and the
// scheduled gate then refuses a still-unknown status BY NAME rather than hanging a step.
//
// THE REMEMBERED LIMIT (Gate 5 G5-C3 / ST1). The keeper never learns of a usage limit — the route
// answers it to the adapter, per turn. The page remembers the last such answer here (`chatgptLimitStore`,
// set by the observer the chatgpt adapter arm wraps around every adapter it builds, cleared by the next
// ok result) and overlays it on the mirrored status, so the chip's *limit reached* and Settings' limit
// line say what the last turn met.
//
// THE PERSIST IN FLIGHT (D4; §11 "L4-11 addition"; Gate 5 G5-C2 / ST8). A refresh rotates the refresh
// token: once the POST succeeded, the OLD token is dead server-side and the NEW one exists only until the
// keeper writes it. A window close landing in that gap signs the user out for good. The desktop's
// close-requested flush therefore awaits `chatgptPlanFlush()`, which asks the two parties that know about
// a persist in flight: the keeper (`flush()` — a refresh whose POST answered but whose write is not yet
// queued, a sign-in between its callback and its persist) and the seat (`flush?()` — the shell's own IPC
// writes). The page patches nothing: the keeper is handed the seat's store object itself, one custody
// path, pinned by the keeper test.
//
// No `console.*` anywhere on this path: a status or an error here can sit beside a token.

import type { AdapterResult, AgentAdapter, BearerFailureCode, BearerResult, BearerSource } from '@snugprotocol/adapters';
import { CHATGPT_ERROR_CODES } from '@snugprotocol/adapters';
import {
  ChatgptPlanError,
  createChatgptPlanSession,
  scrubAuthValues,
  type ChatgptModel,
  type ChatgptPlanErrorCode,
  type ChatgptPlanSession,
  type ChatgptPlanSessionDeps,
  type ChatgptPlanStatus,
  type SignInResult,
} from '@snugprotocol/auth';

import { getPlatform } from '../platform/platform.js';
import { chatgptEffortStore, chatgptModelStore, hasChatgptSeat } from './mode.js';
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

/**
 * How long a boot, restore or scheduler chain waits for the keeper's first read before it proceeds
 * (G5-C1): long enough for a cold IPC round trip, short enough that a hung one never stalls the desktop.
 */
export const CHATGPT_READY_BOUND_MS = 3_000;

/** The keeper's status as every surface reads it; `'unknown'` until the first store read answers. */
export const chatgptPlanStore = createStore<ChatgptPlanStatus>('unknown');

/**
 * A sign-in is out in the system browser (L5-1; AC2). ONE flag for every surface that can start a
 * sign-in — the Welcome card and the Settings card — so each shows the awaiting hint and the
 * visible cancel for the same window, and neither offers a second "Continue" while one is open.
 */
export const chatgptSignInPendingStore = createStore<boolean>(false);

/** The last usage-limit answer a turn met on the plan, while it stands (G5-C3) — see the header. */
export type ChatgptLimit = NonNullable<Extract<ChatgptPlanStatus, { signedIn: true }>['limit']>;

export const chatgptLimitStore = createStore<ChatgptLimit | undefined>(undefined);

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
/** The first read has answered (or there is no seat): the bounded wait starts no timer. */
let readyAnswered = false;
/** Every bearer this page handed an adapter, most recent last — what `redact` scrubs (exact values). */
const handedOut: string[] = [];
/** How many bearers were ever handed out — a step compares before and after a send (see `chatgptBearersHandedOut`). */
let handedCount = 0;

/** The store's value, with "no seat" read as the signed-out, unregistered state it is, and the remembered limit overlaid. */
function statusOf(stored: ChatgptPlanStatus): ChatgptPlanStatus {
  if (stored === 'unknown') return hasChatgptSeat() ? stored : NO_SEAT_STATUS;
  if (!stored.signedIn) return stored;
  const limit = chatgptLimitStore.get();
  return limit === undefined ? stored : { ...stored, limit };
}

/** The keeper's status into the store; the first answer releases every `chatgptPlanReady()` waiter. */
function mirror(): void {
  if (session === undefined) return;
  const status = session.status();
  chatgptPlanStore.set(status);
  if (status !== 'unknown') {
    readyAnswered = true;
    ready.resolve();
  }
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
    readyAnswered = true;
    ready.resolve();
    booting = ready.promise;
    return booting;
  }
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
  if (session === undefined && !hasChatgptSeat()) return Promise.resolve();
  return ready.promise;
}

const realWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `chatgptPlanReady()`, or `CHATGPT_READY_BOUND_MS` — whichever comes first (G5-C1). What every
 * composition root awaits before it starts the scheduler, and what the scheduled gate awaits before it
 * reads the status: a first read that never answers must not stall the desktop for every user in every
 * mode. A status still `'unknown'` afterwards is the gate's to refuse BY NAME. `wait` is injectable
 * for the suites; without a seat nothing is waited for.
 */
export function chatgptPlanReadyBounded(wait: (ms: number) => Promise<void> = realWait): Promise<void> {
  if (readyAnswered || (session === undefined && !hasChatgptSeat())) return Promise.resolve();
  return Promise.race([ready.promise, wait(CHATGPT_READY_BOUND_MS)]);
}

/** Non-hook read for factories and gates (the `currentBrain()` precedent). */
export function chatgptPlanStatus(): ChatgptPlanStatus {
  return statusOf(chatgptPlanStore.get());
}

/** Store-reactive read for the chip, Settings and the Welcome card — the remembered limit included. */
export function useChatgptPlan(): ChatgptPlanStatus {
  const stored = useStore(chatgptPlanStore);
  useStore(chatgptLimitStore);
  return statusOf(stored);
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
// The model choice — ONE derivation for the adapter arm and every surface (ST2; AC8; D6)
// ---------------------------------------------------------------------------------------------

/**
 * The model a chatgpt turn runs on: the caller's (a per-app pin, resolved per send) → the plan's
 * default row → the first model of the account's list, in the server's order (AC8). NEVER the
 * global `model` row — that names an Ollama or hub model. ONE fallback for the constructor, the
 * transport (which needs the model to look up its default level) and the scheduled agent.
 */
export function resolveChatgptModel(explicit?: string): string | undefined {
  return explicit ?? chatgptModelStore.get() ?? chatgptModels()[0]?.id;
}

/**
 * The thinking level a chatgpt turn carries (D6; ADR-0078 §8; Gate 5 ST12 / A3). Interactive turns
 * send the stored `providerEffort:chatgpt` row, read PER SEND — but only when the resolved model
 * OFFERS that level: a level the model lacks is a request the route refuses, with the control to fix
 * it hidden (the Haiku rule hides the level control for a model without levels). An UNATTENDED turn
 * (a scheduled step, with or without tools) runs on the model's own default level from the account's
 * list — never the stored one, never the top one: nobody is watching the spend. `undefined` means no
 * level is sent.
 */
export function chatgptEffortFor(model: string | undefined, unattended: boolean): string | undefined {
  const resolved = chatgptModels().find((candidate) => candidate.id === resolveChatgptModel(model));
  if (unattended) return resolved?.defaultEffort;
  const stored = chatgptEffortStore.get();
  return stored !== undefined && resolved !== undefined && resolved.efforts.includes(stored) ? stored : undefined;
}

/** What every surface that offers a model choice on the plan renders from — see `chatgptModelView`. */
export interface ChatgptModelView {
  /** The ACCOUNT's models, server order (D6) — empty while signed out or unknown. */
  models: readonly ChatgptModel[];
  /** The plan's default: the stored `providerModel:chatgpt` row, else the account list's first. */
  defaultId: string | undefined;
  /** The default's display name — the id itself when the plan no longer lists it (Rule 3: never hidden). */
  defaultName: string | undefined;
  /** The model a think would run on — the pin when given, else the default — when the list knows it. */
  resolved: ChatgptModel | undefined;
  /** That model's id when the plan does NOT list it — said, never silently "default". */
  unlisted: string | undefined;
  /** The resolved model's levels — empty means no level control (ADR-0070's Haiku rule). */
  levels: readonly string[];
}

export function chatgptModelView(status: ChatgptPlanStatus, stored: string | undefined, pin?: string): ChatgptModelView {
  const models = status !== 'unknown' && status.signedIn ? status.models : [];
  const defaultId = stored ?? models[0]?.id;
  const defaultName = defaultId === undefined ? undefined : (models.find((model) => model.id === defaultId)?.name ?? defaultId);
  const chosen = pin ?? defaultId;
  const resolved = models.find((model) => model.id === chosen);
  return {
    models,
    defaultId,
    defaultName,
    resolved,
    unlisted: chosen !== undefined && resolved === undefined ? chosen : undefined,
    levels: resolved?.efforts ?? [],
  };
}

/** The ONE label for the inherit option on the plan — Settings, the chip and both selectors say the same words. */
export function chatgptDefaultLabel(view: ChatgptModelView): string {
  return `default (${view.defaultName ?? 'your plan’s choice'})`;
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
 * A throw the keeper did not name (a write IPC error, a thrown string) is a fault on THIS side of
 * the wire: `network`, retryable — never `usage_unavailable`, whose sentence would blame the plan's
 * usage for a session file that could not be written (Gate 5 G5-A8).
 */
function toBearerFailure(err: unknown): BearerResult {
  if (err instanceof ChatgptPlanError) return { ok: false, code: bearerCodeOf(err.code), retryable: err.retryable };
  return { ok: false, code: 'network', retryable: true };
}

/** A token on its way to an adapter: remembered for `redact`, most recent last, distinct, bounded; counted. */
function handed(token: string): BearerResult {
  const seen = handedOut.indexOf(token);
  if (seen >= 0) handedOut.splice(seen, 1);
  handedOut.push(token);
  if (handedOut.length > HANDED_OUT_RING) handedOut.shift();
  handedCount += 1;
  return { ok: true, token };
}

/**
 * How many bearers this page has handed adapters so far — a monotonic count. A scheduled step reads
 * it before and after a send: a `CHATGPT_*` failure with no bearer handed in between never left the
 * page (the keeper refused before any request), so it is not charged as an AI call (Gate 5 G5-C11).
 */
export function chatgptBearersHandedOut(): number {
  return handedCount;
}

const NO_KEEPER: BearerResult = { ok: false, code: 'sign_in_needed', retryable: false };

/**
 * The keeper as the Responses adapter's `BearerSource`. `get` asks the keeper PER CALL — the page caches
 * no long-lived token (D2); `refresh(stale)` is the keeper's forced, single-flight refresh (D4);
 * `invalidate(stale)` tells the keeper the route refused the RETRY's bearer, so its status stops saying
 * signed in while every send burns a refresh and two requests (G5-C4); `redact` is the auth side's
 * exact-value scrub over every token this page handed out — the page's set, not a snapshot, so a
 * source taken before a token was minted still masks it.
 */
export function chatgptBearerSource(): BearerSource {
  return {
    get: () => (session === undefined ? Promise.resolve(NO_KEEPER) : session.getAccessToken().then(handed, toBearerFailure)),
    refresh: (stale) => (session === undefined ? Promise.resolve(NO_KEEPER) : session.refreshNow(stale).then(handed, toBearerFailure)),
    invalidate: (stale) => (session === undefined ? Promise.resolve() : session.reportRejected(stale)),
    redact: (text) => (handedOut.length === 0 ? text : scrubAuthValues(text, Object.fromEntries(handedOut.map((token, i) => [`bearer-${i}`, token])))),
  };
}

// ---------------------------------------------------------------------------------------------
// The remembered limit (G5-C3)
// ---------------------------------------------------------------------------------------------

/** What a turn's result says about the plan's limit: set on the two limit codes, cleared on an ok reply, else untouched. */
function observeChatgptResult(result: AdapterResult, now: () => number): void {
  if (result.ok) {
    if (chatgptLimitStore.get() !== undefined) chatgptLimitStore.set(undefined);
    return;
  }
  if (result.code === CHATGPT_ERROR_CODES.USAGE_LIMIT) chatgptLimitStore.set({ at: now(), code: 'usage_limit' });
  else if (result.code === CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE) chatgptLimitStore.set({ at: now(), code: 'usage_unavailable' });
}

/**
 * `inner`, with every result it answers observed for the plan's limit — the chatgpt adapter arm wraps
 * each adapter it builds in this. The same adapter otherwise (its own members ride along), so a seat
 * that recognises the constructed adapter still does.
 */
export function withChatgptLimitObserver(inner: AgentAdapter, now: () => number = Date.now): AgentAdapter {
  return {
    ...inner,
    async complete(request) {
      const result = await inner.complete(request);
      observeChatgptResult(result, now);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The close-requested flush (D4; G5-C2 / ST8)
// ---------------------------------------------------------------------------------------------

/**
 * Resolves once the keeper has no persist in flight (its `flush()`) AND the seat has no write in
 * flight (its `flush?()`, when the shell offers one). Settled, never a rejection the close must catch:
 * a flush that failed is a flush that finished.
 */
export async function chatgptPlanFlush(): Promise<void> {
  const seat = getPlatform().chatgptPlan;
  await Promise.allSettled([
    session === undefined ? Promise.resolve() : session.flush(),
    Promise.resolve().then(() => seat?.flush?.()),
  ]);
}

/** Test seam: drop the keeper so the next `bootChatgptPlan` builds afresh against the current platform. */
export function resetChatgptPlanForTests(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  session = undefined;
  booting = undefined;
  ready = deferred();
  readyAnswered = false;
  chatgptPlanStore.set('unknown');
  chatgptSignInPendingStore.set(false);
  chatgptLimitStore.set(undefined);
  handedOut.length = 0;
  handedCount = 0;
}
