// The direct (byok/local) app-mode transport: same AgentTransport surface as
// subscription mode, runs the turn in-browser, refuses turns while imported
// endpoint settings await re-confirmation (F15), and its demo-brain replies are
// valid JSON-only agent replies.

import { parseAgentReply } from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEMO_APP_REPLY } from '../agent/demoApp.js';
import { createDirectAppTransport } from '../agent/transport.js';
import { installTestUserDb } from './userdbTestHelper.js';

// The transport now carries the R-9 egress guard (TASK-20260820), which reads the page
// user DB per send — a db-less send would wait on a boot that never comes, exactly like
// the default getKey (see appTransportRoundTrips.test.ts).
beforeEach(async () => {
  await installTestUserDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createDirectAppTransport', () => {
  it('answers an app-mode wire request without touching the network (mock provider)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be touched'));
    const transport = createDirectAppTransport({
      mode: 'byok',
      provider: 'mock',
      getKey: () => Promise.resolve(undefined),
      needsConfirm: () => false,
    });
    const deltas: string[] = [];
    const result = await transport.send('[SNUG_APP_REQUEST] {"snug":1}', {
      signal: new AbortController().signal,
      onDelta: (delta) => deltas.push(delta),
    });
    expect(result).toEqual({ ok: true, text: DEMO_APP_REPLY, stopReason: 'end' });
    expect(deltas.join('')).toBe(DEMO_APP_REPLY);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('F15 guard: refuses the turn while endpoint settings are unconfirmed — provider untouched', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be touched'));
    const getKey = vi.fn(() => Promise.resolve('sk-should-not-be-read'));
    const transport = createDirectAppTransport({
      mode: 'byok',
      provider: 'anthropic',
      getKey,
      needsConfirm: () => true,
    });
    const result = await transport.send('[SNUG_APP_REQUEST] {"snug":1}', {
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ ok: false, code: 'CONSENT_REQUIRED', retryable: false });
    expect(getKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('demo-brain replies parse as JSON-only agent replies (runner-compatible)', () => {
    const parsed = parseAgentReply(DEMO_APP_REPLY);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect((parsed.data as { message?: string }).message).toContain('demo brain');
  });
});
