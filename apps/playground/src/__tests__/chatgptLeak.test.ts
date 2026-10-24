// chatgptLeak.test.ts — TASK-20261023-siwc-chatgpt-plan Gate 5: the AC10 end-to-end token-leak proofs
// (S8 / verifier R1 / R4; plan §12 S14) and the REAL-adapter rows the mocked suites cannot carry
// (G5-C4 / S1 / A2 invalidate → reportRejected; verifier R5 the unlisted pin; the gate counting a
// refresh-and-retry as ONE call).
//
// THE REAL ADAPTER, A FAKE FETCH, THE FAKE KEEPER. Every other chatgpt suite mocks `openaiResponsesAdapter`
// into a recorder; here `@snugprotocol/adapters` is REAL and the wire is a fake `fetch` the platform seat
// supplies (`fetchImpl`, the one choke point the shell's native transport rides), so the bearer the page
// handed out really rides an `authorization` header, really gets echoed by a 400 body, really gets
// redacted by `bearer.redact` — and the assertions read the places a token could land:
//   (b) the app-frame reply, the step's stored summary and run row, and `exportUserDb({ includeSecrets: true })`;
//   (c) a share bundle built after a sign-in;
//   (d) the two inspectors' snapshot TYPES carry no header field — checked by tsc, not by a render;
//   (e) the chatgpt modules carry no `console.*` (a status or an error there can sit beside a token);
//   (a) an app envelope that carries an `Authorization` of its own: the wire's headers hold the keeper's
//       bearer alone, and the LLM feed never carries that bearer (the round-trips suite's C1 row, in chatgpt mode);
//   the R-9 egress scrub runs on a chatgpt turn (spied), like every other direct turn.
// Positive controls sit beside every negative: the token IS in the fetch header, the export DOES carry the app.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { CHATGPT_ERROR_CODES, type AgentRoundTrip, type AgentTurnEvent } from '@snugprotocol/adapters';
import type { UserDb } from '@snugprotocol/db';
import { buildAppRequest, type ScheduleRun, type ScheduleStep, type ScheduledTask } from '@snugprotocol/protocol';

vi.mock('../agent/pseudonymizeEgress.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../agent/pseudonymizeEgress.js')>();
  return { ...real, guardWireForApp: vi.fn(real.guardWireForApp) };
});

import { chatBrainRoute } from '../access/egress.js';
import { gatedAdapter } from '../agent/gatedAdapter.js';
import { guardWireForApp } from '../agent/pseudonymizeEgress.js';
import { createTurnAdapter } from '../agent/adapter.js';
import { createAppTransport, createDirectAppTransport } from '../agent/transport.js';
import { setPlatform } from '../platform/platform.js';
import type { InspectorEntry } from '../run/inspector.js';
import type { LlmInspectorEntry } from '../run/llmInspector.js';
import { blockedAppRunDeps } from '../schedule/appRun.js';
import { defaultTransportFor, type AppThinkStep } from '../schedule/appThink.js';
import type { StepContext } from '../schedule/engine-types.js';
import { createStepExecutor } from '../schedule/executors.js';
import { prepareShare } from '../share/exportShare.js';
import { setAppPin } from '../state/appModel.js';
import { bootChatgptPlan, resetChatgptPlanForTests } from '../state/chatgptPlan.js';
import { byokKeyPresenceStore, chatgptEffortStore, chatgptModelStore, endpointsNeedConfirmStore, modeStore, modelStore, providerStore, setChatgptModel } from '../state/mode.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import { READY, chatgptDesktopPlatform, fakeChatgptSession, recordingFactory, settle, type FakeChatgptSession } from './chatgptPlanTestHelper.js';
import { installTestUserDb } from './userdbTestHelper.js';

// ------------------------------------------------------------------------------ the fake wire

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Everything the fake wire saw, and the next answers it gives (one per request; exhausted → a plain 2xx stream). */
const wire = { seen: [] as Seen[], answers: [] as Array<(seen: Seen) => Response> };

const sse = (type: string, payload: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
/** A 2xx exactly as the plan route sends it: a body and no headers; one JSON reply as the app expects. */
function okStream(model = 'gpt-6.1-sol', text = '{"answer":"answered on the plan","message":"ok"}'): Response {
  const body =
    sse('response.created', { response: { id: 'r1', status: 'in_progress', model, output: [] } }) +
    sse('response.output_item.added', { output_index: 0, item: { id: 'msg_0', type: 'message', status: 'in_progress', role: 'assistant', content: [] } }) +
    sse('response.output_text.delta', { output_index: 0, content_index: 0, item_id: 'msg_0', delta: text }) +
    sse('response.completed', { response: { id: 'r1', status: 'completed', model, output: [] } });
  return new Response(body, { status: 200 });
}
const echo400 = (seen: Seen): Response =>
  new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${seen.headers.authorization?.replace(/^Bearer /, '')}. Check your settings.` } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
const unauthorized = (): Response => new Response('{"error":{"message":"invalid token"}}', { status: 401 });

const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = value;
  const seen: Seen = { url: input, headers, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {} };
  wire.seen.push(seen);
  const answer = wire.answers.shift() ?? ((): Response => okStream());
  return answer(seen);
};

setPlatform(chatgptDesktopPlatform({ fetchImpl }));

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.handed-to-the-route-ONCE.sigLEAKPROBE0001';
const ROTATED = 'eyJhbGciOiJSUzI1NiJ9.rotated-after-401.sigLEAKPROBE0002';
const OPENAI_KEY = 'sk-proj-a-byok-key-in-the-file-that-must-never-be-read-0123456789';
const NOW = '2026-10-23T08:00:00.000Z';

let db: UserDb;
let appId: string;
let session: FakeChatgptSession;

const bytesAsText = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

function task(steps: ScheduleStep[]): ScheduledTask {
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
  };
}

function context(steps: ScheduleStep[]): StepContext {
  return { task: task(steps), run: { id: 'run-1', taskId: 'task-1', dueAt: NOW, trigger: 'due' }, db, signal: new AbortController().signal, now: () => new Date(NOW) };
}

const thinkStep = (): AppThinkStep => ({ kind: 'app-think', appId, prompt: 'summarise what changed', context: { sql: [], maxRows: 50 } });
const wireFor = (payload: Record<string, unknown> = {}): string => buildAppRequest({ appId, instanceId: 'inst', requestId: 'req', action: 'ask', payload });
const send = (transport: { send: (w: string, o: { signal: AbortSignal }) => Promise<unknown> }, w = wireFor()) => transport.send(w, { signal: new AbortController().signal });

beforeEach(async () => {
  db = await installTestUserDb();
  appId = db.installApp({ displayName: 'Ledger', description: 'Ledger keeps notes', html: '<html>ledger v1 — the shared bytes</html>' }).appId;
  db.setSecret('byok:openai', OPENAI_KEY);
  byokKeyPresenceStore.set({ anthropic: false, openai: true });
  providerStore.set('openai');
  modeStore.set('chatgpt');
  modelStore.set('llama3.2');
  chatgptModelStore.set(undefined);
  chatgptEffortStore.set(undefined);
  endpointsNeedConfirmStore.set(false);
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  setChatgptModel('gpt-6.1-sol');
  await settle();
  wire.seen.length = 0;
  wire.answers.length = 0;
  vi.mocked(guardWireForApp).mockClear();
  resetChatgptPlanForTests();
  session = fakeChatgptSession(READY);
  session.nextAccessToken(TOKEN);
  session.nextRefresh(ROTATED);
  await bootChatgptPlan(recordingFactory(session).create);
});

afterEach(() => {
  resetChatgptPlanForTests();
  modeStore.set('byok');
  providerStore.set('mock');
  modelStore.set(undefined);
  byokKeyPresenceStore.set({ anthropic: false, openai: false });
});

// ---------------------------------------------------------------------------------------------
// (b) the echoed bearer, end to end
// ---------------------------------------------------------------------------------------------

describe('AC10 (b) — a 400 that echoes the bearer: the token reaches the route and NOWHERE else (S8 / R1 / R4)', () => {
  it('the app-frame reply carries the detail with the bearer scrubbed; the fetch header carried it (the positive control)', async () => {
    wire.answers.push(echo400);
    const reply = (await send(createDirectAppTransport({ mode: 'chatgpt', provider: 'openai', appId, needsConfirm: () => false }))) as { ok: boolean; message?: string; code?: string };
    expect(wire.seen).toHaveLength(1);
    expect(wire.seen[0]?.headers.authorization, 'the bearer rides the header — the one place it belongs').toBe(`Bearer ${TOKEN}`);
    expect(wire.seen[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(reply.ok).toBe(false);
    expect(reply.message, 'the detail survives').toContain('Incorrect API key provided');
    expect(reply.message).not.toContain(TOKEN);
    expect(JSON.stringify(reply)).not.toContain(TOKEN);
    expect(JSON.stringify(wire.seen[0]?.body), 'the BYOK key in the file is never in the body either').not.toContain(OPENAI_KEY);
  });

  it('through executeAppThink → the finalized outcome, a stored run row and the FULL export (includeSecrets: true) — none carries the token; the export does carry the app', async () => {
    wire.answers.push(echo400);
    const execute = createStepExecutor({ appRun: blockedAppRunDeps(), transportFor: defaultTransportFor, brainRouteFor: chatBrainRoute });
    const step = thinkStep();
    const outcome = await execute(step, context([step]));
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('Incorrect API key provided');
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);

    // The run row, as the queue would store it (`toStepResult`: status + summary), and the export.
    const run: ScheduleRun = {
      id: 'run-1',
      taskId: 'task-1',
      dueAt: NOW,
      trigger: 'due',
      collapsedCount: 1,
      status: 'failed',
      startedAt: NOW,
      finishedAt: NOW,
      host: { kind: 'desktop' },
      steps: [{ status: outcome.status, ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}) }],
      calls: outcome.calls,
      ...(outcome.summary !== undefined ? { reason: outcome.summary } : {}),
    };
    db.putScheduledTask(task([step]));
    db.putScheduleRun(run);
    expect(JSON.stringify(db.listScheduleRuns('task-1'))).not.toContain(TOKEN);
    const exported = bytesAsText(await db.exportUserDb({ includeSecrets: true }));
    expect(exported, 'the scan can see values: the app is in the export').toContain('Ledger keeps notes');
    expect(exported, 'the stored summary is in the export').toContain('Incorrect API key provided');
    expect(exported).not.toContain(TOKEN);
    expect(exported, 'the plan tokens never enter the file — not even with secrets included').not.toContain(ROTATED);
  });
});

// ---------------------------------------------------------------------------------------------
// (c) a share bundle after a sign-in
// ---------------------------------------------------------------------------------------------

describe('AC10 (c) — a share bundle built after a sign-in carries no token', () => {
  it('prepareShare: the bundle text has the app’s html and never the bearer', async () => {
    await send(createDirectAppTransport({ mode: 'chatgpt', provider: 'openai', appId, needsConfirm: () => false }));
    expect(wire.seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const prepared = await prepareShare(appId, []);
    expect(prepared.text).toContain('ledger v1 — the shared bytes');
    expect(prepared.text).not.toContain(TOKEN);
    expect(prepared.text).not.toContain(OPENAI_KEY);
    expect(prepared.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// (d) the inspectors' snapshot types
// ---------------------------------------------------------------------------------------------

describe('AC10 (d) — the inspectors’ request snapshots have NO header field, by type', () => {
  it('LlmInspectorEntry, the frame InspectorEntry and AgentRoundTrip.request carry no `headers` (tsc checks this)', () => {
    expectTypeOf<LlmInspectorEntry>().not.toHaveProperty('headers');
    expectTypeOf<LlmInspectorEntry>().not.toHaveProperty('authorization');
    expectTypeOf<InspectorEntry>().not.toHaveProperty('headers');
    expectTypeOf<AgentRoundTrip['request']>().not.toHaveProperty('headers');
    expectTypeOf<AgentRoundTrip['request']>().toHaveProperty('system');
    // The runtime twin, so a field added at runtime without a type shows here too.
    const requestKeys: Array<keyof AgentRoundTrip['request']> = ['system', 'messages', 'tools', 'maxOutputTokens'];
    expect(requestKeys).not.toContain('headers');
  });
});

// ---------------------------------------------------------------------------------------------
// (e) no console on the plan's modules
// ---------------------------------------------------------------------------------------------

describe('AC10 (e) — the ChatGPT-plan modules write nothing to the console', () => {
  const SRC = path.resolve(__dirname, '..');
  const MODULES = [
    'state/chatgptPlan.ts',
    'schedule/chatgptOutcome.ts',
    'views/ChatgptPlanRows.tsx',
    'views/ChatgptPlanNotice.tsx',
    'desktop/ChatgptButton.tsx',
    'desktop/ChatgptSignInWait.tsx',
    'desktop/DesktopWelcome.tsx',
    'ui/UsageLimitMessage.tsx',
    'ui/ManageUsageLink.tsx',
    'ui/ChatgptModelOptions.tsx',
  ];
  const stripComments = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it.each(MODULES)('%s has no console.* call', (file) => {
    const code = stripComments(readFileSync(path.join(SRC, file), 'utf8'));
    expect(code).not.toMatch(/\bconsole\s*\./);
  });

  it('the lint can fail: a planted console line is caught', () => {
    expect(stripComments('const a = 1;\nconsole.log(a);\n')).toMatch(/\bconsole\s*\./);
    expect(stripComments('// console.log(a)\n/* console.error(b) */\n')).not.toMatch(/\bconsole\s*\./);
  });
});

// ---------------------------------------------------------------------------------------------
// (a) the envelope's own Authorization + the LLM feed; the R-9 scrub
// ---------------------------------------------------------------------------------------------

describe('AC10 (a) — an app envelope carrying `Authorization` to the plan route, and the C1 feed row in chatgpt mode', () => {
  it('the wire’s headers hold the keeper’s bearer alone — the envelope’s header is DATA in the body, never a request header; the LLM feed never carries the bearer', async () => {
    const events: AgentTurnEvent[] = [];
    const planted = 'Bearer app-planted-value-0123456789';
    const transport = createDirectAppTransport({ mode: 'chatgpt', provider: 'openai', appId, needsConfirm: () => false, onLlmEvent: (event) => events.push(event) });
    const reply = (await send(transport, wireFor({ headers: { Authorization: planted }, question: 'hi' }))) as { ok: boolean };
    expect(reply.ok).toBe(true);
    const seen = wire.seen[0]!;
    expect(Object.keys(seen.headers).sort()).toEqual(['authorization', 'content-type']);
    expect(seen.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen.headers.authorization).not.toContain('app-planted');
    // The envelope reached the model as text — the route decides nothing on it.
    expect(JSON.stringify(seen.body)).toContain('app-planted-value-0123456789');
    // The feed (C1 row): every event, in flight and complete — no bearer anywhere.
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(JSON.stringify(events)).not.toContain(OPENAI_KEY);
  });

  it('a chatgpt turn through createAppTransport runs the R-9 egress scrub like every direct turn (spied)', async () => {
    await send(createAppTransport('chatgpt', 'openai', { appId }));
    expect(vi.mocked(guardWireForApp)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(guardWireForApp).mock.calls[0]?.[0]).toBe(appId);
    expect(vi.mocked(guardWireForApp).mock.calls[0]?.[1]).toContain('[SNUG_APP_REQUEST]');
    expect(wire.seen).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// The real adapter rows the mocked suites cannot carry
// ---------------------------------------------------------------------------------------------

describe('G5-C4 / S1 / A2 — a second 401 after refresh-and-retry tells the keeper which bearer the route refused', () => {
  it('two 401s: refreshNow(first) then reportRejected(retry’s token); the result is CHATGPT_SIGN_IN_NEEDED; the mode stays chatgpt (verifier R6)', async () => {
    wire.answers.push(unauthorized, unauthorized);
    const reply = (await send(createDirectAppTransport({ mode: 'chatgpt', provider: 'openai', appId, needsConfirm: () => false }))) as { ok: boolean; code?: string; message?: string };
    expect(wire.seen.map((s) => s.headers.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${ROTATED}`]);
    expect(session.calls.refreshNow).toEqual([TOKEN]);
    expect(session.calls.reportRejected, 'the RETRY’s bearer, the one the route refused last').toEqual([ROTATED]);
    expect(reply).toMatchObject({ ok: false, code: CHATGPT_ERROR_CODES.SIGN_IN_NEEDED });
    expect(reply.message).not.toContain(ROTATED);
    expect(modeStore.get()).toBe('chatgpt');
  });

  it('a 401 then a 2xx: one refresh, no reportRejected, and the turn answers', async () => {
    wire.answers.push(unauthorized);
    const reply = (await send(createDirectAppTransport({ mode: 'chatgpt', provider: 'openai', appId, needsConfirm: () => false }))) as { ok: boolean };
    expect(reply.ok).toBe(true);
    expect(session.calls.refreshNow).toEqual([TOKEN]);
    expect(session.calls.reportRejected).toEqual([]);
  });
});

describe('verifier R5 — a pinned id NOT on the plan still routes: the request body’s `model` is that id', () => {
  it('through createAppTransport with a chatgpt pin the plan does not list', async () => {
    setAppPin(appId, { provider: 'chatgpt', model: 'gpt-5-retired' });
    await settle();
    await send(createAppTransport('chatgpt', 'openai', { appId }));
    expect(wire.seen[0]?.body.model).toBe('gpt-5-retired');
    // An unlisted model offers no levels we can check, so none is sent (ST12).
    expect(wire.seen[0]?.body).not.toHaveProperty('reasoning');
  });

  it('through createDirectAppTransport with the id as `model`', async () => {
    await send(createDirectAppTransport({ mode: 'chatgpt', provider: 'openai', model: 'gpt-5-retired', appId, needsConfirm: () => false }));
    expect(wire.seen[0]?.body.model).toBe('gpt-5-retired');
  });
});

describe('the gated adapter counts a refresh-and-retry as ONE AI call (verifier)', () => {
  it('a 401 then a 2xx inside one complete(): two requests on the wire, soFar.ai === 1', async () => {
    wire.answers.push(unauthorized);
    const soFar = { ai: 0, net: 0 };
    const adapter = gatedAdapter(createTurnAdapter({ mode: 'chatgpt', provider: 'openai', model: 'gpt-6.1-sol' }, 'app'), { db, soFar, now: () => new Date(NOW) });
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(true);
    expect(wire.seen).toHaveLength(2);
    expect(soFar.ai).toBe(1);
  });
});
