// artifactSink.ts — WHERE an artifact_write lands (child 3, plan F4/F9). Every chat
// surface owns a sink that pins the target app HOST-SIDE (the tool schema carries no
// app id — the model never chooses the target):
//   per-app chat  → pinned to that app; every write is a new version of it.
//   builder thread → the thread's first write installs a NEW app and pins it; later
//                    writes in the same thread version that app. New app = new thread
//                    (the defined escape hatch).
// Works identically for byok/local (tool runs in-page) and subscription mode (the
// client fetches the artifact HTML on the SSE event and pushes it through the same
// sink — the user DB is the source of truth in every mode).

import type { UserDb } from '@snugprotocol/db';

import { deriveDisplayName } from '../state/library.js';
import { getUserDb } from '../state/userdb.js';

export interface ArtifactWriteResult {
  /** User-DB app id (the runnable /run/:id identity). */
  id: string;
  displayName: string;
  version: number;
}

export interface ArtifactSink {
  write(html: string, title?: string): Promise<ArtifactWriteResult>;
  /**
   * The app id every write/tool call in this surface targets. For a builder thread this
   * MINTS (and latches) the id before the first write, so schema/doc tools can run
   * schema-first — the eventual first artifact write installs under the same id.
   */
  ensureTargetId(): Promise<string>;
}

export interface CreateAppTargetSinkOptions {
  /** Per-app chat: the app every write versions. Absent → builder-thread rule. */
  pinnedAppId?: string;
  /**
   * Durable builder-thread pin (review F10): the app id the thread's row already
   * records. A resumed thread versions the SAME app instead of installing a duplicate.
   */
  initialTargetId?: string;
  /** Fired when a write INSTALLS (v1) — the caller persists the thread→app pin. */
  onInstall?: (appId: string) => void;
  /** Injectable for tests; defaults to the page user DB. */
  getDb?: () => Promise<UserDb>;
}

export function createAppTargetSink(options: CreateAppTargetSinkOptions = {}): ArtifactSink {
  const getDb = options.getDb ?? getUserDb;
  /**
   * Builder-thread target id, latched SYNCHRONOUSLY on first need (umbrella review
   * minor 7): concurrent writes racing an unpinned sink must not install two apps.
   * The id may exist BEFORE the app row does (schema-first building); the first
   * artifact write then installs under it, and any writer that finds no row after the
   * await installs synchronously — later continuations see the row and version it.
   */
  let threadTargetId: Promise<string> | undefined =
    options.initialTargetId !== undefined ? Promise.resolve(options.initialTargetId) : undefined;

  const ensureThreadTargetId = (): Promise<string> => {
    threadTargetId ??= Promise.resolve(crypto.randomUUID());
    return threadTargetId;
  };

  return {
    ensureTargetId() {
      if (options.pinnedAppId !== undefined) return Promise.resolve(options.pinnedAppId);
      return ensureThreadTargetId();
    },

    async write(html, title) {
      const db = await getDb();
      const targetId = options.pinnedAppId ?? (await ensureThreadTargetId());

      const existing = db.getApp(targetId);
      if (existing !== undefined) {
        const meta = db.saveAppVersion(targetId, html, title);
        const record = db.getApp(targetId);
        return { id: targetId, displayName: record?.displayName ?? existing.displayName, version: meta.version };
      }
      // No row yet (fresh builder thread, schema-first pre-pin, or a pinned chat
      // alongside a never-installed preview): install UNDER the target id so chat,
      // schema, docs, and app all agree on identity. Synchronous after the awaits
      // above, so a concurrent second write sees the row and versions it.
      const installed = db.installApp({ appId: targetId, displayName: deriveDisplayName(html, title), html });
      options.onInstall?.(installed.appId);
      return { id: installed.appId, displayName: installed.displayName, version: 1 };
    },
  };
}
