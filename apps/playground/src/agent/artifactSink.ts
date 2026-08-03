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
}

export interface CreateAppTargetSinkOptions {
  /** Per-app chat: the app every write versions. Absent → builder-thread rule. */
  pinnedAppId?: string;
  /** Injectable for tests; defaults to the page user DB. */
  getDb?: () => Promise<UserDb>;
}

export function createAppTargetSink(options: CreateAppTargetSinkOptions = {}): ArtifactSink {
  const getDb = options.getDb ?? getUserDb;
  /** Builder-thread pin: set by the first write, versions from then on. */
  let threadTarget: string | undefined;

  return {
    async write(html, title) {
      const db = await getDb();
      const target = options.pinnedAppId ?? threadTarget;

      if (target !== undefined) {
        const existing = db.getApp(target);
        if (existing !== undefined) {
          const meta = db.saveAppVersion(target, html, title);
          const record = db.getApp(target);
          return { id: target, displayName: record?.displayName ?? existing.displayName, version: meta.version };
        }
        // Pinned id with no row yet (e.g. chat alongside a never-installed preview):
        // install UNDER the pinned id so the chat and the app agree on identity.
        const installed = db.installApp({ appId: target, displayName: deriveDisplayName(html, title), html });
        return { id: installed.appId, displayName: installed.displayName, version: 1 };
      }

      const installed = db.installApp({ displayName: deriveDisplayName(html, title), html });
      threadTarget = installed.appId;
      return { id: installed.appId, displayName: installed.displayName, version: 1 };
    },
  };
}
