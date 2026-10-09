/**
 * scheduleCard — the schedule SUGGESTION card's state (TASK-20261009 P1; ADR-0074 §4).
 *
 * A `schedule_propose` call stages ONE proposal per turn on the agent's message — the
 * `DataWriteCardState` pattern, never `present_card` (ADR-0031 §3 keeps cards out of
 * approvals): the tool's sink patches the in-flight message, turn finalization persists the
 * card in the row's `meta.schedule`, and the card re-renders from that row after a reload.
 *
 * THE CARD IS UI, NOT A GATE. Nothing on it can enable a task: *schedule it* opens the one
 * consent surface (`EnableConsent`) and the user's act there calls the ONE writer
 * (`enableProposedTask`), which re-parses the proposal before the engine sees it. What the
 * card stores is therefore a SUGGESTION and how it was answered — `scheduled` (with the task
 * it became), `declined`, or `stale` — and the row is re-validated on every read with
 * `parseScheduleProposal`: a row that travelled through export, import or sync and no longer
 * parses renders NO card rather than a card that misrepresents what the user would be
 * enabling (the data-write card's rule).
 *
 * The card carries its `threadId` so the resolution can be persisted by MERGING the row's
 * meta (the same message may carry an artifact card or the brain stamp) from the card
 * itself, without the hook that staged it — ChatLog renders in two views and neither hands
 * it the thread.
 */

import { parseScheduleProposal, proposalHash, type ScheduleProposal } from '@snugprotocol/protocol';

import type { ProposalChannel } from '../schedule/enableProposedTask.js';

/** How the user answered the card; absent while it is staged. */
export type ScheduleCardResolution = 'scheduled' | 'declined' | 'stale';

/** The channel a card can come from — the builder's tool set or the chat's `schedule` lane (an app suggests on the strip, never in the rail). */
export type ScheduleCardChannel = Exclude<ProposalChannel, 'app'>;

export interface ScheduleCardState {
  /** The staged proposal — re-parsed on read, and again by the writer before anything is created. */
  proposal: ScheduleProposal;
  /** `proposalHash(proposal)` — the dedupe key the engine's declines use; recomputed on read, never trusted from the row. */
  hash: string;
  /** The thread's app at staging — the task's `ownerAppId`; absent for a reminder-only proposal on a thread with no app yet. */
  appId?: string;
  /** Which tool set staged it — the task's `provenance`. */
  channel: ScheduleCardChannel;
  /** The thread the message lives in — what lets the card persist its own resolution. */
  threadId: string;
  resolution?: ScheduleCardResolution;
  /** The task it became, once `scheduled`. */
  taskId?: string;
  /** The user-db row the card is persisted on (set once the turn finalizes; absent while streaming). */
  messageRowId?: number;
}

/** The persisted shape — the row's `meta.schedule`; the row id is the row's own address and is never written into it. */
export type PersistedScheduleCard = Omit<ScheduleCardState, 'messageRowId'>;

const CHANNELS: ReadonlySet<string> = new Set<ScheduleCardChannel>(['builder', 'chat']);
const RESOLUTIONS: ReadonlySet<string> = new Set<ScheduleCardResolution>(['scheduled', 'declined', 'stale']);

/** A fresh staged card for a proposal the sink accepted. */
export function stageScheduleCard(proposal: ScheduleProposal, options: { appId?: string; channel: ScheduleCardChannel; threadId: string }): ScheduleCardState {
  return {
    proposal,
    hash: proposalHash(proposal),
    ...(options.appId !== undefined ? { appId: options.appId } : {}),
    channel: options.channel,
    threadId: options.threadId,
  };
}

/** What the turn persists: the card minus the row id it will be stored under. */
export function scheduleCardToMeta(card: ScheduleCardState): { schedule: PersistedScheduleCard } {
  const { messageRowId: _rowId, ...persisted } = card;
  return { schedule: persisted };
}

/**
 * Rebuild a card from a persisted row, or `undefined` when the row cannot be trusted to
 * render one. The proposal goes through the SHIPPED strict parser (round-tripped through
 * JSON so the tolerant reader sees exactly the bytes the row holds); the hash is recomputed,
 * so a crafted row cannot claim another suggestion's identity.
 */
export function metaToScheduleCard(meta: unknown): ScheduleCardState | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const stored = (meta as { schedule?: unknown }).schedule;
  if (typeof stored !== 'object' || stored === null) return undefined;
  const { proposal, appId, channel, threadId, resolution, taskId } = stored as Partial<PersistedScheduleCard>;
  if (typeof threadId !== 'string' || threadId === '') return undefined;
  if (typeof channel !== 'string' || !CHANNELS.has(channel)) return undefined;
  let raw: string;
  try {
    raw = JSON.stringify(proposal);
  } catch {
    return undefined;
  }
  const parsed = parseScheduleProposal(raw);
  if (parsed === undefined) return undefined;
  if (appId !== undefined && (typeof appId !== 'string' || appId === '')) return undefined;
  if (resolution !== undefined && (typeof resolution !== 'string' || !RESOLUTIONS.has(resolution))) return undefined;
  if (taskId !== undefined && typeof taskId !== 'string') return undefined;
  return {
    proposal: parsed,
    hash: proposalHash(parsed),
    ...(appId !== undefined ? { appId } : {}),
    channel,
    threadId,
    ...(resolution !== undefined ? { resolution } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
  };
}

/**
 * Persist a card's resolution onto its row by MERGING the row's meta (the R-M5 rule the
 * data-write card follows): the same message may carry an artifact card, a directive or the
 * brain stamp, and answering a suggestion must not delete them. Best-effort: a card with no
 * row yet (the turn still streaming) keeps its in-memory answer, and an unwritable audit
 * field never throws out of the surface that just scheduled the user's task.
 */
export function persistScheduleResolution(
  db: {
    updateChatMessageMeta(id: number, meta: unknown): void;
    listChatMessages(threadId: string): { id: number; meta?: unknown }[];
  },
  resolved: ScheduleCardState,
): void {
  const rowId = resolved.messageRowId;
  if (rowId === undefined) return;
  try {
    const existing = db.listChatMessages(resolved.threadId).find((m) => m.id === rowId)?.meta;
    const base = typeof existing === 'object' && existing !== null ? (existing as Record<string, unknown>) : {};
    db.updateChatMessageMeta(rowId, { ...base, ...scheduleCardToMeta(resolved) });
  } catch {
    // The task (if any) already landed; an unwritable audit field is not worth a throw.
  }
}

/** The card's row as the file holds it NOW — how a remounted card learns an answer given while it was unmounted. */
export function readScheduleCardRow(
  db: { listChatMessages(threadId: string): { id: number; meta?: unknown }[] },
  threadId: string,
  rowId: number,
): ScheduleCardState | undefined {
  try {
    const row = db.listChatMessages(threadId).find((m) => m.id === rowId);
    const card = row === undefined ? undefined : metaToScheduleCard(row.meta);
    return card === undefined ? undefined : { ...card, messageRowId: rowId };
  } catch {
    return undefined;
  }
}
