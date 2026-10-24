// The kit's `state/chatgptPlan.ts` (TASK-20261023-siwc-chatgpt-plan, Gate 5 G5-1): the page's ONE
// ChatGPT-plan keeper — built from the custody seat the shell hands the page
// (`getPlatform().chatgptPlan`, ADR-0078 §1–§2), mirroring its status, delegating the acts and
// adapting it to the Responses adapter's bearer seam. NO KIT PLATFORM CARRIES THE SEAT: the desktop's
// shell keeps the session file and gives the page the seat; the probe's bindings, the local runner
// and the refusal table never do. The real module already answers a seatless platform with exactly
// one set of answers — status `{ signedIn: false, registered: false }`, `chatgptPlanReady()` resolved
// at once (L4-11's recorded deviation: `'unknown'` means WAIT, and here nothing will ever arrive),
// every act a named refusal or a no-op, a bearer source that says `sign_in_needed`, an empty model
// list, nothing in flight — and in the kit those are the ONLY answers it can ever give. This stub
// gives them and nothing else, so `@snugprotocol/auth`'s keeper never enters the page.
//
// Not loud, unlike the data-lane stubs: these calls ARE reached in the kit — `App.tsx` boots the
// keeper, the scheduler and the executors await `chatgptPlanReady()`, the brain chip reads the
// status — so the answers are the real module's seatless ones, byte for byte where a consumer
// compares. `apps/host/vite.config.ts` swaps the module by resolved path; `kitDeadLanes.test.ts` §7
// pins the swap, the no-seat invariant (`availableModes()` never offers `chatgpt` under a kit
// platform) and this surface, and mirrors the real module's type surface with `expectTypeOf`. The
// playground and the desktop keep the real module.

import type { BearerResult, BearerSource } from '@snugprotocol/adapters';
import type { ChatgptModel, ChatgptPlanSession, ChatgptPlanSessionDeps, ChatgptPlanStatus, SignInResult } from '@snugprotocol/auth';

import type { Store } from '@playground/state/store.js';

/** The real module's injectable constructor — accepted and ignored: no seat, so no keeper to build. */
export type CreateChatgptPlanSession = (deps: ChatgptPlanSessionDeps) => ChatgptPlanSession;

/** No seat on this platform: signed out, nothing registered, and nothing will ever change that here. */
const NO_SEAT_STATUS: ChatgptPlanStatus = { signedIn: false, registered: false };

/** The sentence an act answers where no seat exists — the real module's own words. */
const NO_SEAT_MESSAGE = 'Signing in with ChatGPT needs the Snug desktop app — this build has no place to keep the session.';

const NO_KEEPER: BearerResult = { ok: false, code: 'sign_in_needed', retryable: false };

/** A store that holds one value for good: a set is ignored, a subscriber is never called. */
function constantStore<T>(value: T): Store<T> {
  return {
    get: () => value,
    set: () => undefined,
    subscribe: () => () => undefined,
  };
}

export const chatgptPlanStore: Store<ChatgptPlanStatus> = constantStore(NO_SEAT_STATUS);

export const chatgptSignInPendingStore: Store<boolean> = constantStore(false);

export function bootChatgptPlan(_create?: CreateChatgptPlanSession): Promise<void> {
  return Promise.resolve();
}

export function chatgptPlanReady(): Promise<void> {
  return Promise.resolve();
}

export function chatgptPlanStatus(): ChatgptPlanStatus {
  return NO_SEAT_STATUS;
}

/** A constant needs no subscription — the hook-shaped name is kept for the surfaces that call it. */
export function useChatgptPlan(): ChatgptPlanStatus {
  return NO_SEAT_STATUS;
}

export function useChatgptSignInPending(): boolean {
  return false;
}

export function refreshChatgptModels(): Promise<void> {
  return Promise.resolve();
}

export function chatgptModels(): readonly ChatgptModel[] {
  return [];
}

export function chatgptDefaultEffortFor(_modelId: string | undefined): string | undefined {
  return undefined;
}

export function signInToChatgpt(_opts?: { prompt?: 'consent' }): Promise<SignInResult> {
  return Promise.resolve({ ok: false, code: 'sign_in_needed', message: NO_SEAT_MESSAGE });
}

export function cancelChatgptSignIn(): Promise<void> {
  return Promise.resolve();
}

export function signOutOfChatgpt(): Promise<{ revocation: 'confirmed' | 'unconfirmed' | 'none' }> {
  return Promise.resolve({ revocation: 'none' });
}

export function forgetChatgptRegistration(): Promise<void> {
  return Promise.resolve();
}

/** No keeper, so no bearer and nothing handed out to scrub — the text comes back as it went in. */
export function chatgptBearerSource(): BearerSource {
  return {
    get: () => Promise.resolve(NO_KEEPER),
    refresh: () => Promise.resolve(NO_KEEPER),
    redact: (text) => text,
  };
}

export function chatgptPlanFlush(): Promise<void> {
  return Promise.resolve();
}

export function resetChatgptPlanForTests(): void {
  // Nothing was built, so there is nothing to drop.
}
