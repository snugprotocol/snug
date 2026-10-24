// schedule/chatgptOutcome.ts — the ONE policy for a scheduled step's reply on the ChatGPT plan
// (TASK-20261023-siwc-chatgpt-plan L4-7, AC7, AC14; ADR-0078 §8; Gate 5 G5-C11 / ST10).
//
// Two executors ask the plan — the tool-free *ask* step (`appThink.ts`, through the app transport)
// and the agent that can look things up (`appAgent.ts`, through its own adapter) — and before Gate 5
// each carried its own copy of what the four `CHATGPT_*` codes mean for a step. This module is the
// one statement, in three parts the two share:
//
//   `chatgptStepOutcome(reply, calls)`  — the four codes as step outcomes. A USAGE LIMIT is a REFUSAL
//     by name, by code — never a failure the queue would retry whatever the reply claims about
//     retryability — and its summary is EXACTLY the adapters' fixed sentence, so the result page
//     recognises it by comparing to the same bytes (`stepResultSchema` carries no code); it carries NO
//     `blockedBy` (not a brain-missing state). USAGE UNAVAILABLE after its one retry is `failed`,
//     retryable. SIGN IN NEEDED / PLAN NOT GRANTED mid-run are `failed` by name. Any other code is not
//     this module's — `undefined`, today's policy.
//   `sendOnPlan(send)` / `planSendTracking(adapter)`  — whether a `CHATGPT_*` failure REACHED the route.
//     The keeper refusing a bearer before any request (signed out, a refresh not ready, the session file
//     unwritable) answers the same code the route would, but nothing left the page and nothing is
//     charged as an AI call (G5-C11): the page counts the bearers it hands out, and a send that saw none
//     handed never reached the brain.
//   `retryUnavailableOnce(adapter, wait)`  — the ONE retry of a `CHATGPT_USAGE_UNAVAILABLE` answer after
//     `CHATGPT_UNAVAILABLE_RETRY_MS`, for the agent path; the tool-free step makes the same retry around
//     its transport send. A second such answer is the step's failure.

import { CHATGPT_ERROR_CODES, CHATGPT_ERROR_SENTENCES, type AdapterResult, type AgentAdapter, type ChatgptErrorCode } from '@snugprotocol/adapters';

import { chatgptBearersHandedOut } from '../state/chatgptPlan.js';
import type { StepOutcome } from './engine-types.js';
import type { Calls } from './protection.js';

/** The pause before the one retry of a `CHATGPT_USAGE_UNAVAILABLE` reply (L4-7). */
export const CHATGPT_UNAVAILABLE_RETRY_MS = 1_500;

const CHATGPT_CODES = new Set<string>(Object.values(CHATGPT_ERROR_CODES));

/** Whether `code` is one of the plan route's four named codes. */
export function isChatgptCode(code: string): code is ChatgptErrorCode {
  return CHATGPT_CODES.has(code);
}

/** A failed reply as either executor sees it — the transport's or the adapter's error shape. */
export interface PlanFailure {
  ok: false;
  code: string;
}

/**
 * The step outcome for a `CHATGPT_*` failure, or `undefined` for any other code (the caller's policy
 * stands). `calls` is what the caller charged — the attempts that reached the brain.
 */
export function chatgptStepOutcome(reply: PlanFailure, calls: Calls): StepOutcome | undefined {
  switch (reply.code) {
    case CHATGPT_ERROR_CODES.USAGE_LIMIT:
      return { status: 'refused', summary: CHATGPT_ERROR_SENTENCES[CHATGPT_ERROR_CODES.USAGE_LIMIT], calls };
    case CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE:
      return { status: 'failed', summary: CHATGPT_ERROR_SENTENCES[CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE], calls, retryable: true };
    case CHATGPT_ERROR_CODES.SIGN_IN_NEEDED:
      return { status: 'failed', summary: CHATGPT_ERROR_SENTENCES[CHATGPT_ERROR_CODES.SIGN_IN_NEEDED], calls };
    case CHATGPT_ERROR_CODES.PLAN_NOT_GRANTED:
      return { status: 'failed', summary: CHATGPT_ERROR_SENTENCES[CHATGPT_ERROR_CODES.PLAN_NOT_GRANTED], calls };
    default:
      return undefined;
  }
}

/**
 * Run `send` and say whether it REACHED the route: every reply but a `CHATGPT_*` failure during which
 * no bearer was handed out did (a non-plan reply is another brain's, always charged). Read around the
 * one send, so a parallel turn handing a bearer can only ever over-charge — never hide a real call.
 */
export async function sendOnPlan<T extends { ok: boolean; code?: string }>(send: () => Promise<T>): Promise<{ reply: T; reachedRoute: boolean }> {
  const before = chatgptBearersHandedOut();
  const reply = await send();
  const planFailure = !reply.ok && reply.code !== undefined && isChatgptCode(reply.code);
  return { reply, reachedRoute: !planFailure || chatgptBearersHandedOut() > before };
}

/** An adapter whose pre-send plan failures are remembered, so the AI-call gate can leave them uncharged (`AiCallAdmission.uncharged`). */
export function planSendTracking(inner: AgentAdapter): { adapter: AgentAdapter; preSend: (result: AdapterResult) => boolean } {
  const preSend = new WeakSet<object>();
  return {
    preSend: (result) => preSend.has(result),
    adapter: {
      async complete(request) {
        const { reply, reachedRoute } = await sendOnPlan(() => inner.complete(request));
        if (!reachedRoute) preSend.add(reply);
        return reply;
      },
    },
  };
}

/**
 * `inner`, retrying ONE `CHATGPT_USAGE_UNAVAILABLE` answer per step after `wait(CHATGPT_UNAVAILABLE_RETRY_MS)`
 * — the route said it is unavailable right now, a 503 before any stream; a second such answer stands.
 * Never retried on a signal that already fired.
 */
export function retryUnavailableOnce(inner: AgentAdapter, wait: (ms: number) => Promise<void>): AgentAdapter {
  let retried = false;
  return {
    async complete(request) {
      const first = await inner.complete(request);
      if (first.ok || first.code !== CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE || retried || request.signal?.aborted === true) return first;
      retried = true;
      await wait(CHATGPT_UNAVAILABLE_RETRY_MS);
      return inner.complete(request);
    },
  };
}
