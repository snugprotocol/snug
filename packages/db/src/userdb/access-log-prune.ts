// access-log-prune.ts — the PRUNE CORE of an access history (ADR-0075 §7), lifted out of `access.ts`
// for TASK-20261010-host-broker PR-5 (contract v2 D-PR5-8) so the two-device history carry
// (`history-carry.ts`) gives way by the SAME tiers `appendAccessLog` prunes by. NON-THROWING: it
// answers whether the rows now fit, and the caller decides what a miss means — `appendAccessLog`
// refuses with ACCESS_LIMIT; the carry leaves the winner's own lines as they were.
//
// It reads every stored element LOOSELY (`looseView`): the write path validates what it ADDS and
// only ever REMOVES from what was there, so nothing already stored is re-parsed on every append
// (the strict parse's credential walk is the expensive half of a read; the `schedules.ts` M3
// reasoning). The READ path (`access.ts`'s `readLog`) still vouches for every entry it hands out.

import { ACCESS_LOG_KINDS, utf8ByteLength, type AccessLogKind } from '@snugprotocol/protocol';

/** A history row's elements as stored, unvalidated: absent → none; a non-array row → one worthless element. */
export function looseEntries(raw: string | undefined): unknown[] {
  if (raw === undefined) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = raw;
  }
  return Array.isArray(json) ? json : [json];
}

/** A row's serialized UTF-8 size — what the per-source and the total caps measure. */
export const bytesOf = (entries: ReadonlyArray<unknown>): number => utf8ByteLength(JSON.stringify(entries));

const LOG_KIND_SET: ReadonlySet<string> = new Set(ACCESS_LOG_KINDS);
/** The lifecycle kinds whose LATEST entry per grant is never pruned (ADR-0075 §7) — and, since 1.2, a grant's latest `wrote` (D-PR3-6). */
const PROTECTED_KINDS: ReadonlySet<AccessLogKind> = new Set<AccessLogKind>(['granted', 'revoked', 'suspended', 'released', 'wrote']);

export interface EntryView {
  /** Undefined for an element that is not a readable entry: worthless bytes, pruned first. */
  kind: AccessLogKind | undefined;
  grantId: string | undefined;
  /** Epoch milliseconds; −∞ for an element with no readable instant (it is the oldest). */
  at: number;
}

/** The LOOSE view of a stored element. */
export function looseView(item: unknown): EntryView {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return { kind: undefined, grantId: undefined, at: Number.NEGATIVE_INFINITY };
  const { kind, grantId, at } = item as { kind?: unknown; grantId?: unknown; at?: unknown };
  const parsedAt = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  return {
    kind: typeof kind === 'string' && LOG_KIND_SET.has(kind) ? (kind as AccessLogKind) : undefined,
    grantId: typeof grantId === 'string' ? grantId : undefined,
    at: Number.isNaN(parsedAt) ? Number.NEGATIVE_INFINITY : parsedAt,
  };
}

/** The latest protected-kind entry per (grant, kind) in one row, as index → grantId. Ties keep the newer position. */
function protectedIndices(entries: readonly unknown[]): Map<number, string> {
  const latest = new Map<string, { index: number; at: number; grantId: string }>();
  entries.forEach((item, index) => {
    const view = looseView(item);
    if (view.kind === undefined || !PROTECTED_KINDS.has(view.kind) || view.grantId === undefined) return;
    const slot = `${view.grantId}\u0000${view.kind}`;
    const seen = latest.get(slot);
    // The row is stored newest first, so on an equal instant the LOWER index is the newer entry.
    if (seen === undefined || view.at > seen.at) latest.set(slot, { index, at: view.at, grantId: view.grantId });
  });
  return new Map([...latest.values()].map(({ index, grantId }) => [index, grantId]));
}

/**
 * One prune tier: may this element go? `protectedGrant` is the element's grant id when it is the
 * latest of a protected kind for that grant, else `undefined`; `heldGrants` (the ids of every grant
 * row the file holds) is read lazily — only a tier that asks pays for it; `item` is the element as
 * stored, for a caller whose tier knows its own elements (the carry's lines give way first).
 */
export type PruneTier = (view: EntryView, protectedGrant: string | undefined, heldGrants: () => ReadonlySet<string>, item: unknown) => boolean;

/**
 * The history's tiers, in order: unreadable bytes, then reads, then every other entry that is not
 * the latest of its kind for its grant — and LAST the latest entries of a grant the file no longer
 * holds.
 */
export const PRUNE_TIERS: readonly PruneTier[] = [
  ({ kind }, guard) => guard === undefined && kind === undefined,
  ({ kind }, guard) => guard === undefined && kind === 'read',
  ({ kind }, guard) => guard === undefined && kind !== undefined && kind !== 'read',
  (_view, guard, held) => guard !== undefined && !held().has(guard),
];

/**
 * The OLDEST prunable element across the given rows, tier by tier; `keep` (the entry being
 * written) is never its own victim. Returns the row and index, or `undefined` when nothing may go.
 */
export function pruneVictim(
  rows: ReadonlyMap<string, unknown[]>,
  keep: unknown,
  heldGrants: () => ReadonlySet<string>,
  tiers: readonly PruneTier[] = PRUNE_TIERS,
): { sourceAppId: string; index: number } | undefined {
  const guarded = new Map<string, Map<number, string>>();
  for (const [sourceAppId, entries] of rows) guarded.set(sourceAppId, protectedIndices(entries));
  for (const prunable of tiers) {
    let victim: { sourceAppId: string; index: number; at: number } | undefined;
    for (const [sourceAppId, entries] of rows) {
      const fenced = guarded.get(sourceAppId);
      for (let index = 0; index < entries.length; index += 1) {
        const item = entries[index];
        if (item === keep) continue;
        const view = looseView(item);
        if (!prunable(view, fenced?.get(index), heldGrants, item)) continue;
        if (victim === undefined || view.at < victim.at) victim = { sourceAppId, index, at: view.at };
      }
    }
    if (victim !== undefined) return { sourceAppId: victim.sourceAppId, index: victim.index };
  }
  return undefined;
}

export interface PruneOptions {
  /** The element being written — never its own victim. */
  keep?: unknown;
  /** The ids of every grant row the file holds, read lazily (the last default tier asks). */
  heldGrants: () => ReadonlySet<string>;
  /** Default `PRUNE_TIERS`. */
  tiers?: readonly PruneTier[];
  /** Told after each removal — the row it left and the element removed — so a caller can keep its own tally. */
  onPruned?: (sourceAppId: string, entries: unknown[], removed: unknown) => void;
}

/**
 * Remove the oldest prunable element, tier by tier, from `rows` (in place) until `fits()` holds.
 * Answers `true` when the rows fit, `false` when nothing more may go — never throws.
 */
export function pruneToFit(rows: ReadonlyMap<string, unknown[]>, fits: () => boolean, options: PruneOptions): boolean {
  while (!fits()) {
    const victim = pruneVictim(rows, options.keep, options.heldGrants, options.tiers);
    if (victim === undefined) return false;
    const entries = rows.get(victim.sourceAppId);
    if (entries === undefined) return false;
    const [removed] = entries.splice(victim.index, 1);
    options.onPruned?.(victim.sourceAppId, entries, removed);
  }
  return true;
}
