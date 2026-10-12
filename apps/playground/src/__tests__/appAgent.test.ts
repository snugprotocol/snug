// appAgent.test.ts — TASK-20261010-host-broker PR-4 (AC29; contract v2 D-PR4-14, D-PR4-15, D-PR4-13,
// D-PR4-16, D-PR4-17; feasibility F7, F8, F9; security S6).
//
// `schedule/appAgent.ts` `executeAppAgent` — *Ask <App>'s AI* that can look things up. The executors
// run the brain gates (keyless/demo refused, a closed data lane or a sidecar app degraded — pinned in
// `scheduleExecutors.test.ts`); this file drives the agent itself once those gates let it through:
//
//   - ONE `runAgentTurn` over `gatedAdapter(createTurnAdapter(<app pin>), admit)`, with exactly three
//     tools — `data_query`, the scheduled `data_propose_write`, `fetch_connection` — under
//     `capToolCalls(…, 8)` and `maxIterations = 10`;
//   - the system is `buildHostSystemPrompt({scheduledAgent: true})` (identity + the scheduled-agent
//     layer; never 45 or 40) with the app's runtime contract as the END suffix;
//   - the AI ceiling refused IN the adapter (`CAPPED` → a capped outcome, nothing more sent); the net
//     ceiling asked before each fetch; F15's `CONSENT_REQUIRED` → `refused`, uncharged;
//   - the round-trip cap reads *<App>’s AI looked things up 8 times and ran out of turns before
//     answering* (`failed`); the 9th tool call answers the cap sentence;
//   - `data_query` reaches the app's own data and, LAZILY, the shared tables: a `read` line only
//     when a statement names one (`saw` then says what was read); `inTransaction` asked first — the
//     busy answer is `Error: <App> is in the middle of a change — try later`;
//   - the turn's taint: a fetch after a shared read answers the taint sentence; fetch-then-read passes;
//   - the outcome carries `tools: {used, fetched?}` (slot names only) and `saw` only when non-empty;
//   - the reply passes `scrubOrWithhold`; the own deadline (the queue's bound − 30 s) stops the turn.
//
// Seams: the brain is replaced at `createTurnAdapter` (the one seam the agent builds its adapter
// through) by a scripted recorder; the network at the platform's `fetchImpl` (the default transport
// the executor deps read); the Access Service through `__setAccessServiceForTests`. The db is a real
// in-memory user db. Clocks are injected (`ctx.now`); the deadline row fakes timers AND Date together.
//
// Assumed seams (Q-T-A-1, Q-T-A-6): `executeAppAgent(step, ctx)`; `StepContext.boundAt` (epoch ms of
// the queue's bound for this run); `StepOutcome.tools`/`saw` as D-PR4-17 spells them.
//
// RED until `schedule/appAgent.ts` exists (the static import below fails the file).

import type { AdapterRequest, AdapterResult, ToolCall } from '@snugprotocol/adapters';
import { authConnectionCredentialSecretKey, type UserDb } from '@snugprotocol/db';
import { SYSTEM_BLOCK_SEPARATOR, buildHostSystemPrompt, getSystemLayer, renderRuntimeContract } from '@snugprotocol/knowledge';
import {
  APP_AGENT_DEADLINE_MARGIN_MS,
  APP_AGENT_MAX_ROUND_TRIPS,
  APP_AGENT_MAX_TOOL_CALLS,
  SCHEDULE_DAILY_CEILINGS,
  runtimeContractSchema,
  type ScheduledTask,
} from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Recorded {
  system: string;
  tools: string[];
  messages: AdapterRequest['messages'];
  aborted: boolean;
}

const h = vi.hoisted(() => ({
  /** One entry per complete() the INNER adapter answers, in order. */
  script: [] as Array<(request: import('@snugprotocol/adapters').AdapterRequest) => import('@snugprotocol/adapters').AdapterResult | Promise<import('@snugprotocol/adapters').AdapterResult>>,
  requests: [] as Array<{ system: string; tools: string[]; messages: unknown[]; aborted: boolean }>,
  created: 0,
  fetches: [] as Array<{ url: string; init?: RequestInit }>,
}));

vi.mock('../agent/adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/adapter.js')>();
  return {
    ...actual,
    createTurnAdapter: () => {
      h.created += 1;
      return {
        complete: async (request: import('@snugprotocol/adapters').AdapterRequest) => {
          h.requests.push({
            system: request.system,
            tools: (request.tools ?? []).map((tool) => tool.name),
            messages: request.messages.map((message) => ({ ...message })),
            aborted: request.signal?.aborted === true,
          });
          const next = h.script.shift();
          if (next === undefined) return { ok: false as const, code: 'HOST_ERROR', message: 'script exhausted', retryable: false };
          return next(request);
        },
      };
    },
  };
});

import { __setAccessServiceForTests, type MaterialisedSet, type MaterialisedTable } from '../access/service.js';
import { setPlatform } from '../platform/platform.js';
import { executeAppAgent } from '../schedule/appAgent.js';
import type { AppThinkStep } from '../schedule/appThink.js';
import type { StepContext } from '../schedule/engine-types.js';
import { NET_CALL_LIMIT_MESSAGE, __resetNetStateForTests, invalidateNetGrants } from '../state/net.js';
import { execFrame, exportFrame } from './dbFrames.js';
import { installTestUserDb } from './userdbTestHelper.js';

setPlatform({
  kind: 'web',
  capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: false },
  fetchImpl: async (url: string, init?: RequestInit) => {
    h.fetches.push({ url, ...(init !== undefined ? { init } : {}) });
    return new Response('{"top":"song"}', { status: 200, headers: { 'content-type': 'application/json' } });
  },
});

const NOW = '2026-10-09T15:00:00.000Z';
const TODAY = '2026-10-09';
const KEY_SLOT = 'melodine';
const KEY_HOST = 'api.melodine.example';

const capSentence = (max: number): string => `Error: this run may make at most ${max} tool calls — answer now with what you have`;
const TAINT = 'Error: not after reading another app’s data in this run — answer with what you have';

let db: UserDb;
let appId: string;

beforeEach(async () => {
  h.script.length = 0;
  h.requests.length = 0;
  h.created = 0;
  h.fetches.length = 0;
  __resetNetStateForTests();
  db = await installTestUserDb();
  const app = db.installApp({ displayName: 'Budget', description: 'Budget keeps the month', html: '<html>budget</html>' });
  appId = app.appId;
  invalidateNetGrants(appId);
  await db.applyAppDdl(appId, ['CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT NOT NULL, cents INTEGER NOT NULL)']);
  for (const [index, label] of ['coffee', 'tea', 'rent'].entries()) {
    const result = await db.driver.handle(appId, execFrame('INSERT INTO t (id, label, cents) VALUES (?, ?, ?)', [index + 1, label, (index + 1) * 100]));
    if (!result.ok) throw new Error('seed failed');
  }
  db.putDeclaredConnection(
    appId,
    KEY_SLOT,
    {
      slot: KEY_SLOT,
      kind: 'api_key',
      provider: { name: 'Melodine Streaming' },
      fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
      request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
      declaredApiHosts: [KEY_HOST],
    },
    'inference',
  );
  db.approveConnection(appId, KEY_SLOT);
  db.setSecret(authConnectionCredentialSecretKey(appId, KEY_SLOT, 'api_key'), 'sk-melodine-0123456789');
  serviceWith(EMPTY_SET);
});

afterEach(() => {
  __setAccessServiceForTests();
  __resetNetStateForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------

const EMPTY_SET: MaterialisedSet = { tables: [], skipped: [], readOnlyTables: [] };

const TRANSACTIONS: MaterialisedTable = {
  grantId: 'g-ledger',
  sourceAppId: 'ledger-app',
  sourceName: 'Ledger',
  alias: 'ledger',
  name: 'ledger__transactions',
  table: 'transactions',
  columns: ['id', 'amount', 'note'],
  types: ['INTEGER', 'REAL', 'TEXT'],
  rows: [
    [1, 12.5, 'SHARED-COFFEE'],
    [2, 900, 'SHARED-RENT'],
  ],
  truncated: false,
  duration: 'always',
};

const SHARED_SET: MaterialisedSet = { tables: [TRANSACTIONS], skipped: [], readOnlyTables: ['ledger__transactions'] };

let materialise: ReturnType<typeof vi.fn>;
let recordRead: ReturnType<typeof vi.fn>;

function serviceWith(set: MaterialisedSet): void {
  materialise = vi.fn(() => Promise.resolve(set));
  recordRead = vi.fn((_caller: unknown, _set: MaterialisedSet, input: { grantIds?: readonly string[] }) =>
    Promise.resolve({ recorded: [...(input.grantIds ?? [])], refused: [] }),
  );
  __setAccessServiceForTests({ materialise, recordRead } as never);
}

function task(steps: AppThinkStep[], extra: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    title: 'morning check',
    enabled: true,
    enabledAt: NOW,
    provenance: 'user',
    steps,
    spec: { kind: 'daily', time: '08:00', tz: 'device' },
    cron: '0 8 * * *',
    missedPolicy: 'ask',
    staleAfterMs: 60_000,
    alert: 'inbox',
    appVersions: {},
    createdAt: NOW,
    updatedAt: NOW,
    consecutiveFailures: 0,
    unseenResults: 0,
    ...extra,
  };
}

function agentStep(overrides: Partial<AppThinkStep> = {}): AppThinkStep {
  const step: AppThinkStep = { kind: 'app-think', appId, prompt: 'what changed this week?', context: { maxRows: 50 }, tools: true, ...overrides };
  return step;
}

function context(step: AppThinkStep, extra: Partial<StepContext> & { boundAt?: number } = {}): StepContext {
  return {
    task: task([step]),
    run: { id: 'run-7', taskId: 'task-1', dueAt: NOW, trigger: 'due' },
    db,
    signal: new AbortController().signal,
    now: () => new Date(NOW),
    spent: () => ({ ai: 0, net: 0 }),
    ...extra,
  } as StepContext;
}

let callSeq = 0;
const toolCall = (name: string, input: Record<string, unknown>): ToolCall => ({ id: `call-${++callSeq}`, name, input });
const asks = (...calls: ToolCall[]) => (): AdapterResult => ({ ok: true, text: '', toolCalls: calls, stopReason: 'tool_use' });
const answers = (text: string) => (): AdapterResult => ({ ok: true, text, toolCalls: [], stopReason: 'end' });

/** The tool results the model was handed in request `index` (the round trip after the one that asked). */
function toolResultsIn(index: number): string[] {
  const request = h.requests[index] as Recorded | undefined;
  return (request?.messages ?? []).filter((message) => message.role === 'tool').map((message) => (message as { content: string }).content);
}

/** The LAST tool result the model was handed. */
function lastToolResult(): string {
  const all = toolResultsIn(h.requests.length - 1);
  return all[all.length - 1] ?? '';
}

function setDay(daily: { ai: number; net: number }): void {
  db.setSchedulerState({ watermark: NOW, globalPause: false, daily: { date: TODAY, ...daily } });
}

async function realLabel(id: number): Promise<string> {
  const result = await db.scratchRun(appId, [{ sql: `SELECT label FROM t WHERE id = ${id}` }]);
  return String(result.statements[0]?.rows?.[0]?.[0]);
}

// ---------------------------------------------------------------------------------------------
// the composition
// ---------------------------------------------------------------------------------------------

describe('executeAppAgent — one tool loop over the scheduled-agent assembly', () => {
  it('offers exactly data_query, data_propose_write and fetch_connection; a direct answer is the summary; nothing looked up', async () => {
    h.script.push(answers('all quiet this week'));
    const step = agentStep();
    const outcome = await executeAppAgent(step, context(step));
    expect(outcome.status).toBe('ok');
    expect(outcome.summary).toBe('all quiet this week');
    expect(outcome.calls).toEqual({ ai: 1, net: 0 });
    expect(outcome.tools).toEqual({ used: 0 });
    expect(outcome.saw).toBeUndefined();
    expect(outcome.proposals).toBeUndefined();
    expect(h.requests).toHaveLength(1);
    expect([...(h.requests[0]?.tools ?? [])].sort()).toEqual(['data_propose_write', 'data_query', 'fetch_connection']);
    expect(h.created).toBe(1);
  });

  it('the system is the scheduledAgent assembly — identity + the scheduled-agent layer, never 45 or 40 (a contract-less app)', async () => {
    h.script.push(answers('ok'));
    const step = agentStep();
    await executeAppAgent(step, context(step));
    const system = h.requests[0]?.system ?? '';
    expect(system).toBe(buildHostSystemPrompt({ appBuilder: false, artifacts: false, scheduledAgent: true, platform: 'web' }));
    expect(system).toContain(getSystemLayer('host-identity'));
    expect(system).toContain(getSystemLayer('scheduled-agent'));
    expect(system).not.toContain(getSystemLayer('app-runtime'));
    expect(system).not.toContain(getSystemLayer('app-response-format'));
  });

  it('the app’s runtime contract rides as the END suffix', async () => {
    const contract = runtimeContractSchema.parse({ overview: 'Budget tracks the month’s spending.' });
    db.putRuntimeContract(appId, 1, contract);
    h.script.push(answers('ok'));
    const step = agentStep();
    await executeAppAgent(step, context(step));
    const base = buildHostSystemPrompt({ appBuilder: false, artifacts: false, scheduledAgent: true, platform: 'web' });
    expect(h.requests[0]?.system).toBe(`${base}${SYSTEM_BLOCK_SEPARATOR}${renderRuntimeContract(contract)}`);
  });

  it('the prompt reaches the model, and the step’s typed queries ride as starting context — the rows as delimited data', async () => {
    h.script.push(answers('ok'));
    const step = agentStep({ context: { sql: ['SELECT id, label FROM t ORDER BY id'], maxRows: 50 } });
    await executeAppAgent(step, context(step));
    const first = (h.requests[0]?.messages[0] as { role: string; content: string } | undefined)?.content ?? '';
    expect(first).toContain('what changed this week?');
    const open = first.indexOf('<query_result>');
    expect(open).toBeGreaterThan(-1);
    expect(first.slice(open)).toContain('"coffee"');
  });

  it('the caps are the contract’s: 8 tool calls, 10 round trips, the 30 s deadline margin', () => {
    expect(APP_AGENT_MAX_TOOL_CALLS).toBe(8);
    expect(APP_AGENT_MAX_ROUND_TRIPS).toBe(10);
    expect(APP_AGENT_DEADLINE_MARGIN_MS).toBe(30_000);
  });
});

describe('the caps — ≤ 8 tool calls, ≤ 10 round trips, and the round-trip-cap sentence', () => {
  it('a model that never stops asking: 10 round trips, the 9th and 10th calls answer the cap sentence, the step fails with the sentence', async () => {
    for (let i = 0; i < 12; i += 1) h.script.push(asks(toolCall('data_query', { sql: `SELECT ${i}` })));
    const step = agentStep();
    const outcome = await executeAppAgent(step, context(step));
    expect(h.requests).toHaveLength(10);
    expect(toolResultsIn(9)).toHaveLength(9);
    expect(toolResultsIn(9)[8]).toBe(capSentence(8));
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toBe('Budget’s AI looked things up 8 times and ran out of turns before answering');
    expect(outcome.calls.ai).toBe(10);
    expect(outcome.tools).toEqual({ used: 8 });
  });
});

describe('the AI ceiling — refused IN the adapter', () => {
  it('99 calls used today: the first round trip goes, the second is CAPPED — nothing more is sent, the step is capped with the one call it spent', async () => {
    setDay({ ai: SCHEDULE_DAILY_CEILINGS.ai - 1, net: 0 });
    h.script.push(asks(toolCall('data_query', { sql: 'SELECT COUNT(*) FROM t' })), answers('never reached'));
    const step = agentStep();
    const outcome = await executeAppAgent(step, context(step));
    expect(h.requests).toHaveLength(1);
    expect(outcome.capped).toBe(true);
    expect(outcome.status).not.toBe('ok');
    expect(outcome.calls.ai).toBe(1);
  });

  it('a full day: nothing is sent at all', async () => {
    setDay({ ai: SCHEDULE_DAILY_CEILINGS.ai, net: 0 });
    h.script.push(answers('never reached'));
    const step = agentStep();
    const outcome = await executeAppAgent(step, context(step));
    expect(h.requests).toEqual([]);
    expect(outcome.capped).toBe(true);
    expect(outcome.calls).toEqual({ ai: 0, net: 0 });
  });

  it('what the run already spent counts (`ctx.spent`)', async () => {
    setDay({ ai: SCHEDULE_DAILY_CEILINGS.ai - 1, net: 0 });
    h.script.push(answers('never reached'));
    const step = agentStep();
    const outcome = await executeAppAgent(step, context(step, { spent: () => ({ ai: 1, net: 0 }) }));
    expect(h.requests).toEqual([]);
    expect(outcome.capped).toBe(true);
  });
});

describe('F15 — an endpoint the user has not confirmed', () => {
  it('CONSENT_REQUIRED → refused with its message, uncharged', async () => {
    const message = 'endpoint settings came from an imported or synced file — confirm them in Settings before running';
    h.script.push(() => ({ ok: false, code: 'CONSENT_REQUIRED', message, retryable: false }));
    const step = agentStep();
    const outcome = await executeAppAgent(step, context(step));
    expect(outcome.status).toBe('refused');
    expect(outcome.summary).toBe(message);
    expect(outcome.calls).toEqual({ ai: 0, net: 0 });
  });
});

describe('data_query — own data, the shared tables lazily, inTransaction first', () => {
  it('reads the app’s own data; no shared table named → no read line, no `saw`', async () => {
    serviceWith(SHARED_SET);
    h.script.push(asks(toolCall('data_query', { sql: 'SELECT label FROM t ORDER BY id' })), answers('three entries'));
    const step = agentStep();
    const outcome = await executeAppAgent(step, context(step));
    expect(lastToolResult()).toContain('coffee');
    expect(lastToolResult()).toContain('<query_result>');
    expect(recordRead).not.toHaveBeenCalled();
    expect(outcome.saw).toBeUndefined();
    expect(outcome.tools).toEqual({ used: 1 });
    expect(outcome.calls).toEqual({ ai: 2, net: 0 });
  });

  it('a statement naming a shared table records the read FIRST (the schedule caller, the grant, the SQL), then answers its rows; `saw` names it', async () => {
    serviceWith(SHARED_SET);
    const sql = 'SELECT note FROM ledger__transactions ORDER BY id';
    h.script.push(asks(toolCall('data_query', { sql })), answers('read it'));
    const step = agentStep();
    const outcome = await executeAppAgent(step, context(step));
    expect(recordRead).toHaveBeenCalledTimes(1);
    const [caller, , input] = recordRead.mock.calls[0] as [unknown, MaterialisedSet, { grantIds?: readonly string[]; sql?: string }];
    expect(caller).toEqual({ kind: 'schedule', appId, taskId: 'task-1', runId: 'run-7' });
    expect([...(input.grantIds ?? [])]).toEqual(['g-ledger']);
    expect(input.sql).toBe(sql);
    expect(lastToolResult()).toContain('SHARED-COFFEE');
    expect(outcome.saw).toEqual([{ source: 'Ledger', table: 'transactions' }]);
  });

  it('the app mid-change → the busy sentence, and the statement never runs', async () => {
    vi.spyOn(db.driver, 'inTransaction').mockImplementation((namespace) => Promise.resolve(namespace === appId));
    const scratch = vi.spyOn(db, 'scratchRun');
    h.script.push(asks(toolCall('data_query', { sql: 'SELECT label FROM t' })), answers('try later'));
    const step = agentStep();
    await executeAppAgent(step, context(step));
    expect(lastToolResult()).toBe('Error: Budget is in the middle of a change — try later');
    expect(scratch.mock.calls.filter(([, statements]) => statements.some((s) => s.sql === 'SELECT label FROM t'))).toEqual([]);
  });
});

describe('fetch_connection inside the turn — counted, ceilinged, tainted', () => {
  it('a fetch reaches the approved host; the outcome counts the net call and names the slot (never a path)', async () => {
    h.script.push(asks(toolCall('fetch_connection', { connection: KEY_SLOT, path: '/v1/top-track', query: { limit: 1 } })), answers('top song fetched'));
    const step = agentStep();
    const outcome = await executeAppAgent(step, context(step));
    expect(h.fetches.map((call) => call.url)).toEqual([`https://${KEY_HOST}/v1/top-track?limit=1`]);
    expect(lastToolResult()).toContain('"top":"song"');
    expect(outcome.calls).toEqual({ ai: 2, net: 1 });
    expect(outcome.tools).toEqual({ used: 1, fetched: [{ connection: KEY_SLOT, calls: 1 }] });
    expect(JSON.stringify(outcome.tools)).not.toContain('/v1/top-track');
  });

  it('the net ceiling is asked BEFORE each fetch: a full day answers the limit sentence, sends nothing, and the step is capped', async () => {
    setDay({ ai: 0, net: SCHEDULE_DAILY_CEILINGS.net });
    h.script.push(asks(toolCall('fetch_connection', { connection: KEY_SLOT, path: '/v1/top-track' })), answers('could not fetch'));
    const step = agentStep();
    const outcome = await executeAppAgent(step, context(step));
    expect(lastToolResult()).toContain(NET_CALL_LIMIT_MESSAGE);
    expect(h.fetches).toEqual([]);
    expect(outcome.capped).toBe(true);
    expect(outcome.calls.net).toBe(0);
  });

  it('a fetch AFTER a shared read in the turn answers the taint sentence and sends nothing', async () => {
    serviceWith(SHARED_SET);
    h.script.push(
      asks(toolCall('data_query', { sql: 'SELECT note FROM ledger__transactions' })),
      asks(toolCall('fetch_connection', { connection: KEY_SLOT, path: '/v1/search', query: { q: 'SHARED-COFFEE' } })),
      answers('done'),
    );
    const step = agentStep();
    await executeAppAgent(step, context(step));
    expect(recordRead).toHaveBeenCalledTimes(1);
    expect(lastToolResult()).toBe(TAINT);
    expect(h.fetches).toEqual([]);
  });

  it('fetch-then-read passes: the fetch made before the read stands, and the read is recorded', async () => {
    serviceWith(SHARED_SET);
    h.script.push(
      asks(toolCall('fetch_connection', { connection: KEY_SLOT, path: '/v1/top-track' })),
      asks(toolCall('data_query', { sql: 'SELECT note FROM ledger__transactions' })),
      answers('done'),
    );
    const step = agentStep();
    const outcome = await executeAppAgent(step, context(step));
    expect(h.fetches).toHaveLength(1);
    expect(recordRead).toHaveBeenCalledTimes(1);
    expect(lastToolResult()).toContain('SHARED-COFFEE');
    expect(outcome.saw).toEqual([{ source: 'Ledger', table: 'transactions' }]);
  });
});

describe('the scheduled data_propose_write inside the turn', () => {
  it('a proposal becomes the step’s pending item with its dry-run count; the real table is untouched', async () => {
    const before = await db.driver.handle(appId, exportFrame());
    h.script.push(asks(toolCall('data_propose_write', { statements: ["UPDATE t SET label = 'chai' WHERE id = 2"], summary: 'rename tea' })), answers('proposed a rename'));
    const step = agentStep();
    const outcome = await executeAppAgent(step, context(step));
    expect(outcome.proposals).toEqual([{ appId, sql: "UPDATE t SET label = 'chai' WHERE id = 2", summary: 'rename tea', counts: { changes: 1 } }]);
    expect(lastToolResult()).toContain('Proposed — it waits for the user’s OK on the result');
    expect(await realLabel(2)).toBe('tea');
    const after = await db.driver.handle(appId, exportFrame());
    expect(after.ok && after.bytesBase64).toBe(before.ok && before.bytesBase64);
  });

  it('under an ARMED task the armed answer is given (the task’s authority is read from ctx.task)', async () => {
    h.script.push(asks(toolCall('data_propose_write', { statements: ["UPDATE t SET label = 'chai' WHERE id = 2"], summary: 'rename tea' })), answers('proposed'));
    const step = agentStep();
    const armed = task([step], { writeAuthority: { rowsPerRun: 200, armedAt: NOW, armedVersion: 1 } } as Partial<ScheduledTask>);
    await executeAppAgent(step, context(step, { task: armed }));
    expect(lastToolResult()).toContain('Proposed — this schedule may make it on its own when it finishes, within its limits; the user can undo it');
  });
});

describe('the reply and the signal', () => {
  it('the reply passes the scrub — a credential-shaped token in the answer never reaches the summary', async () => {
    h.script.push(answers('call it with sk-0123456789abcdefghijkl and you are set'));
    const step = agentStep();
    const outcome = await executeAppAgent(step, context(step));
    expect(outcome.summary ?? '').not.toContain('sk-0123456789abcdefghijkl');
  });

  it('a signal aborted before the step starts → failed, nothing sent', async () => {
    const controller = new AbortController();
    controller.abort();
    h.script.push(answers('late'));
    const step = agentStep();
    const outcome = await executeAppAgent(step, context(step, { signal: controller.signal }));
    expect(outcome.status).toBe('failed');
    expect(h.requests.filter((request) => !request.aborted)).toEqual([]);
    expect(outcome.calls.net).toBe(0);
  });
});

describe('the own deadline — the queue’s bound − 30 s', () => {
  it('a turn that runs past bound − 30 s stops itself and answers with the calls it spent', async () => {
    const T0 = Date.parse(NOW);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: T0 });
    // Round trip 1 takes 100 s of the run's 120 s bound (past bound − 30 s = 90 s) and asks for more.
    h.script.push(
      async () => {
        await vi.advanceTimersByTimeAsync(100_000);
        return asks(toolCall('nothing_by_this_name', {}))();
      },
      asks(toolCall('nothing_by_this_name', {})),
      answers('too late'),
    );
    const step = agentStep();
    const outcome = await executeAppAgent(step, context(step, { now: () => new Date(), boundAt: T0 + 120_000 }));
    vi.useRealTimers();
    // No round trip was answered after the deadline (an aborted one may be attempted, never answered live).
    expect(h.requests.filter((request) => !request.aborted)).toHaveLength(1);
    expect(outcome.status).not.toBe('ok');
    expect(outcome.calls.ai).toBe(h.requests.length);
    expect(outcome.calls.ai).toBeGreaterThanOrEqual(1);
  });
});
