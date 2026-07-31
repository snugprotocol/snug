// The BYOK app-mode transport: same AgentTransport surface as server mode, runs the
// turn in-browser, and its demo-brain replies are valid JSON-only agent replies.

import { parseAgentReply } from '@snugprotocol/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEMO_APP_REPLY } from '../agent/demoApp.js';
import { createByokAppTransport } from '../agent/transport.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createByokAppTransport', () => {
  it('answers an app-mode wire request without touching the network (mock provider)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be touched'));
    const transport = createByokAppTransport({ provider: 'mock', getKey: () => undefined });
    const deltas: string[] = [];
    const result = await transport.send('[SNUG_APP_REQUEST] {"snug":1}', {
      signal: new AbortController().signal,
      onDelta: (delta) => deltas.push(delta),
    });
    expect(result).toEqual({ ok: true, text: DEMO_APP_REPLY });
    expect(deltas.join('')).toBe(DEMO_APP_REPLY);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('demo-brain replies parse as JSON-only agent replies (runner-compatible)', () => {
    const parsed = parseAgentReply(DEMO_APP_REPLY);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect((parsed.data as { message?: string }).message).toContain('demo brain');
  });
});
