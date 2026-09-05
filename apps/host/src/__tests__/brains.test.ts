// brains.test.ts — TASK-20260905-binding-a-artifacts AC1/AC2/AC3: the two host brains
// (`sample` for hosted artifacts, `window.claude.complete` for chat artifacts) and the ONE
// prompt shaper both ride on, which is also the budget's ruler.
//
// The fakes record exactly what reaches the host — the input string/turns and the options —
// so the C1 scan and the byte pin are assertions over the wire, never over a status.

import type { AdapterMessage } from '@snugprotocol/adapters';
import { ERROR_CODES } from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';

import { createCompleteAdapter } from '../brains/complete.js';
import {
  HOST_BRAIN_CODES,
  mapSampleError,
} from '../brains/errors.js';
import { PROMPT_SEPARATOR, measurePrompt, shapeInput, shapeString } from '../brains/prompt.js';
import { createSampleAdapter, type SampleFn, type SampleInput, type SampleOptions, type SampleResult } from '../brains/sample.js';

const SYSTEM = '## Who You Are\n\nYou are the assistant behind a Snug reference host.';
const WIRE = '[SNUG_APP_REQUEST]\n{"appId":"chess","requestId":"req-1","action":"player_move","payload":{},"state":{},"responseSchema":{},"snug":1}';
const bytes = (s: string): number => new TextEncoder().encode(s).length;

interface Recorded {
  input: SampleInput;
  options: SampleOptions | undefined;
}

/** A `sample` fake: scripted outcomes, records every call, streams `onText` in WHOLE-text steps like the platform. */
function fakeSample(
  outcome: { text: string; truncated?: boolean; modelTierApplied?: 'quick' | 'default' | 'complex'; steps?: string[] } | { reject: { code: string; message?: string; text?: string } } | { throw: unknown },
  limits: { maxPromptBytes: number } | 'reject' = { maxPromptBytes: 65536 },
): { sample: SampleFn; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fn = (async (input: SampleInput, options?: SampleOptions): Promise<SampleResult> => {
    calls.push({ input, options });
    if ('throw' in outcome) throw outcome.throw;
    if ('reject' in outcome) {
      const err = Object.assign(new Error(outcome.reject.message ?? outcome.reject.code), outcome.reject);
      throw err;
    }
    const steps = outcome.steps ?? [outcome.text];
    for (const text of steps) options?.onText?.({ text, delta: '' });
    return { text: outcome.text, truncated: outcome.truncated ?? false, modelTierApplied: outcome.modelTierApplied ?? options?.modelTier ?? 'default' };
  }) as SampleFn;
  fn.limits = () => (limits === 'reject' ? Promise.reject(Object.assign(new Error('nope'), { code: 'upstream_error' })) : Promise.resolve(limits));
  fn.json = async () => ({});
  return { sample: fn, calls };
}

const userTurn = (content: string): AdapterMessage[] => [{ role: 'user', content }];

// ------------------------------------------------------------------- the shaper

describe('shapeInput / shapeString — one shaper, one ruler (AC1/AC3)', () => {
  it('a single user message becomes ONE string: system + separator + content (S3 arm a; S11 measured this exact shape)', () => {
    expect(shapeInput(SYSTEM, userTurn(WIRE))).toBe(`${SYSTEM}${PROMPT_SEPARATOR}${WIRE}`);
    expect(PROMPT_SEPARATOR).toBe('\n\n');
    expect(shapeString(SYSTEM, userTurn(WIRE))).toBe(`${SYSTEM}${PROMPT_SEPARATOR}${WIRE}`);
  });

  it('history becomes turns: the system rides as a leading user turn, the list ends on the new user message', () => {
    const messages: AdapterMessage[] = [
      { role: 'user', content: 'build me a timer' },
      { role: 'assistant', content: '```html…```' },
      { role: 'user', content: 'make it red' },
    ];
    expect(shapeInput(SYSTEM, messages)).toEqual([
      { role: 'user', content: SYSTEM },
      { role: 'user', content: 'build me a timer' },
      { role: 'assistant', content: '```html…```' },
      { role: 'user', content: 'make it red' },
    ]);
    // The string form flattens the same turns for a host with no turn API (chat).
    expect(shapeString(SYSTEM, messages)).toBe(
      `${SYSTEM}${PROMPT_SEPARATOR}build me a timer${PROMPT_SEPARATOR}[assistant]\n\`\`\`html…\`\`\`${PROMPT_SEPARATOR}[user]\nmake it red`,
    );
  });

  it('measurePrompt is the UTF-8 byte length of what is SENT — exact for the one-string shape, contents summed for turns', () => {
    const one = shapeInput(SYSTEM, userTurn('héllo ✓'));
    expect(measurePrompt(SYSTEM, userTurn('héllo ✓'))).toBe(bytes(one as string));
    const many: AdapterMessage[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'bé' }, { role: 'user', content: 'c' }];
    expect(measurePrompt(SYSTEM, many)).toBe(bytes(SYSTEM) + bytes('a') + bytes('bé') + bytes('c'));
  });

  it('(N) a tool message cannot be shaped — the host brains are tool-free by contract', () => {
    expect(() => shapeInput(SYSTEM, [{ role: 'tool', toolCallId: 'x', content: '{}' }])).toThrow(/tool/);
  });
});

// ---------------------------------------------------------------- sample adapter

describe('createSampleAdapter — the hosted brain (AC1)', () => {
  it('sends the shaped input with cache:false, the pinned tier, the signal and onText; forwards deltas; reports end', async () => {
    const { sample, calls } = fakeSample({ text: '{"move":{"from":"e7","to":"e5"},"message":"hi"}', steps: ['{"move"', '{"move":{"from":"e7","to":"e5"},"message":"hi"}'] });
    const adapter = createSampleAdapter(sample, { modelTier: 'quick' });
    const deltas: string[] = [];
    const ctl = new AbortController();
    const result = await adapter.complete({ system: SYSTEM, messages: userTurn(WIRE), signal: ctl.signal, onDelta: (d) => deltas.push(d) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe(`${SYSTEM}${PROMPT_SEPARATOR}${WIRE}`);
    expect(calls[0]!.options).toMatchObject({ cache: false, modelTier: 'quick', signal: ctl.signal });
    expect(typeof calls[0]!.options?.onText).toBe('function');
    // onText hands the WHOLE text so far; the adapter contract wants DELTAS.
    expect(deltas).toEqual(['{"move"', ':{"from":"e7","to":"e5"},"message":"hi"}']);
    expect(result).toMatchObject({ ok: true, text: '{"move":{"from":"e7","to":"e5"},"message":"hi"}', stopReason: 'end', toolCalls: [] });
  });

  it('the builder adapter pins `default`; both adapters make NO call on construction (never on load)', async () => {
    const { sample, calls } = fakeSample({ text: 'x' });
    const app = createSampleAdapter(sample, { modelTier: 'quick' });
    const chat = createSampleAdapter(sample, { modelTier: 'default' });
    expect(calls).toHaveLength(0);
    await chat.complete({ system: SYSTEM, messages: userTurn('build') });
    expect(calls[0]!.options?.modelTier).toBe('default');
    await app.complete({ system: SYSTEM, messages: userTurn(WIRE) });
    expect(calls[1]!.options?.modelTier).toBe('quick');
  });

  it('`truncated: true` → stopReason max_tokens, never a parse strike (lesson 2026-08-12)', async () => {
    const { sample } = fakeSample({ text: '{"partial":', truncated: true });
    const result = await createSampleAdapter(sample, { modelTier: 'quick' }).complete({ system: SYSTEM, messages: userTurn(WIRE) });
    expect(result).toMatchObject({ ok: true, text: '{"partial":', stopReason: 'max_tokens' });
  });

  it('reports the tier that actually answered as the wire model', async () => {
    const { sample } = fakeSample({ text: 'ok', modelTierApplied: 'quick' });
    const result = await createSampleAdapter(sample, { modelTier: 'default' }).complete({ system: SYSTEM, messages: userTurn('x') });
    expect(result).toMatchObject({ ok: true, model: 'claude (quick)' });
  });

  it.each([
    ['not_granted', HOST_BRAIN_CODES.CONSENT_DENIED, false],
    ['sampling_disabled', HOST_BRAIN_CODES.CONSENT_DENIED, false],
    ['session_expired', HOST_BRAIN_CODES.CONSENT_DENIED, false],
    ['rate_limited', HOST_BRAIN_CODES.RATE_LIMITED, false],
    ['queue_overflow', HOST_BRAIN_CODES.RATE_LIMITED, false],
    ['prompt_too_large', HOST_BRAIN_CODES.PROMPT_TOO_LARGE, false],
    ['refused', HOST_BRAIN_CODES.REFUSED, false],
    ['empty_completion', HOST_BRAIN_CODES.EMPTY, false],
    ['invalid_json', HOST_BRAIN_CODES.EMPTY, false],
    ['invalid_request', HOST_BRAIN_CODES.INVALID_REQUEST, false],
    ['upstream_error', HOST_BRAIN_CODES.UPSTREAM, true],
    ['capability_disabled', HOST_BRAIN_CODES.CONSENT_DENIED, false],
  ])('maps SampleError %s → %s (retryable %s) — named, never retried in a loop', async (code, expected, retryable) => {
    const { sample } = fakeSample({ reject: { code, message: `platform said ${code}` } });
    const result = await createSampleAdapter(sample, { modelTier: 'quick' }).complete({ system: SYSTEM, messages: userTurn(WIRE) });
    expect(result).toMatchObject({ ok: false, code: expected, retryable });
    if (!result.ok) expect(result.message.length).toBeGreaterThan(10);
  });

  it('`cancelled` → the protocol CANCELLED code with the partial text kept; an already-aborted signal makes no call', async () => {
    const { sample, calls } = fakeSample({ reject: { code: 'cancelled', text: 'partial…' } });
    const ctl = new AbortController();
    const result = await createSampleAdapter(sample, { modelTier: 'quick' }).complete({ system: SYSTEM, messages: userTurn(WIRE), signal: ctl.signal });
    expect(result).toMatchObject({ ok: false, code: ERROR_CODES.CANCELLED, retryable: false, partialText: 'partial…' });
    const pre = new AbortController();
    pre.abort();
    const early = await createSampleAdapter(sample, { modelTier: 'quick' }).complete({ system: SYSTEM, messages: userTurn(WIRE), signal: pre.signal });
    expect(early).toMatchObject({ ok: false, code: ERROR_CODES.CANCELLED });
    expect(calls).toHaveLength(1);
  });

  it('prompt_too_large names the byte count and the cap in its message', async () => {
    const { sample } = fakeSample({ reject: { code: 'prompt_too_large' } });
    const result = await createSampleAdapter(sample, { modelTier: 'default', maxPromptBytes: 65536 }).complete({ system: SYSTEM, messages: userTurn(WIRE) });
    expect(result).toMatchObject({ ok: false, code: HOST_BRAIN_CODES.PROMPT_TOO_LARGE });
    if (!result.ok) expect(result.message).toMatch(new RegExp(`${bytes(`${SYSTEM}${PROMPT_SEPARATOR}${WIRE}`)}.*65,?536`));
  });

  it('an unknown code and a non-SampleError throw both become HOST_ERROR with the message kept', async () => {
    const unknown = await createSampleAdapter(fakeSample({ reject: { code: 'brand_new_code', message: 'm' } }).sample, { modelTier: 'quick' }).complete({ system: SYSTEM, messages: userTurn(WIRE) });
    expect(unknown).toMatchObject({ ok: false, code: ERROR_CODES.HOST_ERROR, retryable: false });
    const thrown = await createSampleAdapter(fakeSample({ throw: new TypeError('boom') }).sample, { modelTier: 'quick' }).complete({ system: SYSTEM, messages: userTurn(WIRE) });
    expect(thrown).toMatchObject({ ok: false, code: ERROR_CODES.HOST_ERROR });
    if (!thrown.ok) expect(thrown.message).toContain('boom');
  });

  it('(N) tool traffic is refused by name — the host brains are tool-free (the builder takes the tool-free arm)', async () => {
    const { sample, calls } = fakeSample({ text: 'x' });
    const adapter = createSampleAdapter(sample, { modelTier: 'default' });
    const withTools = await adapter.complete({ system: SYSTEM, messages: userTurn('x'), tools: [{ name: 't', description: 'd', inputSchema: {} }] });
    expect(withTools).toMatchObject({ ok: false, code: HOST_BRAIN_CODES.TOOLS_UNSUPPORTED, retryable: false });
    const withToolTurn = await adapter.complete({ system: SYSTEM, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 't', input: {} }] }, { role: 'tool', toolCallId: '1', content: '{}' }] });
    expect(withToolTurn).toMatchObject({ ok: false, code: HOST_BRAIN_CODES.TOOLS_UNSUPPORTED });
    expect(calls).toHaveLength(0);
  });

  it('(N, C1) nothing but the shaped prompt reaches the host: no key, no URL, no header, no secret-shaped value', async () => {
    const { sample, calls } = fakeSample({ text: 'x' });
    await createSampleAdapter(sample, { modelTier: 'quick' }).complete({ system: SYSTEM, messages: userTurn(WIRE), cache: true, maxOutputTokens: 512 });
    const wire = JSON.stringify(calls[0]!.input) + JSON.stringify({ ...calls[0]!.options, onText: undefined, signal: undefined });
    for (const forbidden of ['sk-ant', 'Authorization', 'apiKey', 'api_key', 'https://', 'localUrl', 'maxOutputTokens']) {
      expect(wire, `wire contains "${forbidden}"`).not.toContain(forbidden);
    }
    // `cache` from the caller is ignored: the host cache is always off for a live turn.
    expect(calls[0]!.options?.cache).toBe(false);
  });

  it('mapSampleError is the one table (exported for the chip/inspector copy)', () => {
    expect(mapSampleError({ code: 'rate_limited' }, { promptBytes: 10 }).code).toBe(HOST_BRAIN_CODES.RATE_LIMITED);
    expect(mapSampleError({ code: 'cancelled', text: 'p' }, { promptBytes: 10 })).toMatchObject({ code: ERROR_CODES.CANCELLED, partialText: 'p' });
  });
});

// -------------------------------------------------------------- complete adapter

describe('createCompleteAdapter — the chat brain (AC2)', () => {
  it('sends ONE string (the flattened shape), returns the text with stopReason end and a single delta', async () => {
    const prompts: string[] = [];
    const complete = async (prompt: string): Promise<unknown> => {
      prompts.push(prompt);
      return '{"answer":1}';
    };
    const deltas: string[] = [];
    const result = await createCompleteAdapter(complete).complete({ system: SYSTEM, messages: userTurn(WIRE), onDelta: (d) => deltas.push(d) });
    expect(prompts).toEqual([`${SYSTEM}${PROMPT_SEPARATOR}${WIRE}`]);
    expect(result).toMatchObject({ ok: true, text: '{"answer":1}', stopReason: 'end', toolCalls: [] });
    expect(deltas).toEqual(['{"answer":1}']);
  });

  it('(N) a non-string reply, a rejection and an abort are each named — never a hang, never a throw', async () => {
    const bad = await createCompleteAdapter(async () => ({ not: 'a string' })).complete({ system: SYSTEM, messages: userTurn('x') });
    expect(bad).toMatchObject({ ok: false, code: HOST_BRAIN_CODES.BAD_REPLY, retryable: false });
    const rejected = await createCompleteAdapter(async () => Promise.reject(new Error('viewer said no'))).complete({ system: SYSTEM, messages: userTurn('x') });
    expect(rejected).toMatchObject({ ok: false, code: ERROR_CODES.HOST_ERROR });
    if (!rejected.ok) expect(rejected.message).toContain('viewer said no');
    const ctl = new AbortController();
    const slow = createCompleteAdapter(() => new Promise((resolve) => setTimeout(() => resolve('late'), 5)));
    const pending = slow.complete({ system: SYSTEM, messages: userTurn('x'), signal: ctl.signal });
    ctl.abort();
    expect(await pending).toMatchObject({ ok: false, code: ERROR_CODES.CANCELLED });
    const tools = await createCompleteAdapter(async () => 'x').complete({ system: SYSTEM, messages: userTurn('x'), tools: [{ name: 't', description: 'd', inputSchema: {} }] });
    expect(tools).toMatchObject({ ok: false, code: HOST_BRAIN_CODES.TOOLS_UNSUPPORTED });
  });
});
