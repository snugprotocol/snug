/**
 * gatedAdapter — the scheduled agent's AI-call ceiling, AT the adapter (TASK-20261010-host-broker
 * PR-4, D-PR4-15; feasibility F8).
 *
 * WHY THE WRAPPER AND NOT A PRE-CHECK. The queue asks for headroom for ONE AI call before an
 * *Ask* step starts, which is the whole cost of the tool-free step. The agent's tool loop can
 * make up to ten round trips, and every one of them is an AI call the day's ceiling must admit
 * — and `runAgentTurn`'s only pre-send hook is synchronous and cannot refuse. So the question is
 * asked where the call is made: on EVERY `complete()`, the file's counters for the day of the
 * injected clock, plus what the run already spent, plus what this step spent so far, plus one.
 * No headroom → `CAPPED` and the inner adapter is never called: nothing more is sent.
 *
 * WHAT IS COUNTED. `soFar.ai` moves only when the wrapper DELEGATES — the attempt is the call,
 * so a delegated call that fails (or throws) still counts — with the scheduler's one exception
 * (`schedule/scrub.ts`): F15's `CONSENT_REQUIRED` refused before any provider was touched, so
 * nothing left the page and nothing is charged. `soFar` is a mutable tally the step SHARES with
 * its fetch tool's network counting; it is read fresh at every call, never captured.
 */

import type { AdapterResult, AgentAdapter } from '@snugprotocol/adapters';
import { ERROR_CODES } from '@snugprotocol/protocol';

import { capped } from '../schedule/copy.js';
import { ZERO_CALLS, countersSoFar, wouldExceedCeiling, type Calls, type SchedulerStateSeat } from '../schedule/protection.js';

/** The code a call refused at the day's AI ceiling answers with — not a wire code; the agent maps it to a capped step. */
export const AI_CEILING_CODE = 'CAPPED';

/** What the wrapper asks the ceiling with — the step's seats, each read at the call. */
export interface AiCallAdmission {
  /** The scheduler-state seat — the day's counters live in the file. */
  db: SchedulerStateSeat;
  /** What the steps before this one already spent on the run. */
  spent?: (() => Calls) | undefined;
  /** This step's own tally, shared with its fetch tool; the wrapper writes `ai`. */
  soFar: Calls;
  /** The step's clock — the day is its UTC date, never the wall clock's. */
  now: () => Date;
  /**
   * A delegated call whose failure never left the page (Gate 5 G5-C11): the ChatGPT-plan keeper
   * refusing a bearer BEFORE any request was made is not an AI call, like F15's `CONSENT_REQUIRED`.
   * The caller knows (it wrapped the adapter); the wrapper asks and un-counts.
   */
  uncharged?: (result: AdapterResult) => boolean;
}

/** `inner`, asking the day's AI ceiling before every call it passes on. */
export function gatedAdapter(inner: AgentAdapter, admit: AiCallAdmission): AgentAdapter {
  return {
    async complete(request) {
      const counters = countersSoFar(admit.db, admit.spent?.() ?? ZERO_CALLS, admit.soFar, admit.now().toISOString());
      if (wouldExceedCeiling(counters, { ai: 1 }) === 'ai') {
        return { ok: false, code: AI_CEILING_CODE, message: capped('AI call'), retryable: false };
      }
      admit.soFar.ai += 1;
      const result = await inner.complete(request);
      if (!result.ok && (result.code === ERROR_CODES.CONSENT_REQUIRED || admit.uncharged?.(result) === true)) admit.soFar.ai -= 1;
      return result;
    },
  };
}
