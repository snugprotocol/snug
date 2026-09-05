// compose.ts — the kit's composition root (TASK-20260905-binding-a-artifacts): from the
// probe's answers and the page, the seats the platform carries. Pure over injected window /
// document slices so every binding's wiring is tested without a browser; `main.tsx` calls
// it once and renders.
//
//   artifact / artifact-static → the artifact-html RECORD over the probed bucket (seeded
//       from the page's `snug-db` block; the save act only where `artifact` resolved), the
//       custody seat, the export seat over `downloads` (or the copy path).
//   artifact-chat             → `window.storage` as the file's home when the viewer has it
//       (else the bucket), no save act (storage IS the durable copy), the copy export.
//   local-host / file         → the bucket, the custody chip's plain-file copy, the copy export.
//
// The hand-in runs AFTER the user db opens (`handIn(db)`), never before: it installs and
// updates through the db, and pending (edited-copy) hand-ins are offered through the
// run header's seat.

import { type PersistenceBackend, type UserDb } from '@snugprotocol/db';

import type { AgentHandInSeat, CustodySeat, PendingAgentUpdate, SnugPlatform } from '@playground/platform/platform';
import { createStore, type Store } from '@playground/state/store';

import { readDbBlock } from '../../../scripts/lib/page-blocks.mjs';
import { createExportSeat } from './exportSeat.js';
import { applyPendingHandIn, handInFromPage, readBundleBlocksFromDocument, type HandInOutcome, type PendingHandIn } from './handin.js';
import { createHostPlatform } from './platform-host.js';
import type { ProbeResult } from './probe.js';
import { CUSTODY_NOTE_STASH_KEY, createArtifactRecord, type ArtifactRecord } from './storage/artifactHtml.js';
import { createCustodyStore, type CustodyStore } from './storage/custodyStore.js';
import { createWindowStorageBackend, type WindowStorageLike } from './storage/windowStorage.js';

export interface ComposeWindow {
  location: { href: string };
  fetch?: (input: string, init?: { cache?: 'no-store' }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  sessionStorage?: { getItem(key: string): string | null; removeItem(key: string): void };
  /** The chat viewer's flat storage, when present. */
  storage?: unknown;
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
  pending: Store<readonly PendingAgentUpdate[]>;
  /** The boot-time hand-in — call once the user db is open. */
  handIn(db: UserDb): Promise<HandInOutcome>;
}

const isWindowStorage = (value: unknown): value is WindowStorageLike => {
  const s = value as Partial<WindowStorageLike> | null;
  return typeof s?.get === 'function' && typeof s.set === 'function' && typeof s.delete === 'function' && typeof s.list === 'function';
};

export function composeHostPlatform(probe: ProbeResult, win: ComposeWindow, doc: ComposeDocument, wasm: Uint8Array): Composition {
  const custody = createCustodyStore();
  const stamp = doc.querySelector('meta[name="snug-host-build"]')?.getAttribute('content') ?? 'dev';

  let backend: PersistenceBackend = probe.storage.backend;
  let record: ArtifactRecord | undefined;
  if (probe.binding === 'artifact' || probe.binding === 'artifact-static') {
    const blockBody = doc.getElementById('snug-db')?.textContent;
    const pageBlock = blockBody == null ? undefined : readDbBlock(`<script type="text/plain" id="snug-db">${blockBody}</script>`);
    const artifact = probe.host?.artifact;
    record = createArtifactRecord({
      bucket: probe.storage.backend,
      pageBlock,
      canonicalSource: async () => {
        if (win.fetch === undefined) throw new Error('this page cannot read its own source');
        const response = await win.fetch(win.location.href, { cache: 'no-store' });
        if (!response.ok) throw new Error(`the page answered ${response.status}`);
        return response.text();
      },
      expectedStamp: stamp,
      publish: artifact === undefined ? undefined : (html) => artifact.publish(html),
      store: custody,
    });
    backend = record.backend;
  } else if (probe.binding === 'artifact-chat' && isWindowStorage(win.storage)) {
    backend = createWindowStorageBackend(win.storage);
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

  const custodySeat: CustodySeat = {
    state: custody,
    dismissNote: () => custody.patch({ note: undefined }),
    // The save act exists only where a save can ever happen: the `artifact` namespace
    // resolved. A static page carries the record (it seeds from the block) but no act.
    ...(record !== undefined && probe.host?.artifact !== undefined
      ? {
          save: async () => {
            const outcome = await record!.publish();
            return outcome.ok ? { ok: true, message: `saved to this artifact (save #${outcome.saved})` } : { ok: false, message: outcome.message };
          },
          canSave: () => record!.canSave(),
        }
      : {}),
    ...(record !== undefined
      ? {
          loadPageCopy: () => record!.loadPageCopy(),
          keepBrowserCopy: () => record!.keepBrowserCopy(),
        }
      : {}),
  };

  const pending = createStore<readonly PendingAgentUpdate[]>([]);
  const pendingByApp = new Map<string, PendingHandIn>();
  let dbForApply: UserDb | undefined;
  const agentHandIns: AgentHandInSeat = {
    pending,
    async apply(appId) {
      const entry = pendingByApp.get(appId);
      if (entry === undefined || dbForApply === undefined) throw new Error('nothing is pending for this app');
      const result = await applyPendingHandIn(dbForApply, entry);
      pendingByApp.delete(appId);
      pending.set([...pendingByApp.values()].map((p) => ({ appId: p.appId, displayName: p.displayName, bundleId: p.bundleId })));
      return result;
    },
  };

  const platform = createHostPlatform(probe, wasm, {
    userdbBackend: backend,
    custody: custodySeat,
    saveFile: createExportSeat({ downloads: probe.host?.downloads, store: custody }),
    agentHandIns,
  });

  return {
    platform,
    custody,
    ...(record !== undefined ? { record } : {}),
    pending,
    async handIn(db) {
      dbForApply = db;
      const outcome = await handInFromPage(db, readBundleBlocksFromDocument(doc));
      for (const p of outcome.pending) pendingByApp.set(p.appId, p);
      pending.set(outcome.pending.map((p) => ({ appId: p.appId, displayName: p.displayName, bundleId: p.bundleId })));
      return outcome;
    },
  };
}
