// handin.ts — the app hand-in (TASK-20260905-binding-a-artifacts AC8, ADR-0065 §6), and since
// TASK-20261003 (ADR-0072 §3) the ONE core every binding hands in through.
//
// Inside a Claude artifact the agent hands apps in as `snug-app-bundle/1` blocks embedded in
// the page (`scripts/snug-embed.mjs` writes them; `scripts/lib/page-blocks.mjs` is the
// grammar), read ONCE at boot after the user db opens. Under the local runner the same
// bundles arrive one at a time, as events, while the page is up (`local/handinEvents.ts`).
// Both go through `applyAgentBundles`, and both offer an edited copy's update through
// `createHandInSeat` — the runner used to reuse the core and drop everything around it, so
// its edited-copy updates were offered nowhere. Each bundle is resolved:
//
//   1. an app under `agent:<lineage>`            → an update candidate
//   2. else the app the bundle was LIFTED FROM     → an update candidate (kit-built or an
//      (`bundle.lineage === appId`)                  installed starter; its install_source
//                                                    untouched; NEVER a `share:` copy)
//   3. else                                        → a NEW install, owned (`agent:<lineage>`)
//
// An update candidate whose recorded bundle id differs applies ONLY when the copy is
// unedited (`isEditedCopy` — the one predicate the run header shares); an edited copy is
// never superseded silently: it is PENDING and the run header offers it through the
// ADR-0045 §7 confirm. A deleted app stays deleted (the `agentDismissed:` tombstone — read
// only when no target exists, so a rolled-back bundle can still update a live app) — unless
// the hand-in is `explicit`, the ONE rule the bindings do not share (see `HandInOptions`). A
// bundle carrying connections is a hard refusal at the boundary (D4), BEFORE it can be
// offered; every refusal is named, never a crash. Idempotent: the same block on the next
// boot installs nothing twice.
//
// THE TRUST BOUNDARY (plan review S1, written down): under Binding A the page is the
// publisher's output — whoever can republish the artifact can replace the kit's own
// JavaScript, so a consent gate on bundle blocks would defend nothing against a page
// writer. The boundary is the artifact's write permission (private by default). What
// holds inside it: no connections, no silent supersession, every version revertable,
// the hub note, the tombstone.

import {
  SHARE_INSTALL_SOURCE_PREFIX,
  agentDismissedSettingKey,
  agentInstallSource,
  installAppFromBundle,
  isEditedCopy,
  sharedBundleSettingKey,
  updateAppFromBundle,
  type UserDb,
} from '@snugprotocol/db';
import { appBundleId, parseAppBundle, type AppBundle } from '@snugprotocol/protocol';

import { CONNECTIONS_UNAVAILABLE } from '@playground/platform/availability';
import type { AgentHandInSeat, PendingAgentUpdate } from '@playground/platform/platform';

import { BUNDLE_BLOCK_TYPE, LINEAGE_RULE, type BundleBlockRead } from '../../../scripts/lib/page-blocks.mjs';

/** What the hand-in reads of a block: the lineage attribute and the JSON text. */
export type HandInBlock = Pick<BundleBlockRead, 'lineage' | 'json'>;

export interface PendingHandIn {
  lineage: string;
  appId: string;
  displayName: string;
  bundleId: string;
  bundle: AppBundle;
}

export interface HandInOutcome {
  installed: { appId: string; displayName: string }[];
  updated: { appId: string; displayName: string; version: number }[];
  /** Edited copies the agent handed a newer version for — offered, never applied here. */
  pending: PendingHandIn[];
  skipped: { lineage: string; reason: 'current' | 'dismissed' }[];
  refused: { lineage: string; reason: string }[];
}

/** The blocks as the live DOM carries them. */
export function readBundleBlocksFromDocument(doc: { querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null; textContent: string | null }> }): HandInBlock[] {
  const nodes = doc.querySelectorAll(`script[type="${BUNDLE_BLOCK_TYPE}"]`);
  const blocks: HandInBlock[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    blocks.push({ lineage: node.getAttribute('data-lineage') ?? '', json: (node.textContent ?? '').trim() });
  }
  return blocks;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface HandInOptions {
  /**
   * How a bundle asking for connections is refused. Under Binding A connected apps do not
   * exist at all; under Binding B they DO — but the user grants them in the wizard, never a
   * bundle. The refusal stands in both, and only its sentence differs (ADR-0068 D-B26).
   */
  binding?: 'artifact' | 'local-host';
  /**
   * The agent is handing this in NOW, by an act the user asked for (the runner's tool call)
   * — not a block riding a page that is read again on every load. It is the ONE place the
   * bindings differ (the parity test states it): an explicit hand-in of an app the user
   * deleted CLEARS the tombstone and installs, because "build that again" is the request;
   * a page block for a deleted app stays deleted, because honouring it would resurrect the
   * app every time the page opened.
   */
  explicit?: boolean;
}

export async function applyAgentBundles(db: UserDb, blocks: readonly HandInBlock[], options: HandInOptions = {}): Promise<HandInOutcome> {
  const outcome: HandInOutcome = { installed: [], updated: [], pending: [], skipped: [], refused: [] };
  for (const block of blocks) {
    const parsed = parseAppBundle(block.json);
    if (!parsed.ok) {
      const detail = parsed.reason === 'invalid' ? parsed.issues.map((i) => `${i.path}: ${i.message}`).join('; ') : parsed.reason;
      outcome.refused.push({ lineage: block.lineage, reason: `the handed-in block is not a Snug app bundle (${detail})` });
      continue;
    }
    const bundle = parsed.bundle;
    if (!LINEAGE_RULE.test(block.lineage) || block.lineage !== bundle.lineage) {
      outcome.refused.push({ lineage: block.lineage, reason: `the block's lineage "${block.lineage}" does not match the bundle's "${bundle.lineage}"` });
      continue;
    }
    const lineage = bundle.lineage;
    // D4 at the boundary — before the block can be installed, updated OR offered.
    if (bundle.connections.length > 0) {
      outcome.refused.push({
        lineage,
        reason:
          options.binding === 'local-host'
            ? `"${bundle.app.displayName}" asks for ${bundle.connections.length} connection(s) — connect it yourself in Snug, from the app's own connections door. A bundle cannot bring a connection.`
            : // The kit's ONE sentence for a host without connections (K4) — this core serves
              // every binding that has none, and "inside an artifact" named only one of them.
              `"${bundle.app.displayName}" asks for ${bundle.connections.length} connection(s) — ${CONNECTIONS_UNAVAILABLE}, so this hand-in was refused`,
      });
      continue;
    }
    const bundleId = await appBundleId(bundle);
    const lifted = db.getApp(lineage);
    const target =
      db.getAppByInstallSource(agentInstallSource(lineage)) ??
      (lifted !== undefined && lifted.installSource?.startsWith(SHARE_INSTALL_SOURCE_PREFIX) !== true ? lifted : undefined);
    try {
      if (target === undefined) {
        // Cleared, not stepped over: a tombstone left behind an installed app would have the
        // next page block for this lineage read "dismissed" about an app the user has.
        if (options.explicit === true) db.deleteSetting(agentDismissedSettingKey(lineage));
        else if (db.getSetting(agentDismissedSettingKey(lineage)) === bundleId) {
          outcome.skipped.push({ lineage, reason: 'dismissed' });
          continue;
        }
        const result = await installAppFromBundle(db, bundle, { bundleId, provenance: 'agent' });
        const app = db.getApp(result.appId);
        outcome.installed.push({ appId: result.appId, displayName: app?.displayName ?? bundle.app.displayName });
        continue;
      }
      if (db.getSetting(sharedBundleSettingKey(target.appId)) === bundleId) {
        outcome.skipped.push({ lineage, reason: 'current' });
        continue;
      }
      if (isEditedCopy(db, target.appId)) {
        outcome.pending.push({ lineage, appId: target.appId, displayName: target.displayName, bundleId, bundle });
        continue;
      }
      const result = await updateAppFromBundle(db, target.appId, bundle, { bundleId, provenance: 'agent' });
      if (result.status === 'updated') outcome.updated.push({ appId: target.appId, displayName: target.displayName, version: result.version });
      else outcome.skipped.push({ lineage, reason: 'current' });
    } catch (error) {
      outcome.refused.push({ lineage, reason: message(error) });
    }
  }
  return outcome;
}

/** The offered update, taken: ADR-0045 §7's confirm happened in the run header. */
export async function applyPendingHandIn(db: UserDb, pending: PendingHandIn): Promise<{ version: number }> {
  const result = await updateAppFromBundle(db, pending.appId, pending.bundle, { bundleId: pending.bundleId, provenance: 'agent' });
  if (result.status !== 'updated') throw new Error('this copy already reflects the handed-in version');
  return { version: result.version };
}

export interface HandInSeat {
  /** What the platform carries: the offers, and the act that takes one after the confirm. */
  seat: AgentHandInSeat;
  /** Fold one hand-in's outcome in — new offers added, superseded ones withdrawn — against the db it ran on. */
  absorb(db: UserDb, outcome: HandInOutcome): void;
}

/**
 * The offers for edited copies (ADR-0045 §7), for whichever binding composes it.
 *
 * AN OFFER IS WITHDRAWN when it stops being true (K6): the user took it; the app was
 * deleted; the app became that version by another path; or a later hand-in updated the app
 * directly (the copy was reverted to the agent's version in between), which makes this the
 * OLDER version. The last arrives with an outcome. The middle two are facts about the user's
 * file that change with no hand-in at all, so they are checked where the offers are READ —
 * silently: the snapshot changes, nothing is notified, and the only reader is the run header
 * of the app the offer is for, which re-reads on its own renders.
 */
export function createHandInSeat(): HandInSeat {
  const offers = new Map<string, PendingHandIn>();
  const listeners = new Set<() => void>();
  let db: UserDb | undefined;
  // ONE array between changes: `useSyncExternalStore` re-renders for ever on a fresh one.
  let snapshot: readonly PendingAgentUpdate[] = [];
  const reshape = (): void => {
    snapshot = [...offers.values()].map((offer) => ({ appId: offer.appId, displayName: offer.displayName, bundleId: offer.bundleId }));
  };
  const publish = (): void => {
    reshape();
    for (const listener of listeners) listener();
  };
  /** Drop offers the file no longer supports. True when any went. */
  const withdrawStale = (): boolean => {
    if (db === undefined) return false;
    let dropped = false;
    for (const [appId, offer] of offers) {
      if (db.getApp(appId) === undefined || db.getSetting(sharedBundleSettingKey(appId)) === offer.bundleId) {
        offers.delete(appId);
        dropped = true;
      }
    }
    return dropped;
  };
  return {
    seat: {
      pending: {
        get() {
          if (withdrawStale()) reshape();
          return snapshot;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      async apply(appId) {
        withdrawStale();
        const offer = offers.get(appId);
        if (offer === undefined || db === undefined) throw new Error('nothing is pending for this app');
        const result = await applyPendingHandIn(db, offer);
        offers.delete(appId);
        publish();
        return result;
      },
    },
    absorb(nextDb, outcome) {
      db = nextDb;
      const before = offers.size;
      for (const updated of outcome.updated) offers.delete(updated.appId);
      // Keyed by app: a newer offer for the same app replaces the older one.
      for (const pending of outcome.pending) offers.set(pending.appId, pending);
      const stale = withdrawStale();
      if (stale || outcome.pending.length > 0 || offers.size !== before) publish();
    },
  };
}

/** One line for the custody chip after a hand-in did something. */
export function describeHandIn(outcome: HandInOutcome): string | undefined {
  const parts: string[] = [];
  if (outcome.installed.length > 0) parts.push(`installed by your agent: ${outcome.installed.map((a) => a.displayName).join(', ')}`);
  if (outcome.updated.length > 0) parts.push(`updated by your agent: ${outcome.updated.map((a) => `${a.displayName} · v${a.version}`).join(', ')}`);
  if (outcome.pending.length > 0) parts.push(`your agent handed in a new version of ${outcome.pending.map((p) => p.displayName).join(', ')} — you edited it, so the update is offered in the app`);
  if (outcome.refused.length > 0) parts.push(`refused: ${outcome.refused.map((r) => r.reason).join('; ')}`);
  return parts.length === 0 ? undefined : parts.join(' · ');
}
