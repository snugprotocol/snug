// handin.ts — the app hand-in (TASK-20260905-binding-a-artifacts AC8, ADR-0065 §6). Inside
// a Claude artifact the agent hands apps in as `snug-app-bundle/1` blocks embedded in the
// page (`scripts/snug-embed.mjs` writes them; `scripts/lib/page-blocks.mjs` is the grammar).
// Boot, after the user db opens, reads every block and resolves it:
//
//   1. an app under `agent:<lineage>`            → an update candidate
//   2. else the app the bundle was LIFTED FROM     → an update candidate (kit-built or an
//      (`bundle.lineage === appId`)                  installed starter; its install_source untouched)
//   3. else                                        → a NEW install, owned (`agent:<lineage>`)
//
// An update candidate whose recorded bundle id differs applies ONLY when the copy is
// unedited (`isEditedCopy` — the one predicate the run header shares); an edited copy is
// never superseded silently: it is PENDING and the run header offers it through the
// ADR-0045 §7 confirm. A deleted app stays deleted (the `agentDismissed:` tombstone).
// A bundle carrying connections is a hard refusal (D4); every refusal is named, never a
// crash. Idempotent: the same block on the next boot installs nothing twice.
//
// THE TRUST BOUNDARY (plan review S1, written down): under Binding A the page is the
// publisher's output — whoever can republish the artifact can replace the kit's own
// JavaScript, so a consent gate on bundle blocks would defend nothing against a page
// writer. The boundary is the artifact's write permission (private by default). What
// holds inside it: no connections, no silent supersession, every version revertable,
// the hub note, the tombstone.

import {
  agentDismissedSettingKey,
  agentInstallSource,
  installAppFromBundle,
  isEditedCopy,
  sharedBundleSettingKey,
  updateAppFromBundle,
  type UserDb,
} from '@snugprotocol/db';
import { appBundleId, parseAppBundle, type AppBundle } from '@snugprotocol/protocol';

import { BUNDLE_BLOCK_TYPE, LINEAGE_RULE, type BundleBlockRead } from '../../../scripts/lib/page-blocks.mjs';

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

/** The blocks as the live DOM carries them — the same shape `readBundleBlocks` yields from a page string. */
export function readBundleBlocksFromDocument(doc: { querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null; textContent: string | null }> }): BundleBlockRead[] {
  const nodes = doc.querySelectorAll(`script[type="${BUNDLE_BLOCK_TYPE}"]`);
  const blocks: BundleBlockRead[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    blocks.push({ lineage: node.getAttribute('data-lineage') ?? '', json: (node.textContent ?? '').trim(), index: i, end: i });
  }
  return blocks;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function handInFromPage(db: UserDb, blocks: readonly BundleBlockRead[]): Promise<HandInOutcome> {
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
    const bundleId = await appBundleId(bundle);
    if (db.getSetting(agentDismissedSettingKey(lineage)) === bundleId) {
      outcome.skipped.push({ lineage, reason: 'dismissed' });
      continue;
    }
    const target = db.getAppByInstallSource(agentInstallSource(lineage)) ?? db.getApp(lineage);
    try {
      if (target === undefined) {
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

/** One line for the hub / the chip after a boot that handed something in. */
export function describeHandIn(outcome: HandInOutcome): string | undefined {
  const parts: string[] = [];
  if (outcome.installed.length > 0) parts.push(`installed by your agent: ${outcome.installed.map((a) => a.displayName).join(', ')}`);
  if (outcome.updated.length > 0) parts.push(`updated by your agent: ${outcome.updated.map((a) => `${a.displayName} · v${a.version}`).join(', ')}`);
  if (outcome.pending.length > 0) parts.push(`your agent handed in a new version of ${outcome.pending.map((p) => p.displayName).join(', ')} — you edited it, so the update is offered in the app`);
  if (outcome.refused.length > 0) parts.push(`refused: ${outcome.refused.map((r) => r.reason).join('; ')}`);
  return parts.length === 0 ? undefined : parts.join(' · ');
}
