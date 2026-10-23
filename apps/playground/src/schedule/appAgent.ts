// schedule/appAgent.ts — *Ask <App>'s AI* that can look things up (TASK-20261010-host-broker PR-4,
// D-PR4-14, D-PR4-15, D-PR4-16, D-PR4-17; ADR-0076 §9; feasibility F7, F8, F9; security S6).
//
// THE ONE IDEA. An *ask* step with `tools: true` is ONE agent turn the host runs itself — the app
// never opens — over three tools: `data_query` (the app's own data, and lazily the tables the user
// let it read from other apps), the scheduled `data_propose_write` (changes for the result, through
// the one proposal gate) and `fetch_connection` (GET-only through the app's approved connections).
// There is no data-lane turn body to lift (the chat's is one body for every lane), so this module is
// the fifth `runAgentTurn` call site: it builds its own adapter, system and tools, decides caching,
// and reads the loop's events for nothing but its own accounting — a scheduled run has no inspector.
//
// THE GATES RUN FIRST, in `executors.ts`: the demo override and a keyless BYOK brain are refused, and
// a brain that cannot run the data lane or an app holding a sidecar fact degrades to the tool-free
// step; this module is reached — LAZILY, and swapped for a loud stub in the host kit, whose brains
// never pass those gates — only after them. The lazy import is a window in which Settings can change
// the brain, so the route is read ONCE more here, immediately before the adapter is built, and judged
// by the same rule (Gate-5 JOBS-F3): the keyless gate's own refusal, or `tools.unavailable: 'brain'`
// for a route with no data lane. The adapter's config is built FROM that route — never re-derived by
// hand — and a config the adapter would route anywhere else throws: a demo script must never answer
// a person, and a tool loop must never run on a brain with no data lane. Nothing is read before that.
//
// THE BOUNDS, each where the cost is incurred:
//   - every AI call asks the day's ceiling AT the adapter (`agent/gatedAdapter.ts`) — `CAPPED`
//     answers without calling the brain, and the step is `capped: 'ai'`;
//   - at most `APP_AGENT_MAX_ROUND_TRIPS` round trips (the loop's own cap — hitting it reads *looked
//     things up N times and ran out of turns*) and `APP_AGENT_MAX_TOOL_CALLS` tool calls (ONE counter
//     over all three tools; the ninth answers the cap sentence);
//   - every fetch asks the day's NETWORK counter first (`onNetCall`) — read directly, never through
//     `wouldExceedCeiling`, whose AI-first answer would hide a spent network day behind a spent AI
//     one (Gate-5 SEC-F4) — and is counted then; a network refusal marks the step `capped: 'net'`;
//   - at most `SCHEDULE_PROPOSALS_PER_RUN` changes on the RUN: the steps before this one already
//     pooled some (`ctx.proposalsSoFar`), so the model is told the run is full when it is, rather
//     than told a change waits that the queue then drops (Gate-5 JOBS-F7);
//   - the step stops itself `APP_AGENT_DEADLINE_MARGIN_MS` before the queue's bound (`ctx.boundAt`),
//     so it answers WITH the calls it spent instead of losing them to the queue's race — the stop
//     reaches a fetch already in flight too (`signal`, JOBS-F5).
// `soFar` is the step's one tally — the adapter wrapper writes `ai`, the fetch seat writes `net` —
// and it IS the outcome's `calls`.
//
// THE TAINT (S6). The first time a `data_query` records a read of another app's data, the turn is
// tainted and `fetch_connection` refuses for the rest of it: shared rows never ride a query string
// to this app's own hosts. Fetch-then-read stays allowed. `saw` names what was read, only what was.
//
// WHAT IT SAYS. The system is `buildHostSystemPrompt({scheduledAgent: true})` — identity and the
// scheduled-agent preamble, never 45's or 40's JSON doctrine — with the app's runtime contract as the
// END suffix (the transport's rule). The first message is the tool-free step's own context — the
// overview, the DDL, the shared tables by name only (never a row: those arrive through `data_query`,
// their line first), the step's typed SELECTs as delimited data (`runContextQueries`: the app asked
// `inTransaction` once first) — then the connections it can fetch through and the question. The
// answer is the FINAL round's text — what the model wrote before a look-up is narration, not the
// answer (Gate-5 JOBS-F4) — and it is stored, so it passes the `store` scrub here, before
// `finalizeOutcome` applies it again. The model never sees what the host made of its proposals.

import { CHATGPT_ERROR_CODES, runAgentTurn, type AgentAdapter, type AgentTool } from '@snugprotocol/adapters';
import type { UserDb } from '@snugprotocol/db';
import { SYSTEM_BLOCK_SEPARATOR, buildHostSystemPrompt, renderRuntimeContract } from '@snugprotocol/knowledge';
import {
  APP_AGENT_DEADLINE_MARGIN_MS,
  APP_AGENT_MAX_ROUND_TRIPS,
  APP_AGENT_MAX_TOOL_CALLS,
  ERROR_CODES,
  SCHEDULE_DAILY_CEILINGS,
  SCHEDULE_PROPOSALS_PER_RUN,
  type RuntimeContract,
  type ScheduleProposalItem,
  type StepSaw,
  type StepTools,
} from '@snugprotocol/protocol';

import { chatBrainRoute, chatDoorOpen, type ReaderBrainRoute } from '../access/egress.js';
import { namesTable } from '../access/materialise.js';
import type { MaterialisedSet } from '../access/service.js';
import { adapterKindFor, chatgptEffortFor, createTurnAdapter, routeOf, type TurnAdapterConfig } from '../agent/adapter.js';
import { buildDataTools, capToolCalls, type SharedTablesSeat } from '../agent/dataTools.js';
import { buildFetchConnectionTool, fetchableConnections } from '../agent/fetchConnectionTool.js';
import { AI_CEILING_CODE, gatedAdapter } from '../agent/gatedAdapter.js';
import { oneLine } from '../agent/sharedDdl.js';
import { ENDPOINTS_UNCONFIRMED, promptPlatform } from '../agent/transport.js';
import { resolveModelForApp } from '../state/appModel.js';
import { SECRET_KEY_PREFIX, endpointsNeedConfirm, localUrlStore } from '../state/mode.js';
import { CANCELLED_SUMMARY, keylessBrainGate, renderThinkContext, runContextQueries, sawOf, type AppThinkStep } from './appThink.js';
import { appMissing, capped, ranOutOfTime, ranOutOfTurns } from './copy.js';
import type { StepContext, StepOutcome } from './engine-types.js';
import { ZERO_CALLS, countersSoFar, type Calls } from './protection.js';
import { WITHHELD_SUMMARY, scrubOrWithhold } from './scrub.js';

/** The brain moved to one that cannot look things up after the executors' gate let the step through. */
const NO_DIRECT_BRAIN = 'the brain in Settings can’t look things up for a schedule — it will answer without looking next time';

/**
 * The adapter config for the route the chat's own derivation takes for `appId` (`chatBrainRoute`,
 * which the executors gated on): the provider after the per-app pin, the key read from the FILE,
 * the per-app model, the local endpoint. Only a route with a data lane reaches here — a keyed BYOK,
 * a local brain or the ChatGPT plan (`chatDoorOpen`).
 */
function configFrom(db: UserDb, appId: string, route: ReaderBrainRoute): TurnAdapterConfig {
  const model = resolveModelForApp(appId);
  const modelSeat = model !== undefined ? { model } : {};
  if (route.kind === 'local') return { mode: 'local', provider: route.provider, ...modelSeat, localUrl: localUrlStore.get() };
  if (route.kind === 'chatgpt') {
    // NO secret read (L4-8): the plan's adapter takes its bearer from the keeper per attempt; a
    // `byok:` row is another route's credential. Unattended, so the model's default level (ADR-0078 §8).
    const effort = chatgptEffortFor(model, true);
    return { mode: 'chatgpt', provider: route.provider, ...modelSeat, ...(effort !== undefined ? { effort } : {}) };
  }
  const key = db.getSecret(`${SECRET_KEY_PREFIX}${route.provider}`);
  return { mode: 'byok', provider: route.provider, ...(key !== undefined ? { key } : {}), ...modelSeat };
}

/**
 * The brain this step's turn may be sent to NOW, or the step's refusal (see the module comment):
 * the keyless gate's own outcome for the demo override or a keyless BYOK, `tools.unavailable:
 * 'brain'` for a route with no data lane, F15's refusal while the file's endpoints wait for a
 * confirm. Throws when the config would build a different adapter than the route it came from.
 */
function directBrain(db: UserDb, appId: string): { config: TurnAdapterConfig } | { refused: StepOutcome } {
  const route = chatBrainRoute(db, appId);
  const keyless = keylessBrainGate(db, appId, route);
  if (keyless !== undefined) return { refused: keyless };
  if (!chatDoorOpen(route)) return { refused: { status: 'refused', summary: NO_DIRECT_BRAIN, calls: { ...ZERO_CALLS }, tools: { unavailable: 'brain' } } };
  // F15: the file's endpoints are re-confirmed before ANY direct turn.
  if (endpointsNeedConfirm()) return { refused: { status: 'refused', summary: ENDPOINTS_UNCONFIRMED, calls: { ...ZERO_CALLS } } };
  const config = configFrom(db, appId, route);
  const built = adapterKindFor(routeOf(config));
  if (built !== route.kind) throw new Error(`the scheduled agent's adapter would be '${built}', not the '${route.kind}' brain it was gated on`);
  return { config };
}

/** A call made on a signal that already fired never reaches the brain — the deadline or the queue stopped the turn. */
function stopsWhenAborted(inner: AgentAdapter): AgentAdapter {
  return {
    complete: (request) =>
      request.signal?.aborted === true
        ? Promise.resolve({ ok: false, code: ERROR_CODES.CANCELLED, message: 'turn aborted', retryable: false })
        : inner.complete(request),
  };
}

function runtimeContractOf(db: UserDb, appId: string): RuntimeContract | undefined {
  try {
    return db.getRuntimeContract(appId);
  } catch {
    return undefined; // a contract that cannot be read runs the turn on the generic layers (the transport's rule)
  }
}

/** The connections it can fetch through, by slot — or the honest none, so it never invents one. */
function connectionsBlock(db: UserDb, appId: string): string {
  const connections = fetchableConnections(db, appId);
  if (connections.length === 0) return 'Connections: none — fetch_connection has nothing to reach for this app.';
  return ['Connections fetch_connection can reach (by slot):', ...connections.map(({ slot, name }) => `- ${slot} — ${name}`)].join('\n');
}

export async function executeAppAgent(step: AppThinkStep, ctx: StepContext): Promise<StepOutcome> {
  if (ctx.signal.aborted) return { status: 'failed', summary: CANCELLED_SUMMARY, calls: { ...ZERO_CALLS } };
  const app = ctx.db.getApp(step.appId);
  if (app === undefined) return { status: 'blocked', summary: appMissing.text, calls: { ...ZERO_CALLS } };
  const appName = oneLine(app.displayName);

  // The brain, read again right before its adapter is built (JOBS-F3) — and before anything is read.
  const brain = directBrain(ctx.db, step.appId);
  if ('refused' in brain) return brain.refused;
  const soFar: Calls = { ...ZERO_CALLS };
  const adapter = stopsWhenAborted(gatedAdapter(createTurnAdapter(brain.config, 'app'), { db: ctx.db, spent: ctx.spent, soFar, now: ctx.now }));

  // The turn's own signal: the queue's, and the step's deadline before the queue's bound.
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  ctx.signal.addEventListener('abort', stop, { once: true });
  let deadlineHit = false;
  const deadline =
    ctx.boundAt === undefined
      ? undefined
      : setTimeout(
          () => {
            deadlineHit = true;
            controller.abort();
          },
          Math.max(0, ctx.boundAt - APP_AGENT_DEADLINE_MARGIN_MS - ctx.now().getTime()),
        );

  let used = 0;
  let netCapped = false;
  let tainted = false;
  const fetched = new Map<string, number>();
  const saw: StepSaw[] = [];
  const proposals: ScheduleProposalItem[] = [];

  try {
    // The tables the user let this app read on a schedule — dumped for the schedule caller, NOTHING
    // recorded: the line is written by `data_query`, only when a statement names one (the chat door's rule).
    const { accessService } = await import('../access/service.js');
    const service = accessService();
    const caller = { kind: 'schedule' as const, appId: step.appId, taskId: ctx.task.id, runId: ctx.run.id };
    const set: MaterialisedSet = await service.materialise(caller);
    const shared: SharedTablesSeat | undefined =
      set.tables.length === 0
        ? undefined
        : {
            set,
            recordRead: async (grantIds, sql) => {
              const outcome = await service.recordRead(caller, set, { grantIds, sql });
              if (outcome.recorded.length > 0) {
                tainted = true; // before any of their rows can reach the brain (S6)
                const recorded = new Set(outcome.recorded);
                for (const entry of sawOf(set.tables.filter((table) => recorded.has(table.grantId) && namesTable(sql, table.name)))) {
                  if (!saw.some((known) => known.source === entry.source && known.table === entry.table)) saw.push(entry);
                }
              }
              return outcome;
            },
          };

    // The typed SELECTs are starting context, on the app's own data only; asked mid-change, they wait.
    const queries = await runContextQueries(ctx.db, step.appId, appName, step.context.sql ?? [], []);
    const context = renderThinkContext({ app, schema: ctx.db.getAppSchema(step.appId), queries, maxRows: step.context.maxRows, shared: set, withSharedRows: false, now: ctx.now().getTime() });
    const message = [context, connectionsBlock(ctx.db, step.appId), `The question to answer now:\n${step.prompt}`].join('\n\n');

    const base = buildHostSystemPrompt({ appBuilder: false, artifacts: false, scheduledAgent: true, platform: promptPlatform() });
    const contract = runtimeContractOf(ctx.db, step.appId);
    const system = contract === undefined ? base : `${base}${SYSTEM_BLOCK_SEPARATOR}${renderRuntimeContract(contract)}`;

    /** A tool call that got past the cap — the count `tools.used` reports. */
    const counted = (tool: AgentTool): AgentTool => ({
      def: tool.def,
      run: (input) => {
        used += 1;
        return tool.run(input);
      },
    });
    const tools = capToolCalls(
      [
        ...buildDataTools({
          appId: step.appId,
          getDb: () => Promise.resolve(ctx.db),
          ...(shared !== undefined ? { shared } : {}),
          scheduled: {
            armed: ctx.task.writeAuthority !== undefined,
            // The run's room, not this step's: what the earlier steps pooled counts (JOBS-F7).
            onProposal: (item) => {
              if ((ctx.proposalsSoFar?.() ?? 0) + proposals.length >= SCHEDULE_PROPOSALS_PER_RUN) return false;
              proposals.push(item);
              return true;
            },
          },
        }),
        buildFetchConnectionTool({
          appId: step.appId,
          getDb: () => Promise.resolve(ctx.db),
          taint: () => tainted,
          signal: controller.signal,
          onNetCall: (slot) => {
            // The network counter itself (SEC-F4): a spent AI day must never mask a spent network one.
            const day = countersSoFar(ctx.db, ctx.spent?.() ?? ZERO_CALLS, soFar, ctx.now().toISOString());
            if (day.net + 1 > SCHEDULE_DAILY_CEILINGS.net) {
              netCapped = true;
              return false;
            }
            soFar.net += 1;
            fetched.set(slot, (fetched.get(slot) ?? 0) + 1);
            return true;
          },
        }),
      ].map(counted),
      APP_AGENT_MAX_TOOL_CALLS,
    );

    let roundTrips = 0;
    let lastAskedForTools = false;
    /** The answer: the text of the round that asked for no tool — never the narration before a look-up (JOBS-F4). */
    let finalText: string | undefined;
    const result = await runAgentTurn({
      adapter,
      system,
      messages: [{ role: 'user', content: message }],
      tools,
      maxIterations: APP_AGENT_MAX_ROUND_TRIPS,
      // Up to ten round trips over one stable system and tool list: the prefix is worth caching.
      cache: true,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type !== 'round_trip') return;
        roundTrips += 1;
        lastAskedForTools = event.response.ok && event.response.toolCalls.length > 0;
        if (event.response.ok && event.response.toolCalls.length === 0) finalText = event.response.text;
      },
    });

    const toolsSeat: StepTools = { used, ...(fetched.size > 0 ? { fetched: [...fetched].map(([connection, calls]) => ({ connection, calls })) } : {}) };
    const facts = {
      calls: { ...soFar },
      tools: toolsSeat,
      ...(saw.length > 0 ? { saw } : {}),
      ...(proposals.length > 0 ? { proposals } : {}),
      ...(netCapped ? { capped: 'net' as const } : {}),
    };
    if (ctx.signal.aborted) return { status: 'failed', summary: CANCELLED_SUMMARY, ...facts };
    if (deadlineHit) return { status: 'failed', summary: ranOutOfTime(appName, used), ...facts };
    if (result.ok) return { status: 'ok', summary: scrubOrWithhold(finalText ?? result.text, 'store') ?? WITHHELD_SUMMARY, ...facts };
    if (result.code === AI_CEILING_CODE) return { status: 'refused', summary: capped('AI call'), ...facts, capped: 'ai' };
    if (result.code === ERROR_CODES.CONSENT_REQUIRED) return { status: 'refused', summary: result.message, ...facts };
    // The plan's usage limit is a REFUSAL by name on this path too (AC14, L4-7) — the same policy by
    // code as the tool-free step's, so the queue never sees a failure to retry.
    if (result.code === CHATGPT_ERROR_CODES.USAGE_LIMIT) return { status: 'refused', summary: result.message, ...facts };
    if (result.code === ERROR_CODES.CANCELLED) return { status: 'failed', summary: CANCELLED_SUMMARY, ...facts };
    if (roundTrips >= APP_AGENT_MAX_ROUND_TRIPS && lastAskedForTools) return { status: 'failed', summary: ranOutOfTurns(appName, used), ...facts };
    return { status: 'failed', summary: result.message, ...facts };
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    ctx.signal.removeEventListener('abort', stop);
  }
}
