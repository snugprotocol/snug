// chatgptRouting.test.ts — TASK-20261023-siwc-chatgpt-plan Gate 3, L4: THE BEHAVIOURAL MATRIX
// (plan §4 row 4/6, replacing the seat-enumeration grep — Gate-2 F16/S7; §11 L4-1, L4-2, L4-3,
// L4-5, L4-6, L4-8, L4-9; ADR-0078 §1, §5).
//
// The owner's rule, as a property: in mode `chatgpt` the plan is the brain at EVERY seat that
// copies the routing derivation — whatever the keeper says (ready, signed out, plan not granted,
// limited) and whatever keys sit in the file. A missing session is a NAMED result from the
// adapter or a named refusal at the scheduled gate, never a fall-through to a key, a local model
// or the demo brain. Crossed: 4 keeper states × {a BYOK OpenAI key in snug_secrets, none} ×
// {an Anthropic key, none}; asserted at each seat:
//   adapterKindFor (every provider × key) · routeOf → adapterKindFor · resolveActiveBrainFrom (a
//   builder pick to Anthropic included) · appBrainKind (the editor's second copy — and it agrees
//   with adapterKindFor for byok/local) · chatBrainRoute / readerAdapterKind / chatDoorOpen ·
//   egressFor's brain line (the D9 sentence) · keylessBrainGate (undefined when the plan may
//   answer; the NAMED sentence when signed out or not granted — never the keyless one) ·
//   askBrainFor · liveInferenceAdapter / inferenceWireCopy (decideWire's chatgpt arm) ·
//   createTurnAdapter (openaiResponsesAdapter with { bearer, model, effort } and no key; no
//   openai/anthropic/local/mock adapter constructed) — and `getByokKey` is NEVER called.
// Then the send paths: createDirectAppTransport / createAppTransport and createDirectBuilder in
// chatgpt mode read the model and the effort PER SEND from the plan's rows, never a key; the
// arm's model fallback (config → providerModel:chatgpt → the cached list's first) and its named
// result when there is none.
//
// Seams: `@snugprotocol/adapters` partially mocked — the four classic factories become
// pass-through SPIES (so "never constructed" is observable), `openaiResponsesAdapter` a
// recorder answering one plain reply; `../state/mode.js` partially mocked so `getByokKey` is a
// pass-through spy and everything else is the real module (ONE module graph — vitest keeps a
// mocked module's instance across a registry reset, so this file never resets it). The platform
// is the desktop WITH the custody seat, set once; the keeper is booted per test on a fake.
//
// RED until `state/chatgptPlan.ts`, the `'chatgpt'` arms and the new exports exist.

import type { UserDb } from '@snugprotocol/db';
import { buildAppRequest } from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatgptPlanStatus } from '@snugprotocol/auth';

const h = vi.hoisted(() => ({
  /** Every options object `openaiResponsesAdapter` was built with, in order. */
  responses: [] as Array<Record<string, unknown>>,
  reply: { ok: true, text: '{"message":"answered on the plan"}', toolCalls: [], stopReason: 'end', model: 'gpt-6.1-sol' } as const,
}));

vi.mock('@snugprotocol/adapters', async (importOriginal) => {
  const real = await importOriginal<typeof import('@snugprotocol/adapters')>();
  return {
    ...real,
    anthropicAdapter: vi.fn(real.anthropicAdapter),
    openaiAdapter: vi.fn(real.openaiAdapter),
    localAdapter: vi.fn(real.localAdapter),
    mockAdapter: vi.fn(real.mockAdapter),
    openaiResponsesAdapter: vi.fn((options: Record<string, unknown>) => {
      h.responses.push(options);
      return { complete: async () => h.reply };
    }),
  };
});

vi.mock('../state/mode.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../state/mode.js')>();
  return { ...real, getByokKey: vi.fn(real.getByokKey) };
});

import * as adapters from '@snugprotocol/adapters';

import { BRAIN_NAMES, EGRESS } from '../access/copy.js';
import { chatBrainRoute, chatDoorOpen, egressFor, readerAdapterKind } from '../access/egress.js';
import { ADAPTER_KINDS, adapterKindFor, createTurnAdapter, routeOf } from '../agent/adapter.js';
import type { ArtifactSink } from '../agent/artifactSink.js';
import { createDirectBuilder } from '../agent/builder.js';
import { inferenceWireCopy, liveInferenceAdapter } from '../agent/inferrerAdapter.js';
import { createAppTransport, createDirectAppTransport } from '../agent/transport.js';
import { setPlatform } from '../platform/platform.js';
import { askBrainFor } from '../schedule/askBrain.js';
import { KEYLESS_BRAIN_REFUSAL, keylessBrainGate } from '../schedule/appThink.js';
import { appBrainKind } from '../schedule/editorModel.js';
import { resolveActiveBrain, resolveActiveBrainFrom } from '../state/activeBrain.js';
import { appModelStore, appProviderStore, setAppPin } from '../state/appModel.js';
import { builderPickStore } from '../state/builderModel.js';
import { bootChatgptPlan, resetChatgptPlanForTests } from '../state/chatgptPlan.js';
import {
  byokKeyPresenceStore,
  chatgptEffortStore,
  chatgptModelStore,
  endpointsNeedConfirmStore,
  getByokKey,
  modeStore,
  modelStore,
  providerChoiceStore,
  providerModelsStore,
  providerStore,
  setChatgptEffort,
  setChatgptModel,
  type ByokProvider,
} from '../state/mode.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import {
  D9_DATA_USE,
  LIMITED,
  MATRIX_STATUSES,
  NOT_GRANTED,
  NOT_GRANTED_REFUSAL,
  READY,
  SIGNED_OUT,
  SIGNED_OUT_REFUSAL,
  chatgptDesktopPlatform,
  fakeChatgptSession,
  recordingFactory,
  settle,
} from './chatgptPlanTestHelper.js';
import { installTestUserDb } from './userdbTestHelper.js';

setPlatform(chatgptDesktopPlatform());

const OPENAI_KEY = 'sk-proj-test-openai-key-that-must-never-be-read-0123456789';
const ANTHROPIC_KEY = 'sk-ant-api03-test-anthropic-key-never-read-0123456789';
const PROVIDERS: readonly ByokProvider[] = ['mock', 'anthropic', 'openai'];
const SETTINGS_BRAIN = { kind: 'settings' } as const;

let db: UserDb;
let appId: string;

const getByokKeySpy = vi.mocked(getByokKey);
const classicFactories = (): Array<{ name: string; calls: number }> => [
  { name: 'openaiAdapter', calls: vi.mocked(adapters.openaiAdapter).mock.calls.length },
  { name: 'anthropicAdapter', calls: vi.mocked(adapters.anthropicAdapter).mock.calls.length },
  { name: 'localAdapter', calls: vi.mocked(adapters.localAdapter).mock.calls.length },
  { name: 'mockAdapter', calls: vi.mocked(adapters.mockAdapter).mock.calls.length },
];
const expectNoClassicAdapter = (where: string): void => {
  for (const factory of classicFactories()) expect(factory.calls, `${where}: ${factory.name} must never be constructed in chatgpt mode`).toBe(0);
};

async function bootKeeper(status: ChatgptPlanStatus): Promise<void> {
  resetChatgptPlanForTests();
  await bootChatgptPlan(recordingFactory(fakeChatgptSession(status)).create);
}

/** Put the file's keys (and the presence store the chip reads) in the requested state. */
function setKeys(openai: boolean, anthropic: boolean): void {
  if (openai) db.setSecret('byok:openai', OPENAI_KEY);
  else db.deleteSecret('byok:openai');
  if (anthropic) db.setSecret('byok:anthropic', ANTHROPIC_KEY);
  else db.deleteSecret('byok:anthropic');
  byokKeyPresenceStore.set({ anthropic, openai });
  providerStore.set(anthropic ? 'anthropic' : openai ? 'openai' : 'mock');
}

function wireFor(id: string): string {
  return buildAppRequest({ appId: id, instanceId: 'inst-1', requestId: 'req-1', action: 'ask', payload: { q: 'hello' } });
}

const sink: ArtifactSink = {
  write: () => Promise.resolve({ id: 'app-x', displayName: 'unused', version: 1 }),
  ensureTargetId: () => Promise.resolve('app-x'),
};

beforeEach(async () => {
  db = await installTestUserDb();
  appId = db.installApp({ displayName: 'Ledger', description: 'Ledger keeps notes', html: '<html>v1</html>' }).appId;
  modeStore.set('chatgpt');
  providerChoiceStore.set(undefined);
  providerModelsStore.set({});
  modelStore.set('llama3.2'); // the global (local) model row — must never reach the plan
  chatgptModelStore.set(undefined);
  chatgptEffortStore.set(undefined);
  endpointsNeedConfirmStore.set(false);
  appModelStore.set({});
  appProviderStore.set({});
  builderPickStore.set(undefined);
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  setKeys(false, false);
  h.responses.length = 0;
  vi.mocked(adapters.openaiAdapter).mockClear();
  vi.mocked(adapters.anthropicAdapter).mockClear();
  vi.mocked(adapters.localAdapter).mockClear();
  vi.mocked(adapters.mockAdapter).mockClear();
  getByokKeySpy.mockClear();
  await bootKeeper(READY);
});

afterEach(() => {
  resetChatgptPlanForTests();
  modeStore.set('byok');
  modelStore.set(undefined);
  providerStore.set('mock');
  byokKeyPresenceStore.set({ anthropic: false, openai: false });
});

// ---------------------------------------------------------------------------------------------
// The derivation itself (L4-1)
// ---------------------------------------------------------------------------------------------

describe('the spies are live (control — without it every "never called" below could pass vacuously)', () => {
  it('in BYOK mode the same seats DO read the key through the spied getByokKey and build the classic adapter', async () => {
    modeStore.set('byok');
    setKeys(true, false);
    const transport = createDirectAppTransport({ mode: 'byok', provider: 'openai', appId, needsConfirm: () => false });
    await transport.send(wireFor(appId), { signal: new AbortController().signal }).catch(() => undefined);
    await liveInferenceAdapter(appId);
    expect(getByokKeySpy).toHaveBeenCalled();
    expect(vi.mocked(adapters.openaiAdapter)).toHaveBeenCalled();
  });
});

describe('adapterKindFor — the chatgpt arm comes before every provider/key check (L4-1)', () => {
  it('ADAPTER_KINDS carries "chatgpt"', () => {
    expect(ADAPTER_KINDS).toContain('chatgpt');
  });

  it('mode chatgpt is "chatgpt" for every provider and either key presence — key presence is irrelevant', () => {
    for (const provider of PROVIDERS) {
      for (const hasKey of [true, false]) {
        expect(adapterKindFor({ mode: 'chatgpt', provider, hasKey }), `provider=${provider} hasKey=${String(hasKey)}`).toBe('chatgpt');
      }
    }
  });

  it('host and webllm still outrank everything; chatgpt never leaks into another mode', () => {
    expect(adapterKindFor({ mode: 'host', provider: 'openai', hasKey: true })).toBe('host');
    expect(adapterKindFor({ mode: 'webllm', provider: 'openai', hasKey: true })).toBe('webllm');
    expect(adapterKindFor({ mode: 'byok', provider: 'openai', hasKey: true })).toBe('openai');
    expect(adapterKindFor({ mode: 'byok', provider: 'openai', hasKey: false })).toBe('demo');
    expect(adapterKindFor({ mode: 'local', provider: 'openai', hasKey: true })).toBe('local');
  });

  it('resolveActiveBrainFrom: the demo override still outranks the mode; below it the plan is named', () => {
    const keys = { anthropic: true, openai: true };
    expect(resolveActiveBrainFrom({ brain: { kind: 'demo', reason: 'no-webgpu' }, mode: 'chatgpt', provider: 'openai', keys, builderPick: undefined })).toBe('demo');
    expect(resolveActiveBrainFrom({ brain: SETTINGS_BRAIN, mode: 'chatgpt', provider: 'openai', keys, builderPick: undefined })).toBe('chatgpt');
  });

  it('appBrainKind (the schedule editor’s second copy) answers exactly what adapterKindFor answers for byok and local — the copy may not drift', () => {
    for (const mode of ['byok', 'local'] as const) {
      for (const provider of PROVIDERS) {
        for (const anthropic of [true, false]) {
          for (const openai of [true, false]) {
            const keys = { anthropic, openai };
            const hasKey = provider === 'anthropic' || provider === 'openai' ? keys[provider] : false;
            expect(appBrainKind({ brain: SETTINGS_BRAIN, mode, provider, pinned: undefined, keys }), `${mode}/${provider}/${JSON.stringify(keys)}`).toBe(
              adapterKindFor({ mode, provider, hasKey }),
            );
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// THE MATRIX (row 4/6)
// ---------------------------------------------------------------------------------------------

describe('the behavioural matrix — mode chatgpt × keeper state × keys in the file: the plan, everywhere', () => {
  for (const [label, status] of MATRIX_STATUSES) {
    for (const openai of [true, false]) {
      for (const anthropic of [true, false]) {
        it(`keeper ${label} · BYOK OpenAI key ${openai ? 'present' : 'absent'} · Anthropic key ${anthropic ? 'present' : 'absent'}`, async () => {
          await bootKeeper(status);
          setKeys(openai, anthropic);
          // The plan's default model is chosen — so a signed-out keeper (no cached list) still
          // reaches the Responses adapter, whose bearer then answers the named result (L2).
          setChatgptModel('gpt-6.1-sol');
          // A BYOK pin on the app too — the plan must outrank it (L4-4).
          if (openai) setAppPin(appId, { provider: 'openai', model: 'gpt-4o' });
          await settle();
          const keys = { anthropic, openai };

          // 1. The derivation, for every provider the stores could hold.
          for (const provider of PROVIDERS) {
            expect(adapterKindFor({ mode: 'chatgpt', provider, hasKey: true })).toBe('chatgpt');
            expect(adapterKindFor({ mode: 'chatgpt', provider, hasKey: false })).toBe('chatgpt');
            expect(adapterKindFor(routeOf({ mode: 'chatgpt', provider, ...(openai ? { key: OPENAI_KEY } : {}) }))).toBe('chatgpt');
          }

          // 2. The chip's live derivation — a fresh-thread builder pick to Anthropic included.
          expect(resolveActiveBrainFrom({ brain: SETTINGS_BRAIN, mode: 'chatgpt', provider: providerStore.get(), keys, builderPick: undefined })).toBe('chatgpt');
          expect(
            resolveActiveBrainFrom({ brain: SETTINGS_BRAIN, mode: 'chatgpt', provider: providerStore.get(), keys, builderPick: { provider: 'anthropic', model: 'claude-sonnet-5' } }),
          ).toBe('chatgpt');
          expect(resolveActiveBrain()).toBe('chatgpt');

          // 3. The schedule editor's copy, whatever the app's pin says.
          for (const pinned of [undefined, 'openai', 'anthropic', 'chatgpt']) {
            expect(appBrainKind({ brain: SETTINGS_BRAIN, mode: 'chatgpt', provider: providerStore.get(), pinned, keys }), `pinned=${String(pinned)}`).toBe('chatgpt');
          }

          // 4. The data lane: a real brain, no "key missing", the door open, the D9 line.
          expect(chatBrainRoute(db, appId)).toMatchObject({ kind: 'chatgpt', keyMissing: false });
          expect(readerAdapterKind(db, appId)).toBe('chatgpt');
          expect(chatDoorOpen(chatBrainRoute(db, appId))).toBe(true);
          const lines = egressFor(db, appId, { unattended: false, sourceName: 'Pantry' });
          expect(lines[0]).toEqual({ kind: 'brain', text: EGRESS.chatgpt });
          expect(lines.some((line) => line.kind === 'chat')).toBe(true);

          // 5. The scheduled gate: the plan may answer unless signed out / not granted — then BY NAME.
          const gate = keylessBrainGate(db, appId);
          if (status === SIGNED_OUT) {
            expect(gate).toEqual({ status: 'refused', summary: SIGNED_OUT_REFUSAL, calls: { ai: 0, net: 0 }, blockedBy: 'brain' });
            expect(askBrainFor(db, appId)).toBe('blocked');
          } else if (status === NOT_GRANTED) {
            expect(gate).toEqual({ status: 'refused', summary: NOT_GRANTED_REFUSAL, calls: { ai: 0, net: 0 }, blockedBy: 'brain' });
            expect(askBrainFor(db, appId)).toBe('blocked');
          } else {
            // ready, or limited (L4-6: signed in + granted proceeds; a standing limit is the adapter's named result — L4-7).
            expect(gate).toBeUndefined();
            expect(askBrainFor(db, appId)).toBe('tools');
          }
          expect(gate?.summary).not.toBe(KEYLESS_BRAIN_REFUSAL);

          // 6. The inferrer: decideWire's chatgpt arm, before any key read (L4-9).
          const inference = await liveInferenceAdapter(appId);
          expect(inference.ok).toBe(true);
          expect(h.responses).toHaveLength(1);
          await expect(inferenceWireCopy()).resolves.toContain('your ChatGPT plan');

          // 7. The constructor: the Responses adapter with a bearer, never a key; nothing else built.
          for (const purpose of ['app', 'chat'] as const) {
            createTurnAdapter({ mode: 'chatgpt', provider: 'openai', ...(openai ? { key: OPENAI_KEY } : {}), model: 'gpt-6.1-sol', effort: 'high' }, purpose);
          }
          expect(h.responses).toHaveLength(3);
          for (const options of h.responses.slice(1)) {
            expect(options).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
            const bearer = options.bearer as { get?: unknown; refresh?: unknown; redact?: unknown };
            expect(typeof bearer.get).toBe('function');
            expect(typeof bearer.refresh).toBe('function');
            expect(typeof bearer.redact).toBe('function');
            expect(options).not.toHaveProperty('apiKey');
            expect(options).not.toHaveProperty('key');
            expect(JSON.stringify(options)).not.toContain(OPENAI_KEY);
          }

          expectNoClassicAdapter(label);
          expect(getByokKeySpy, 'getByokKey must never be called in chatgpt mode').not.toHaveBeenCalled();
        });
      }
    }
  }
});

describe('the data lane names the plan (L4-5; D9)', () => {
  it('EGRESS.chatgpt carries the D9 data-use sentence verbatim — and never a training or retention promise', () => {
    expect(EGRESS.chatgpt).toContain(D9_DATA_USE);
    expect(EGRESS.chatgpt.toLowerCase()).not.toContain('not used for training');
    expect(EGRESS.chatgpt.toLowerCase()).not.toContain('zero retention');
  });

  it('BRAIN_NAMES names the brain "ChatGPT plan"', () => {
    expect(BRAIN_NAMES.chatgpt.brain).toBe('ChatGPT plan');
  });
});

// ---------------------------------------------------------------------------------------------
// The send paths (L4-2, L4-3)
// ---------------------------------------------------------------------------------------------

describe('createDirectAppTransport / createAppTransport in chatgpt mode — no key, model and effort per send (L4-3)', () => {
  it('a turn runs on the Responses adapter with the plan’s default model and level, a BYOK OpenAI key in the file untouched', async () => {
    setKeys(true, true);
    setChatgptModel('gpt-6.1-sol');
    setChatgptEffort('high');
    await settle();
    const transport = createDirectAppTransport({ mode: 'chatgpt', provider: 'openai', model: 'gpt-6.1-sol', appId, needsConfirm: () => false });
    const reply = await transport.send(wireFor(appId), { signal: new AbortController().signal });
    expect(reply).toMatchObject({ ok: true });
    expect(h.responses).toHaveLength(1);
    expect(h.responses[0]).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
    expect(JSON.stringify(h.responses[0])).not.toContain(OPENAI_KEY);
    expectNoClassicAdapter('createDirectAppTransport');
    expect(getByokKeySpy).not.toHaveBeenCalled();
  });

  it('the level is read PER SEND: a change between two sends of one transport reaches the second; none set → omitted', async () => {
    const transport = createAppTransport('chatgpt', 'openai', undefined, appId);
    setChatgptModel('gpt-6.1-sol');
    await settle();
    await transport.send(wireFor(appId), { signal: new AbortController().signal });
    setChatgptEffort('low');
    await settle();
    await transport.send(wireFor(appId), { signal: new AbortController().signal });
    setChatgptEffort('ultra');
    await settle();
    await transport.send(wireFor(appId), { signal: new AbortController().signal });
    expect(h.responses.map((o) => o.effort)).toEqual([undefined, 'low', 'ultra']);
    expect(getByokKeySpy).not.toHaveBeenCalled();
  });

  it('the model resolves per send from providerModel:chatgpt — never the global `model` row (llama3.2) — and a chatgpt pin wins', async () => {
    const transport = createAppTransport('chatgpt', 'openai', undefined, appId);
    setChatgptModel('gpt-6.1-sol');
    await settle();
    await transport.send(wireFor(appId), { signal: new AbortController().signal });
    setAppPin(appId, { provider: 'chatgpt', model: 'gpt-6.1-mini' });
    await settle();
    await transport.send(wireFor(appId), { signal: new AbortController().signal });
    expect(h.responses.map((o) => o.model)).toEqual(['gpt-6.1-sol', 'gpt-6.1-mini']);
    expect(h.responses.map((o) => o.model)).not.toContain('llama3.2');
  });

  it('F15 holds: an unconfirmed file refuses the plan turn before any adapter is built (L4-12)', async () => {
    const transport = createDirectAppTransport({ mode: 'chatgpt', provider: 'openai', appId, needsConfirm: () => true });
    const reply = await transport.send(wireFor(appId), { signal: new AbortController().signal });
    expect(reply).toMatchObject({ ok: false, code: 'CONSENT_REQUIRED', retryable: false });
    expect(h.responses).toHaveLength(0);
  });
});

describe('createDirectBuilder in chatgpt mode — the builder and app-chat lanes (L4-3)', () => {
  it('stamps the plan as the brain, builds the Responses adapter with the row’s model and level, and never reads a key', async () => {
    setKeys(true, true);
    setChatgptModel('gpt-6.1-sol');
    setChatgptEffort('medium');
    await settle();
    const brains: string[] = [];
    const builder = createDirectBuilder({ mode: 'chatgpt', provider: 'openai', sink, appId, needsConfirm: () => false });
    const result = await builder.send('make me a tracker', { onBrain: (kind) => brains.push(kind) }, new AbortController().signal);
    expect(result).toMatchObject({ ok: true });
    expect(brains).toEqual(['chatgpt']);
    expect(h.responses).toHaveLength(1);
    expect(h.responses[0]).toMatchObject({ model: 'gpt-6.1-sol', effort: 'medium' });
    expect(JSON.stringify(h.responses[0])).not.toContain(OPENAI_KEY);
    expect(JSON.stringify(h.responses[0])).not.toContain(ANTHROPIC_KEY);
    expectNoClassicAdapter('createDirectBuilder');
    expect(getByokKeySpy).not.toHaveBeenCalled();
  });

  it('a BYOK provider pin on the attached app does not reroute a chatgpt builder turn', async () => {
    setKeys(true, true);
    setAppPin(appId, { provider: 'anthropic', model: 'claude-sonnet-5' });
    setChatgptModel('gpt-6.1-sol');
    await settle();
    const brains: string[] = [];
    const builder = createDirectBuilder({ mode: 'chatgpt', provider: 'openai', sink, appId, needsConfirm: () => false });
    await builder.send('hi', { onBrain: (kind) => brains.push(kind) }, new AbortController().signal);
    expect(brains).toEqual(['chatgpt']);
    expect(h.responses[0]).toMatchObject({ model: 'gpt-6.1-sol' });
    expectNoClassicAdapter('createDirectBuilder with a BYOK pin');
  });
});

describe('createTurnAdapter’s chatgpt arm — the model fallback and its named result (L4-2)', () => {
  const request = { system: 's', messages: [{ role: 'user' as const, content: 'hi' }] };

  it('config.model wins', () => {
    setChatgptModel('gpt-6.1-mini');
    createTurnAdapter({ mode: 'chatgpt', provider: 'openai', model: 'gpt-6.1-sol' }, 'app');
    expect(h.responses[0]).toMatchObject({ model: 'gpt-6.1-sol' });
  });

  it('no config.model → the providerModel:chatgpt row', async () => {
    setChatgptModel('gpt-6.1-mini');
    await settle();
    createTurnAdapter({ mode: 'chatgpt', provider: 'openai' }, 'app');
    expect(h.responses[0]).toMatchObject({ model: 'gpt-6.1-mini' });
  });

  it('no row → the first model of the plan’s cached list (server order)', async () => {
    await bootKeeper(READY);
    createTurnAdapter({ mode: 'chatgpt', provider: 'openai' }, 'app');
    expect(h.responses[0]).toMatchObject({ model: 'gpt-6.1-sol' });
  });

  for (const [label, status] of [
    ['signed out', SIGNED_OUT],
    ['plan not granted (no models)', NOT_GRANTED],
  ] as const) {
    it(`no model anywhere (${label}) → a RESULT naming it (HOST_ERROR), never a throw, never another adapter`, async () => {
      await bootKeeper(status);
      const adapter = createTurnAdapter({ mode: 'chatgpt', provider: 'openai', key: OPENAI_KEY }, 'app');
      const result = await adapter.complete(request);
      expect(result).toMatchObject({ ok: false, code: 'HOST_ERROR' });
      expect(result.ok ? '' : result.message).toContain('no ChatGPT model is chosen');
      expect(h.responses).toHaveLength(0);
      expectNoClassicAdapter(`no model (${label})`);
    });
  }

  it('the global `model` row is NEVER the plan’s fallback (it names an Ollama/subscription model)', async () => {
    await bootKeeper(SIGNED_OUT);
    modelStore.set('llama3.2');
    const adapter = createTurnAdapter({ mode: 'chatgpt', provider: 'openai' }, 'app');
    await adapter.complete(request);
    expect(h.responses.map((o) => o.model)).not.toContain('llama3.2');
  });

  it('a limited plan still builds the Responses adapter — the limit is ITS named result, never a reroute (L4-7)', async () => {
    await bootKeeper(LIMITED);
    createTurnAdapter({ mode: 'chatgpt', provider: 'openai', model: 'gpt-6.1-sol' }, 'app');
    expect(h.responses).toHaveLength(1);
    expectNoClassicAdapter('limited');
  });
});
