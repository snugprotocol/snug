// TASK-20261023-siwc-chatgpt-plan L2 — byte-split replay of the three RECORDED Responses streams
// (fixtures/openai-responses/*.sse, PROVENANCE.md beside them) through the real adapter
// (lesson L268: a parser is only proven honest against the real wire, at every boundary the
// network could cut it). Then the recorded tool round trip driven through `runAgentTurn`, which
// must resend the FULL context — `store:false` means the route remembers nothing (AC4).
//
// The splits are made on BYTES, not on string characters: `stream-toolcall-2.sse` carries raw
// UTF-8 (`’`, `°`), and a boundary inside a multi-byte sequence is exactly the cut a string-level
// splitter could never produce.
//
// Expected values were read from the fixtures by hand (and cross-checked against each stream's
// own `response.output_text.done` / `function_call_arguments.done` / `response.completed`).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  openaiResponsesAdapter,
  runAgentTurn,
  type AdapterResult,
  type AgentTool,
  type BearerSource,
  type FetchLike,
} from '../index.js';
import { fakeFetch } from './helpers.js';

const FIXTURES = join(__dirname, 'fixtures', 'openai-responses');
const load = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));

const TOKEN = 'plan-bearer-for-replay-0123456789abcdef';
const bearer: BearerSource = {
  get: async () => ({ ok: true, token: TOKEN }),
  refresh: async () => ({ ok: true, token: TOKEN }),
  redact: (text) => text.split(TOKEN).join('***'),
};

/** A header-less 2xx (as recorded: `content-type: null`) delivering exactly these byte chunks. */
function bytesResponse(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200 },
  );
}

const WEATHER: AgentTool = {
  def: {
    name: 'get_weather',
    description: 'Current weather for a city.',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
  },
  run: (input) => `14°C, light rain in ${String(input.city)}`,
};

const SYSTEM = 'You are a terse assistant inside a local app. Answer in one short sentence.';

interface Expected {
  file: string;
  text: string;
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  stopReason: 'end' | 'tool_use';
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

// Read from the recorded bytes. toolcall-1's single call: name `get_weather`, call_id
// `call_dey9hByG71tiQf2bdSR2ff8l`, arguments `{"city":"Olden, Norway"}` (assembled from eight
// deltas; `.done` carries the same string).
const EXPECTED: Expected[] = [
  {
    file: 'stream-text.sse',
    text: 'Hello, Snug, enjoy your day!',
    toolCalls: [],
    stopReason: 'end',
    usage: { inputTokens: 35, outputTokens: 95, cacheReadTokens: 0 },
  },
  {
    file: 'stream-toolcall-1.sse',
    text: '',
    toolCalls: [{ id: 'call_dey9hByG71tiQf2bdSR2ff8l', name: 'get_weather', input: { city: 'Olden, Norway' } }],
    stopReason: 'tool_use',
    usage: { inputTokens: 78, outputTokens: 21, cacheReadTokens: 0 },
  },
  {
    file: 'stream-toolcall-2.sse',
    text: 'It’s currently 14°C with light rain in Olden, Norway.',
    toolCalls: [],
    stopReason: 'end',
    usage: { inputTokens: 121, outputTokens: 19, cacheReadTokens: 0 },
  },
];

async function replay(chunks: Uint8Array[]): Promise<{ result: AdapterResult; deltas: string[] }> {
  const { fetchImpl } = fakeFetch(() => bytesResponse(chunks));
  const adapter = openaiResponsesAdapter({ bearer, model: 'gpt-6.1-sol', fetch: fetchImpl });
  const deltas: string[] = [];
  const result: AdapterResult = await adapter.complete({
    system: SYSTEM,
    messages: [{ role: 'user', content: 'replay' }],
    tools: [WEATHER.def],
    onDelta: (d: string) => deltas.push(d),
  });
  return { result, deltas };
}

/**
 * EVERY byte boundary — exhaustive, not sampled: mid-`data:`, between the two newlines of a
 * block, mid-JSON-escape, and inside each multi-byte UTF-8 sequence. Cheap enough (~35k
 * replays across the three fixtures in a few seconds) that sampling would only lose coverage.
 */
function splitPoints(bytes: Uint8Array): number[] {
  return Array.from({ length: bytes.length - 1 }, (_, i) => i + 1);
}

function project(result: AdapterResult): unknown {
  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  return { text: result.text, toolCalls: result.toolCalls, stopReason: result.stopReason, usage: result.usage, model: result.model };
}

describe('recorded Responses streams — the adapter is byte-faithful at every boundary (L268)', () => {
  it('the fixtures are the recorded bytes (sizes as checked in) and toolcall-2 really carries multi-byte UTF-8', () => {
    expect(load('stream-text.sse').length).toBe(13_923);
    expect(load('stream-toolcall-1.sse').length).toBe(9_211);
    expect(load('stream-toolcall-2.sse').length).toBe(12_228);
    expect(load('stream-toolcall-2.sse').some((byte) => byte >= 0x80)).toBe(true);
  });

  describe.each(EXPECTED)('$file', (expected) => {
    const bytes = load(expected.file);
    const want = {
      text: expected.text,
      toolCalls: expected.toolCalls,
      stopReason: expected.stopReason,
      usage: expected.usage,
      model: 'gpt-6.1-sol',
    };

    it('whole-body delivery: the expected text, tool calls, usage and wire model; deltas concatenate to the text', async () => {
      const { result, deltas } = await replay([bytes]);
      expect(project(result)).toEqual(want);
      expect(deltas.join('')).toBe(expected.text);
    });

    it('EVERY two-chunk byte split assembles the identical result', async () => {
      const points = splitPoints(bytes);
      expect(points).toHaveLength(bytes.length - 1); // the sweep is real, not vacuous
      for (const at of points) {
        const { result, deltas } = await replay([bytes.slice(0, at), bytes.slice(at)]);
        expect(project(result), `split at byte ${at}`).toEqual(want);
        expect(deltas.join(''), `split at byte ${at} altered the streamed deltas`).toBe(expected.text);
      }
    }, 120_000);

    it('one-byte-per-chunk delivery assembles the identical result', async () => {
      const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
      const { result, deltas } = await replay(chunks);
      expect(project(result)).toEqual(want);
      expect(deltas.join('')).toBe(expected.text);
    }, 30_000);
  });
});

describe('the recorded tool round trip through runAgentTurn — full-context resend (AC4)', () => {
  it('the second request’s input is the whole prior conversation + the function_call + the function_call_output', async () => {
    const legs = [load('stream-toolcall-1.sse'), load('stream-toolcall-2.sse')];
    let leg = 0;
    const { calls, fetchImpl } = fakeFetch(() => bytesResponse([legs[leg++]!]));
    const adapter = openaiResponsesAdapter({ bearer, model: 'gpt-6.1-sol', fetch: fetchImpl as FetchLike });

    const prior = [
      { role: 'user' as const, content: 'Hi there.' },
      { role: 'assistant' as const, content: 'Hello! How can I help?' },
      { role: 'user' as const, content: 'What is the weather in Olden, Norway?' },
    ];
    const deltas: string[] = [];
    const result = await runAgentTurn({ adapter, system: SYSTEM, messages: prior, tools: [WEATHER], onDelta: (d) => deltas.push(d) });

    expect(result).toEqual({ ok: true, text: 'It’s currently 14°C with light rain in Olden, Norway.', stopReason: 'end' });
    expect(deltas.join('')).toBe('It’s currently 14°C with light rain in Olden, Norway.');
    expect(calls).toHaveLength(2);

    const priorItems = [
      { role: 'user', content: 'Hi there.' },
      { role: 'assistant', content: 'Hello! How can I help?' },
      { role: 'user', content: 'What is the weather in Olden, Norway?' },
    ];
    const toolDef = {
      type: 'function',
      name: 'get_weather',
      description: 'Current weather for a city.',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
    };
    expect(calls[0]!.bodyJson).toEqual({
      model: 'gpt-6.1-sol',
      instructions: SYSTEM,
      input: priorItems,
      tools: [toolDef],
      store: false,
      stream: true,
    });
    expect(calls[1]!.bodyJson).toEqual({
      model: 'gpt-6.1-sol',
      instructions: SYSTEM,
      input: [
        ...priorItems,
        // the first leg produced no text, so no empty assistant item precedes the call
        { type: 'function_call', call_id: 'call_dey9hByG71tiQf2bdSR2ff8l', name: 'get_weather', arguments: '{"city":"Olden, Norway"}' },
        { type: 'function_call_output', call_id: 'call_dey9hByG71tiQf2bdSR2ff8l', output: '14°C, light rain in Olden, Norway' },
      ],
      tools: [toolDef],
      store: false,
      stream: true,
    });
    for (const call of calls) expect(new Headers(call.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  });
});
