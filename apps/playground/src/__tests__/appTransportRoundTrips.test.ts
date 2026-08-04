// appTransportRoundTrips.test.ts — TASK-20260804-hub-polish, follow-up round.
//
// THE BUG (owner-reported, BYOK mode): "I switched to BYOK mode but the model round
// trips are still not populating. I tried running the Chess app and made a move — it
// did show messages in the inspector section but not LLM round trips."
//
// That symptom is diagnostic. The frame/bridge inspector populated, so the app WAS
// talking to the host; only the LLM surface stayed empty. The reason is that the
// playground has TWO runAgentTurn call sites, and only one of them was ever wired:
//
//   agent/builder.ts:223   — the BUILDER chat (wired: emits round_trip via onEvent)
//   agent/transport.ts:67  — the APP FRAME's transport (NOT wired — no onEvent at all)
//
// A Chess move is an in-app `sendMessage`, so it travels the app-frame transport and
// its round trips were dropped on the floor. Phase F fixed BuilderView's missing
// options object; it could not fix this, because this is a different seam entirely.
//
// These tests assert at the TRANSPORT level (not the panel), so they stay true no
// matter which surface renders the data.

import { beforeEach, describe, expect, it } from 'vitest';

import type { AgentRoundTrip } from '@snugprotocol/adapters';

import { createDirectAppTransport } from '../agent/transport.js';
import { installTestUserDb } from './userdbTestHelper.js';

// The 'mock' provider is a real adapter with a scripted app reply — no network, and
// it drives the identical runAgentTurn seam the anthropic/openai adapters do. That
// keeps the test about the WIRING (the bug) rather than about provider wire formats.

describe('the app-frame transport reports LLM round trips (owner bug: BYOK + Chess move)', () => {
  // The default getKey reads the user DB, so a transport built without an injected
  // key hangs forever until a DB is installed as the page singleton.
  beforeEach(async () => {
    await installTestUserDb();
  });

  it('emits a round trip for an in-app turn so the LLM surface can render it', async () => {
    const trips: AgentRoundTrip[] = [];
    const transport = createDirectAppTransport({
      mode: 'byok',
      provider: 'mock',
      needsConfirm: () => false,
      onRoundTrip: (trip) => trips.push(trip),
    });

    const result = await transport.send(JSON.stringify({ type: 'chat', text: 'I play e4' }), {
      signal: new AbortController().signal,
    });

    expect(result.ok, 'the turn itself must still succeed').toBe(true);
    expect(trips, 'an in-app LLM turn must produce at least one round trip').not.toHaveLength(0);
    expect(trips[0]?.index).toBe(0);
    expect(trips[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('carries the request AND response so the panel has something to show', async () => {
    const trips: AgentRoundTrip[] = [];
    const transport = createDirectAppTransport({
      mode: 'byok',
      provider: 'mock',
      needsConfirm: () => false,
      onRoundTrip: (trip) => trips.push(trip),
    });
    await transport.send(JSON.stringify({ type: 'chat', text: 'hello' }), {
      signal: new AbortController().signal,
    });

    const trip = trips[0];
    expect(trip?.request.system, 'the system prompt as sent').toBeTruthy();
    expect(trip?.request.messages.length, 'the conversation as sent').toBeGreaterThan(0);
    expect(trip?.response.ok).toBe(true);
  });

  it('C1: the BYOK key never appears in a round trip (it rides in a header, never a body)', async () => {
    const trips: AgentRoundTrip[] = [];
    const KEY = 'sk-ant-SUPERSECRETKEYVALUE';
    const transport = createDirectAppTransport({
      mode: 'byok',
      provider: 'mock',
      getKey: () => Promise.resolve(KEY),
      needsConfirm: () => false,
      onRoundTrip: (trip) => trips.push(trip),
    });
    await transport.send(JSON.stringify({ type: 'chat', text: 'hi' }), {
      signal: new AbortController().signal,
    });

    // Wiring a new observation point is exactly when a credential can start leaking,
    // so assert it at the seam rather than trusting the downstream redactor.
    expect(JSON.stringify(trips), 'C1: a BYOK key must never reach the round-trip feed').not.toContain(KEY);
  });

  it('stays optional — a transport built without the callback still works', async () => {
    const transport = createDirectAppTransport({
      mode: 'byok',
      provider: 'mock',
      needsConfirm: () => false,
    });
    const result = await transport.send(JSON.stringify({ type: 'chat', text: 'hi' }), {
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
  });
});
