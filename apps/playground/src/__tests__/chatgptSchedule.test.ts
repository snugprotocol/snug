// chatgptSchedule.test.ts — TASK-20261023-siwc-chatgpt-plan Gate 3, L4: scheduled "ask the AI"
// steps on the ChatGPT plan (AC14; plan §4 rows 5, 14, 17; §11 L4-3, L4-6, L4-7, L4-8, L4-12;
// ADR-0078 §8 — the owner's interview answer Q3: a signed-in plan is a real brain, limits refuse
// by name, a signed-out plan refuses by name like a keyless key).
//
// Pinned, each with the mutation it catches:
//   - a READY plan runs the step on the plan's adapter (the real app transport, `defaultTransportFor`)
//     with no key read; a limited keeper still sends — the limit is the adapter's named result;
//   - signed out / plan not granted → `refused`, `blockedBy: 'brain'`, the NAMED sentence, 0 AI
//     calls, nothing sent (the keyless/demo sentence would be a lie about the user's choice);
//   - `'unknown'` = WAIT (F9): a launch catch-up step held while the keeper's first read is out
//     neither refuses a valid session nor sends — signed-in → it runs; signed-out → refused by name;
//   - THE ERROR POLICY (L4-7): `CHATGPT_USAGE_LIMIT` → `refused` by name, NOT retried (even if a
//     reply said retryable), one AI call; `CHATGPT_USAGE_UNAVAILABLE` → exactly ONE retry after the
//     injectable wait (`AppThinkDeps.wait(ms)`, default 1 500 ms), then `failed`, `retryable: true`;
//     `CHATGPT_SIGN_IN_NEEDED` / `CHATGPT_PLAN_NOT_GRANTED` mid-run → `failed`, one AI call, no retry;
//   - unattended steps run on the model's DEFAULT level (from the cached list), never the stored
//     `providerEffort:chatgpt` (ADR-0078 §8) — through the scheduled agent's `configFrom` (L4-8, built
//     with NO secret read) and through the tool-free step's transport (AC14 — see the report);
//   - F15 (row 17): an imported `.snug` whose mode is chatgpt refuses turns and scheduled steps
//     until the user confirms its endpoints.
//
// Seams: `@snugprotocol/adapters` partially mocked — `openaiResponsesAdapter` a recorder over a
// SCRIPT of results (one per `complete()`); `../state/mode.js` partially mocked so `getByokKey`
// is a pass-through spy; `db.getSecret` spied so a `byok:` row read on the plan path is seen
// (a spy on `createTurnAdapter` is NOT used: the scheduler ↔ userdb import cycle can bind the
// real export before a module mock of `agent/adapter.js` exists, which made it vacuous). The platform is the
// desktop WITH the custody seat, set once; the keeper is booted per test on a fake.
//
// RED until `state/chatgptPlan.ts`, the chatgpt arms, the scheduled gates/policy and the new
// exports exist.

import type { AdapterResult } from '@snugprotocol/adapters';
import { CHATGPT_ERROR_CODES } from '@snugprotocol/adapters';
import { createMemoryBackend, openUserDb, type UserDb } from '@snugprotocol/db';
import { buildAppRequest, type ScheduleStep, type ScheduledTask } from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatgptPlanStatus } from '@snugprotocol/auth';

const h = vi.hoisted(() => ({
  /** Every options object `openaiResponsesAdapter` was built with, in order. */
  responses: [] as Array<Record<string, unknown>>,
  /** One result per `complete()`, in order; exhausted → a plain JSON answer. */
  script: [] as Array<import('@snugprotocol/adapters').AdapterResult>,
  completes: 0,
}));

vi.mock('@snugprotocol/adapters', async (importOriginal) => {
  const real = await importOriginal<typeof import('@snugprotocol/adapters')>();
  return {
    ...real,
    openaiResponsesAdapter: vi.fn((options: Record<string, unknown>) => {
      h.responses.push(options);
      return {
        complete: async () => {
          h.completes += 1;
          return h.script.shift() ?? { ok: true, text: '{"answer":"answered on the plan"}', toolCalls: [], stopReason: 'end' };
        },
      };
    }),
  };
});

vi.mock('../state/mode.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../state/mode.js')>();
  return { ...real, getByokKey: vi.fn(real.getByokKey) };
});

import { chatBrainRoute } from '../access/egress.js';
import { ENDPOINTS_UNCONFIRMED, createAppTransport } from '../agent/transport.js';
import { setPlatform } from '../platform/platform.js';
import { KEYLESS_BRAIN_REFUSAL, defaultTransportFor, executeAppThink, keylessBrainGate, type AppThinkStep } from '../schedule/appThink.js';
import { blockedAppRunDeps } from '../schedule/appRun.js';
import type { StepContext } from '../schedule/engine-types.js';
import { createStepExecutor } from '../schedule/executors.js';
import { bootChatgptPlan, resetChatgptPlanForTests } from '../state/chatgptPlan.js';
import {
  byokKeyPresenceStore,
  chatgptEffortStore,
  chatgptModelStore,
  confirmEndpoints,
  endpointsNeedConfirm,
  endpointsNeedConfirmStore,
  getByokKey,
  modeStore,
  modelStore,
  providerStore,
  setChatgptEffort,
  setChatgptModel,
} from '../state/mode.js';
import { importUserFile } from '../state/sync.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import {
  LIMITED,
  NOT_GRANTED,
  NOT_GRANTED_REFUSAL,
  READY,
  SIGNED_OUT,
  SIGNED_OUT_REFUSAL,
  chatgptDesktopPlatform,
  fakeChatgptSession,
  recordingFactory,
  settle,
  type FakeChatgptSession,
} from './chatgptPlanTestHelper.js';
import { installTestUserDb, locateWasm } from './userdbTestHelper.js';

setPlatform(chatgptDesktopPlatform());

const NOW = '2026-10-23T08:00:00.000Z';
const OPENAI_KEY = 'sk-proj-test-openai-key-that-must-never-be-read-0123456789';
const LIMIT_SENTENCE = 'Usage limit reached — Review your plan or this app’s limit in ChatGPT settings.';

let db: UserDb;
let appId: string;
let session: FakeChatgptSession;

const getByokKeySpy = vi.mocked(getByokKey);

async function bootKeeper(status: ChatgptPlanStatus, wait = true): Promise<FakeChatgptSession> {
  resetChatgptPlanForTests();
  session = fakeChatgptSession(status);
  const booting = bootChatgptPlan(recordingFactory(session).create);
  if (wait) await booting;
  else await settle();
  return session;
}

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
  return {
    task: task(steps),
    run: { id: 'run-1', taskId: 'task-1', dueAt: NOW, trigger: 'due' },
    db,
    signal: new AbortController().signal,
    now: () => new Date(NOW),
  };
}

function thinkStep(overrides: Partial<Omit<AppThinkStep, 'kind'>> = {}): AppThinkStep {
  return { kind: 'app-think', appId, prompt: 'summarise what changed', context: { sql: [], maxRows: 50 }, ...overrides };
}

/** The production executor's gates (brainRouteFor: chatBrainRoute) over the real app transport. */
const productionLike = (wait?: (ms: number) => Promise<void>) =>
  createStepExecutor({ appRun: blockedAppRunDeps(), transportFor: defaultTransportFor, brainRouteFor: chatBrainRoute, ...(wait !== undefined ? { wait } : {}) });

const failure = (code: string, message: string, retryable: boolean): AdapterResult => ({ ok: false, code, message, retryable });

/**
 * Every `snug_secrets` read of a BYOK key row on the db — L4-8: the plan's config is built with
 * NO secret read (today's `configFrom` reads `byok:<provider>` straight from the file).
 */
function byokSecretReads(): string[] {
  return vi
    .mocked(db.getSecret)
    .mock.calls.map(([key]) => String(key))
    .filter((key) => key.startsWith('byok:'));
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await settle();
  return done;
}

beforeEach(async () => {
  db = await installTestUserDb();
  appId = db.installApp({ displayName: 'Ledger', description: 'Ledger keeps notes', html: '<html>v1</html>' }).appId;
  db.setSecret('byok:openai', OPENAI_KEY); // a BYOK key in the file — the plan must never read it
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
  h.responses.length = 0;
  h.script.length = 0;
  h.completes = 0;
  vi.spyOn(db, 'getSecret');
  getByokKeySpy.mockClear();
  await bootKeeper(READY);
});

afterEach(() => {
  resetChatgptPlanForTests();
  modeStore.set('byok');
  providerStore.set('mock');
  modelStore.set(undefined);
  byokKeyPresenceStore.set({ anthropic: false, openai: false });
  endpointsNeedConfirmStore.set(false);
});

// ---------------------------------------------------------------------------------------------
// The gates (L4-6)
// ---------------------------------------------------------------------------------------------

describe('the scheduled gate on a chatgpt route (L4-6)', () => {
  it('a READY plan runs the step on the plan’s adapter — one AI call, no key read', async () => {
    const step = thinkStep();
    const outcome = await productionLike()(step, context([step]));
    expect(outcome).toMatchObject({ status: 'ok', summary: 'answered on the plan', calls: { ai: 1, net: 0 } });
    expect(h.responses).toHaveLength(1);
    expect(h.completes).toBe(1);
    expect(getByokKeySpy).not.toHaveBeenCalled();
    expect(byokSecretReads()).toEqual([]);
  });

  it('signed out → refused BY NAME, blockedBy brain, nothing sent, nothing spent — never the keyless sentence', async () => {
    await bootKeeper(SIGNED_OUT);
    const step = thinkStep();
    const outcome = await productionLike()(step, context([step]));
    expect(outcome).toMatchObject({ status: 'refused', summary: SIGNED_OUT_REFUSAL, calls: { ai: 0, net: 0 }, blockedBy: 'brain' });
    expect(outcome.summary).not.toBe(KEYLESS_BRAIN_REFUSAL);
    expect(h.responses).toHaveLength(0);
    expect(h.completes).toBe(0);
  });

  it('plan not granted → refused BY NAME ("Allow plan usage…"), nothing sent', async () => {
    await bootKeeper(NOT_GRANTED);
    const step = thinkStep({ tools: true });
    const outcome = await productionLike()(step, context([step]));
    expect(outcome).toMatchObject({ status: 'refused', summary: NOT_GRANTED_REFUSAL, calls: { ai: 0, net: 0 }, blockedBy: 'brain' });
    expect(h.completes).toBe(0);
  });

  it('the gate reads the keeper LIVE: a sign-out between two steps refuses the second', async () => {
    const step = thinkStep();
    await expect(productionLike()(step, context([step]))).resolves.toMatchObject({ status: 'ok' });
    session.setStatus(SIGNED_OUT);
    expect(keylessBrainGate(db, appId)).toMatchObject({ status: 'refused', summary: SIGNED_OUT_REFUSAL });
    await expect(productionLike()(step, context([step]))).resolves.toMatchObject({ status: 'refused', summary: SIGNED_OUT_REFUSAL });
  });
});

describe('`unknown` = WAIT at launch (F9; plan §4 row 5)', () => {
  it('a catch-up step held while the first read is out does not refuse and does not send; the read answers signed-in → it runs', async () => {
    await bootKeeper('unknown', false);
    const step = thinkStep();
    const running = productionLike()(step, context([step]));
    expect(await settled(running)).toBe(false);
    expect(h.completes).toBe(0);

    session.resolveFirstRead(READY);
    await expect(running).resolves.toMatchObject({ status: 'ok', calls: { ai: 1, net: 0 } });
    expect(h.completes).toBe(1);
  });

  it('the read answers signed-out → refused BY NAME, nothing sent', async () => {
    await bootKeeper('unknown', false);
    const step = thinkStep();
    const running = productionLike()(step, context([step]));
    expect(await settled(running)).toBe(false);
    session.resolveFirstRead(SIGNED_OUT);
    await expect(running).resolves.toMatchObject({ status: 'refused', summary: SIGNED_OUT_REFUSAL, blockedBy: 'brain' });
    expect(h.completes).toBe(0);
  });

  it('executeAppThink called directly waits too — it never sends on an unanswered keeper', async () => {
    await bootKeeper('unknown', false);
    const step = thinkStep();
    const running = executeAppThink(step, context([step]), { transportFor: defaultTransportFor });
    expect(await settled(running)).toBe(false);
    expect(h.completes).toBe(0);
    session.resolveFirstRead(READY);
    await expect(running).resolves.toMatchObject({ status: 'ok' });
  });
});

// ---------------------------------------------------------------------------------------------
// The error policy (L4-7)
// ---------------------------------------------------------------------------------------------

describe('the scheduled error policy on the plan (L4-7; AC7, AC14)', () => {
  it('CHATGPT_USAGE_LIMIT → refused by name, NOT retried, counted as one AI call (usage may have been spent)', async () => {
    await bootKeeper(LIMITED); // a standing limit still sends — the gate proceeds, the reply names it
    h.script.push(failure(CHATGPT_ERROR_CODES.USAGE_LIMIT, LIMIT_SENTENCE, false));
    const wait = vi.fn(() => Promise.resolve());
    const step = thinkStep();
    const outcome = await executeAppThink(step, context([step]), { transportFor: defaultTransportFor, wait });
    expect(outcome).toMatchObject({ status: 'refused', calls: { ai: 1, net: 0 } });
    expect(outcome.summary).toContain('Usage limit reached');
    expect(h.completes).toBe(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('a limit is never retried even when the reply claims retryable — the policy is by CODE', async () => {
    h.script.push(failure(CHATGPT_ERROR_CODES.USAGE_LIMIT, LIMIT_SENTENCE, true));
    const wait = vi.fn(() => Promise.resolve());
    const step = thinkStep();
    const outcome = await executeAppThink(step, context([step]), { transportFor: defaultTransportFor, wait });
    expect(outcome.status).toBe('refused');
    expect(h.completes).toBe(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('a limit through the production executor is refused too — the queue does not see a failure to retry', async () => {
    h.script.push(failure(CHATGPT_ERROR_CODES.USAGE_LIMIT, LIMIT_SENTENCE, false));
    const step = thinkStep();
    const outcome = await productionLike(() => Promise.resolve())(step, context([step]));
    expect(outcome).toMatchObject({ status: 'refused', calls: { ai: 1, net: 0 } });
    expect(h.completes).toBe(1);
  });

  it('CHATGPT_USAGE_UNAVAILABLE → exactly ONE retry after the wait (1 500 ms), then failed by name with retryable: true', async () => {
    h.script.push(failure(CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE, 'ChatGPT usage is unavailable right now — try again shortly.', true));
    h.script.push(failure(CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE, 'ChatGPT usage is unavailable right now — try again shortly.', true));
    const wait = vi.fn(() => Promise.resolve());
    const step = thinkStep();
    const outcome = await executeAppThink(step, context([step]), { transportFor: defaultTransportFor, wait });
    expect(outcome).toMatchObject({ status: 'failed', retryable: true });
    expect(outcome.summary).toContain('unavailable');
    expect(h.completes).toBe(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(1500);
  });

  it('CHATGPT_USAGE_UNAVAILABLE then a reply → the retry answers and the step is ok', async () => {
    h.script.push(failure(CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE, 'ChatGPT usage is unavailable right now — try again shortly.', true));
    const wait = vi.fn(() => Promise.resolve());
    const step = thinkStep();
    const outcome = await executeAppThink(step, context([step]), { transportFor: defaultTransportFor, wait });
    expect(outcome).toMatchObject({ status: 'ok', summary: 'answered on the plan' });
    expect(h.completes).toBe(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  for (const code of [CHATGPT_ERROR_CODES.SIGN_IN_NEEDED, CHATGPT_ERROR_CODES.PLAN_NOT_GRANTED]) {
    it(`${code} mid-run → failed by name, one AI call, no retry`, async () => {
      h.script.push(failure(code, `the plan said ${code}`, false));
      const wait = vi.fn(() => Promise.resolve());
      const step = thinkStep();
      const outcome = await executeAppThink(step, context([step]), { transportFor: defaultTransportFor, wait });
      expect(outcome).toMatchObject({ status: 'failed', calls: { ai: 1, net: 0 } });
      expect(h.completes).toBe(1);
      expect(wait).not.toHaveBeenCalled();
    });
  }

  it('the classic codes keep today’s policy — a HOST_ERROR on the plan is failed, never retried', async () => {
    h.script.push(failure('HOST_ERROR', 'the model said no', true));
    const wait = vi.fn(() => Promise.resolve());
    const step = thinkStep();
    const outcome = await executeAppThink(step, context([step]), { transportFor: defaultTransportFor, wait });
    expect(outcome).toMatchObject({ status: 'failed', calls: { ai: 1, net: 0 } });
    expect(h.completes).toBe(1);
    expect(wait).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// Unattended level + the scheduled agent's config (L4-3, L4-8; ADR-0078 §8)
// ---------------------------------------------------------------------------------------------

describe('unattended steps run on the model’s DEFAULT level, never the stored one (ADR-0078 §8)', () => {
  it('the scheduled agent (tools: true): configFrom builds { mode: chatgpt, model, effort: defaultEffort } with NO key', async () => {
    setChatgptEffort('ultra'); // the interactive choice — must not reach an unattended step
    await settle();
    const step = thinkStep({ tools: true });
    const outcome = await productionLike()(step, context([step]));
    expect(outcome.status).toBe('ok');
    expect(h.responses.length).toBeGreaterThan(0);
    for (const options of h.responses) expect(options).toMatchObject({ model: 'gpt-6.1-sol', effort: 'medium' });
    expect(byokSecretReads(), 'the scheduled agent must build the plan config with NO secret read').toEqual([]);
    expect(JSON.stringify(h.responses)).not.toContain(OPENAI_KEY);
    expect(getByokKeySpy).not.toHaveBeenCalled();
  });

  it('a model whose levels are unknown runs with NO level unattended — never the stored top one', async () => {
    setChatgptModel('gpt-6.1-mini'); // no defaultEffort in the cached list
    setChatgptEffort('ultra');
    await settle();
    const step = thinkStep({ tools: true });
    await productionLike()(step, context([step]));
    expect(h.responses.at(-1)?.effort).toBeUndefined();
  });

  it('the tool-free step (the app transport) runs on the default level too — the stored level is the interactive one', async () => {
    setChatgptEffort('ultra');
    await settle();
    const step = thinkStep();
    await productionLike()(step, context([step]));
    expect(h.responses).toHaveLength(1);
    expect(h.responses[0]).toMatchObject({ model: 'gpt-6.1-sol', effort: 'medium' });
  });

  it('…while an interactive app turn on the same settings sends the stored level', async () => {
    setChatgptEffort('ultra');
    await settle();
    const wire = buildAppRequest({ appId, instanceId: 'inst', requestId: 'req', action: 'ask', payload: {} });
    await createAppTransport('chatgpt', 'openai', undefined, appId).send(wire, { signal: new AbortController().signal });
    expect(h.responses.at(-1)).toMatchObject({ effort: 'ultra' });
  });
});

// ---------------------------------------------------------------------------------------------
// F15 (row 17, L4-12)
// ---------------------------------------------------------------------------------------------

describe('F15 — an imported file whose mode is chatgpt stays under the endpoint confirm (row 17)', () => {
  /** A foreign `.snug`: mode chatgpt, one app — the bytes another machine would hand this one. */
  async function foreignChatgptFile(): Promise<{ bytes: Uint8Array; foreignAppId: string }> {
    const opened = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
    if (opened.status !== 'ok') throw new Error(`fixture open failed: ${opened.status}`);
    const foreign = opened.userDb;
    foreign.setSetting('mode', 'chatgpt');
    foreign.setSetting('providerModel:chatgpt', 'gpt-6.1-sol');
    const app = foreign.installApp({ displayName: 'Imported', description: 'came with the file', html: '<html>imported</html>' });
    return { bytes: await foreign.exportUserDb({ includeSecrets: false }), foreignAppId: app.appId };
  }

  it('turns and scheduled steps are refused (ENDPOINTS_UNCONFIRMED, nothing sent) until confirmEndpoints()', async () => {
    const { bytes, foreignAppId } = await foreignChatgptFile();
    await importUserFile({ arrayBuffer: () => Promise.resolve(bytes.slice().buffer as ArrayBuffer) });
    expect(modeStore.get()).toBe('chatgpt');
    expect(endpointsNeedConfirm()).toBe(true);
    appId = foreignAppId;

    const wire = buildAppRequest({ appId, instanceId: 'inst', requestId: 'req', action: 'ask', payload: {} });
    const turn = await createAppTransport('chatgpt', 'openai', undefined, appId).send(wire, { signal: new AbortController().signal });
    expect(turn).toMatchObject({ ok: false, code: 'CONSENT_REQUIRED', message: ENDPOINTS_UNCONFIRMED });

    const toolFree = thinkStep();
    await expect(productionLike()(toolFree, context([toolFree]))).resolves.toMatchObject({ status: 'refused', summary: ENDPOINTS_UNCONFIRMED, calls: { ai: 0, net: 0 } });
    const agent = thinkStep({ tools: true });
    await expect(productionLike()(agent, context([agent]))).resolves.toMatchObject({ status: 'refused', summary: ENDPOINTS_UNCONFIRMED, calls: { ai: 0, net: 0 } });
    expect(h.completes).toBe(0);

    confirmEndpoints();
    await expect(productionLike()(toolFree, context([toolFree]))).resolves.toMatchObject({ status: 'ok' });
    expect(h.completes).toBe(1);
  });
});
