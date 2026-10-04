// brains.test.ts — TASK-20260905-binding-a-artifacts AC1/AC3: the host brain (`sample`, the
// artifact runtime's — chat artifacts included since the 2026-10-03 measurement; the
// September chat runtime's `window.claude.complete` is gone, TASK-20261003 R5 C2) and the ONE
// prompt shaper it rides on, which is also the budget's ruler. TASK-20261003 R5 C4: the
// error table pinned to contract 0.2.67's `SampleErrorCode`, and the replies the owner's
// probe recorded on 0.2.67 run through the graduated parser.
//
// The fakes record exactly what reaches the host — the input string/turns and the options —
// so the C1 scan and the byte pin are assertions over the wire, never over a status.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { AdapterMessage } from '@snugprotocol/adapters';
import { HOST_BRAIN_REFUSED_CODE } from '@playground/platform/platform';
import { ERROR_CODES, parseAgentReply } from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';

import { HOST_BRAIN_CODES, SAMPLE_ERRORS, mapSampleError } from '../brains/errors.js';
import { DEFAULT_MAX_PROMPT_BYTES, PROMPT_SEPARATOR, measurePrompt, shapeInput } from '../brains/prompt.js';
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

describe('shapeInput — one shaper, one ruler (AC1/AC3)', () => {
  it('a single user message becomes ONE string: system + separator + content (S3 arm a; S11 measured this exact shape)', () => {
    expect(shapeInput(SYSTEM, userTurn(WIRE))).toBe(`${SYSTEM}${PROMPT_SEPARATOR}${WIRE}`);
    expect(PROMPT_SEPARATOR).toBe('\n\n');
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
    const adapter = createSampleAdapter(sample, { tier: () => 'quick' });
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
    const app = createSampleAdapter(sample, { tier: () => 'quick' });
    const chat = createSampleAdapter(sample, { tier: () => 'default' });
    expect(calls).toHaveLength(0);
    await chat.complete({ system: SYSTEM, messages: userTurn('build') });
    expect(calls[0]!.options?.modelTier).toBe('default');
    await app.complete({ system: SYSTEM, messages: userTurn(WIRE) });
    expect(calls[1]!.options?.modelTier).toBe('quick');
  });

  it('`truncated: true` → stopReason max_tokens, never a parse strike (lesson 2026-08-12)', async () => {
    const { sample } = fakeSample({ text: '{"partial":', truncated: true });
    const result = await createSampleAdapter(sample, { tier: () => 'quick' }).complete({ system: SYSTEM, messages: userTurn(WIRE) });
    expect(result).toMatchObject({ ok: true, text: '{"partial":', stopReason: 'max_tokens' });
  });

  it('reports the tier that actually answered as the wire model', async () => {
    const { sample } = fakeSample({ text: 'ok', modelTierApplied: 'quick' });
    const result = await createSampleAdapter(sample, { tier: () => 'default' }).complete({ system: SYSTEM, messages: userTurn('x') });
    expect(result).toMatchObject({ ok: true, model: 'claude (quick)' });
  });

  it('TASK-20260906 AC2: the tier is read at CALL time — a switch between calls changes the next call and makes no call of its own', async () => {
    const { sample, calls } = fakeSample({ text: 'ok' });
    let tier: 'quick' | 'default' | 'complex' = 'quick';
    const adapter = createSampleAdapter(sample, { tier: () => tier });
    await adapter.complete({ system: SYSTEM, messages: userTurn(WIRE) });
    tier = 'complex'; // the switch
    expect(calls).toHaveLength(1); // nothing spent by switching
    await adapter.complete({ system: SYSTEM, messages: userTurn(WIRE) });
    expect(calls.map((c) => c.options?.modelTier)).toEqual(['quick', 'complex']);
  });

  it('TASK-20260906 AC4: every answer reports (asked, answered) to `onApplied` — the store decides what a substitution means', async () => {
    const applied: [string, string][] = [];
    const honoured = createSampleAdapter(fakeSample({ text: 'ok' }).sample, { tier: () => 'complex', onApplied: (a, b) => applied.push([a, b]) });
    await honoured.complete({ system: SYSTEM, messages: userTurn('x') });
    const substituted = createSampleAdapter(fakeSample({ text: 'ok', modelTierApplied: 'default' }).sample, { tier: () => 'complex', onApplied: (a, b) => applied.push([a, b]) });
    await substituted.complete({ system: SYSTEM, messages: userTurn('x') });
    expect(applied).toEqual([['complex', 'complex'], ['complex', 'default']]);
    // A rejection reports nothing: no tier answered.
    const rejected = createSampleAdapter(fakeSample({ reject: { code: 'rate_limited' } }).sample, { tier: () => 'quick', onApplied: (a, b) => applied.push([a, b]) });
    await rejected.complete({ system: SYSTEM, messages: userTurn('x') });
    expect(applied).toHaveLength(2);
  });

  it.each(Object.entries(EXPECTED_RESULTS))('maps SampleError %s → its named result — one call, never retried by the kit', async (code, [expected, retryable, says]) => {
    const { sample, calls } = fakeSample({ reject: { code, message: `platform said ${code}` } });
    const result = await createSampleAdapter(sample, { tier: () => 'quick', maxPromptBytes: 262_144 }).complete({ system: SYSTEM, messages: userTurn(WIRE) });
    expect(result).toMatchObject({ ok: false, code: expected, retryable });
    if (!result.ok) {
      expect(result.message).toMatch(says);
      // The runtime's own words ride along in parentheses — a developer can read what it said.
      if (code !== 'cancelled') expect(result.message).toContain(`(platform said ${code})`);
    }
    expect(calls).toHaveLength(1);
  });

  it('`cancelled` → the protocol CANCELLED code with the partial text kept; an already-aborted signal makes no call', async () => {
    const { sample, calls } = fakeSample({ reject: { code: 'cancelled', text: 'partial…' } });
    const ctl = new AbortController();
    const result = await createSampleAdapter(sample, { tier: () => 'quick' }).complete({ system: SYSTEM, messages: userTurn(WIRE), signal: ctl.signal });
    expect(result).toMatchObject({ ok: false, code: ERROR_CODES.CANCELLED, retryable: false, partialText: 'partial…' });
    const pre = new AbortController();
    pre.abort();
    const early = await createSampleAdapter(sample, { tier: () => 'quick' }).complete({ system: SYSTEM, messages: userTurn(WIRE), signal: pre.signal });
    expect(early).toMatchObject({ ok: false, code: ERROR_CODES.CANCELLED });
    expect(calls).toHaveLength(1);
  });

  it('prompt_too_large names the byte count and the cap in its message', async () => {
    const { sample } = fakeSample({ reject: { code: 'prompt_too_large' } });
    const result = await createSampleAdapter(sample, { tier: () => 'default', maxPromptBytes: 65536 }).complete({ system: SYSTEM, messages: userTurn(WIRE) });
    expect(result).toMatchObject({ ok: false, code: HOST_BRAIN_CODES.PROMPT_TOO_LARGE });
    if (!result.ok) expect(result.message).toMatch(new RegExp(`${bytes(`${SYSTEM}${PROMPT_SEPARATOR}${WIRE}`)}.*65,?536`));
  });

  it('prompt_too_large with no cap given names the probe’s own fallback — the one constant, not a copy of it', () => {
    const message = mapSampleError({ code: 'prompt_too_large' }, { promptBytes: 70_000 }).message;
    expect(message).toContain(`this host accepts up to ${DEFAULT_MAX_PROMPT_BYTES.toLocaleString('en-US')}`);
  });

  it('C4: an UNKNOWN code is treated as upstream_error (sample.d.ts 0.2.67) with the code itself visible — offered for a manual retry, never retried by the kit', async () => {
    // MIGRATED 2026-10-03 (TASK-20261003 R5 C4) from "an unknown code … becomes HOST_ERROR,
    // retryable false": contract 0.2.67 says "Treat an unknown code as upstream_error".
    for (const code of ['brand_new_code', 'constructor', '__proto__', 'toString']) {
      const { sample, calls } = fakeSample({ reject: { code, message: 'm', text: 'so far' } });
      const result = await createSampleAdapter(sample, { tier: () => 'quick' }).complete({ system: SYSTEM, messages: userTurn(WIRE) });
      expect(result, code).toMatchObject({ ok: false, code: HOST_BRAIN_CODES.UPSTREAM, retryable: true, partialText: 'so far' });
      if (!result.ok) expect(result.message, code).toContain(`"${code}"`);
      expect(calls, code).toHaveLength(1);
    }
  });

  it('a rejection that is not a SampleError (no string code) stays HOST_ERROR with its message kept', async () => {
    const thrown = await createSampleAdapter(fakeSample({ throw: new TypeError('boom') }).sample, { tier: () => 'quick' }).complete({ system: SYSTEM, messages: userTurn(WIRE) });
    expect(thrown).toMatchObject({ ok: false, code: ERROR_CODES.HOST_ERROR, retryable: false });
    if (!thrown.ok) expect(thrown.message).toContain('boom');
    expect(mapSampleError({ code: 42, message: 'odd' }, { promptBytes: 1 })).toMatchObject({ ok: false, code: ERROR_CODES.HOST_ERROR, retryable: false });
  });

  it('(N) tool traffic is refused by name — the host brains are tool-free (the builder takes the tool-free arm)', async () => {
    const { sample, calls } = fakeSample({ text: 'x' });
    const adapter = createSampleAdapter(sample, { tier: () => 'default' });
    const withTools = await adapter.complete({ system: SYSTEM, messages: userTurn('x'), tools: [{ name: 't', description: 'd', inputSchema: {} }] });
    expect(withTools).toMatchObject({ ok: false, code: HOST_BRAIN_CODES.TOOLS_UNSUPPORTED, retryable: false });
    const withToolTurn = await adapter.complete({ system: SYSTEM, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 't', input: {} }] }, { role: 'tool', toolCallId: '1', content: '{}' }] });
    expect(withToolTurn).toMatchObject({ ok: false, code: HOST_BRAIN_CODES.TOOLS_UNSUPPORTED });
    expect(calls).toHaveLength(0);
  });

  it('(N, C1) nothing but the shaped prompt reaches the host: no key, no URL, no header, no secret-shaped value', async () => {
    const { sample, calls } = fakeSample({ text: 'x' });
    await createSampleAdapter(sample, { tier: () => 'quick' }).complete({ system: SYSTEM, messages: userTurn(WIRE), cache: true, maxOutputTokens: 512 });
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

// ------------------------------------------------- C4: the contract's error codes, pinned

/**
 * `SampleErrorCode`, VERBATIM from the artifact runtime's own type definitions — `sample.d.ts`,
 * contract **0.2.67** (the contract claude.ai serves, read 2026-10-03; the kit was written to
 * 0.2.41). When the contract's union changes, this block is re-copied from the new file and
 * the assertion below fails until the kit's table names exactly the new set.
 */
const SAMPLE_D_TS_0_2_67_SAMPLE_ERROR_CODE = `
    type SampleErrorCode =
      | "invalid_request"
      | "prompt_too_large"
      | "images_unavailable"
      | "tools_unavailable"
      | "image_rejected"
      | "cancelled"
      | "not_granted"
      | "session_expired"
      | "sampling_disabled"
      | "not_declared"
      | "rate_limited"
      | "refused"
      | "empty_completion"
      | "invalid_json"
      | "upstream_error"
      | "capability_disabled"
      | "capability_removed"
      | "transform_error"
      | "queue_overflow";
`;
const CONTRACT_CODES = [...SAMPLE_D_TS_0_2_67_SAMPLE_ERROR_CODE.matchAll(/\| "([a-z_]+)"/g)].map((match) => match[1]!);

/**
 * What each code must come back as, regrouped by contract 0.2.67's own groups ("grouped by what
 * the page should do"): [Snug code, retryable, what the sentence says]. A literal, never read
 * from the module under test. `retryable` is the MANUAL-retry hint the run view and the app
 * see; nothing in the kit or the runner retries a host-brain answer by itself.
 */
const EXPECTED_RESULTS: Record<string, readonly [string, boolean, RegExp]> = {
  // You did it.
  cancelled: [ERROR_CODES.CANCELLED, false, /^stopped$/],
  // A page bug — nothing was sent. `queue_overflow` MOVED here in 0.2.67 ("hundreds of calls
  // were made before the runtime started") — it was a rate limit in the kit's 0.2.41 table.
  invalid_request: [HOST_BRAIN_CODES.INVALID_REQUEST, false, /malformed.*Snug defect/],
  transform_error: [HOST_BRAIN_CODES.INVALID_REQUEST, false, /could not be prepared.*Snug defect/],
  queue_overflow: [HOST_BRAIN_CODES.INVALID_REQUEST, false, /hundreds of calls.*before.*started.*Snug defect/],
  prompt_too_large: [HOST_BRAIN_CODES.PROMPT_TOO_LARGE, false, /\d[\d,]* bytes; this host accepts up to 262,144/],
  // Hide the feature for this view — permanent. (The kit never sends an image or a tool, so
  // the two "that feature" codes name a Snug defect rather than a view to hide something in.)
  not_granted: [HOST_BRAIN_CODES.CONSENT_DENIED, false, /not allowed.*reload to be asked again/],
  sampling_disabled: [HOST_BRAIN_CODES.UNAVAILABLE, false, /not available to this account or organization/],
  not_declared: [HOST_BRAIN_CODES.UNAVAILABLE, false, /no longer declares Claude/],
  capability_disabled: [HOST_BRAIN_CODES.UNAVAILABLE, false, /cannot be used in this view/],
  capability_removed: [HOST_BRAIN_CODES.UNAVAILABLE, false, /runtime.*does not offer/],
  images_unavailable: [HOST_BRAIN_CODES.INVALID_REQUEST, false, /images.*Snug never sends.*Snug defect/],
  tools_unavailable: [HOST_BRAIN_CODES.TOOLS_UNSUPPORTED, false, /tools.*Snug defect/],
  // Tell the viewer, keep the control — the page never retries by itself. `session_expired`
  // MOVED here in 0.2.67 ("the viewer must sign in again") — it was "consent denied".
  rate_limited: [HOST_BRAIN_CODES.RATE_LIMITED, false, /busy.*never retries on its own/],
  session_expired: [HOST_BRAIN_CODES.SESSION_EXPIRED, false, /sign in to Claude again/],
  image_rejected: [HOST_BRAIN_CODES.INVALID_REQUEST, false, /image.*Snug never sends.*Snug defect/],
  refused: [HOST_BRAIN_CODES.REFUSED, false, /declined.*unchanged/],
  empty_completion: [HOST_BRAIN_CODES.EMPTY, false, /no text/],
  invalid_json: [HOST_BRAIN_CODES.EMPTY, false, /no parseable JSON/],
  upstream_error: [HOST_BRAIN_CODES.UPSTREAM, true, /could not be reached.*try again/],
};

describe('C4 — every SampleErrorCode of contract 0.2.67 maps to a named result', () => {
  it('the kit’s table names EXACTLY the contract’s 19 codes — a contract diff is this one failing assertion', () => {
    expect(CONTRACT_CODES).toHaveLength(19);
    expect(new Set(CONTRACT_CODES).size).toBe(19);
    expect(Object.keys(SAMPLE_ERRORS).sort()).toEqual([...CONTRACT_CODES].sort());
    expect(Object.keys(EXPECTED_RESULTS).sort()).toEqual([...CONTRACT_CODES].sort());
  });

  it('no contract code falls through to the generic HOST_ERROR, and none comes back as the one code the runner retries by itself (THREAD_CONFLICT)', () => {
    for (const code of CONTRACT_CODES) {
      const result = mapSampleError({ code, message: 'm' }, { promptBytes: 1 });
      expect(result.code, code).not.toBe(ERROR_CODES.HOST_ERROR);
      expect(result.code, code).not.toBe(ERROR_CODES.THREAD_CONFLICT);
    }
    expect(mapSampleError({ code: 'brand_new_code' }, { promptBytes: 1 }).code).not.toBe(ERROR_CODES.THREAD_CONFLICT);
  });

  it('only upstream_error is offered for a retry ("Only upstream_error is transient")', () => {
    const retryable = CONTRACT_CODES.filter((code) => mapSampleError({ code }, { promptBytes: 1 }).retryable);
    expect(retryable).toEqual(['upstream_error']);
  });

  it('e.text — "the part of the answer you may keep" — is kept on every code but `refused`, whose partial is WITHDRAWN', () => {
    for (const code of CONTRACT_CODES) {
      const result = mapSampleError({ code, message: 'm', text: 'written so far' }, { promptBytes: 1 });
      if (code === 'refused') expect(result, code).not.toHaveProperty('partialText');
      else expect(result.partialText, code).toBe('written so far');
    }
  });

  it('a refusal AFTER text streamed: the adapter forwards no partial with the refusal — what was shown is withdrawn, not kept', async () => {
    // The platform streamed text, then rejected `refused` with no `e.text` (0.2.67). The kit
    // must not hand the partial on as something to keep: neither the contract's text nor what
    // the adapter itself forwarded through onDelta.
    const calls: Recorded[] = [];
    const sample = (async (input: SampleInput, options?: SampleOptions): Promise<SampleResult> => {
      calls.push({ input, options });
      options?.onText?.({ text: 'Sure, here is', delta: 'Sure, here is' });
      throw { code: 'refused', message: 'declined' };
    }) as SampleFn;
    sample.limits = async () => ({ maxPromptBytes: 262_144 });
    sample.json = async () => ({});
    const deltas: string[] = [];
    const result = await createSampleAdapter(sample, { tier: () => 'quick' }).complete({ system: SYSTEM, messages: userTurn(WIRE), onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(['Sure, here is']);
    expect(result).toMatchObject({ ok: false, code: HOST_BRAIN_CODES.REFUSED, retryable: false });
    expect(result).not.toHaveProperty('partialText');
  });

  it('the refusal’s code is the platform seat’s — the one code a surface that showed streamed text clears it on', () => {
    // The bubble that rendered those deltas is the playground's; it cannot import the kit, so
    // the code it clears on is homed on the seat both read (platform.ts) — one string.
    expect(HOST_BRAIN_CODES.REFUSED).toBe(HOST_BRAIN_REFUSED_CODE);
    expect(mapSampleError({ code: 'refused' }, { promptBytes: 1 }).code).toBe(HOST_BRAIN_REFUSED_CODE);
  });
});

// ------------------------- C4: the replies the owner's probe recorded, through the parser

const FIXTURES = path.join(__dirname, 'fixtures', 'sample-0.2.67');
interface RecordedReply {
  tier: 'quick' | 'default' | 'complex';
  tierApplied?: 'quick' | 'default' | 'complex';
  form?: string;
  len: number;
  truncatedFlag: boolean;
  reply: string;
  replyEnd?: string;
}
const chessTurn = JSON.parse(readFileSync(path.join(FIXTURES, 'chess-app-turn.musuyx9k.json'), 'utf8')) as { limits: { maxPromptBytes: number }; appTurn: RecordedReply[] };
const terse = JSON.parse(readFileSync(path.join(FIXTURES, 'terse-instruction-and-ladder.musuq7g5.json'), 'utf8')) as {
  limits: { maxPromptBytes: number };
  json: RecordedReply;
  ladder: (Partial<RecordedReply> & { bytes: number; outcome: string; code?: string; message?: string })[];
};

/** The probe kept a long reply as its head (`reply`) and tail (`replyEnd`) beside its length; rebuild it from their overlap (PROVENANCE.md). */
function wholeReply(recorded: RecordedReply): string {
  if (recorded.reply.length === recorded.len || recorded.replyEnd === undefined) return recorded.reply;
  const overlap = recorded.reply.length + recorded.replyEnd.length - recorded.len;
  if (overlap < 0 || !recorded.reply.endsWith(recorded.replyEnd.slice(0, overlap))) throw new Error('the recorded head and tail do not overlap — the reply cannot be rebuilt');
  return recorded.reply + recorded.replyEnd.slice(overlap);
}

/** One recorded reply, answered through `sample` the way 0.2.67 streams it (text = previous + delta; the last call carries the whole text). */
async function answerWith(recorded: RecordedReply): Promise<{ result: Awaited<ReturnType<ReturnType<typeof createSampleAdapter>['complete']>>; deltas: string[] }> {
  const text = wholeReply(recorded);
  const half = text.slice(0, Math.ceil(text.length / 2));
  const { sample } = fakeSample({ text, truncated: recorded.truncatedFlag, modelTierApplied: recorded.tierApplied ?? recorded.tier, steps: [half, text] });
  const deltas: string[] = [];
  const result = await createSampleAdapter(sample, { tier: () => recorded.tier, maxPromptBytes: chessTurn.limits.maxPromptBytes }).complete({
    system: SYSTEM,
    messages: userTurn(WIRE),
    onDelta: (d) => deltas.push(d),
  });
  return { result, deltas };
}

describe('C4 — every reply shape recorded on sample 0.2.67 parses through the graduated parser', () => {
  it('the fixtures are what PROVENANCE.md says: contract 0.2.67’s cap, both chess tiers, the prose reply rebuilt to its recorded 802 characters', () => {
    expect(chessTurn.limits.maxPromptBytes).toBe(262_144);
    expect(chessTurn.appTurn.map((t) => [t.tier, t.form, t.reply.length === t.len])).toEqual([
      ['quick', 'fenced', true],
      ['default', 'bare', true],
    ]);
    expect(terse.json).toMatchObject({ tier: 'quick', form: 'prose', len: 802 });
    expect(wholeReply(terse.json)).toHaveLength(802);
    expect(wholeReply(terse.json)).toMatch(/^I appreciate you testing my guidelines/);
    expect(wholeReply(terse.json)).toMatch(/What would actually be helpful for you\?$/);
  });

  it('quick — the FENCED reply to the real chess turn: the adapter hands the text on whole, and the parser unfences it to the JSON object', async () => {
    const quick = chessTurn.appTurn.find((t) => t.tier === 'quick')!;
    const { result, deltas } = await answerWith(quick);
    expect(result).toMatchObject({ ok: true, text: quick.reply, stopReason: 'end', model: 'claude (quick)' });
    expect(deltas.join('')).toBe(quick.reply);
    if (!result.ok) return;
    // The object exactly as recorded — `from`/`to` at the TOP level (the chess contract's v2
    // responseGuidance shape). Chess v3 reads it as a move too (examples/reply-shape.test.mjs).
    expect(parseAgentReply(result.text)).toEqual({ ok: true, data: { from: 'e7', to: 'e5', message: "Classic. Let's see what you've got." } });
  });

  it('default — the BARE reply to the real chess turn: the parser takes it whole, `move` nested as the envelope’s schema has it', async () => {
    const bare = chessTurn.appTurn.find((t) => t.tier === 'default')!;
    const { result } = await answerWith(bare);
    expect(result).toMatchObject({ ok: true, text: bare.reply, stopReason: 'end', model: 'claude (default)' });
    if (!result.ok) return;
    expect(parseAgentReply(result.text)).toEqual({
      ok: true,
      data: { move: { from: 'e7', to: 'e5' }, message: "Classic for a classic beatdown. Let's dance.", gameOver: false },
    });
  });

  it('the refusal-shaped PROSE reply to a terse instruction: the named off-script result (PARSE_FAILED, an excerpt of what it said) — never a throw, never a move', async () => {
    const { result } = await answerWith(terse.json);
    // The runtime ANSWERED (this is not its `refused` code): the adapter reports the text it got.
    expect(result).toMatchObject({ ok: true, text: wholeReply(terse.json), stopReason: 'end', model: 'claude (quick)' });
    if (!result.ok) return;
    const parsed = parseAgentReply(result.text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatchObject({ code: ERROR_CODES.PARSE_FAILED, retryable: true });
    expect(parsed.error.rawExcerpt).toMatch(/^I appreciate you testing my guidelines/);
    expect(parsed).not.toHaveProperty('data');
    expect(JSON.stringify(parsed)).not.toMatch(/"(from|to|move)"\s*:/);
  });

  it('the cap ladder’s marker echoes (8,192 / 65,536 / 262,144 B): plain text, so the same named off-script result — never a throw', async () => {
    const echoes = terse.ladder.filter((rung) => rung.outcome === 'ok');
    expect(echoes.map((rung) => rung.bytes)).toEqual([8_192, 65_536, 262_144]);
    for (const rung of echoes) {
      const { result } = await answerWith(rung as RecordedReply);
      expect(result).toMatchObject({ ok: true, text: rung.reply });
      if (!result.ok) continue;
      expect(result.text).toMatch(/^HEAD-[a-z0-9]+\nTAIL-[a-z0-9]+$/);
      expect(parseAgentReply(result.text)).toMatchObject({ ok: false, error: { code: ERROR_CODES.PARSE_FAILED } });
    }
  });

  it('the ladder’s 262,145-byte rung, as the runtime refused it: the named PROMPT_TOO_LARGE naming the bytes and the cap limits() reported', async () => {
    const over = terse.ladder.find((rung) => rung.outcome === 'rejected')!;
    expect(over).toMatchObject({ bytes: 262_145, code: 'prompt_too_large', message: 'the prompt exceeds the 256 KiB limit' });
    const { sample } = fakeSample({ reject: { code: over.code!, message: over.message! } });
    const result = await createSampleAdapter(sample, { tier: () => 'quick', maxPromptBytes: terse.limits.maxPromptBytes }).complete({ system: SYSTEM, messages: userTurn(WIRE) });
    expect(result).toMatchObject({ ok: false, code: HOST_BRAIN_CODES.PROMPT_TOO_LARGE, retryable: false });
    if (!result.ok) {
      expect(result.message).toContain('this host accepts up to 262,144');
      expect(result.message).toContain('(the prompt exceeds the 256 KiB limit)');
    }
  });
});

// ---------------------------------------------------------------------------
// TASK-20260906-tool-free-kb-inlining AC3 — the tool-free builder assembly fits the host
// cap WITH HEADROOM, measured by THIS ruler (the one the adapter sends with — lesson
// 2026-08-05: a bound re-derived upstream of the sent string is a second bound). A layer
// that grows past the pinned ceiling fails HERE, not as a silently refused build turn on
// the artifact.
// ---------------------------------------------------------------------------
describe('the tool-free builder assembly under the host cap (AC3)', () => {
  it('inline core + the fenced-HTML suffix measure ≤ HOST_BUILDER_SYSTEM_MAX_BYTES on the wire shape, and the ceiling leaves the reserved minimum under the probe\'s default cap', async () => {
    const { buildHostSystemPrompt, SYSTEM_BLOCK_SEPARATOR } = await import('@snugprotocol/knowledge');
    const { WEBLLM_BUILD_SUFFIX } = await import('@playground/agent/webllm/appHtml');
    const { HOST_BUILDER_RESERVED_MIN_BYTES, HOST_BUILDER_SYSTEM_MAX_BYTES } = await import('@playground/agent/promptBudget');
    const system = `${buildHostSystemPrompt({ appBuilder: true, artifacts: false, platform: 'host', knowledge: 'inline' })}${SYSTEM_BLOCK_SEPARATOR}${WEBLLM_BUILD_SUFFIX}`;
    // The FIRST builder turn is one user message → ONE string on the wire (the S11 shape).
    const measured = measurePrompt(system, [{ role: 'user', content: '' }]);
    // The failure message prints the measured bytes — the one place the current figure is
    // derived rather than restated.
    expect(measured, `inline builder system text measures ${measured} B on the wire`).toBeLessThanOrEqual(HOST_BUILDER_SYSTEM_MAX_BYTES);
    expect(DEFAULT_MAX_PROMPT_BYTES - HOST_BUILDER_SYSTEM_MAX_BYTES).toBeGreaterThanOrEqual(HOST_BUILDER_RESERVED_MIN_BYTES);
    // The ruler counts what shapeInput sends — the string's UTF-8 bytes — nothing derived.
    expect(measured).toBe(bytes(shapeInput(system, [{ role: 'user', content: '' }]) as string));
  });

  it("the ceiling is meaningful: today's tooled assembly is far under it and the whole KB would be far over", async () => {
    const { buildHostSystemPrompt, getKnowledgeBase } = await import('@snugprotocol/knowledge');
    const { HOST_BUILDER_SYSTEM_MAX_BYTES } = await import('@playground/agent/promptBudget');
    expect(bytes(buildHostSystemPrompt({ appBuilder: true, artifacts: true, platform: 'host' }))).toBeLessThan(HOST_BUILDER_SYSTEM_MAX_BYTES / 4);
    const wholeKb = getKnowledgeBase().reduce((n, s) => n + bytes(s.text), 0);
    expect(wholeKb).toBeGreaterThan(DEFAULT_MAX_PROMPT_BYTES); // the reason this task SELECTS instead of inlining everything
  });
});
