// pseudonymizeEgress.test.ts — TASK-20260820-host-pseudonymisation AC3–AC9, AC11.
//
// THE EGRESS HALF of the R-9 backstop: before an app-message wire from a
// sidecar-connected app reaches ANY provider (BYOK, local, subscription /invoke — the
// scrub sits at the seam they share), the host redacts every harvested identity and the
// jid/phone primitives. The backstop is ANTI-DEFAULT AND ANTI-NAIVE, not
// anti-adversarial: it stops raw identities flowing by default and by sloppiness; a
// deliberately obfuscating app (homoglyphs, base64, numeric smuggling) still defeats
// substring redaction, and the threat-model rewrite says so.
//
// Assertions sit AT THE SEAM (the request the adapter receives), per the
// appTransportRoundTrips convention: "assert at the seam rather than trusting the
// downstream redactor."

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRoundTrip } from '@snugprotocol/adapters';
import { SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY } from '@snugprotocol/db';
import { buildAppRequest, SIDECAR_SYMBOLIC_HOST, SNUG_APP_REQUEST_TAG } from '@snugprotocol/protocol';

import { createAppTransport } from '../transport.js';
import {
  CONTACT_TOKEN,
  guardWireForApp,
  NUMBER_TOKEN,
  scrubAppWire,
  scrubText,
} from '../pseudonymizeEgress.js';
import { installTestUserDb } from '../../__tests__/userdbTestHelper.js';
import { getUserDb } from '../../state/userdb.js';

const APP = 'app-telepath';
const DIRECTORY = ['Priya Sharma', 'News', '919876543210@s.whatsapp.net'];

// No `fields`: WhatsApp is a PINNED registry provider, so the starter channel may not
// author credential-prompt copy — the admission gate substitutes the registry's own.
const sidecarRequirement = {
  slot: 'whatsapp',
  provider: { name: 'WhatsApp' },
  kind: 'linked_device' as const,
  declaredApiHosts: [SIDECAR_SYMBOLIC_HOST],
};

async function seedSidecarApp(appId = APP, directory: readonly string[] = DIRECTORY): Promise<void> {
  const db = await getUserDb();
  db.putDeclaredConnection(appId, 'whatsapp', sidecarRequirement, 'starter');
  db.approveConnection(appId, 'whatsapp');
  db.setSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY, [...directory]);
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  await installTestUserDb();
});

// ------------------------------------------------------------------ the pure scrub

describe('scrubText — directory identities and the primitives (AC3, AC5)', () => {
  it('replaces a harvested name case-insensitively, whole words only', () => {
    expect(scrubText('PRIYA SHARMA said hi to priya sharma', DIRECTORY)).toBe(
      `${CONTACT_TOKEN} said hi to ${CONTACT_TOKEN}`,
    );
    // Word boundary: "News" in the directory must not gut "Newsworthy" (plan review F10).
    expect(scrubText('a Newsworthy update on the News thread', DIRECTORY)).toBe(
      `a Newsworthy update on the ${CONTACT_TOKEN} thread`,
    );
  });

  it('matches longest-first so a contained name leaves no fragment', () => {
    const out = scrubText('Ana Maria wrote to Ana', ['Ana', 'Ana Maria']);
    expect(out).toBe(`${CONTACT_TOKEN} wrote to ${CONTACT_TOKEN}`);
  });

  it('redacts jid-shaped tokens and dialable digit runs with an EMPTY directory (AC5)', () => {
    expect(scrubText('ping 12345@s.whatsapp.net and 77@lid now', [])).toBe(
      `ping ${CONTACT_TOKEN} and ${CONTACT_TOKEN} now`,
    );
    expect(scrubText('call +91 98765 43210 or (555) 123-4567', [])).toBe(
      `call ${NUMBER_TOKEN} or ${NUMBER_TOKEN}`,
    );
  });

  it('short digit runs survive; dash-separated dates are the DOCUMENTED over-redaction', () => {
    // Prices, times, small quantities — the text the analysis exists to read.
    expect(scrubText('paid € 4.50 at 12:45, seat 314', [])).toBe('paid € 4.50 at 12:45, seat 314');
    // 8 digits inside the phone character class: redacts. Over-redaction is the safe
    // direction and is pinned here so it is a documented behavior, not a surprise.
    expect(scrubText('met on 2026-08-20', [])).toBe(`met on ${NUMBER_TOKEN}`);
  });

  it('never rewrites the pseudonym vocabulary (AC6): P-labels and YOU pass verbatim', () => {
    const text = 'P12 told YOU that P3 agreed';
    expect(scrubText(text, DIRECTORY)).toBe(text);
  });

  it('skips directory entries shorter than 3 chars — they would shred ordinary prose', () => {
    expect(scrubText('an apple a day', ['an'])).toBe('an apple a day');
  });
});

describe('scrubAppWire — the whole envelope, not just state (AC4, AC7, AC8a)', () => {
  const cleanEnvelope = {
    appId: APP,
    instanceId: 'inst-1',
    requestId: 'req-1',
    action: 'profile_thread',
    state: { transcript: [{ author: 'P1', text: 'lunch at 12:45?', ts: 5, fromMe: false }] },
    responseSchema: { type: 'object' },
  };

  it('a cooperating app’s wire passes byte-identical (canonical JSON.stringify wires)', () => {
    const wire = buildAppRequest(cleanEnvelope);
    expect(scrubAppWire(wire, DIRECTORY)).toBe(wire);
  });

  it('redacts identities inside nested state values AND object keys', () => {
    const wire = buildAppRequest({
      ...cleanEnvelope,
      state: {
        transcript: [{ author: 'Priya Sharma', text: 'reach me on +91 98765 43210' }],
        stats: { 'Priya Sharma': 4 },
      },
    });
    const out = scrubAppWire(wire, DIRECTORY);
    expect(out).not.toContain('Priya Sharma');
    expect(out).not.toContain('98765');
    expect(out).toContain(CONTACT_TOKEN);
    expect(out).toContain(NUMBER_TOKEN);
    // Still a parseable tagged wire — the scrub transforms, never corrupts.
    expect(out.startsWith(SNUG_APP_REQUEST_TAG)).toBe(true);
  });

  it('responseSchema and action are NOT a smuggling channel (plan-review blocker 1)', () => {
    const wire = buildAppRequest({
      ...cleanEnvelope,
      // A boundary-legal spelling: the walk covers `action`; a name GLUED to word chars
      // ('tell_Priya') is the disclosed anti-naive residual, same as any obfuscation.
      action: 'tell Priya Sharma now',
      responseSchema: {
        type: 'object',
        description: 'reply to Priya Sharma on 919876543210@s.whatsapp.net',
        properties: { who: { enum: ['Priya Sharma'] } },
      },
    });
    const out = scrubAppWire(wire, DIRECTORY);
    expect(out).not.toContain('Priya Sharma');
    expect(out).not.toContain('919876543210@s.whatsapp.net');
  });

  it('a name containing a JSON metacharacter is caught via the parsed walk, not the raw wire', () => {
    // On the wire this name is `Pri \"ya\"` — raw substring replacement would miss it.
    const name = 'Pri "ya" Sharma';
    const wire = buildAppRequest({ ...cleanEnvelope, state: { text: `ask ${name} about it` } });
    expect(scrubAppWire(wire, [name])).not.toContain('ya" Sharma');
  });

  it('a wire that fails parseAppRequest still gets unescape-normalised redaction (AC8a)', () => {
    // Well-formed JSON would take the parsed path; this one is deliberately NOT a valid
    // envelope (missing required ids), and hides the name behind \uXXXX escapes.
    const raw = `${SNUG_APP_REQUEST_TAG}\n{"snug":1,"note":"ping \\u0050riya Sharma at \\u003921 98765 43210"`;
    const out = scrubAppWire(raw, DIRECTORY);
    expect(out).not.toContain('riya Sharma');
    expect(out).toContain(CONTACT_TOKEN);
  });
});

// -------------------------------------------------------------- the transport seam

function collectTrips(): { trips: AgentRoundTrip[]; onLlmEvent: (event: { type: string }) => void } {
  const trips: AgentRoundTrip[] = [];
  return {
    trips,
    onLlmEvent: (event) => {
      if (event.type === 'round_trip') trips.push(event as unknown as AgentRoundTrip);
    },
  };
}

const wireWithName = (): string =>
  buildAppRequest({
    appId: APP,
    instanceId: 'inst-1',
    requestId: 'req-1',
    action: 'profile_thread',
    state: { transcript: [{ author: 'Priya Sharma', text: 'my number is +91 98765 43210' }] },
  });

describe('the app transport scrubs sidecar-connected apps at the shared seam (AC3, AC6, AC8b, AC9)', () => {
  it('the adapter receives the scrubbed wire, never the raw one', async () => {
    await seedSidecarApp();
    const { trips, onLlmEvent } = collectTrips();
    const transport = createAppTransport('byok', 'mock', onLlmEvent, APP);

    const result = await transport.send(wireWithName(), { signal: new AbortController().signal });

    expect(result.ok).toBe(true);
    const sent = JSON.stringify(trips[0]?.request.messages ?? []);
    expect(sent, 'R-9: a raw identity must never cross to the provider').not.toContain('Priya Sharma');
    expect(sent).not.toContain('98765');
    expect(sent).toContain('[contact]');
  });

  it('an app with NO sidecar connection is delivered byte-identical (AC6 — scope negative)', async () => {
    const { trips, onLlmEvent } = collectTrips();
    const transport = createAppTransport('byok', 'mock', onLlmEvent, 'app-plain');
    const db = await getUserDb();
    db.setSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY, DIRECTORY);

    const wire = buildAppRequest({
      appId: 'app-plain',
      instanceId: 'inst-1',
      requestId: 'req-1',
      action: 'book_court',
      // Names and numbers this app is ENTITLED to send — a contacts or ledger app.
      state: { note: 'Priya Sharma, +91 98765 43210' },
    });
    await transport.send(wire, { signal: new AbortController().signal });

    const sent = JSON.stringify(trips[0]?.request.messages ?? []);
    expect(sent).toContain('Priya Sharma');
    expect(sent).not.toContain('[contact]');
  });

  it('a connection approved AFTER the transport was created is scrubbed on the next send (AC8b)', async () => {
    const { trips, onLlmEvent } = collectTrips();
    // Created FIRST — the stale-capture defect class transport.ts documents twice.
    const transport = createAppTransport('byok', 'mock', onLlmEvent, APP);

    await transport.send(wireWithName(), { signal: new AbortController().signal });
    expect(JSON.stringify(trips[0]?.request.messages ?? [])).toContain('Priya Sharma');

    await seedSidecarApp();
    await transport.send(wireWithName(), { signal: new AbortController().signal });
    expect(JSON.stringify(trips[1]?.request.messages ?? [])).not.toContain('Priya Sharma');
  });

  it('the subscription /invoke body is scrubbed too — the seam covers BOTH transports (AC9)', async () => {
    await seedSidecarApp();
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ''));
        return new Response('{}', { status: 500 });
      }),
    );

    const transport = createAppTransport('subscription', 'mock', undefined, APP);
    await transport.send(wireWithName(), { signal: new AbortController().signal });

    expect(bodies.length, 'the /invoke POST must have been attempted').toBeGreaterThan(0);
    expect(bodies.join(''), 'the hub-bound body is provider-bound: same boundary').not.toContain('Priya Sharma');
  });

  it('the model reply returns to the app verbatim — no host de-anonymisation (AC11)', async () => {
    await seedSidecarApp();
    const transport = createAppTransport('byok', 'mock', undefined, APP);
    const result = await transport.send(wireWithName(), { signal: new AbortController().signal });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The host transforms the OUTBOUND wire only; the reply is the app's to reverse.
      expect(result.text).not.toContain(CONTACT_TOKEN);
    }
  });
});

describe('guardWireForApp — fail closed, never fail open (AC8c)', () => {
  it('refuses by name when the user DB cannot be read at send time', async () => {
    const result = await guardWireForApp(APP, wireWithName(), () => Promise.reject(new Error('db unavailable')));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBeTruthy();
      expect(result.message).toMatch(/pseudonym|scrub|privacy/i);
    }
  });

  it('passes a non-sidecar app through unchanged when the DB is readable', async () => {
    const wire = wireWithName();
    const result = await guardWireForApp('app-plain', wire);
    expect(result).toEqual({ ok: true, wire });
  });
});
