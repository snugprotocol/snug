// compose.ts — the kit's composition root for every binding the PROBE finds
// (TASK-20260905-binding-a-artifacts): from the probe's answers and the page, the seats the
// platform carries. Pure over injected window / document slices so every binding's wiring
// is tested without a browser; the boot calls it once and renders. (The local runner is
// composed by `local/compose-local.ts` — the boot decides which, `boot.tsx`.)
//
//   artifact / artifact-static → the artifact-html RECORD over the probed bucket (seeded
//       from the page's `snug-db` block; the save act only where `artifact` resolved), the
//       custody seat, the export seat over `downloads` (or the copy path). A chat-created
//       artifact is this binding: the same hosted runtime (measured 2026-10-03).
//   file                      → the bucket, the custody chip's plain-file copy, the copy
//       export. (A loopback static server is file-class too — K2; so is a page that meets
//       only the September chat runtime's flat `window.claude.complete` — TASK-20261003 R5
//       C2: that runtime, and the per-view `window.storage` it kept the file in, are gone,
//       and the kit no longer reads either.)
//
// The hand-in runs AFTER the user db opens (`handIn(db)`), never before: it installs and
// updates through the db, and pending (edited-copy) hand-ins are offered through the
// run header's seat. `handInBeforePaint` is the named, bounded wait the entry uses so a
// prompt db paints with the handed-in apps and a stuck db still shows its recovery UI.

import { type PersistenceBackend, type UserDb } from '@snugprotocol/db';

import type { CustodySeat, PendingAgentUpdate, SnugPlatform } from '@playground/platform/platform';

import { parseDbBlockBody } from '../../../scripts/lib/page-blocks.mjs';
import { createExportSeat } from './exportSeat.js';
import { applyAgentBundles, createHandInSeat, readBundleBlocksFromDocument, type HandInOutcome } from './handin.js';
import { createHostPlatform } from './platform-host.js';
import type { ProbeResult } from './probe.js';
import { CUSTODY_NOTE_STASH_KEY, createArtifactRecord, type ArtifactRecord } from './storage/artifactHtml.js';
import { createCustodyStore, type CustodyStore } from './storage/custodyStore.js';

export interface ComposeWindow {
  location: { href: string };
  fetch?: (input: string, init?: { cache?: 'no-store' }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  sessionStorage?: { getItem(key: string): string | null; removeItem(key: string): void };
  /** The terminal act after "load the page's copy". */
  reload?: () => void;
}

export interface ComposeDocument {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
  getElementById(id: string): { textContent: string | null } | null;
  querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null; textContent: string | null }>;
}

export interface Composition {
  platform: SnugPlatform;
  custody: CustodyStore;
  record?: ArtifactRecord;
  pending: { get(): readonly PendingAgentUpdate[]; subscribe(listener: () => void): () => void };
  /** The boot-time hand-in — call once the user db is open. */
  handIn(db: UserDb): Promise<HandInOutcome>;
}

/** How long the first paint waits for the db + hand-in before rendering anyway (a stuck db must still show its recovery UI). */
export const HAND_IN_BEFORE_PAINT_MS = 4_000;

/**
 * Wait for the hand-in, but never longer than `ms`: a db that opens promptly paints with
 * the handed-in apps (the hub reads its list once at mount); a db that cannot open never
 * resolves `getUserDb()`, so past the bound the App renders its recovery surface and the
 * hand-in lands whenever the db does. Resolves `true` when the hand-in finished in time.
 */
export function handInBeforePaint(handIn: Promise<unknown>, ms: number = HAND_IN_BEFORE_PAINT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([handIn.then(() => true, () => true), bound]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function composeHostPlatform(probe: ProbeResult, win: ComposeWindow, doc: ComposeDocument, wasm: Uint8Array): Composition {
  // A working copy in MEMORY (Safari denies third-party storage) is gone with the tab —
  // the chip says so beside the artifact arms (correctness review 14).
  const custody = createCustodyStore(probe.storage.kind === 'memory' ? { workingCopy: 'memory' } : {});
  const stamp = doc.querySelector('meta[name="snug-host-build"]')?.getAttribute('content') ?? 'dev';

  let backend: PersistenceBackend = probe.storage.backend;
  let record: ArtifactRecord | undefined;
  const artifact = probe.host?.artifact;
  if (probe.binding === 'artifact' || probe.binding === 'artifact-static') {
    const blockBody = doc.getElementById('snug-db')?.textContent;
    const pageBlock = blockBody == null ? undefined : parseDbBlockBody(blockBody);
    record = createArtifactRecord({
      bucket: probe.storage.backend,
      pageBlock: pageBlock === undefined ? undefined : pageBlock.corrupt !== undefined ? pageBlock : { ...pageBlock, index: 0, end: 0 },
      canonicalSource: async () => {
        if (win.fetch === undefined) throw new Error('this page cannot read its own source');
        const response = await win.fetch(win.location.href, { cache: 'no-store' });
        if (!response.ok) throw new Error(`the page answered ${response.status}`);
        return response.text();
      },
      expectedStamp: stamp,
      publish: artifact === undefined ? undefined : (html) => artifact.publish(html),
      store: custody,
      ...(win.reload !== undefined ? { onReload: win.reload } : {}),
    });
    backend = record.backend;
  }

  // A publish reloads the view; the note it stashed is rendered once, then dropped.
  try {
    const stashed = win.sessionStorage?.getItem(CUSTODY_NOTE_STASH_KEY);
    if (stashed !== null && stashed !== undefined) {
      custody.patch({ note: stashed });
      win.sessionStorage?.removeItem(CUSTODY_NOTE_STASH_KEY);
    }
  } catch {
    /* no session storage here */
  }

  const custodySeat: CustodySeat = { state: custody, dismissNote: () => custody.patch({ note: undefined }) };
  if (record !== undefined) {
    const r = record;
    custodySeat.loadPageCopy = () => r.loadPageCopy();
    custodySeat.keepBrowserCopy = () => r.keepBrowserCopy();
    // The save act exists only where a save can ever happen: the `artifact` namespace
    // resolved. A static page carries the record (it seeds from the block) but no act.
    if (artifact !== undefined) {
      custodySeat.save = async () => {
        const outcome = await r.publish();
        return outcome.ok ? { ok: true, message: `saved to this artifact (save #${outcome.saved})` } : { ok: false, message: outcome.message };
      };
      custodySeat.canSave = () => r.canSave();
    }
  }

  // The ONE seat for offered updates — the runner's composition makes the same one (K4).
  const handIns = createHandInSeat();

  const platform = createHostPlatform(probe, wasm, {
    userdbBackend: backend,
    custody: custodySeat,
    saveFile: createExportSeat({ downloads: probe.host?.downloads, store: custody }),
    agentHandIns: handIns.seat,
  });

  return {
    platform,
    custody,
    ...(record !== undefined ? { record } : {}),
    pending: handIns.seat.pending,
    async handIn(db) {
      // The page's embedded blocks through the ONE core, under Binding A's rule: a block
      // rides the page and is read again on every load, so an app the user deleted stays
      // deleted (no `explicit`).
      const outcome = await applyAgentBundles(db, readBundleBlocksFromDocument(doc));
      handIns.absorb(db, outcome);
      return outcome;
    },
  };
}
