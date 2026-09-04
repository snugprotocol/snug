// exportShare.ts — the sharer's side (TASK-20260904-app-sharing, ADR-0063 §2/§6).
//
// One app in the user file → one `snug-app-bundle/1` text. The db package builds the
// bundle (`buildAppBundle`: current version only, requirement halves only, the two
// mandatory strips); THIS module supplies the two things db cannot know:
//
//   1. THE BARE-BORROWER REDUCTION. A connection whose provider the registry knows is
//      exported as `slot / provider / kind / hosts` only — the shape starters ship in
//      `connection.json` — so the RECIPIENT's registry substitutes its own pinned seats
//      (fields, endpoints, registration, scopes). Exporting the sharer's substituted copy
//      would be admitted only while byte-equal to the recipient's registry (finding 15)
//      and would carry seats the borrow ban then refuses as authored (finding 24). The
//      borrow test is `admitConnectionRequirement` itself, on the `shared` channel — the
//      same predicate the recipient runs, so "is this a borrow?" cannot drift.
//   2. THE SHARE SCAN (AC5): a named warning per credential-shaped literal in the html or
//      a selected doc, with its line. Never a rewrite (a silently altered app is a broken
//      app) and never a hard refusal (the sharer owns the code) — the sheet shows the
//      warning and offers "share anyway".
//
// The bundle text is what travels on BOTH transports: the `.snug` download and the
// encrypted link payload (phase 2) are the same bytes.

import { admitConnectionRequirement } from '@snugprotocol/auth';
import { buildAppBundle } from '@snugprotocol/db';
import { appBundleId, type AppBundle, type ConnectionRequirement } from '@snugprotocol/protocol';

import { getPlatform } from '../platform/platform.js';
import { downloadBlob } from '../run/exportDb.js';
import { findCredentialShapes, type CredentialShapeHit } from '../security/credentialShapes.js';
import { getUserDb } from '../state/userdb.js';

export interface ShareWarning {
  /** `html`, or the doc slug. */
  where: string;
  hits: CredentialShapeHit[];
}

export interface PreparedShare {
  bundle: AppBundle;
  bundleId: string;
  text: string;
  bytes: number;
  warnings: ShareWarning[];
  /** The `.snug` file name the download and the OS share sheet use. */
  fileName: string;
}

/** Sanitize an app name into a file stem: letters, digits, space, dash, underscore; never empty. */
export function shareFileStem(displayName: string): string {
  const stem = displayName.replace(/[^a-z0-9-_ ]/gi, '').trim().replace(/\s+/g, ' ');
  return stem === '' ? 'snug-app' : stem;
}

/**
 * Reduce a registry-known provider's requirement to the bare borrower. Pure. Exported
 * for the db-level export hook and its test.
 */
export function reduceToBareBorrower(requirement: ConnectionRequirement): ConnectionRequirement {
  const admitted = admitConnectionRequirement(requirement, { channel: 'shared' });
  if (admitted.borrowed !== true) return requirement;
  const bare: ConnectionRequirement = {
    slot: requirement.slot,
    provider: {
      name: requirement.provider.name,
      ...(requirement.provider.docsUrl !== undefined ? { docsUrl: requirement.provider.docsUrl } : {}),
    },
    kind: requirement.kind,
    ...(requirement.lanHost !== undefined
      ? { lanHost: requirement.lanHost }
      : requirement.declaredApiHosts !== undefined
        ? { declaredApiHosts: requirement.declaredApiHosts }
        : {}),
  };
  return bare;
}

async function hubVersion(): Promise<string | undefined> {
  const updates = getPlatform().appUpdates;
  if (updates === undefined) return undefined;
  try {
    const version = await updates.currentVersion();
    return /^[A-Za-z0-9.+-]{1,40}$/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Build the bundle for one owned app with the chosen docs, scan it, and return everything the sheet shows. */
export async function prepareShare(appId: string, docs: readonly string[]): Promise<PreparedShare> {
  const db = await getUserDb();
  const version = await hubVersion();
  const bundle = await buildAppBundle(db, appId, {
    docs,
    ...(version !== undefined ? { hubVersion: version } : {}),
    reduceConnection: reduceToBareBorrower,
  });
  const bundleId = await appBundleId(bundle);
  const text = JSON.stringify(bundle);
  const warnings: ShareWarning[] = [];
  const htmlHits = findCredentialShapes(bundle.html);
  if (htmlHits.length > 0) warnings.push({ where: 'html', hits: htmlHits });
  for (const doc of bundle.docs ?? []) {
    const hits = findCredentialShapes(doc.content);
    if (hits.length > 0) warnings.push({ where: doc.slug, hits });
  }
  // The contract and the DDL travel too (Gate-5 finding 12): a key in a contract setting
  // or a `DEFAULT '…'` literal is as much a leak as one in the html.
  if (bundle.contract !== undefined) {
    const hits = findCredentialShapes(JSON.stringify(bundle.contract));
    if (hits.length > 0) warnings.push({ where: 'what it tells the AI', hits });
  }
  const ddlHits = findCredentialShapes((bundle.schema?.ddl ?? []).join('\n'));
  if (ddlHits.length > 0) warnings.push({ where: 'data schema', hits: ddlHits });
  return {
    bundle,
    bundleId,
    text,
    bytes: new TextEncoder().encode(text).length,
    warnings,
    fileName: `${shareFileStem(bundle.app.displayName)}.snug`,
  };
}

/** The attachment transport: the ONE `downloadBlob` dispatch (desktop consent-scoped save / web anchor). */
export function downloadShare(prepared: PreparedShare): void {
  downloadBlob(new Blob([prepared.text], { type: 'application/json' }), prepared.fileName);
}

/** Whether this browser can hand a FILE to the OS share sheet (mobile sheets, macOS AirDrop). */
export function canShareFile(prepared: PreparedShare): boolean {
  const nav = globalThis.navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  if (typeof nav?.canShare !== 'function' || typeof nav.share !== 'function') return false;
  try {
    return nav.canShare({ files: [new File([prepared.text], prepared.fileName, { type: 'application/json' })] });
  } catch {
    return false;
  }
}

/** Open the OS share sheet with the `.snug` file. Resolves false when the user dismissed it. */
export async function shareViaOs(prepared: PreparedShare): Promise<boolean> {
  const file = new File([prepared.text], prepared.fileName, { type: 'application/json' });
  try {
    await navigator.share({ files: [file], title: prepared.bundle.app.displayName });
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return false;
    throw error;
  }
}
