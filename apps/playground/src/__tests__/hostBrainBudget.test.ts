// hostBrainBudget.test.ts — TASK-20260905-binding-a-artifacts AC1/AC3: the platform brain
// seat carries one adapter PER PURPOSE (the app envelope on `quick`, the builder and the
// inferrer on `default` — a host decision, never a control), and the builder's host arm
// budgets the turn against the seat's cap on the SAME ruler the adapter sends with —
// history dropped oldest-first, then a NAMED refusal with zero adapter calls; the app's
// html is never cut (T4 S11 arm F: a cut context + "write the ENTIRE file" returns a
// plausible app whose tail the model invented).
//
// Fresh module graph per case (setPlatform is set-once) — the hostBrain.test.ts harness.
import type { AdapterMessage, AdapterRequest, AgentAdapter } from '@snugprotocol/adapters';
import { createMemoryBackend } from '@snugprotocol/db';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformBrain, SnugPlatform } from '../platform/platform.js';
import { hostPlatform as hostFixture } from './fixtures/hostPlatform.js';

const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

const HOST_LABEL = 'Claude · this artifact’s viewer';
const CAP = 65_536;
const SEP = '\n\n';
const utf8 = (s: string): number => new TextEncoder().encode(s).length;
/** The kit's ruler, as the seat will carry it: one string when the turn is a single user message, contents summed otherwise. */
const ruler = (system: string, messages: AdapterMessage[]): number =>
  messages.length === 1 ? utf8(`${system}${SEP}${messages[0]!.content}`) : utf8(system) + messages.reduce((n, m) => n + utf8(m.content), 0);

interface Graph {
  platform: typeof import('../platform/platform.js');
  adapter: typeof import('../agent/adapter.js');
  builder: typeof import('../agent/builder.js');
  inferrer: typeof import('../agent/inferrerAdapter.js');
  budget: typeof import('../agent/promptBudget.js');
}

function fakeAdapter(name: string): { adapter: AgentAdapter; calls: AdapterRequest[] } {
  const calls: AdapterRequest[] = [];
  return {
    calls,
    adapter: {
      complete: async (request) => {
        calls.push(request);
        return { ok: true, text: `reply from ${name}`, toolCalls: [], stopReason: 'end' };
      },
    },
  };
}

const hostPlatform = (brain: PlatformBrain): SnugPlatform => hostFixture({ brain, userdbBackend: createMemoryBackend() });

async function fresh(brain: PlatformBrain): Promise<Graph> {
  vi.resetModules();
  vi.doMock('../run/wasm.js', () => ({ locateWasm }));
  const platform = await import('../platform/platform.js');
  platform.setPlatform(hostPlatform(brain));
  return {
    platform,
    adapter: await import('../agent/adapter.js'),
    builder: await import('../agent/builder.js'),
    inferrer: await import('../agent/inferrerAdapter.js'),
    budget: await import('../agent/promptBudget.js'),
  };
}

const fakeSink = { write: async () => ({ id: 'app-1', displayName: 'app', version: 1 }), ensureTargetId: async () => 'app-1' };
const signal = (): AbortSignal => new AbortController().signal;
const html = (kb: number): string => `<!doctype html><html><body>${'x'.repeat(kb * 1024)}</body></html>`;
const block = (code: string): string => `## The app you are working on\n\nName: Big\n\n### Current app code (v1)\n\n\`\`\`html\n${code}\n\`\`\``;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../run/wasm.js');
});

describe('one adapter per purpose (AC1)', () => {
  it("'app' turns take `adapter`, 'chat' turns (builder, inferrer) take `chatAdapter`", async () => {
    const app = fakeAdapter('app');
    const chat = fakeAdapter('chat');
    const g = await fresh({ kind: 'host', label: HOST_LABEL, adapter: app.adapter, chatAdapter: chat.adapter, streaming: true, tools: false });
    expect(g.adapter.createTurnAdapter({ mode: 'host', provider: 'mock' }, 'app')).toBe(app.adapter);
    expect(g.adapter.createTurnAdapter({ mode: 'host', provider: 'mock' }, 'chat')).toBe(chat.adapter);
    const agent = g.builder.createDirectBuilder({ mode: 'host', provider: 'mock', sink: fakeSink });
    await agent.send('build me a tiny app', {}, signal());
    expect(chat.calls).toHaveLength(1);
    expect(app.calls).toHaveLength(0);
    const live = await g.inferrer.liveInferenceAdapter();
    expect(live.ok && live.adapter).toBe(chat.adapter);
  });

  it('without `chatAdapter` every purpose takes `adapter` (T2 shape, unchanged)', async () => {
    const only = fakeAdapter('only');
    const g = await fresh({ kind: 'host', label: HOST_LABEL, adapter: only.adapter, streaming: true, tools: false });
    expect(g.adapter.createTurnAdapter({ mode: 'host', provider: 'mock' }, 'app')).toBe(only.adapter);
    expect(g.adapter.createTurnAdapter({ mode: 'host', provider: 'mock' }, 'chat')).toBe(only.adapter);
  });
});

describe('budget or refuse — the builder under a capped host brain (AC3)', () => {
  const brain = (chat: AgentAdapter): PlatformBrain => ({
    kind: 'host',
    label: HOST_LABEL,
    adapter: fakeAdapter('app').adapter,
    chatAdapter: chat,
    streaming: true,
    tools: false,
    maxPromptBytes: CAP,
    promptBytes: ruler,
  });

  // Fixture sizes since TASK-20260906-tool-free-kb-inlining: the tool-free builder carries
  // the five-file KB core INLINE (~41 KB of system text, ceiling 45,056 — `HOST_BUILDER_SYSTEM_MAX_BYTES`),
  // so the room beside it is ≈ 20 KiB, not the ≈ 60 KB these cases were first written
  // against. An 18 KB app fits under the CEILING (not just today's bytes); 51 KB — S11's
  // measured whole-app case — is now the refused example. The doctrine is unchanged:
  // whole or refused, never cut.
  it('an 18 KB app rides WHOLE and the bytes sent are at or under the cap on the identical string', async () => {
    const chat = fakeAdapter('chat');
    const g = await fresh(brain(chat.adapter));
    const agent = g.builder.createDirectBuilder({ mode: 'host', provider: 'mock', sink: fakeSink });
    const code = html(18);
    const result = await agent.send({ message: 'add a pause button', contextBlock: block(code) }, {}, signal());
    expect(result.ok).toBe(true);
    expect(chat.calls).toHaveLength(1);
    const sent = chat.calls[0]!;
    expect(sent.system).toContain(code); // intact — no marker, no cut
    expect(ruler(sent.system, sent.messages)).toBeLessThanOrEqual(CAP);
  });

  it('(N) a 51 KB app is REFUSED by name before any call — the message carries the bytes and the cap', async () => {
    const chat = fakeAdapter('chat');
    const g = await fresh(brain(chat.adapter));
    const agent = g.builder.createDirectBuilder({ mode: 'host', provider: 'mock', sink: fakeSink });
    const result = await agent.send({ message: 'add a timestamp', contextBlock: block(html(51)) }, {}, signal());
    expect(result).toMatchObject({ ok: false, code: g.budget.PROMPT_TOO_LARGE_CODE, retryable: false });
    if (!result.ok) {
      // The message names the WHOLE turn (52,224 of html + the builder's own system text)
      // and the cap — the exact total is the ruler's business, not a band fit to today's bytes.
      expect(result.message).toMatch(/comes to \d{2,3},\d{3} bytes \(the app, its context and the builder's own instructions/);
      expect(result.message).toContain('65,536');
      expect(result.message).toMatch(/export/i);
    }
    expect(chat.calls).toHaveLength(0);
  });

  it('history is dropped oldest-first before anything else; the app code is never touched', async () => {
    const chat = fakeAdapter('chat');
    const g = await fresh(brain(chat.adapter));
    const agent = g.builder.createDirectBuilder({ mode: 'host', provider: 'mock', sink: fakeSink });
    const code = html(12);
    // Self-calibrating (Gate-5 fold): learn the turn's bytes WITHOUT history from the
    // ruler, then size the OLDEST message so the turn is over the cap by ~1 KB — less than
    // that one message, whatever the builder layers measure.
    const recent = [
      { role: 'user' as const, content: 'recent question' },
      { role: 'assistant' as const, content: 'recent answer' },
    ];
    const probe = await agent.send({ message: 'one more change', contextBlock: block(code), history: recent }, {}, signal());
    expect(probe.ok).toBe(true);
    const base = ruler(chat.calls[0]!.system, chat.calls[0]!.messages);
    chat.calls.length = 0;
    const oldestSize = CAP - base + 1024;
    const history = [
      { role: 'user' as const, content: `oldest ${'h'.repeat(oldestSize)}` },
      { role: 'assistant' as const, content: 'older answer' },
      ...recent,
    ];
    const result = await agent.send({ message: 'one more change', contextBlock: block(code), history }, {}, signal());
    expect(result.ok).toBe(true);
    const sent = chat.calls[0]!;
    expect(sent.system).toContain(code);
    // Over by less than one history message: exactly the OLDEST goes, nothing more.
    expect(sent.messages.map((m) => m.content.slice(0, 6))).toEqual(['older ', 'recent', 'recent', 'one mo']);
    expect(ruler(sent.system, sent.messages)).toBeLessThanOrEqual(CAP);
  });

  it('positive twin: a host brain WITHOUT a ruler never refuses (the T2 seat, unchanged)', async () => {
    const chat = fakeAdapter('chat');
    const g = await fresh({ kind: 'host', label: HOST_LABEL, adapter: chat.adapter, streaming: true, tools: false, maxPromptBytes: CAP });
    const agent = g.builder.createDirectBuilder({ mode: 'host', provider: 'mock', sink: fakeSink });
    const result = await agent.send({ message: 'x', contextBlock: block(html(117)) }, {}, signal());
    expect(result.ok).toBe(true);
    expect(chat.calls).toHaveLength(1);
  });

  it('fitHostTurn is pure and exact: over by one byte after every rung → refuse; at the cap → fits', async () => {
    const g = await fresh({ kind: 'host', label: HOST_LABEL, adapter: fakeAdapter('a').adapter, streaming: true, tools: false });
    const system = 'S';
    const message = 'm';
    const cap = ruler(system, [{ role: 'user', content: message }]);
    expect(g.budget.fitHostTurn({ system, history: [], message }, { maxPromptBytes: cap, promptBytes: ruler })).toMatchObject({ ok: true, droppedHistory: 0 });
    expect(g.budget.fitHostTurn({ system, history: [], message }, { maxPromptBytes: cap - 1, promptBytes: ruler })).toMatchObject({ ok: false, bytes: cap });
  });
});
