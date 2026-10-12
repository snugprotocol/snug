// schedule/executors.ts — the step executors behind `engine-types.ts`'s seam
// (TASK-20261009-scheduling-framework E6; ADR-0074 §5, §6). The queue decides WHEN and claims
// the run; this module decides WHAT one step does, by `step.kind`:
//
//   notify     *Remind me*     — an `ok` inbox result whose summary is the body, plus an `alert`
//                                the executor only SUGGESTS: the queue raises it through the
//                                host's seat when the task's `alert` is `notification`, with
//                                the §6 rules (plain text, capped, prefixed, rate-limited).
//   app-think  *Ask [app]'s AI* — `appThink.ts`: the app's own transport, tool-free, the reply's
//                                data changes dry-run and pending, never executed; since
//                                TASK-20261010-host-broker PR-2 (D-PR2-13) over the tables the
//                                user let the app read *also while away* — `defaultSharedFor`
//                                asks the Access Service for the SCHEDULE caller, records the
//                                read on every source's history BEFORE anything is rendered,
//                                and hands the step only the grants it recorded.
//   app-run    *Run [app]*     — `appRun.ts` (PR-B, ADR-0074 §3; ADR-0077): the kv handshake into
//                                the ONE instance of the app — the open app's live frame under
//                                the run-scoped ask gate, else the ONE hidden frame; the user's
//                                own *run now* on the live frame; refused by name where the host
//                                has no scheduler seat; `capped` before a delegated dispatch.
//
// THE DISCIPLINE EVERY ARM SHARES, in `createStepExecutor`:
//   - an outcome is DATA, never a throw: anything thrown inside an arm is a `failed` outcome
//     carrying the message, nothing spent;
//   - the queue's signal is honoured: aborted before the step starts → `failed` with the fixed
//     "cancelled" summary and no call made; aborted while it ran → the same (the queue is what
//     records the RUN as `interrupted` — the executor only says what happened to the step);
//   - `finalizeOutcome` is the one place result text is made safe to STORE, through
//     `scrub.ts`'s `store` policy (M15): a summary, an alert or a failure message that LOOKS
//     like a credential (`findScheduleCredential` — the same walk the run row's parse refuses
//     on) is WITHHELD whole behind a fixed sentence; what survives is shape-scrubbed and capped
//     at `SCHEDULE_STEP_SUMMARY_MAX_CHARS`; a pending change whose statement or reason carries
//     a credential is dropped, because the run row would otherwise refuse to parse and the
//     tolerant read would lose the whole result (security F12).
//
// `executeStep` is the production composition (`defaultTransportFor` — the brain and the
// settings stores read per call; `defaultSharedFor` — the Access Service through a LAZY edge,
// F13, the scheduler's import cycle below being the reason; `defaultAppRunDeps` — the page's
// mount store and registry); `createStepExecutor(deps)` is the seam the tests inject into, with
// `blockedAppRunDeps()` for a fake that wants every app-run step refused by name (M12).
//
// THE BRAIN GATES (TASK-20261010-host-broker PR-4, D-PR4-15; T-A Q8) run in the production
// composition, which passes `brainRouteFor` — the chat's own route derivation, the app transport's.
// On BOTH paths of an *ask* step, first: the demo override or a keyless BYOK brain → `refused` with
// `blockedBy: 'brain'`, nothing sent, nothing read (that brain would answer a person with a script).
// Then, for a step that may look things up: a route with no data lane (the host, subscription and
// WebLLM brains — `chatDoorOpen`) or an app holding a sidecar fact (the tool loop has no R-9 egress
// scrub, which the app transport applies per send) DEGRADES to the tool-free step, saying why on
// `tools.unavailable`. Otherwise `schedule/appAgent.ts`, reached through a LAZY import: the agent's
// graph loads only when a step needs it, and the host kit — whose brains never pass these gates —
// swaps the module for a loud stub. A composition without `brainRouteFor` (the unit seam) runs every
// *ask* step tool-free, exactly as before PR-4.
//
// *FETCH NEW DATA FIRST* (TASK-20261010-host-broker PR-5, D-PR5-19; F2, F7, D11). An *ask* step
// carrying `refreshFirst` asks the apps its app may read while the person is away to fetch new data
// BEFORE either branch reads them — after the brain gate (a step no brain may answer fetches
// nothing), and on the unit seam too. `access/fetchFirst.ts` is reached through a LAZY import (the
// load-order rule, F6), for the SCHEDULE caller, with the run's seams (`deps.appRun`), the run's
// signal and its spend so far. THE TWO CLOCKS (F2): the fetch's time is measured on the run's clock
// (`ctx.now`, `ctx.boundAt`) — what is left before the queue's bound, less the agent's margin and the
// time the answer itself still needs — and handed over on the dispatchers' clock (`Date.now()`), no
// longer than one app run's own bound; nothing left → nothing dispatched. THE AI RE-CHECK (F7): the
// queue asked the day's ceiling for one AI call before the step; when the fetch spent AI calls of its
// own, it is asked again with them before the brain is — none left → `refused`, `capped: 'ai'`. The
// fetch's calls ride EVERY outcome (a branch that throws, an abort, a refusal) and the step's
// `ctx.spent` counts them, so the agent's own ceiling sees them too. A fetch that failed never fails
// the step: what it came to rides the `fetched` seat (`none` when no app lets it ask any more), and
// `summary` stays exactly the AI's text.

import type { UserDb } from '@snugprotocol/db';
import {
  APP_AGENT_DEADLINE_MARGIN_MS,
  SCHEDULE_STEP_SUMMARY_MAX_CHARS,
  STEP_SAW_MAX_ENTRIES,
  STEP_SAW_NAME_MAX_CHARS,
  findScheduleCredential,
  type ScheduleProposalItem,
  type ScheduleStep,
  type StepFetched,
  type StepSaw,
} from '@snugprotocol/protocol';
import type { AgentTransport } from '@snugprotocol/runner';

import { chatBrainRoute, chatDoorOpen, type ReaderBrainRoute } from '../access/egress.js';
import type { FetchedSource, FetchFirstResult } from '../access/fetchFirst.js';
import type { MaterialisedSet } from '../access/service.js';
import { oneLine } from '../agent/sharedDdl.js';
import { appHasSidecarFact } from '../state/sidecarLive.js';
import { defaultAppRunDeps, executeAppRun, type AppRunDeps } from './appRun.js';
import { CANCELLED_SUMMARY, defaultTransportFor, executeAppThink, keylessBrainGate, type AppThinkDeps, type AppThinkStep } from './appThink.js';
import { capped } from './copy.js';
import type { StepContext, StepExecutor, StepOutcome } from './engine-types.js';
import { ZERO_CALLS, countersSoFar, wouldExceedCeiling, type Calls } from './protection.js';
import { WITHHELD_SUMMARY, scrubOrWithhold } from './scrub.js';
import { messageOf } from './taskShape.js';

export { CANCELLED_SUMMARY } from './appThink.js';
export { blockedAppRunDeps } from './appRun.js';
/** What replaces a text that looked like a credential — its home is `scrub.ts`, which the scheduled agent reads it from too. */
export { WITHHELD_SUMMARY } from './scrub.js';

export interface StepExecutorDeps {
  /** The app's OWN transport, or `undefined` when no brain can answer (the demo brain) — see `appThink.ts`. */
  transportFor(appId: string): AgentTransport | undefined;
  /** The scheduler door's tables for an *Ask the AI* step (PR-2) — absent ⇒ the step sees none; see `appThink.ts`. */
  sharedFor?: AppThinkDeps['sharedFor'];
  /**
   * The brain route an *Ask the AI* step would take for its app NOW (PR-4) — present, the brain
   * gates run (the production composition passes `chatBrainRoute`); absent, every *ask* step runs
   * tool-free, ungated, as before PR-4 (the unit seam).
   */
  brainRouteFor?(db: UserDb, appId: string): ReaderBrainRoute;
  /**
   * The *Run [app]* seams (`appRun.ts`): the platform seat, the hidden mount store, the
   * live-host registry, the runtime composition. Required — a unit fake that wants the arm
   * refused by name passes `blockedAppRunDeps()` rather than leaving the seams out (M12).
   */
  appRun: AppRunDeps;
}

/**
 * The production `sharedFor` (D-PR2-13; C-Q1): the Access Service, reached LAZILY (the cycle
 * below), asked for the SCHEDULE caller — `attended: false` for every trigger, *run now*
 * included, so the step sees exactly the away set — then the read RECORDED on every source's
 * history with every grant id of the set and no statement (the rows go into the prompt) before
 * any context is rendered. Only the grants answered `recorded` reach the brain; a refused one
 * (its access ended meanwhile, or a line the history could not write) is said as a skip.
 */
export async function defaultSharedFor(appId: string, ctx: StepContext): Promise<MaterialisedSet> {
  const { accessService } = await import('../access/service.js');
  const service = accessService();
  const caller = { kind: 'schedule' as const, appId, taskId: ctx.task.id, runId: ctx.run.id };
  const set = await service.materialise(caller);
  const grantIds = [...new Set(set.tables.map((table) => table.grantId))];
  const { recorded, refused } = await service.recordRead(caller, set, { grantIds });
  const kept = new Set(recorded);
  const tables = set.tables.filter((table) => kept.has(table.grantId));
  return { tables, skipped: [...set.skipped, ...refused], readOnlyTables: tables.map((table) => table.name).sort() };
}

/**
 * What the step's answer still needs after its fetch (F2): the fetch may use the time before the
 * queue's bound less the agent's own margin AND this much, so the brain is always asked in time.
 */
export const FETCH_FIRST_ANSWER_RESERVE_MS = 30_000;

/** The `store` policy, then the cap. An empty string stays empty — no sentence is invented. */
function safeText(text: string): string {
  const safe = scrubOrWithhold(text, 'store');
  return safe === undefined ? WITHHELD_SUMMARY : safe.slice(0, SCHEDULE_STEP_SUMMARY_MAX_CHARS);
}

/** A read table's names as the run row may hold them: one line each, capped (R-88). */
function safeSaw(saw: readonly StepSaw[]): StepSaw[] {
  const cut = (text: string): string => oneLine(text).slice(0, STEP_SAW_NAME_MAX_CHARS);
  return saw.slice(0, STEP_SAW_MAX_ENTRIES).map(({ source, table }) => ({ source: cut(source), table: cut(table) }));
}

/** What the fetch came to, as the run row may hold it: one line per source, capped (the `saw` precedent). */
function safeFetched(fetched: readonly StepFetched[]): StepFetched[] {
  return fetched.slice(0, STEP_SAW_MAX_ENTRIES).map(({ source, outcome }) => ({ source: oneLine(source).slice(0, STEP_SAW_NAME_MAX_CHARS), outcome }));
}

function safeProposal(item: ScheduleProposalItem): ScheduleProposalItem | undefined {
  if (findScheduleCredential(item) !== undefined) return undefined;
  const summary = item.summary === undefined ? undefined : scrubOrWithhold(item.summary, 'store');
  const { summary: _raw, ...rest } = item;
  return { ...rest, ...(summary !== undefined ? { summary } : {}) };
}

/** The one place result text is made safe to store (see the module comment). Answers a NEW object. */
export function finalizeOutcome(outcome: StepOutcome): StepOutcome {
  const out: StepOutcome = { status: outcome.status, calls: { ...outcome.calls } };
  // The queue's fold reads it (D-PR1-6) — the kind as found, so the run says WHICH limit (Gate-5 JOBS-F6); never a persisted field.
  if (outcome.capped !== undefined && outcome.capped !== false) out.capped = outcome.capped;
  if (outcome.summary !== undefined) out.summary = safeText(outcome.summary);
  if (outcome.alert !== undefined) out.alert = { title: safeText(outcome.alert.title), body: safeText(outcome.alert.body) };
  if (outcome.proposals !== undefined) {
    const kept = outcome.proposals.map(safeProposal).filter((item): item is ScheduleProposalItem => item !== undefined);
    if (kept.length > 0) out.proposals = kept;
  }
  // PR-4's host facts (D-PR4-17), each only when it has something to say.
  if (outcome.inOpenApp === true) out.inOpenApp = true;
  if (outcome.saw !== undefined && outcome.saw.length > 0) out.saw = safeSaw(outcome.saw);
  if (outcome.fetched !== undefined && outcome.fetched.length > 0) out.fetched = safeFetched(outcome.fetched);
  if (outcome.tools !== undefined) out.tools = outcome.tools;
  if (outcome.blockedBy !== undefined) out.blockedBy = outcome.blockedBy;
  return out;
}

const plus = (a: Calls, b: Calls): Calls => ({ ai: a.ai + b.ai, net: a.net + b.net });

/** One source's answer as the step result says it — a door's own stop is a fetch that did not finish. */
const fetchedOutcome = (source: FetchedSource): StepFetched['outcome'] => (source.outcome === 'stopped' ? 'failed' : source.outcome);

/** The `fetched` seat: one entry per source asked — or `none`, under the step's own app, when no app lets it ask any more. */
function fetchedSeat(asked: readonly FetchedSource[], appName: string): StepFetched[] {
  if (asked.length === 0) return [{ source: appName, outcome: 'none' }];
  return asked.map((source) => ({ source: source.sourceName, outcome: fetchedOutcome(source) }));
}

/**
 * *fetch new data first* for one *ask* step (D-PR5-19): the apps its app may read while the person is
 * away, asked through `fetchFirst` within the time the run has left (F2). `undefined` when the fetch
 * could not even be reached — then nothing was asked, and the step says nothing about it.
 */
async function fetchFirstFor(step: AppThinkStep, ctx: StepContext, deps: StepExecutorDeps): Promise<FetchFirstResult | undefined> {
  // Measured on the run's clock, handed over on the dispatchers' (F2) — never longer than one app run's own bound.
  const left = ctx.boundAt === undefined ? Number.POSITIVE_INFINITY : ctx.boundAt - APP_AGENT_DEADLINE_MARGIN_MS - FETCH_FIRST_ANSWER_RESERVE_MS - ctx.now().getTime();
  const deadline = Date.now() + Math.min(deps.appRun.resultTimeoutMs, left);
  try {
    const { fetchFirst } = await import('../access/fetchFirst.js');
    return await fetchFirst(ctx.db, deps.appRun, { kind: 'schedule', appId: step.appId, taskId: ctx.task.id, runId: ctx.run.id }, { signal: ctx.signal, run: { spent: () => ctx.spent?.() ?? { ...ZERO_CALLS }, deadline } });
  } catch {
    return undefined; // a fetch that could not run is never the step's failure
  }
}

/** The branch the step takes once the brain gate let it through: tool-free, degraded, or the agent — lazily. */
async function answerAsk(step: AppThinkStep, ctx: StepContext, deps: StepExecutorDeps, route: ReaderBrainRoute | undefined): Promise<StepOutcome> {
  if (route === undefined || step.tools !== true) return executeAppThink(step, ctx, deps);
  const unavailable = !chatDoorOpen(route) ? 'brain' : appHasSidecarFact(ctx.db, step.appId) ? 'sidecar' : undefined;
  if (unavailable !== undefined) return { ...(await executeAppThink(step, ctx, deps)), tools: { unavailable } };
  const { executeAppAgent } = await import('./appAgent.js');
  return executeAppAgent(step, ctx);
}

/**
 * An *Ask the AI* step under the production gates (see the module comment): refused for a keyless
 * brain, then — when it asks — the fetch first, then degraded to the tool-free step where tools
 * cannot run, else the agent. The fetch's calls ride whatever the branch answers, a throw included.
 */
async function executeAsk(step: AppThinkStep, ctx: StepContext, deps: StepExecutorDeps): Promise<StepOutcome> {
  const route = deps.brainRouteFor?.(ctx.db, step.appId);
  if (route !== undefined) {
    const refused = keylessBrainGate(ctx.db, step.appId, route);
    if (refused !== undefined) return refused;
  }
  if (step.refreshFirst !== true) return answerAsk(step, ctx, deps, route);

  const fetched = await fetchFirstFor(step, ctx, deps);
  const calls = fetched?.calls ?? { ...ZERO_CALLS };
  const seat: Pick<StepOutcome, 'fetched'> = fetched === undefined ? {} : { fetched: fetchedSeat(fetched.asked, ctx.db.getApp(step.appId)?.displayName ?? step.appId) };
  if (ctx.signal.aborted) return { status: 'failed', summary: CANCELLED_SUMMARY, calls, ...seat };
  const spent = (): Calls => plus(ctx.spent?.() ?? ZERO_CALLS, calls);
  // F7: the queue asked for one AI call's headroom before the step; a fetch that spent AI calls asks again with them.
  if (calls.ai > 0 && wouldExceedCeiling(countersSoFar(ctx.db, spent(), ZERO_CALLS, ctx.now().toISOString()), { ai: 1 }) === 'ai') {
    return { status: 'refused', capped: 'ai', summary: capped('AI call'), calls, ...seat };
  }
  let outcome: StepOutcome;
  try {
    // The branch counts the fetch as spent by the run — the agent's own ceiling sees it.
    outcome = await answerAsk(step, { ...ctx, spent }, deps, route);
  } catch (err) {
    outcome = { status: 'failed', summary: messageOf(err), calls: { ...ZERO_CALLS } };
  }
  return { ...outcome, calls: plus(outcome.calls, calls), ...seat };
}

async function dispatch(step: ScheduleStep, ctx: StepContext, deps: StepExecutorDeps): Promise<StepOutcome> {
  switch (step.kind) {
    case 'notify':
      return { status: 'ok', summary: step.body, calls: { ...ZERO_CALLS }, alert: { title: step.title, body: step.body } };
    case 'app-run':
      return executeAppRun(step, ctx, deps.appRun);
    case 'app-think':
      return executeAsk(step, ctx, deps);
    default: {
      // A row a newer host wrote: `failed` with the kind named, never a throw.
      const unknown: never = step;
      return { status: 'failed', summary: `unknown step kind: ${String((unknown as { kind?: unknown }).kind)}`, calls: { ...ZERO_CALLS } };
    }
  }
}

export function createStepExecutor(deps: StepExecutorDeps): StepExecutor {
  return async (step, ctx) => {
    let outcome: StepOutcome;
    try {
      outcome = ctx.signal.aborted ? { status: 'failed', summary: CANCELLED_SUMMARY, calls: { ...ZERO_CALLS } } : await dispatch(step, ctx, deps);
    } catch (err) {
      outcome = { status: 'failed', summary: messageOf(err), calls: { ...ZERO_CALLS } };
    }
    // Cut short while it ran: say so (what was spent stays charged); the queue records the run.
    if (ctx.signal.aborted) outcome = { status: 'failed', summary: CANCELLED_SUMMARY, calls: outcome.calls };
    return finalizeOutcome(outcome);
  };
}

/**
 * The production executor: the app transport resolved per call from the brain and the settings
 * stores, the brain gates over the chat's route derivation (PR-4), the scheduler door over the
 * Access Service, the *Run [app]* seams over the page's hidden mount store and live-host registry.
 * Composed on FIRST USE, never at load. Re-evaluated at Gate-5 PR-B M8: moving the handshake's
 * names to `scheduleKey.ts` took `appRun.ts` out of the scheduler's imports, but the cycle this
 * guards remains through THIS module — `scheduler.ts` → `executors.ts` → `appRun.ts` →
 * `run/appRuntime.ts` → `state/net.ts` → `state/userdb.ts` → `scheduler.ts` — so a load-time
 * dereference would still hit a binding in its temporal dead zone whichever module the bundle
 * enters the cycle by. The lazy composition stays.
 */
let production: StepExecutor | undefined;
export const executeStep: StepExecutor = (step, ctx) => {
  production ??= createStepExecutor({ transportFor: defaultTransportFor, sharedFor: defaultSharedFor, brainRouteFor: chatBrainRoute, appRun: defaultAppRunDeps() });
  return production(step, ctx);
};
