// scheduledTransport.test.ts — TASK-20261009-scheduling-framework A4 (ADR-0074 §6; security
// F6, F12): the counting/capping decorator the hidden frame's `createAppTransport` is wrapped
// in (the `consentTransport` pattern). Every send is asked of the ceiling first; a send that
// reached the brain is one AI call on the run row; a reply is shape-scrubbed and WITHHELD whole
// when it still looks like a credential; streaming deltas never reach the app from a
// scheduled run (the reply is scrubbed once, whole — the hidden frame declares `streaming:
// false`). MUTATION CHECK (red as predicted during development): return the inner reply
// untouched → the C1 rows red.
import { ERROR_CODES } from '@snugprotocol/protocol';
import type { AgentTransport, AgentTransportOptions } from '@snugprotocol/runner';
import { describe, expect, it, vi } from 'vitest';

import { SCHEDULED_AI_LIMIT_MESSAGE, SCHEDULED_REPLY_WITHHELD, createScheduledTransport } from '../schedule/scheduledTransport.js';

interface Inner extends AgentTransport {
  calls: Array<{ wire: string; options: AgentTransportOptions }>;
}

function inner(answer: (wire: string) => Awaited<ReturnType<AgentTransport['send']>>): Inner {
  const calls: Inner['calls'] = [];
  return {
    calls,
    send: async (wire, options) => {
      calls.push({ wire, options });
      return answer(wire);
    },
  };
}

const okReply = (text: string) => ({ ok: true as const, text });
const signal = (): AbortSignal => new AbortController().signal;

describe('createScheduledTransport — counting and capping', () => {
  it('asks the ceiling BEFORE every send; a send the ceiling admits reaches the brain and counts ONE AI call', async () => {
    const brain = inner(() => okReply('hello'));
    const onCall = vi.fn(() => true);
    const transport = createScheduledTransport(brain, { onCall });
    expect(transport.calls).toBe(0);
    expect(await transport.send('[SNUG_APP_REQUEST] {"v":1}', { signal: signal() })).toEqual({ ok: true, text: 'hello' });
    expect(onCall).toHaveBeenCalledTimes(1);
    expect(brain.calls).toHaveLength(1);
    expect(transport.calls).toBe(1);
    await transport.send('[SNUG_APP_REQUEST] {"v":1}', { signal: signal() });
    expect(transport.calls).toBe(2);
  });

  it('at the ceiling the send is refused BY NAME, non-retryable, and the brain is never touched — nothing counted', async () => {
    const brain = inner(() => okReply('hello'));
    const transport = createScheduledTransport(brain, { onCall: () => false });
    const result = await transport.send('[SNUG_APP_REQUEST] {"v":1}', { signal: signal() });
    expect(result).toEqual({ ok: false, code: ERROR_CODES.HOST_ERROR, message: SCHEDULED_AI_LIMIT_MESSAGE, retryable: false });
    expect(brain.calls).toHaveLength(0);
    expect(transport.calls).toBe(0);
  });

  it('a reply that refused before anything left the page (CONSENT_REQUIRED) is not charged — the app-think rule', async () => {
    const brain = inner(() => ({ ok: false as const, code: ERROR_CODES.CONSENT_REQUIRED, message: 'confirm the endpoint first', retryable: false }));
    const transport = createScheduledTransport(brain, { onCall: () => true });
    const result = await transport.send('[SNUG_APP_REQUEST] {"v":1}', { signal: signal() });
    expect(result).toMatchObject({ ok: false, code: ERROR_CODES.CONSENT_REQUIRED });
    expect(transport.calls).toBe(0);
  });

  it('any other failure from the brain is charged (the call was made) and passed through as data', async () => {
    const brain = inner(() => ({ ok: false as const, code: ERROR_CODES.NETWORK_ERROR, message: 'offline', retryable: true }));
    const transport = createScheduledTransport(brain, { onCall: () => true });
    expect(await transport.send('w', { signal: signal() })).toEqual({ ok: false, code: ERROR_CODES.NETWORK_ERROR, message: 'offline', retryable: true });
    expect(transport.calls).toBe(1);
  });
});

describe('createScheduledTransport — the C1 wall on the reply side', () => {
  it('shape-scrubs a reply: a bearer token embedded in prose reaches the app redacted, the prose intact', async () => {
    const brain = inner(() => okReply('use the header Authorization: Bearer sk-abc123DEF456ghi789JKL012mno345pqr678 for the call'));
    const transport = createScheduledTransport(brain, { onCall: () => true });
    const result = await transport.send('w', { signal: signal() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain('sk-abc123DEF456ghi789JKL012mno345pqr678');
    expect(result.text).toContain('for the call');
  });

  it('WITHHOLDS a reply whole when it still looks like a credential after the scrub (a URL with userinfo) — a named refusal, counted', async () => {
    const brain = inner(() => okReply('https://alice:hunter2@api.example.com/v1'));
    const transport = createScheduledTransport(brain, { onCall: () => true });
    const result = await transport.send('w', { signal: signal() });
    expect(result).toEqual({ ok: false, code: ERROR_CODES.HOST_ERROR, message: SCHEDULED_REPLY_WITHHELD, retryable: false });
    expect(transport.calls).toBe(1);
  });

  it('a clean reply passes byte-for-byte, with its stopReason', async () => {
    const brain = inner(() => ({ ok: true as const, text: '{"answer":"sunny, 18°"}', stopReason: 'end' as const }));
    const transport = createScheduledTransport(brain, { onCall: () => true });
    expect(await transport.send('w', { signal: signal() })).toEqual({ ok: true, text: '{"answer":"sunny, 18°"}', stopReason: 'end' });
  });

  it('never forwards `onDelta`: a streamed delta cannot carry an unscrubbed fragment to the app; the signal is forwarded', async () => {
    const brain = inner(() => okReply('whole'));
    const transport = createScheduledTransport(brain, { onCall: () => true });
    const onDelta = vi.fn();
    const controller = new AbortController();
    await transport.send('w', { signal: controller.signal, onDelta });
    expect(brain.calls[0]!.options.signal).toBe(controller.signal);
    expect('onDelta' in brain.calls[0]!.options).toBe(false);
    expect(onDelta).not.toHaveBeenCalled();
  });
});
