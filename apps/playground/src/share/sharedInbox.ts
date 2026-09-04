// sharedInbox.ts — the "shared with you" shelf (TASK-20260904-app-sharing, ADR-0063 §4).
//
// A received bundle is INERT until the user installs it, and it is MEMORY-FIRST: it
// lands in this module store (which outlives every view and dies with the page) and is
// written into the user file only after an explicit act — opening an attachment (a
// double-click or a Settings pick IS the act), or clicking "keep" on a link preview.
// A bare link visit never writes third-party bytes into the file, so a drive-by URL
// cannot fill the shelf (finding 12). Persistence is one `snug_settings` row per bundle
// (`sharedApp:<bundleId>`), keyed by CONTENT id so the same bundle twice is one row.
//
// THE CAP REFUSES, NEVER EVICTS (finding 21): a share the user never saw must not be
// silently dropped to make room; the 13th arrival is refused with a note.
//
// IDENTITY. `bundleId` is computed here from the bytes (`appBundleId`, sha-256 over the
// canonical JSON) — never read from the bundle. The preview ROUTE is `shared--<bundleId>`
// beside `starter--<folder>`; `isUnownedId` is the one predicate RunView uses for the
// read-only branches both kinds share, and `isSharedId` for the branches a shared
// preview alone needs (no LLM transport without opt-in).
//
// NOTHING HERE RENDERS. The store holds parsed data; the cards, the preview and the
// install button live in HubView / RunView. Nothing from a bundle is ever handed to the
// DOM as HTML — names, blurbs and doc text render as text nodes (AC16).

import { APP_BUNDLE_MAX_BYTES, appBundleId, parseAppBundle, type AppBundle } from '@snugprotocol/protocol';
import { bundleIdFromSharedAppSettingKey, sharedAppSettingKey } from '@snugprotocol/db';

import { isStarterId } from '../starter/starterApps.js';
import { createStore, type Store } from '../state/store.js';
import { getUserDb } from '../state/userdb.js';

export const SHARED_PREFIX = 'shared--';
export const MAX_SHARED_INBOX = 12;
/** Aggregate cap on the KEPT shelf — 12 × the bundle cap is a bounded slice of the 64 MiB file. */
export const MAX_SHARED_INBOX_BYTES = MAX_SHARED_INBOX * APP_BUNDLE_MAX_BYTES;

export type SharedSource = 'file' | 'link' | 'settings';

export interface SharedEntry {
  bundleId: string;
  bundle: AppBundle;
  /** The exact text that was received — what "keep" persists and what install re-parses. */
  text: string;
  receivedAt: string;
  source: SharedSource;
  /** True once the row is in the user file (opened attachment, or "keep" on a link). */
  kept: boolean;
  /**
   * For a LINK receipt only, in memory only — never persisted: the relay id and the
   * fragment key, so the preview can offer "open in Snug for Mac" (the desktop deep
   * link carries both) without the page keeping the key in its address bar.
   */
  link?: { id: string; key: string };
}

export type ReceiveResult =
  | { ok: true; entry: SharedEntry; duplicate: boolean }
  | { ok: false; reason: 'too-large' | 'not-json' | 'not-a-bundle' | 'invalid' | 'shelf-full'; detail?: string };

export const sharedInboxStore: Store<readonly SharedEntry[]> = createStore<readonly SharedEntry[]>([]);

/** A note for the hub/settings surfaces (a refused arrival, a kept confirmation); null = nothing to say. */
export const sharedInboxNoteStore: Store<string | null> = createStore<string | null>(null);

/**
 * A request to open a preview from a non-React caller (the platform open seam, the
 * Settings picker). App.tsx consumes it with `useNavigate` and clears it.
 */
export const sharedOpenRequestStore: Store<string | null> = createStore<string | null>(null);

export function isSharedId(id: string): boolean {
  return id.startsWith(SHARED_PREFIX);
}

/** A read-only preview of something the user does not own yet — a bundled starter or a shared bundle. */
export function isUnownedId(id: string): boolean {
  return isStarterId(id) || isSharedId(id);
}

export function sharedRouteIdFor(bundleId: string): string {
  return `${SHARED_PREFIX}${bundleId}`;
}

export function bundleIdFromSharedRouteId(id: string): string | undefined {
  if (!isSharedId(id)) return undefined;
  const bundleId = id.slice(SHARED_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(bundleId) ? bundleId : undefined;
}

export function listSharedEntries(): readonly SharedEntry[] {
  return sharedInboxStore.get();
}

export function getSharedEntry(bundleId: string): SharedEntry | undefined {
  return sharedInboxStore.get().find((entry) => entry.bundleId === bundleId);
}

/** The shelf entry, if any, whose lineage an installed app's `install_source` names. */
export function sharedEntryForLineage(lineage: string): SharedEntry | undefined {
  return sharedInboxStore.get().find((entry) => entry.bundle.lineage === lineage);
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

function keptBytes(entries: readonly SharedEntry[]): number {
  return entries.filter((entry) => entry.kept).reduce((sum, entry) => sum + utf8Bytes(entry.text), 0);
}

/**
 * Receive bundle TEXT from any source. Parses and validates at the boundary, computes the
 * content id, and places the entry on the shelf. `persist: true` (an explicit act) also
 * writes the settings row; a link visit passes `false` and the entry stays in memory.
 */
export async function receiveSharedBundle(
  text: string,
  options: { source: SharedSource; persist: boolean; link?: { id: string; key: string } },
): Promise<ReceiveResult> {
  const parsed = parseAppBundle(text);
  if (!parsed.ok) {
    const detail = parsed.reason === 'invalid' ? parsed.issues.map((i) => `${i.path}: ${i.message}`).join('; ') : undefined;
    return { ok: false, reason: parsed.reason, ...(detail !== undefined ? { detail } : {}) };
  }
  const bundleId = await appBundleId(parsed.bundle);
  const current = sharedInboxStore.get();
  const existing = current.find((entry) => entry.bundleId === bundleId);
  if (existing !== undefined) {
    if (options.persist && !existing.kept) return keepSharedEntry(bundleId).then((entry) => ({ ok: true, entry: entry ?? existing, duplicate: true }));
    return { ok: true, entry: existing, duplicate: true };
  }
  if (current.length >= MAX_SHARED_INBOX) {
    return { ok: false, reason: 'shelf-full', detail: `your shared shelf holds ${MAX_SHARED_INBOX} apps — install or dismiss one first` };
  }
  const entry: SharedEntry = {
    bundleId,
    bundle: parsed.bundle,
    text,
    receivedAt: new Date().toISOString(),
    source: options.source,
    kept: false,
    ...(options.link !== undefined ? { link: options.link } : {}),
  };
  sharedInboxStore.set([...current, entry]);
  if (options.persist) {
    const kept = await keepSharedEntry(bundleId);
    return { ok: true, entry: kept ?? entry, duplicate: false };
  }
  return { ok: true, entry, duplicate: false };
}

interface PersistedSharedRow {
  text: string;
  receivedAt: string;
  source: SharedSource;
}

/** Write the entry into the user file (the explicit "keep" act). Returns the kept entry. */
export async function keepSharedEntry(bundleId: string): Promise<SharedEntry | undefined> {
  const entry = getSharedEntry(bundleId);
  if (entry === undefined) return undefined;
  if (entry.kept) return entry;
  const others = sharedInboxStore.get().filter((e) => e.bundleId !== bundleId);
  if (keptBytes(others) + utf8Bytes(entry.text) > MAX_SHARED_INBOX_BYTES) {
    sharedInboxNoteStore.set('your shared shelf is full — install or dismiss an app before keeping another');
    return entry;
  }
  const db = await getUserDb();
  const row: PersistedSharedRow = { text: entry.text, receivedAt: entry.receivedAt, source: entry.source };
  try {
    db.setSetting(sharedAppSettingKey(bundleId), row);
  } catch (error) {
    // The file's byte cap (TOO_LARGE) is the only writer failure here; say so rather
    // than swallowing it behind a `void` (Gate-5 finding 14).
    sharedInboxNoteStore.set(`could not keep this shared app: ${error instanceof Error ? error.message : String(error)}`);
    return entry;
  }
  const kept: SharedEntry = { ...entry, kept: true };
  sharedInboxStore.set(sharedInboxStore.get().map((e) => (e.bundleId === bundleId ? kept : e)));
  return kept;
}

/** Remove from the shelf and, if kept, from the user file. Dismiss or install both end here. */
export async function removeSharedEntry(bundleId: string): Promise<void> {
  const entry = getSharedEntry(bundleId);
  sharedInboxStore.set(sharedInboxStore.get().filter((e) => e.bundleId !== bundleId));
  if (entry?.kept === true) {
    const db = await getUserDb();
    db.deleteSetting(sharedAppSettingKey(bundleId));
  }
}

/**
 * Boot / user-file-swap hydration: read every `sharedApp:` row back onto the shelf.
 * Rows that no longer parse (a newer format, a damaged row) are dropped from the file
 * — they cannot be shown honestly and cannot be installed.
 */
export async function hydrateSharedInbox(): Promise<void> {
  const db = await getUserDb();
  const entries: SharedEntry[] = [];
  for (const key of db.listSettingKeys()) {
    const bundleId = bundleIdFromSharedAppSettingKey(key);
    if (bundleId === undefined) continue;
    const raw = db.getSetting(key);
    const row = raw as Partial<PersistedSharedRow> | undefined;
    if (row === undefined || typeof row.text !== 'string') {
      db.deleteSetting(key);
      continue;
    }
    const parsed = parseAppBundle(row.text);
    if (!parsed.ok) {
      // NOT deleted (Gate-5 finding 11): a row this build cannot parse may be a bundle
      // from a NEWER format that a newer hub reads fine — files roam, and this hydrate
      // runs after every sync pull, so a deletion here would sync back and destroy a
      // share the user kept elsewhere. Unreadable here means invisible here, no more.
      continue;
    }
    // Recompute identity from the bytes — never trust the key alone (a hand-edited file
    // could put one bundle under another's id).
    const computed = await appBundleId(parsed.bundle);
    if (computed !== bundleId) {
      db.deleteSetting(key);
      continue;
    }
    entries.push({
      bundleId,
      bundle: parsed.bundle,
      text: row.text,
      receivedAt: typeof row.receivedAt === 'string' ? row.receivedAt : new Date(0).toISOString(),
      source: row.source === 'file' || row.source === 'link' || row.source === 'settings' ? row.source : 'file',
      kept: true,
    });
  }
  // Memory-only entries from this session survive a hydrate (a user-file swap must not
  // lose a link preview the user is looking at); kept entries are replaced by the file's.
  const memoryOnly = sharedInboxStore.get().filter((entry) => !entry.kept && !entries.some((e) => e.bundleId === entry.bundleId));
  sharedInboxStore.set([...entries, ...memoryOnly]);
}

/** A user-file swap seam (import / pull / restore): the kept rows belong to the OLD file. */
export function resetSharedInbox(): void {
  sharedInboxStore.set([]);
  sharedInboxNoteStore.set(null);
  sharedOpenRequestStore.set(null);
}

/** Test seam. */
export function __resetSharedInboxForTests(): void {
  resetSharedInbox();
}
