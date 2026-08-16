/**
 * TASK-20260811-lean-runtime-data-chat, P0.2 — `chatIntentSchema` (ADR-0019).
 *
 * The classifier's output is a ROUTER INPUT: it decides which context an app-chat message
 * gets assembled with and which tools that turn may reach. So the schema's job is to make
 * an unusable classification INDISTINGUISHABLE from a failed one — `parseChatIntent`
 * returns undefined and the router clarifies (AC-F2-1, fail-closed). Anything that
 * "mostly parses" would route on a guess, and one of those lanes writes code.
 *
 * Internal draft — OUT of `json-schemas.ts` SOURCES (publication line guarded below).
 */

import { describe, expect, it } from 'vitest';
import { buildJsonSchemas } from '../json-schemas.js';
import {
  CHAT_INTENTS,
  CHAT_INTENT_CLARIFICATION_MAX_CHARS,
  CHAT_INTENT_DATA_LANE,
  CHAT_INTENT_FEATURE_LANE,
  CHAT_INTENT_PROVIDER_LANE,
  CHAT_LANES,
  chatIntentSchema,
  isDataIntent,
  isFeatureIntent,
  isProviderIntent,
  laneForIntent,
  parseChatIntent,
} from '../chat-intent.js';

describe('chatIntentSchema — the eight intents', () => {
  it('pins the intent set exactly (persisted/routed literals — never retyped downstream)', () => {
    expect([...CHAT_INTENTS]).toEqual([
      'data_read',
      'data_write',
      'schema_change',
      'app_change',
      'provider_read',
      'provider_write',
      'app_question',
      'other',
    ]);
  });

  it('accepts the provider intents (TASK-20260815, ADR-0031 §2)', () => {
    expect(chatIntentSchema.parse({ intent: 'provider_read', confidence: 0.9 }).intent).toBe('provider_read');
    expect(chatIntentSchema.parse({ intent: 'provider_write', confidence: 0.9 }).intent).toBe('provider_write');
  });

  it('accepts a well-formed classification', () => {
    const parsed = chatIntentSchema.parse({ intent: 'data_read', confidence: 0.92 });
    expect(parsed.intent).toBe('data_read');
    expect(parsed.confidence).toBeCloseTo(0.92);
  });

  it('accepts an optional clarification question, bounded', () => {
    expect(() =>
      chatIntentSchema.parse({ intent: 'other', confidence: 0.2, clarification: 'Did you mean last month?' }),
    ).not.toThrow();
    expect(() =>
      chatIntentSchema.parse({
        intent: 'other',
        confidence: 0.2,
        clarification: 'x'.repeat(CHAT_INTENT_CLARIFICATION_MAX_CHARS + 1),
      }),
    ).toThrow();
  });

  it('rejects an unknown intent — a mis-spelled lane must never fall through to a default', () => {
    expect(() => chatIntentSchema.parse({ intent: 'rebuild', confidence: 1 })).toThrow();
    expect(() => chatIntentSchema.parse({ intent: 'DATA_READ', confidence: 1 })).toThrow();
  });

  it('requires confidence in [0,1]', () => {
    expect(() => chatIntentSchema.parse({ intent: 'data_read' })).toThrow();
    expect(() => chatIntentSchema.parse({ intent: 'data_read', confidence: 1.5 })).toThrow();
    expect(() => chatIntentSchema.parse({ intent: 'data_read', confidence: -0.1 })).toThrow();
  });

  it('is STRICT: an unknown key is a rejection', () => {
    expect(() => chatIntentSchema.parse({ intent: 'data_read', confidence: 1, sql: 'DROP TABLE x' })).toThrow();
  });
});

describe('parseChatIntent — fail-closed by construction (AC-F2-1)', () => {
  it('reads a classification out of raw model text', () => {
    expect(parseChatIntent('{"intent":"data_write","confidence":0.8}')).toEqual({
      intent: 'data_write',
      confidence: 0.8,
    });
  });

  it('returns undefined for every unusable reply shape — never a default lane', () => {
    for (const bad of [
      undefined,
      null,
      '',
      'I think you want to query your data.',
      '{"intent":"data_read"}',
      '{"intent":"rebuild","confidence":1}',
      '{{',
    ]) {
      expect(parseChatIntent(bad as string | undefined), String(bad)).toBeUndefined();
    }
  });

  it('never resolves an unparseable reply to app_change — the lane that writes code', () => {
    // The single most dangerous failure mode: a malformed classification silently
    // routing to the feature lane reproduces today's "every message is a rebuild" bug
    // with extra steps.
    expect(parseChatIntent('garbage')).toBeUndefined();
  });
});

describe('laneForIntent — ONE exhaustive map, no silent default lane (F7, TASK-20260815)', () => {
  it('assigns every intent a lane — an intent the map forgot cannot exist at runtime', () => {
    // Exhaustiveness is compile-enforced (`satisfies Record<ChatIntent, ChatLane>`); this
    // runtime loop is the mutation tripwire: deleting a map entry breaks the build AND
    // this test, so neither a cast nor a partial map can sneak an intent past routing.
    for (const intent of CHAT_INTENTS) {
      expect(CHAT_LANES, intent).toContain(laneForIntent(intent));
    }
  });

  it('pins the lane assignment exactly', () => {
    expect(CHAT_INTENTS.map((intent) => [intent, laneForIntent(intent)])).toEqual([
      ['data_read', 'data'],
      ['data_write', 'data'],
      ['schema_change', 'feature'],
      ['app_change', 'feature'],
      ['provider_read', 'provider'],
      ['provider_write', 'provider'],
      ['app_question', 'answer'],
      ['other', 'answer'],
    ]);
  });

  it('keeps the lane groupings as derived views of the same map', () => {
    expect([...CHAT_INTENT_DATA_LANE]).toEqual(['data_read', 'data_write']);
    expect([...CHAT_INTENT_FEATURE_LANE]).toEqual(['schema_change', 'app_change']);
    expect([...CHAT_INTENT_PROVIDER_LANE]).toEqual(['provider_read', 'provider_write']);

    expect(isDataIntent('data_read')).toBe(true);
    expect(isDataIntent('provider_read')).toBe(false);
    // v1 collapses schema_change into the feature lane execution-wise (owner decision (c));
    // the classification still differs so the copy can differ.
    expect(isFeatureIntent('schema_change')).toBe(true);
    expect(isFeatureIntent('provider_write')).toBe(false);
    expect(isProviderIntent('provider_read')).toBe(true);
    expect(isProviderIntent('provider_write')).toBe(true);
    expect(isProviderIntent('data_write')).toBe(false);
  });

  it('leaves app_question/other in the tool-free answer lane', () => {
    for (const intent of ['app_question', 'other'] as const) {
      expect(laneForIntent(intent), intent).toBe('answer');
      expect(isDataIntent(intent), intent).toBe(false);
      expect(isFeatureIntent(intent), intent).toBe(false);
      expect(isProviderIntent(intent), intent).toBe(false);
    }
  });
});

describe('publication line — chat intents stay OUT of json-schemas SOURCES', () => {
  it('buildJsonSchemas() exports no chat-intent entry', () => {
    const names = Object.keys(buildJsonSchemas());
    expect(names).not.toContain('chat-intent.json');
    expect(names.some((name) => name.includes('intent'))).toBe(false);
  });
});
