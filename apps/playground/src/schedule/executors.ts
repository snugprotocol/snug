// schedule/executors.ts — the step executors behind `engine-types.ts`'s seam
// (TASK-20261009-scheduling-framework E6; ADR-0074 §5, §6). The queue decides WHEN and claims
// the run; this module decides WHAT one step does, by `step.kind`:
//
//   notify     *Remind me*     — an `ok` inbox result whose summary is the body, plus an `alert`
//                                the executor only SUGGESTS: the queue raises it through the
//                                host's seat when the task's `alert` is `notification`, with
//                                the §6 rules (plain text, capped, prefixed, rate-limited).
//   app-think  *Ask [app]'s AI* — `appThink.ts`: the app's own transport, tool-free, the reply's
//                                data changes dry-run and pending, never executed.
//   app-run    *Run [app]*     — `refused` by name in PR-A. PR-B replaces this arm with the
//                                hidden-frame handshake (ADR-0074 §3); until then the step is
//                                recorded as refused, not silently skipped, so the result page
//                                says why nothing ran.
//
// THE DISCIPLINE EVERY ARM SHARES, in `createStepExecutor`:
//   - an outcome is DATA, never a throw: anything thrown inside an arm is a `failed` outcome
//     carrying the message, nothing spent;
//   - the queue's signal is honoured: aborted before the step starts → `failed` with the fixed
//     "cancelled" summary and no call made; aborted while it ran → the same (the queue is what
//     records the RUN as `interrupted` — the executor only says what happened to the step);
//   - `finalizeOutcome` is the one place result text is made safe to store: a summary, an alert
//     or a failure message that LOOKS like a credential (`findScheduleCredential` — the same
//     walk the run row's parse refuses on) is WITHHELD whole behind a fixed sentence; what
//     survives is shape-scrubbed (`scrubCredentialProse`) and capped at
//     `SCHEDULE_STEP_SUMMARY_MAX_CHARS`; a pending change whose statement or reason carries a
//     credential is dropped, because the run row would otherwise refuse to parse and the
//     tolerant read would lose the whole result (security F12).
//
// `executeStep` is the production composition (`defaultTransportFor` — the brain and the
// settings stores read per call); `createStepExecutor(deps)` is the seam the tests inject into.

import { SCHEDULE_STEP_SUMMARY_MAX_CHARS, findScheduleCredential, type ScheduleProposalItem, type ScheduleStep } from '@snugprotocol/protocol';
import type { AgentTransport } from '@snugprotocol/runner';

import { scrubCredentialProse } from '../security/credentialShapes.js';
import { CANCELLED_SUMMARY, defaultTransportFor, executeAppThink } from './appThink.js';
import type { StepContext, StepExecutor, StepOutcome } from './engine-types.js';

export { CANCELLED_SUMMARY } from './appThink.js';

export interface StepExecutorDeps {
  /** The app's OWN transport, or `undefined` when no brain can answer (the demo brain) — see `appThink.ts`. */
  transportFor(appId: string): AgentTransport | undefined;
}

/** What replaces a summary, an alert line or a failure message that looked like a credential. */
export const WITHHELD_SUMMARY = 'a result was withheld because it looked like a credential';

/** The PR-A answer for a *Run [app]* step. */
export const APP_RUN_LATER_SUMMARY = 'running an app on a schedule arrives in a later release';

const none = (): StepOutcome['calls'] => ({ ai: 0, net: 0 });

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : String(err);
}

/** Refuse whole, else scrub shapes and cap. An empty string stays empty — no sentence is invented. */
function safeText(text: string): string {
  if (text === '') return text;
  if (findScheduleCredential({ text }) !== undefined) return WITHHELD_SUMMARY;
  return scrubCredentialProse(text).slice(0, SCHEDULE_STEP_SUMMARY_MAX_CHARS);
}

function safeProposal(item: ScheduleProposalItem): ScheduleProposalItem | undefined {
  if (findScheduleCredential(item) !== undefined) return undefined;
  return { ...item, ...(item.summary !== undefined ? { summary: scrubCredentialProse(item.summary) } : {}) };
}

/** The one place result text is made safe to store (see the module comment). Answers a NEW object. */
export function finalizeOutcome(outcome: StepOutcome): StepOutcome {
  const out: StepOutcome = { status: outcome.status, calls: { ...outcome.calls } };
  if (outcome.summary !== undefined) out.summary = safeText(outcome.summary);
  if (outcome.alert !== undefined) out.alert = { title: safeText(outcome.alert.title), body: safeText(outcome.alert.body) };
  if (outcome.proposals !== undefined) {
    const kept = outcome.proposals.map(safeProposal).filter((item): item is ScheduleProposalItem => item !== undefined);
    if (kept.length > 0) out.proposals = kept;
  }
  return out;
}

async function dispatch(step: ScheduleStep, ctx: StepContext, deps: StepExecutorDeps): Promise<StepOutcome> {
  switch (step.kind) {
    case 'notify':
      return { status: 'ok', summary: step.body, calls: none(), alert: { title: step.title, body: step.body } };
    case 'app-run':
      return { status: 'refused', summary: APP_RUN_LATER_SUMMARY, calls: none() };
    case 'app-think':
      return executeAppThink(step, ctx, deps);
    default: {
      // A row a newer host wrote: `failed` with the kind named, never a throw.
      const unknown: never = step;
      return { status: 'failed', summary: `unknown step kind: ${String((unknown as { kind?: unknown }).kind)}`, calls: none() };
    }
  }
}

export function createStepExecutor(deps: StepExecutorDeps): StepExecutor {
  return async (step, ctx) => {
    let outcome: StepOutcome;
    try {
      outcome = ctx.signal.aborted ? { status: 'failed', summary: CANCELLED_SUMMARY, calls: none() } : await dispatch(step, ctx, deps);
    } catch (err) {
      outcome = { status: 'failed', summary: errorMessage(err), calls: none() };
    }
    // Cut short while it ran: say so (what was spent stays charged); the queue records the run.
    if (ctx.signal.aborted) outcome = { status: 'failed', summary: CANCELLED_SUMMARY, calls: outcome.calls };
    return finalizeOutcome(outcome);
  };
}

/** The production executor: the app transport resolved per call from the brain and the settings stores. */
export const executeStep: StepExecutor = createStepExecutor({ transportFor: defaultTransportFor });
