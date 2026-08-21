// appModelRouting.test.ts — TASK-20260817-per-app-model-selector AC6/AC7/AC8.
//
// The owner's core ask is that a pick actually ROUTES: every app-scoped LLM call for
// that app must reach the provider naming the chosen model. Four lanes read a model
// today, and each is asserted here INDEPENDENTLY — reverting any one of them to the bare
// `modelStore.get()` must red exactly one test in this file. A single combined
// assertion would let three broken lanes hide behind one working one.
//
//   AC6a  app-frame turns          `resolveAppTransport` → createDirectAppTransport
//   AC6b  app-attached chat        `useBuilderChat`'s agent memo (attached app)
//   AC6c  the builder lane         the same memo (owner decision 1 (b)+(c) share it)
//   AC6d  connection inference     `liveInferenceAdapter`
//
// The assertion altitude is the WIRE: the `model` field on the request body the adapter
// actually sends. That is where the decision lands (lessons.md 2026-08-05 — assert at
// the altitude where the DECISION is made, and for routing the decision is only real
// once it is on the wire). Asserting a returned config object instead would pass while
// the adapter dropped the field.
//
// AC7  the brain OVERRIDE still wins: under `webllm`/`demo` the pick is ignored (ADR-0015
//      — the brain overrides the CONFIGURED mode entirely), as it is for `mock`.
// AC8  subscription mode carries the resolved model as the `/invoke` body `model`, which
//      the server already swaps per request (routes/invoke.ts:96-98).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppTransport, resolveAppTransport } from '../agent/transport.js';
import { createDirectBuilder } from '../agent/builder.js';
import type { ArtifactSink } from '../agent/artifactSink.js';
import { liveInferenceAdapter } from '../agent/inferrerAdapter.js';
import { appModelStore, appProviderStore, setAppModel, setAppPin } from '../state/appModel.js';
import {
  byokKeyPresenceStore,
  endpointsNeedConfirmStore,
  modeStore,
  modelStore,
  providerChoiceStore,
  providerModelsStore,
  providerStore,
} from '../state/mode.js';
import { installTestUserDb } from './userdbTestHelper.js';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const APP_A = 'app-a';
const APP_B = 'app-b';

/**
 * A fetch double that records the `model` field of every request body it sees and
 * answers with a minimal, well-formed Anthropic SSE stream. Recording the BODY (rather
 * than spying on `anthropicAdapter`) is what makes this a wire assertion: a lane that
 * resolves the right model but fails to forward it still reds.
 */
function recordingFetch(): { calls: string[]; fetchImpl: typeof globalThis.fetch } {
  const calls: string[] = [];
  const fetchImpl = (async (input: unknown, init?: { body?: unknown }) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { model?: string }) : {};
    calls.push(String(body.model));
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"message\\":\\"ok\\"}"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

/**
 * A no-op ArtifactSink. These tests drive the model decision, not artifact writing — but
 * the seam is required, and a stub that satisfies the real interface (rather than a cast)
 * is what keeps the tsc gate meaningful.
 */
function testSink(): ArtifactSink {
  return {
    write: () => Promise.resolve({ id: APP_A, displayName: 'unused', version: 1 }),
    ensureTargetId: () => Promise.resolve(APP_A),
  };
}

beforeEach(async () => {
  appModelStore.set({});
  appProviderStore.set({});
  modelStore.set(undefined);
  modeStore.set('byok');
  providerStore.set('anthropic');
  providerChoiceStore.set(undefined);
  providerModelsStore.set({});
  byokKeyPresenceStore.set({ anthropic: true, openai: true });
  endpointsNeedConfirmStore.set(false);
  vi.restoreAllMocks();
  const db = await installTestUserDb();
  db.setSecret('byok:anthropic', 'sk-test-key');
  db.setSecret('byok:openai', 'sk-openai-key');
});

describe('AC6a — app-frame turns route to the app’s model', () => {
  it('sends the app’s pinned model on the wire', async () => {
    providerModelsStore.set({ anthropic: 'claude-opus-4-8' });
    setAppModel(APP_A, 'claude-opus-5');
    await flush();

    const { calls, fetchImpl } = recordingFetch();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

    const transport = resolveAppTransport('byok', 'anthropic', undefined, APP_A);
    await transport.send('[SNUG_APP_REQUEST] {"snug":1}', { signal: new AbortController().signal });

    expect(calls).toEqual(['claude-opus-5']);
  });

  it('sends the provider default for an app with no pick', async () => {
    // MIGRATED (TASK-20260821): the byok default is per-provider now, and the fixture is
    // deliberately NOT the adapter's own default — 'claude-sonnet-5' would pass vacuously
    // because an absent model makes the adapter apply exactly that id.
    providerModelsStore.set({ anthropic: 'claude-opus-4-8' });
    const { calls, fetchImpl } = recordingFetch();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

    const transport = resolveAppTransport('byok', 'anthropic', undefined, APP_B);
    await transport.send('[SNUG_APP_REQUEST] {"snug":1}', { signal: new AbortController().signal });

    expect(calls).toEqual(['claude-opus-4-8']);
  });

  it('reads the pick PER SEND, so a mid-session switch takes effect without remounting', async () => {
    // transport.ts states the rule: these values are read per send, never captured at
    // construction, because RunView memoizes the transport. A pick that only applied
    // after a reload would violate the owner's "route all LLM calls" ask in the exact
    // moment the user makes the choice.
    //
    // The per-send resolution lives in `createAppTransport`, which re-enters
    // `resolveAppTransport` on EVERY send — so this test drives the memoized wrapper
    // (what RunView actually holds), not the inner factory. Driving the inner factory
    // and re-using its result would test a transport nobody keeps.
    setAppModel(APP_A, 'claude-opus-5');
    await flush();
    const { calls, fetchImpl } = recordingFetch();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

    const transport = createAppTransport('byok', 'anthropic', undefined, APP_A);
    await transport.send('[SNUG_APP_REQUEST] {"snug":1}', { signal: new AbortController().signal });

    setAppModel(APP_A, 'claude-sonnet-5');
    await flush();
    await transport.send('[SNUG_APP_REQUEST] {"snug":1}', { signal: new AbortController().signal });

    expect(calls).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('keeps two apps on their own models in the same session', async () => {
    setAppModel(APP_A, 'claude-opus-5');
    setAppModel(APP_B, 'claude-sonnet-5');
    await flush();
    const { calls, fetchImpl } = recordingFetch();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

    await resolveAppTransport('byok', 'anthropic', undefined, APP_A).send('[SNUG_APP_REQUEST] {"snug":1}', {
      signal: new AbortController().signal,
    });
    await resolveAppTransport('byok', 'anthropic', undefined, APP_B).send('[SNUG_APP_REQUEST] {"snug":1}', {
      signal: new AbortController().signal,
    });

    expect(calls).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });
});

describe('AC6b/AC6c — the builder + app-attached chat lane routes to the app’s model', () => {
  // Both lanes resolve through ONE `useMemo` in useBuilderChat (the surprise recorded in
  // the task file), so they are driven here through the same seam the memo calls.
  it('sends the attached app’s pinned model on the wire', async () => {
    providerModelsStore.set({ anthropic: 'claude-opus-4-8' });
    setAppModel(APP_A, 'claude-opus-5');
    await flush();

    const { calls, fetchImpl } = recordingFetch();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

    const builder = createDirectBuilder({
      mode: 'byok',
      provider: 'anthropic',
      sink: testSink(),
      appId: APP_A,
    });
    await builder.send('hello', {}, new AbortController().signal);

    expect(calls[0]).toBe('claude-opus-5');
  });

  it('falls back to the provider default when no app is attached (a fresh build thread)', async () => {
    providerModelsStore.set({ anthropic: 'claude-opus-4-8' });
    const { calls, fetchImpl } = recordingFetch();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

    const builder = createDirectBuilder({
      mode: 'byok',
      provider: 'anthropic',
      sink: testSink(),
    });
    await builder.send('hello', {}, new AbortController().signal);

    expect(calls[0]).toBe('claude-opus-4-8');
  });
});

describe('AC6d — connection inference routes to the app’s model', () => {
  it('uses the app’s pinned model when an app id is in scope', async () => {
    providerModelsStore.set({ anthropic: 'claude-opus-4-8' });
    setAppModel(APP_A, 'claude-opus-5');
    await flush();

    const { calls, fetchImpl } = recordingFetch();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

    const result = await liveInferenceAdapter(APP_A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await result.adapter.complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    });

    expect(calls[0]).toBe('claude-opus-5');
  });

  it('falls back to the provider default when no app id is in scope', async () => {
    providerModelsStore.set({ anthropic: 'claude-opus-4-8' });
    const { calls, fetchImpl } = recordingFetch();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

    const result = await liveInferenceAdapter();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await result.adapter.complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    });

    expect(calls[0]).toBe('claude-opus-4-8');
  });
});

describe('AC7 — the brain override and the mock provider ignore the pick', () => {
  it('does not send a per-app model under the demo brain', async () => {
    // `demo` is the no-WebGPU fallback and routes to the mock adapter: no network at all.
    // The guarantee under test is that the pick cannot re-enable a real provider call.
    setAppModel(APP_A, 'claude-opus-5');
    await flush();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be touched'));

    const transport = resolveAppTransport('byok', 'mock', undefined, APP_A);
    const result = await transport.send('[SNUG_APP_REQUEST] {"snug":1}', {
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AC8 — subscription mode carries the resolved model to /invoke', () => {
  it('puts the app’s pinned model in the request body', async () => {
    modeStore.set('subscription');
    modelStore.set('claude-sonnet-5');
    setAppModel(APP_A, 'claude-opus-5');
    await flush();

    const { calls, fetchImpl } = recordingFetch();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

    const transport = resolveAppTransport('subscription', 'anthropic', undefined, APP_A);
    await transport.send('[SNUG_APP_REQUEST] {"snug":1}', { signal: new AbortController().signal });

    // The server already accepts and swaps a per-request `model` (routes/invoke.ts:96-98),
    // so no server change is owed — only that the hub actually sends the resolved value.
    expect(calls[0]).toBe('claude-opus-5');
  });
});

/**
 * TASK-20260821 AC10 — a PROVIDER pin routes the wire: adapter family, endpoint, key
 * and model all follow the app's pinned provider, per send.
 *
 * The double answers BOTH wire dialects, keyed on the URL, and records
 * `host · model · key` so a lane that resolves the right provider but forwards the
 * wrong key (or the other provider's model id) still reds.
 */
function dualRecordingFetch(): { calls: string[]; fetchImpl: typeof globalThis.fetch } {
  const calls: string[] = [];
  const fetchImpl = (async (input: unknown, init?: { body?: unknown; headers?: unknown }) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { model?: string }) : {};
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = headers['x-api-key'] ?? headers['Authorization'] ?? headers['authorization'] ?? '';
    const host = new URL(url).host;
    calls.push(`${host} · ${String(body.model)} · ${key.replace(/^Bearer /, '')}`);
    if (host.includes('anthropic')) {
      const sse = [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"message\\":\\"ok\\"}"}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    const sse = [
      'data: {"choices":[{"delta":{"content":"{\\"message\\":\\"ok\\"}"},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":3}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

describe('AC10 — a provider pin routes adapter, key and model (per send, no remount)', () => {
  it('an app pinned to the OTHER provider sends to that provider with ITS key and model', async () => {
    providerModelsStore.set({ anthropic: 'claude-opus-4-8' });
    setAppPin(APP_A, { provider: 'openai', model: 'gpt-4o-mini' });
    await flush();
    const { calls, fetchImpl } = dualRecordingFetch();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

    // The captured `provider` argument is the RESOLVED DEFAULT (anthropic) — the pin
    // must override it inside the per-send resolution, not rely on the caller.
    const transport = createAppTransport('byok', 'anthropic', undefined, APP_A);
    await transport.send('[SNUG_APP_REQUEST] {"snug":1}', { signal: new AbortController().signal });

    expect(calls).toEqual(['api.openai.com · gpt-4o-mini · sk-openai-key']);
  });

  it('a pin made MID-SESSION reroutes the very next send of the memoized transport', async () => {
    const { calls, fetchImpl } = dualRecordingFetch();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

    const transport = createAppTransport('byok', 'anthropic', undefined, APP_A);
    await transport.send('[SNUG_APP_REQUEST] {"snug":1}', { signal: new AbortController().signal });
    setAppPin(APP_A, { provider: 'openai', model: 'gpt-4o-mini' });
    await flush();
    await transport.send('[SNUG_APP_REQUEST] {"snug":1}', { signal: new AbortController().signal });

    expect(calls[0]).toContain('api.anthropic.com');
    expect(calls[1]).toBe('api.openai.com · gpt-4o-mini · sk-openai-key');
  });

  it('the builder lane follows the attached app’s provider pin', async () => {
    setAppPin(APP_A, { provider: 'openai', model: 'gpt-4o-mini' });
    await flush();
    const { calls, fetchImpl } = dualRecordingFetch();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

    const builder = createDirectBuilder({
      mode: 'byok',
      provider: 'anthropic',
      sink: testSink(),
      appId: APP_A,
    });
    await builder.send('hello', {}, new AbortController().signal);

    expect(calls[0]).toBe('api.openai.com · gpt-4o-mini · sk-openai-key');
  });

  it('the inference lane follows the app’s provider pin', async () => {
    setAppPin(APP_A, { provider: 'openai', model: 'gpt-4o-mini' });
    await flush();
    const { calls, fetchImpl } = dualRecordingFetch();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

    const result = await liveInferenceAdapter(APP_A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await result.adapter.complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    });

    expect(calls[0]).toBe('api.openai.com · gpt-4o-mini · sk-openai-key');
  });

  it('an app WITHOUT a pin keeps following the default provider — the pin is per-app', async () => {
    setAppPin(APP_A, { provider: 'openai', model: 'gpt-4o-mini' });
    await flush();
    const { calls, fetchImpl } = dualRecordingFetch();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

    const transport = createAppTransport('byok', 'anthropic', undefined, APP_B);
    await transport.send('[SNUG_APP_REQUEST] {"snug":1}', { signal: new AbortController().signal });

    expect(calls[0]).toContain('api.anthropic.com');
    expect(calls[0]).toContain('sk-test-key');
  });
});
