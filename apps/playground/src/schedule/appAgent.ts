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
// THE GATES ARE NOT HERE. `executors.ts` refuses the demo override and a keyless BYOK brain, and
// degrades to the tool-free step when the brain cannot run the data lane or the app holds a sidecar
// fact; this module is reached — LAZILY, and swapped for a loud stub in the host kit, whose brains
// never pass those gates — only after them.
//
// THE BOUNDS, each where the cost is incurred:
//   - every AI call asks the day's ceiling AT the adapter (`agent/gatedAdapter.ts`) — `CAPPED`
//     answers without calling the brain, and the step is `capped`;
//   - at most `APP_AGENT_MAX_ROUND_TRIPS` round trips (the loop's own cap — hitting it reads *looked
//     things up N times and ran out of turns*) and `APP_AGENT_MAX_TOOL_CALLS` tool calls (ONE counter
//     over all three tools; the ninth answers the cap sentence);
//   - every fetch asks the day's network ceiling first (`onNetCall`), and is counted then;
//   - the step stops itself `APP_AGENT_DEADLINE_MARGIN_MS` before the queue's bound (`ctx.boundAt`),
//     so it answers WITH the calls it spent instead of losing them to the queue's race.
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
// their line first), the step's typed SELECTs as delimited data — then the connections it can fetch
// through and the question. The reply is stored, so it passes the `store` scrub here, before
// `finalizeOutcome` applies it again. The model never sees what the host made of its proposals.

import { runAgentTurn, type AgentAdapter, type AgentTool } from '@snugprotocol/adapters';
import type { UserDb } from '@snugprotocol/db';
import { SYSTEM_BLOCK_SEPARATOR, buildHostSystemPrompt, renderRuntimeContract } from '@snugprotocol/knowledge';
import {
  APP_AGENT_DEADLINE_MARGIN_MS,
  APP_AGENT_MAX_ROUND_TRIPS,
  APP_AGENT_MAX_TOOL_CALLS,
  ERROR_CODES,
  type RuntimeContract,
  type ScheduleProposalItem,
  type StepSaw,
  type StepTools,
} from '@snugprotocol/protocol';

import { appMidChange } from '../access/copy.js';
import { namesTable } from '../access/materialise.js';
import type { MaterialisedSet } from '../access/service.js';
import { createTurnAdapter, type TurnAdapterConfig } from '../agent/adapter.js';
import { buildDataTools, capToolCalls, type SharedTablesSeat } from '../agent/dataTools.js';
import { buildFetchConnectionTool, fetchableConnections } from '../agent/fetchConnectionTool.js';
import { AI_CEILING_CODE, gatedAdapter } from '../agent/gatedAdapter.js';
import { oneLine } from '../agent/sharedDdl.js';
import { ENDPOINTS_UNCONFIRMED, promptPlatform } from '../agent/transport.js';
import { appProviderPinFor, resolveModelForApp } from '../state/appModel.js';
import { SECRET_KEY_PREFIX, endpointsNeedConfirm, localUrlStore, modeStore, providerStore } from '../state/mode.js';
import { currentBrain } from '../state/webllm.js';
import { CANCELLED_SUMMARY, renderThinkContext, runContextQuery, sawOf, type AppThinkStep, type ContextQuery } from './appThink.js';
import { appMissing, capped, ranOutOfTime, ranOutOfTurns } from './copy.js';
import type { StepContext, StepOutcome } from './engine-types.js';
import { WITHHELD_SUMMARY } from './executors.js';
import { countersSoFar, wouldExceedCeiling, type Calls } from './protection.js';
import { scrubOrWithhold } from './scrub.js';

const NOTHING: Calls = { ai: 0, net: 0 };

/** The brain moved to one that cannot look things up after the executors' gate let the step through. */
const NO_DIRECT_BRAIN = 'the brain in Settings can’t look things up for a schedule — it will answer without looking next time';

/**
 * The adapter the app's own transport would build for this app NOW (`agent/transport.ts`
 * `resolveAppTransport`, read at the call): the platform brain, the WebLLM/demo overrides, then the
 * settings — the per-app provider pin under the same guard, the key read from the FILE, the per-app
 * model. `undefined` for the subscription route, which has no direct adapter (and no data lane, so
 * the executors never send a step here on it).
 */
function adapterConfigFor(db: UserDb, appId: string): TurnAdapterConfig | undefined {
  const provider = providerStore.get();
  const brain = currentBrain();
  if (brain.kind === 'host') return { mode: 'host', provider };
  if (brain.kind === 'webllm') return { mode: 'webllm', provider };
  if (brain.kind === 'demo') return { mode: 'byok', provider: 'mock' };
  const mode = modeStore.get();
  if (mode === 'subscription') return undefined;
  const effective = mode === 'byok' && provider !== 'mock' ? (appProviderPinFor(appId) ?? provider) : provider;
  const key = mode === 'byok' && (effective === 'anthropic' || effective === 'openai') ? db.getSecret(`${SECRET_KEY_PREFIX}${effective}`) : undefined;
  const model = resolveModelForApp(appId);
  return {
    mode,
    provider: effective,
    ...(key !== undefined ? { key } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(mode === 'local' ? { localUrl: localUrlStore.get() } : {}),
  };
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
  if (ctx.signal.aborted) return { status: 'failed', summary: CANCELLED_SUMMARY, calls: { ...NOTHING } };
  const app = ctx.db.getApp(step.appId);
  if (app === undefined) return { status: 'blocked', summary: appMissing.text, calls: { ...NOTHING } };
  const appName = oneLine(app.displayName);
  const config = adapterConfigFor(ctx.db, step.appId);
  // Only a brain that changed between the executors' gate and this call lands here (the gate degrades it).
  if (config === undefined) return { status: 'refused', summary: NO_DIRECT_BRAIN, calls: { ...NOTHING }, tools: { unavailable: 'brain' } };
  // F15: the file's endpoints are re-confirmed before ANY direct turn; a platform-pinned brain never reads them.
  if (config.mode !== 'host' && endpointsNeedConfirm()) return { status: 'refused', summary: ENDPOINTS_UNCONFIRMED, calls: { ...NOTHING } };

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

  const soFar: Calls = { ...NOTHING };
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
    const busy = (step.context.sql ?? []).length > 0 && (await ctx.db.driver.inTransaction(step.appId));
    const queries: ContextQuery[] = [];
    for (const sql of step.context.sql ?? []) {
      queries.push({ sql, result: busy ? { error: appMidChange(appName) } : await runContextQuery(ctx.db, step.appId, sql, []) });
    }
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
          scheduled: { armed: ctx.task.writeAuthority !== undefined, onProposal: (item) => void proposals.push(item) },
        }),
        buildFetchConnectionTool({
          appId: step.appId,
          getDb: () => Promise.resolve(ctx.db),
          taint: () => tainted,
          signal: controller.signal,
          onNetCall: (slot) => {
            const day = countersSoFar(ctx.db, ctx.spent?.() ?? NOTHING, soFar, ctx.now().toISOString());
            if (wouldExceedCeiling(day, { net: 1 }) === 'net') {
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

    const adapter = stopsWhenAborted(
      gatedAdapter(createTurnAdapter(config, 'app'), { db: ctx.db, spent: ctx.spent, soFar, now: ctx.now }),
    );
    let roundTrips = 0;
    let lastAskedForTools = false;
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
      },
    });

    const toolsSeat: StepTools = { used, ...(fetched.size > 0 ? { fetched: [...fetched].map(([connection, calls]) => ({ connection, calls })) } : {}) };
    const facts = {
      calls: { ...soFar },
      tools: toolsSeat,
      ...(saw.length > 0 ? { saw } : {}),
      ...(proposals.length > 0 ? { proposals } : {}),
      ...(netCapped ? { capped: true } : {}),
    };
    if (ctx.signal.aborted) return { status: 'failed', summary: CANCELLED_SUMMARY, ...facts };
    if (deadlineHit) return { status: 'failed', summary: ranOutOfTime(appName, used), ...facts };
    if (result.ok) return { status: 'ok', summary: scrubOrWithhold(result.text, 'store') ?? WITHHELD_SUMMARY, ...facts };
    if (result.code === AI_CEILING_CODE) return { status: 'refused', summary: capped('AI call'), ...facts, capped: true };
    if (result.code === ERROR_CODES.CONSENT_REQUIRED) return { status: 'refused', summary: result.message, ...facts };
    if (result.code === ERROR_CODES.CANCELLED) return { status: 'failed', summary: CANCELLED_SUMMARY, ...facts };
    if (roundTrips >= APP_AGENT_MAX_ROUND_TRIPS && lastAskedForTools) return { status: 'failed', summary: ranOutOfTurns(appName, used), ...facts };
    return { status: 'failed', summary: result.message, ...facts };
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    ctx.signal.removeEventListener('abort', stop);
  }
}
