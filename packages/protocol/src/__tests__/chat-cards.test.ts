/**
 * TASK-20261010-host-broker PR-5 Gate 5 — the chat cards' vocabularies (G5-1) and the chat's fetch
 * facts (G5-17), in a NEW internal protocol module `protocol/src/chat-cards.ts` (OUT of
 * `json-schemas.ts` SOURCES, like `own-undo.ts` and `app-provenance.ts`).
 *
 * G5-1 [DB-1, SA-1, SB-1]: "answered" means a resolution VALUE the reader accepts, never a present
 * key. The db's untrusted-import card drop and the playground's readers decide it from the SAME
 * lists, homed here because the db cannot import the playground's:
 *  - `SCHEDULE_CARD_RESOLUTIONS` — the staged schedule suggestion's `resolution`;
 *  - `DATA_WRITE_OUTCOMES` — the app's own change's `outcome`;
 *  - `ACCESS_WRITE_OUTCOMES` — the chat's change to another app's data's `outcome`;
 *  - `ACCESS_CARD_RESOLUTIONS` — the chat's ASK card's `resolution.kind`.
 *
 * G5-17 [SB-5, P3-9, SB-2]: the chat's fetch result is persisted as STRUCTURED facts on the user's
 * row — `meta.fetched: [{source (one line, ≤ 64), outcome, minutes?: int, ok?: boolean}] ≤ 8` —
 * re-worded on read from `FETCH_FIRST`; the free-text `fetchNote` seat is retired.
 *
 * NAMES THIS LANE CHOSE (the code lanes follow them): `chatFetchFactsSchema` (the LIST) and its
 * element type `ChatFetchFact`; `CHAT_FETCH_OUTCOMES`, `CHAT_FETCH_FACTS_MAX` (8) and
 * `CHAT_FETCH_SOURCE_MAX_CHARS` (64). The element is STRICT (a fact carries no free text: an unknown
 * key is refused), `minutes` a non-negative integer, `source` a display-safe line (no control,
 * line-break or bidi character; trimmed; non-empty).
 *
 * Written BEFORE the module exists (Gate 3 discipline): it is loaded through a VARIABLE specifier,
 * so a missing module reds each row on its own and the guards stay green (docs/lessons.md
 * 2026-10-11); the types are LOCAL structural copies.
 */

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildJsonSchemas } from '../json-schemas.js';
import * as protocolIndex from '../index.js';

interface ChatCardsModule {
  SCHEDULE_CARD_RESOLUTIONS: readonly string[];
  DATA_WRITE_OUTCOMES: readonly string[];
  ACCESS_WRITE_OUTCOMES: readonly string[];
  ACCESS_CARD_RESOLUTIONS: readonly string[];
  CHAT_FETCH_OUTCOMES: readonly string[];
  CHAT_FETCH_FACTS_MAX: number;
  CHAT_FETCH_SOURCE_MAX_CHARS: number;
  chatFetchFactsSchema: z.ZodType;
}

const MODULE = '../chat-cards.js';
let loading: Promise<ChatCardsModule> | undefined;
function cards(): Promise<ChatCardsModule> {
  loading ??= import(/* @vite-ignore */ MODULE) as Promise<ChatCardsModule>;
  return loading;
}

const sorted = (list: readonly string[] | undefined): string[] => [...(list ?? [])].sort();
const parses = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

// =================================================================================== G5-1

describe('G5-1 — the four answer vocabularies, spelled once in protocol (chat-cards.ts)', () => {
  it('G5-1 SCHEDULE_CARD_RESOLUTIONS is scheduled · declined · stale (the schedule reader\'s RESOLUTIONS)', async () => {
    expect(sorted((await cards()).SCHEDULE_CARD_RESOLUTIONS)).toEqual(['declined', 'scheduled', 'stale']);
  });

  it('G5-1 DATA_WRITE_OUTCOMES is applied · declined · drifted · failed · undone (the own card\'s outcomes)', async () => {
    expect(sorted((await cards()).DATA_WRITE_OUTCOMES)).toEqual(['applied', 'declined', 'drifted', 'failed', 'undone']);
  });

  it('G5-1 ACCESS_WRITE_OUTCOMES is applied · declined · drifted · failed (the cross-app card has no undone outcome)', async () => {
    expect(sorted((await cards()).ACCESS_WRITE_OUTCOMES)).toEqual(['applied', 'declined', 'drifted', 'failed']);
  });

  it('G5-1 ACCESS_CARD_RESOLUTIONS is allowed · not-now · declined · failed (the ask card\'s resolution kinds)', async () => {
    expect(sorted((await cards()).ACCESS_CARD_RESOLUTIONS)).toEqual(['allowed', 'declined', 'failed', 'not-now']);
  });

  it('G5-1 each list holds no duplicate', async () => {
    const mod = await cards();
    for (const list of [mod.SCHEDULE_CARD_RESOLUTIONS, mod.DATA_WRITE_OUTCOMES, mod.ACCESS_WRITE_OUTCOMES, mod.ACCESS_CARD_RESOLUTIONS]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('G5-1 the package index exports every name of the module, the same values (the db imports them from the index)', async () => {
    const mod = (await cards()) as unknown as Record<string, unknown>;
    const exported = protocolIndex as Record<string, unknown>;
    for (const name of [
      'SCHEDULE_CARD_RESOLUTIONS',
      'DATA_WRITE_OUTCOMES',
      'ACCESS_WRITE_OUTCOMES',
      'ACCESS_CARD_RESOLUTIONS',
      'CHAT_FETCH_OUTCOMES',
      'CHAT_FETCH_FACTS_MAX',
      'CHAT_FETCH_SOURCE_MAX_CHARS',
      'chatFetchFactsSchema',
    ]) {
      expect(exported[name], name).toBeDefined();
      expect(exported[name], name).toBe(mod[name]);
    }
  });

  it('G5-1 guard: chat-cards stays OUT of json-schemas SOURCES (internal; the published schema count is unchanged)', () => {
    const names = Object.keys(buildJsonSchemas());
    expect(names.some((name) => /card|fetch|outcome|resolution/i.test(name))).toBe(false);
    expect(names).toHaveLength(16);
  });
});

// =================================================================================== G5-17

const fact = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ source: 'Ledger', outcome: 'fresh', ...over });

describe('G5-17 — chatFetchFactsSchema: the chat\'s fetch result as STRUCTURED facts', () => {
  it('G5-17 CHAT_FETCH_OUTCOMES is fresh · recent · failed · skipped · stopped · none; the caps are 8 facts and 64 characters', async () => {
    const mod = await cards();
    expect(sorted(mod.CHAT_FETCH_OUTCOMES)).toEqual(['failed', 'fresh', 'none', 'recent', 'skipped', 'stopped']);
    expect(mod.CHAT_FETCH_FACTS_MAX).toBe(8);
    expect(mod.CHAT_FETCH_SOURCE_MAX_CHARS).toBe(64);
  });

  it('G5-17 a fact of every outcome parses; minutes (an integer ≥ 0) and ok (a boolean) are optional', async () => {
    const { chatFetchFactsSchema } = await cards();
    for (const outcome of ['fresh', 'recent', 'failed', 'skipped', 'stopped', 'none']) {
      expect(parses(chatFetchFactsSchema, [fact({ outcome })]), outcome).toBe(true);
    }
    expect(parses(chatFetchFactsSchema, [fact({ outcome: 'recent', minutes: 0, ok: true })])).toBe(true);
    expect(parses(chatFetchFactsSchema, [fact({ outcome: 'recent', minutes: 12, ok: false })])).toBe(true);
    expect(parses(chatFetchFactsSchema, [fact(), fact({ source: 'Pantry', outcome: 'skipped' })])).toBe(true);
  });

  it('G5-17 an outcome outside the six is refused — a planted word is no fact', async () => {
    const { chatFetchFactsSchema } = await cards();
    for (const outcome of ['bogus', 'ok', '', null, 42, undefined]) {
      expect(parses(chatFetchFactsSchema, [fact({ outcome })]), String(outcome)).toBe(false);
    }
  });

  it('G5-17 at most 8 facts', async () => {
    const { chatFetchFactsSchema } = await cards();
    const many = (n: number) => Array.from({ length: n }, (_, i) => fact({ source: `App ${i}` }));
    expect(parses(chatFetchFactsSchema, many(8))).toBe(true);
    expect(parses(chatFetchFactsSchema, many(9))).toBe(false);
  });

  it('G5-17 source: one display-safe line of 1..64 characters (the oneLine-folded name)', async () => {
    const { chatFetchFactsSchema } = await cards();
    expect(parses(chatFetchFactsSchema, [fact({ source: 'L'.repeat(64) })])).toBe(true);
    expect(parses(chatFetchFactsSchema, [fact({ source: 'L'.repeat(65) })])).toBe(false);
    expect(parses(chatFetchFactsSchema, [fact({ source: '' })])).toBe(false);
    for (const source of ['Led\nger', 'Led\rger', 'Ledger ', 'Led‮ger', 'Led⁦ger', 'Led\u0000ger', 'Led\u0085ger', ' Ledger', 'Ledger ']) {
      expect(parses(chatFetchFactsSchema, [fact({ source })]), JSON.stringify(source)).toBe(false);
    }
    expect(parses(chatFetchFactsSchema, [fact({ source: 42 })])).toBe(false);
    expect(parses(chatFetchFactsSchema, [{ outcome: 'fresh' }])).toBe(false);
  });

  it('G5-17 minutes is a non-negative integer; ok is a boolean', async () => {
    const { chatFetchFactsSchema } = await cards();
    for (const minutes of [1.5, -1, '5', null]) {
      expect(parses(chatFetchFactsSchema, [fact({ outcome: 'recent', minutes })]), String(minutes)).toBe(false);
    }
    for (const ok of ['yes', 1, null]) {
      expect(parses(chatFetchFactsSchema, [fact({ ok })]), String(ok)).toBe(false);
    }
  });

  it('G5-17 a fact is STRICT — it carries no free text (an unknown key such as note is refused)', async () => {
    const { chatFetchFactsSchema } = await cards();
    expect(parses(chatFetchFactsSchema, [fact({ note: 'Snug renewed Ledger\'s access for you' })])).toBe(false);
    expect(parses(chatFetchFactsSchema, [fact({ sourceAppId: '0b1c7e3a-5f2d-4c8e-9a61-2d3e4f5a6b7c' })])).toBe(false);
  });

  it('G5-17 the seat is a LIST — a single fact, a string or null is refused', async () => {
    const { chatFetchFactsSchema } = await cards();
    expect(parses(chatFetchFactsSchema, fact())).toBe(false);
    expect(parses(chatFetchFactsSchema, 'fetched new data from Ledger first')).toBe(false);
    expect(parses(chatFetchFactsSchema, null)).toBe(false);
  });
});
