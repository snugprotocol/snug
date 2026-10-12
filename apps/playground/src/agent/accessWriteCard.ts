// agent/accessWriteCard.ts — the chat's CROSS-APP card, as state: what `data_propose_write` staged
// on the agent's message under its OWN key `meta.accessWrite`, how a persisted one is re-admitted,
// and the apply the card's act reaches (TASK-20261010-host-broker PR-5; contract v2 D-PR5-10,
// D-PR5-12, D-PR5-14 and its v2.1 answers TC-Q10, TC-Q11, TC-Q12; S3, S4, S7, S9).
//
// STRICT BOTH WAYS (D-PR5-10): `metaToAccessWrite` re-admits a persisted card only whole — any
// invalid, missing or UNKNOWN seat drops the card — and never with a statement that fails the
// access SQL rule or carries an invisible format character, a line or paragraph separator or a blank
// filler (staging's own rule, `isPlainSqlText` — Gate-5 G5-16 SB-6); its `outcome` is one of the
// protocol's `ACCESS_WRITE_OUTCOMES`, the list the untrusted import reads too (G5-1). The rehydrate
// also drops a card whose `appId` is not the thread's pinned app. Swapped out of the kit with
// `access/AccessWriteCard.tsx` (D-PR5-16): no kit turn stages one, and a persisted one renders as no
// card there.
//
// THE SEATS HANG TOGETHER, or there is no card: an `undoId` only on an applied card; a `failedWhy`
// either beside `outcome: 'failed'` (a settled failure — never *busy* or *waiting*) or alone as one
// of the two that keep the acts (*busy*, *waiting* — D-PR5-14a). What is persisted is what the user
// can still act on: a non-terminal why is the moment's, never written to the row.
//
// THE APPLY (`approveCrossAppWrite`): the chat caller rebuilt at approve time — the card's reader,
// the thread, the reader's CURRENT generation — then `writeChatApproved` with the count the card
// showed. The answer is the card's next state: applied with the undo it can be put back by, drifted,
// failed with its why, or — busy, waiting — the same card with the why above its acts.

import { z } from 'zod';

import type { UserDb } from '@snugprotocol/db';
import { ACCESS_WRITE_OUTCOMES, LIMITS, accessSqlSchema, accessTableNameSchema, type AccessWriteOutcome } from '@snugprotocol/protocol';

import { ACCESS_WRITE_FAILED_WHYS, writeChatApproved, type AccessWriteFailedWhy, type ChatAccessCaller } from '../access/chatWrite.js';
import { readerGeneration } from '../access/grants.js';
import { isCardSummary, isPlainSqlText } from './dataTools.js';

export type { AccessWriteFailedWhy };
/** How the card was settled — the protocol's list (G5-1). `busy` and `waiting` are not settlements: they set `failedWhy` and leave the acts (D-PR5-14a). */
export type { AccessWriteOutcome };

/** The live access the change runs under, as it was when the card was staged — re-checked at apply (a renewal keeps the id, so `grantedAt` too — S9). */
export interface AccessWriteTarget {
  grantId: string;
  grantedAt: string;
  sourceAppId: string;
  /** The source's own table. */
  table: string;
}

export interface AccessWriteCardState {
  /** The reader — the thread's pinned app. */
  appId: string;
  target: AccessWriteTarget;
  /** ONE statement in the SOURCE's names (the alias renamed — `renameDmlTarget`). */
  sql: string;
  /** The AI's words about it, shown quoted — never trusted. */
  summary?: string;
  /** The plan's count when it was staged. */
  previewed: number;
  outcome?: AccessWriteOutcome;
  failedWhy?: AccessWriteFailedWhy;
  /** The journal entry an applied change can be undone by, on the source's ⋈ sheet — host chrome only. */
  undoId?: string;
  /** The user-db row the card is persisted on, once the turn finalised. */
  messageRowId?: number;
}

/** The persisted shape — the row's `meta.accessWrite`; the row id is the row's own address and is never written into it. */
export type PersistedAccessWrite = Omit<AccessWriteCardState, 'messageRowId'>;

/** The two whys that keep the card's acts: an apply may succeed in a moment. */
const KEEPS_THE_ACTS: ReadonlySet<AccessWriteFailedWhy> = new Set<AccessWriteFailedWhy>(['busy', 'waiting']);

const appIdSchema = z.string().min(1).max(LIMITS.ID_CHARS);

/** The card as a row may hold it — every seat in its own shape, nothing else (D-PR5-10). */
const persistedSchema = z
  .strictObject({
    appId: appIdSchema,
    target: z.strictObject({
      grantId: z.uuid(),
      grantedAt: z.iso.datetime(),
      sourceAppId: appIdSchema,
      table: accessTableNameSchema,
    }),
    // The access SQL rule, and nothing that hides or splits what the user reads — a literal included (S7, SB-6).
    sql: accessSqlSchema.refine(isPlainSqlText),
    summary: z.string().refine(isCardSummary).optional(),
    // A staged card changes at least one row: a plan of none is never staged (D-PR5-11 (7)).
    previewed: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    outcome: z.enum(ACCESS_WRITE_OUTCOMES).optional(),
    failedWhy: z.enum(ACCESS_WRITE_FAILED_WHYS).optional(),
    undoId: z.uuid().optional(),
  })
  .refine((card) => card.undoId === undefined || card.outcome === 'applied')
  .refine((card) => card.failedWhy === undefined || (card.outcome === 'failed' ? !KEEPS_THE_ACTS.has(card.failedWhy) : card.outcome === undefined && KEEPS_THE_ACTS.has(card.failedWhy)));

/** A persisted cross-app card, re-admitted strictly — `undefined` for anything that is not one whole and valid. */
export function metaToAccessWrite(meta: unknown): AccessWriteCardState | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const parsed = persistedSchema.safeParse((meta as { accessWrite?: unknown }).accessWrite);
  if (!parsed.success) return undefined;
  const { summary, outcome, failedWhy, undoId, ...required } = parsed.data;
  return {
    ...required,
    ...(summary !== undefined ? { summary } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(failedWhy !== undefined ? { failedWhy } : {}),
    ...(undoId !== undefined ? { undoId } : {}),
  };
}

/** What the turn (or an answer) persists: the card minus its row id and minus a why that only keeps the acts. */
export function accessWriteToMeta(card: AccessWriteCardState): { accessWrite: PersistedAccessWrite } {
  const { messageRowId: _rowId, failedWhy, ...persisted } = card;
  return { accessWrite: { ...persisted, ...(failedWhy !== undefined && !KEEPS_THE_ACTS.has(failedWhy) ? { failedWhy } : {}) } };
}

/**
 * Persist a card's answer onto its row by MERGING the row's meta (the ask card's rule): the same
 * message may carry an artifact card or the brain stamp. The thread is the CARD's — the one the hook
 * read when the act began, never the thread on screen when it ended (SC14) — and a row that thread
 * does not hold is never written: merging onto nothing would REPLACE that row's meta, dropping what
 * else it carries (Gate-5 G5-16 ii-5). Best-effort: a card with no row yet keeps its answer in
 * memory, and an unwritable audit field never throws.
 */
export function persistAccessWrite(
  db: {
    updateChatMessageMeta(id: number, meta: unknown): void;
    listChatMessages(threadId: string): { id: number; meta?: unknown }[];
  },
  threadId: string,
  card: AccessWriteCardState,
): void {
  const rowId = card.messageRowId;
  if (rowId === undefined) return;
  try {
    const row = db.listChatMessages(threadId).find((m) => m.id === rowId);
    if (row === undefined) return;
    const base = typeof row.meta === 'object' && row.meta !== null ? (row.meta as Record<string, unknown>) : {};
    db.updateChatMessageMeta(rowId, { ...base, ...accessWriteToMeta(card) });
  } catch {
    // The change itself already landed (or never did); an unwritable audit field is not worth a throw.
  }
}

/** The card's *apply to Ledger*: `writeChatApproved` under the current reader generation, answered as the card's next state. */
export async function approveCrossAppWrite(db: UserDb, card: AccessWriteCardState, options: { threadId: string }): Promise<AccessWriteCardState> {
  const liveGeneration = readerGeneration(card.appId);
  const caller: ChatAccessCaller = { kind: 'chat', appId: card.appId, threadId: options.threadId, ...(liveGeneration !== undefined ? { liveGeneration } : {}) };
  const outcome = await writeChatApproved(db, caller, { ...card.target, sql: card.sql, expectChanges: card.previewed });
  // A why from an earlier apply (busy, waiting) is the moment's — this answer replaces it.
  const { failedWhy: _earlier, ...rest } = card;
  if (outcome.ok) return { ...rest, outcome: 'applied', ...(outcome.undoId !== undefined ? { undoId: outcome.undoId } : {}) };
  const why = outcome.why ?? 'failed';
  if (KEEPS_THE_ACTS.has(why)) return { ...rest, failedWhy: why };
  if (why === 'drifted') return { ...rest, outcome: 'drifted' };
  return { ...rest, outcome: 'failed', failedWhy: why };
}
