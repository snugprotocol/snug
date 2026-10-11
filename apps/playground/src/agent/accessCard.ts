/**
 * accessCard — the access ASK card's state (TASK-20261010-host-broker PR-2 AC12; ADR-0076 §2;
 * D-PR2-11, D-PR2-16; S10). Mirrors `scheduleCard.ts`.
 *
 * An `access_propose` call stages ONE ask per turn on the agent's message — the schedule card's
 * pattern: the tool's hook patches the in-flight message, turn finalization persists the card in
 * the row's `meta.access` (a new key beside `meta.schedule`; no persisted record changes shape),
 * and the card re-renders from that row after a reload.
 *
 * THE CARD IS UI, NOT A GRANT. Nothing on it can allow anything: *review* opens the host's own
 * consent sheet through `startUserAsk` (the one recipe), and only the user's act THERE reaches
 * the one writer. What the card stores is therefore the AI's ask — its purpose and hints,
 * re-parsed through the protocol's display rule and hints schema on EVERY read — and how the
 * user answered it: `allowed` (with the source, tables and duration the strip's line names),
 * `not-now`, `declined`, or `failed` (the sheet could not act). A dismissal is NOT a resolution
 * (B-Q3: the yield rule closes the sheet, the card keeps its acts and writes nothing), so a stored
 * `dismissed` is a drifted row like any other. A row that drifted — a control character or a
 * credential in the purpose, a hint the schema refuses, a missing address, an unknown resolution
 * — renders NO card rather than a card that misstates what the user would be reviewing.
 *
 * THE THREAD'S APP IS THE ADDRESS (S10). The card carries the app it was staged for, but the
 * review always asks for the THREAD's pinned app; `readAccessCardRow` drops a card whose
 * `appId` is not that app, and so does the hook's rehydrate — a persisted row cannot point the
 * ask at another app.
 */

import { ACCESS_DURATIONS, accessHintsSchema, accessPurposeSchema, type AccessDuration, type AccessHints } from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';

import type { AccessProposal } from './accessProposeTool.js';

/** How the user answered the card; absent while it is staged. */
export type AccessCardResolution =
  | { kind: 'allowed'; sourceName: string; tables: string[]; duration: AccessDuration }
  | { kind: 'not-now' }
  | { kind: 'declined' }
  | { kind: 'failed' };

export interface AccessCardState {
  /** The AI's purpose — re-parsed through the protocol's display rule on read; shown quoted, never trusted. */
  purpose: string;
  /** The AI's relevance hints — re-parsed through the protocol's schema on read; the sheet ranks the user's apps by them. */
  hints?: AccessHints;
  /** The thread's app at staging — the reader the ask is for; the review resolves the app from the THREAD row, never from here. */
  appId: string;
  /** The thread the message lives in — what lets the card's answer be persisted by merging the row's meta. */
  threadId: string;
  resolution?: AccessCardResolution;
  /** The user-db row the card is persisted on (set once the turn finalizes; absent while streaming). */
  messageRowId?: number;
}

/** The persisted shape — the row's `meta.access`; the row id is the row's own address and is never written into it. */
export type PersistedAccessCard = Omit<AccessCardState, 'messageRowId'>;

const RESOLUTION_KINDS: ReadonlySet<string> = new Set<AccessCardResolution['kind']>(['allowed', 'not-now', 'declined', 'failed']);
const DURATIONS: ReadonlySet<string> = new Set<string>(ACCESS_DURATIONS);

/** A fresh staged card for a proposal the hook accepted — for the THREAD's app. */
export function stageAccessCard(proposal: AccessProposal, options: { appId: string; threadId: string }): AccessCardState {
  return {
    purpose: proposal.purpose,
    ...(proposal.hints !== undefined ? { hints: proposal.hints } : {}),
    appId: options.appId,
    threadId: options.threadId,
  };
}

/** What the turn persists: the card minus the row id it will be stored under. */
export function accessCardToMeta(card: AccessCardState): { access: PersistedAccessCard } {
  const { messageRowId: _rowId, ...persisted } = card;
  return { access: persisted };
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** A persisted resolution, re-admitted: a known kind with the fields that kind carries; anything else is no resolution. */
function readResolution(stored: unknown): AccessCardResolution | undefined {
  if (typeof stored !== 'object' || stored === null) return undefined;
  const { kind } = stored as { kind?: unknown };
  if (typeof kind !== 'string' || !RESOLUTION_KINDS.has(kind)) return undefined;
  if (kind !== 'allowed') return { kind: kind as Exclude<AccessCardResolution['kind'], 'allowed'> };
  const { sourceName, tables, duration } = stored as { sourceName?: unknown; tables?: unknown; duration?: unknown };
  if (!nonEmptyString(sourceName)) return undefined;
  if (!Array.isArray(tables) || !tables.every((table) => typeof table === 'string')) return undefined;
  if (typeof duration !== 'string' || !DURATIONS.has(duration)) return undefined;
  return { kind: 'allowed', sourceName, tables: [...(tables as string[])], duration: duration as AccessDuration };
}

/**
 * Rebuild a card from a persisted row, or `undefined` when the row cannot be trusted to render
 * one: the purpose through the protocol's display rule, the hints through its schema, both
 * addresses non-empty, the resolution a known shape.
 */
export function metaToAccessCard(meta: unknown): AccessCardState | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const stored = (meta as { access?: unknown }).access;
  if (typeof stored !== 'object' || stored === null) return undefined;
  const { purpose, hints, appId, threadId, resolution } = stored as Partial<PersistedAccessCard> & { resolution?: unknown };
  const parsedPurpose = accessPurposeSchema.safeParse(purpose);
  if (!parsedPurpose.success) return undefined;
  const parsedHints = hints === undefined ? undefined : accessHintsSchema.safeParse(hints);
  if (parsedHints !== undefined && !parsedHints.success) return undefined;
  if (!nonEmptyString(appId) || !nonEmptyString(threadId)) return undefined;
  const readResolved = resolution === undefined ? undefined : readResolution(resolution);
  if (resolution !== undefined && readResolved === undefined) return undefined;
  return {
    purpose: parsedPurpose.data,
    ...(parsedHints !== undefined ? { hints: parsedHints.data } : {}),
    appId,
    threadId,
    ...(readResolved !== undefined ? { resolution: readResolved } : {}),
  };
}

/**
 * Persist a card's resolution onto its row by MERGING the row's meta (the schedule card's rule):
 * the same message may carry an artifact card, a directive or the brain stamp, and answering an
 * ask must not delete them. Best-effort: a card with no row yet keeps its in-memory answer, and
 * an unwritable audit field never throws out of the surface that just answered.
 */
export function persistAccessResolution(
  db: {
    updateChatMessageMeta(id: number, meta: unknown): void;
    listChatMessages(threadId: string): { id: number; meta?: unknown }[];
  },
  resolved: AccessCardState,
): void {
  const rowId = resolved.messageRowId;
  if (rowId === undefined) return;
  try {
    const existing = db.listChatMessages(resolved.threadId).find((m) => m.id === rowId)?.meta;
    const base = typeof existing === 'object' && existing !== null ? (existing as Record<string, unknown>) : {};
    db.updateChatMessageMeta(rowId, { ...base, ...accessCardToMeta(resolved) });
  } catch {
    // The answer already reached the sheet (or nowhere); an unwritable audit field is not worth a throw.
  }
}

/**
 * The card's row as the file holds it NOW — how a remounted card learns an answer given while
 * it was unmounted. ALSO the S10 belt: a card whose app is not the thread's pinned app is no
 * card, however well-formed the row.
 */
export function readAccessCardRow(db: Pick<UserDb, 'listChatMessages' | 'getThread'>, threadId: string, rowId: number): AccessCardState | undefined {
  try {
    const row = db.listChatMessages(threadId).find((m) => m.id === rowId);
    const card = row === undefined ? undefined : metaToAccessCard(row.meta);
    if (card === undefined) return undefined;
    if (db.getThread(threadId)?.appId !== card.appId) return undefined;
    return { ...card, messageRowId: rowId };
  } catch {
    return undefined;
  }
}
