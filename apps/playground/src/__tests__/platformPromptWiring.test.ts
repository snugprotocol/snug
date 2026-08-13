// TASK-20260812-desktop-auth-awareness P2 — the platform seat reaches every playground
// assembly CALL SITE (AC1/AC2 wiring). Written RED-FIRST at Gate 3.
//
// TESTED AT THE DECISION ALTITUDE, deliberately (lesson 2026-08-05): the line that
// evaluates "which platform is this?" lives in `builder.ts` / `transport.ts` /
// `connectionInferrerAdapter.ts`, so that is where the assertions sit — never at the
// adapter, which would pass just as happily with a web prompt on desktop. The app-chat
// lanes need no call site of their own: useBuilderChat constructs its agent ONLY
// through `createDirectBuilder` (useBuilderChat.ts — the agent memo), so the builder
// assertions below ARE the lanes' decision altitude; the server path is asserted by
// its own suite staying byte-identical (invoke.ts deliberately has no platform seat —
// desktop never calls the hub).
//
// The platform is set-once/set-before-first-read, so every case takes a FRESH module
// registry (the platformFetchWiring.test.ts pattern) and imports its consumers
// dynamically from that same generation.
import { describe, expect, it, vi } from 'vitest';

import type { AdapterRequest, AgentAdapter, AgentRoundTrip, AgentTurnEvent } from '@snugprotocol/adapters';
import { getSystemLayer } from '@snugprotocol/knowledge';

import type { ArtifactSink, ArtifactWriteResult } from '../agent/artifactSink.js';
import type { SnugPlatform } from '../platform/platform.js';
import type { WebllmChatRequest, WebllmChunk, WebllmEngineLike } from '../agent/webllm/engine.js';

/** The rendered desktop layer — imported, never retyped (lesson 2026-08-03). */
const desktopLayer = (): string => getSystemLayer('platform-desktop');

const desktopPlatform = (): SnugPlatform => ({
  kind: 'desktop',
  capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
});

/** Fresh module registry; the platform (when given) is set BEFORE any consumer import. */
async function freshRegistry(platform?: SnugPlatform): Promise<void> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  await helper.installTestUserDb();
}

function tripCollector(): { trips: AgentRoundTrip[]; onLlmEvent: (event: AgentTurnEvent) => void } {
  const trips: AgentRoundTrip[] = [];
  return {
    trips,
    onLlmEvent: (event) => {
      if (event.type === 'round_trip') {
        const { type: _type, ...trip } = event;
        trips.push(trip);
      }
    },
  };
}

function recordingSink(): ArtifactSink {
  return {
    write: (html, title) => {
      void html;
      const result: ArtifactWriteResult = { id: 'app-platform-test', displayName: title ?? 'your app', version: 1 };
      return Promise.resolve(result);
    },
    ensureTargetId: () => Promise.resolve('app-platform-test'),
  };
}

// ---------------------------------------------------------------------------
// Builder (standard branch) — the assembly the app-chat lanes also ride.
// ---------------------------------------------------------------------------

async function builderSystem(platform?: SnugPlatform): Promise<string> {
  await freshRegistry(platform);
  const { createDirectBuilder } = await import('../agent/builder.js');
  const { trips, onLlmEvent } = tripCollector();
  const agent = createDirectBuilder({
    mode: 'byok',
    provider: 'mock',
    sink: recordingSink(),
    needsConfirm: () => false,
  });
  await agent.send('build me a timer', { onLlmEvent }, new AbortController().signal);
  return trips[0]?.request.system ?? '';
}

describe('builder call site (standard branch) — the platform seat is passed where the decision is made', () => {
  it('desktop platform set → the builder system carries the desktop layer', async () => {
    const system = await builderSystem(desktopPlatform());
    expect(system).toContain(desktopLayer());
  });

  it('no platform set → web default: the builder system carries NO desktop copy (AC10)', async () => {
    const system = await builderSystem();
    expect(system.length).toBeGreaterThan(0);
    expect(system).not.toContain(desktopLayer());
    expect(system).not.toContain('Snug Desktop App');
  });
});

// ---------------------------------------------------------------------------
// Builder (webllm branch) — the OTHER assembly line in builder.ts.
// ---------------------------------------------------------------------------

function scriptedEngine(reply: string): { engine: WebllmEngineLike; requests: WebllmChatRequest[] } {
  const requests: WebllmChatRequest[] = [];
  const engine: WebllmEngineLike = {
    chat: {
      completions: {
        create(request) {
          requests.push(request);
          async function* generate(): AsyncGenerator<WebllmChunk> {
            yield { model: 'test-model', choices: [{ delta: { content: reply }, finish_reason: null }] };
            yield { model: 'test-model', choices: [{ delta: {}, finish_reason: 'stop' }] };
          }
          return Promise.resolve(generate());
        },
      },
    },
  };
  return { engine, requests };
}

async function webllmSystem(platform?: SnugPlatform): Promise<string> {
  await freshRegistry(platform);
  const engineModule = await import('../agent/webllm/engine.js');
  const { engine, requests } = scriptedEngine('no app this turn.');
  engineModule.setWebllmEngineLoaderForTests(() => Promise.resolve(engine));
  try {
    const { createDirectBuilder } = await import('../agent/builder.js');
    const agent = createDirectBuilder({
      mode: 'webllm',
      provider: 'mock',
      sink: recordingSink(),
      needsConfirm: () => false,
    });
    await agent.send('build me a timer', {}, new AbortController().signal);
    const system = requests[0]?.messages[0];
    return system?.role === 'system' ? system.content : '';
  } finally {
    engineModule.setWebllmEngineLoaderForTests(undefined);
    engineModule.resetWebllmEngineForTests();
  }
}

describe('builder call site (webllm branch)', () => {
  it('desktop platform set → the webllm system carries the desktop layer beneath the suffix', async () => {
    expect(await webllmSystem(desktopPlatform())).toContain(desktopLayer());
  });

  it('no platform set → no desktop copy in the webllm system', async () => {
    const system = await webllmSystem();
    expect(system.length).toBeGreaterThan(0);
    expect(system).not.toContain(desktopLayer());
  });
});

// ---------------------------------------------------------------------------
// App transport — the appRuntime assembly (ADR-0018 D1).
// ---------------------------------------------------------------------------

async function transportSystem(platform?: SnugPlatform): Promise<string> {
  await freshRegistry(platform);
  const { createDirectAppTransport } = await import('../agent/transport.js');
  const { trips, onLlmEvent } = tripCollector();
  const transport = createDirectAppTransport({
    mode: 'byok',
    provider: 'mock',
    needsConfirm: () => false,
    onLlmEvent,
  });
  await transport.send(JSON.stringify({ type: 'chat', text: 'I play e4' }), {
    signal: new AbortController().signal,
  });
  return trips[0]?.request.system ?? '';
}

describe('app-transport call site — the appRuntime assembly carries the platform seat', () => {
  it('desktop platform set → the runtime system carries the desktop layer', async () => {
    expect(await transportSystem(desktopPlatform())).toContain(desktopLayer());
  });

  it('no platform set → the lean runtime assembly is unchanged (AC10)', async () => {
    const system = await transportSystem();
    expect(system).toContain('You Are Running Inside an App');
    expect(system).not.toContain(desktopLayer());
  });
});

// ---------------------------------------------------------------------------
// Inferrer adapter — AC2's wiring half: platform facts ride the USER slot.
// ---------------------------------------------------------------------------

async function inferrerWire(platform?: SnugPlatform): Promise<{ system: string; user: string }> {
  await freshRegistry(platform);
  const { runConnectionRequirementInference } = await import('../agent/connectionInferrerAdapter.js');
  const seen: AdapterRequest[] = [];
  const adapter: AgentAdapter = {
    complete: (request) => {
      seen.push(request);
      return Promise.resolve({
        ok: true,
        text: '{"requirement":null,"confidence":0.1,"evidence":[]}',
        toolCalls: [],
        stopReason: 'end',
      });
    },
  };
  // An UNPINNED provider with pasted docs: the ladder must reach the completion seam.
  await runConnectionRequirementInference({
    providerName: 'Tidepool Analytics',
    slot: 'tidepool',
    docsText: 'Tidepool Analytics API - pass your key in the X-Api-Key header.',
    adapter,
  });
  expect(seen, 'the completion seam was never reached').toHaveLength(1);
  const request = seen[0]!;
  return { system: request.system, user: String(request.messages[0]?.content ?? '') };
}

describe('inferrer call site — the adapter passes the platform through (AC2)', () => {
  it('desktop platform set → the USER slot carries the pinned "Platform facts (desktop):" block', async () => {
    const { user } = await inferrerWire(desktopPlatform());
    expect(user).toMatch(/^Platform facts \(desktop\):$/m);
    expect(user).toMatch(/typed by the user/i);
  });

  it('no platform set → web default: the user slot carries NO platform block', async () => {
    const { user } = await inferrerWire();
    expect(user).toContain('<provider_docs>');
    expect(user).not.toContain('Platform facts');
  });

  it('the SYSTEM slot is byte-identical on web and desktop (D2 — static system)', async () => {
    const desktop = await inferrerWire(desktopPlatform());
    const web = await inferrerWire();
    expect(desktop.system).toBe(web.system);
  });
});
