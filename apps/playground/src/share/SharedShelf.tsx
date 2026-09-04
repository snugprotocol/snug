// SharedShelf.tsx — the hub's "shared with you" section (TASK-20260904, AC12).
//
// One card per bundle on the shelf, in the app-tile shape the starters use, each with a
// `shared` badge, a dismiss control, and — when the lineage is already in the user's
// file — `installed` (opens the copy) or `update` (opens the copy; the update act is in
// its header). Reports only: nothing here writes the user file except dismiss, which
// removes a row the user explicitly kept. Text nodes throughout (AC16): the bundle's
// name, emoji and description render as text, never as markup.

import type { CSSProperties, ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { sharedBundleSettingKey, shareInstallSource } from '@snugprotocol/db';
import { useEffect, useState } from 'react';

import { getUserDb } from '../state/userdb.js';
import { useStore } from '../state/store.js';
import { Card } from '../ui/Card.js';
import { Button } from '../ui/Button.js';
import { removeSharedEntry, sharedInboxNoteStore, sharedInboxStore, sharedRouteIdFor, type SharedEntry } from './sharedInbox.js';

export interface SharedShelfProps {
  /** install_source → appId, the hub's dedup map. */
  installedBySource: ReadonlyMap<string, string>;
}

function receivedLabel(entry: SharedEntry): string {
  const via = entry.source === 'link' ? 'from a link' : entry.source === 'settings' ? 'from a file you added' : 'from a file';
  return entry.kept ? via : `${via} · not kept yet`;
}

export function SharedShelf({ installedBySource }: SharedShelfProps): ReactElement | null {
  const entries = useStore(sharedInboxStore);
  const note = useStore(sharedInboxNoteStore);
  const navigate = useNavigate();
  // Which installed copies are BEHIND their shelf bundle (identity, never bytes).
  const [installedIds, setInstalledIds] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void getUserDb().then((db) => {
      if (cancelled) return;
      const next = new Map<string, string>();
      for (const entry of entries) {
        const appId = installedBySource.get(shareInstallSource(entry.bundle.lineage));
        if (appId === undefined) continue;
        const current = db.getSetting(sharedBundleSettingKey(appId));
        next.set(entry.bundleId, typeof current === 'string' ? current : '');
      }
      setInstalledIds(next);
    });
    return () => {
      cancelled = true;
    };
  }, [entries, installedBySource]);

  if (entries.length === 0 && note === null) return null;

  return (
    <>
      <h2 className="section-title">shared with you</h2>
      {note !== null ? (
        <div className="hint" role="status" data-testid="shared-shelf-note">
          {note}
        </div>
      ) : null}
      {entries.length === 0 ? null : (
        <div className="tile-grid" data-testid="shared-shelf">
          {entries.map((entry) => {
            const app = entry.bundle.app;
            const installedAppId = installedBySource.get(shareInstallSource(entry.bundle.lineage));
            const installed = installedAppId !== undefined;
            const updateAvailable = installed && installedIds.get(entry.bundleId) !== entry.bundleId;
            const style = { '--tile-color': app.iconColor ?? 'var(--ember)' } as CSSProperties;
            // An available UPDATE opens the PREVIEW, not the installed copy (Gate-5
            // finding 1): the new bundle's docs and contract are readable only there,
            // and the update act lives in that preview's header.
            const target = installed && !updateAvailable ? `/run/${installedAppId}` : `/run/${sharedRouteIdFor(entry.bundleId)}`;
            return (
              <Card key={entry.bundleId} interactive className="app-tile" style={style} data-testid="shared-tile" data-shared-name={app.displayName}>
                {installed ? (
                  updateAvailable ? (
                    <span className="tile-update-badge" data-testid="shared-update-badge">
                      update
                    </span>
                  ) : (
                    <span className="tile-installed-badge">installed</span>
                  )
                ) : (
                  <span className="tile-shared-badge" data-testid="shared-badge">
                    shared
                  </span>
                )}
                <button
                  type="button"
                  className="tile-link tile-card-button"
                  data-testid={installed && !updateAvailable ? 'shared-open-installed' : 'shared-open-card'}
                  onClick={() => navigate(target)}
                  aria-label={`open ${app.displayName}`}
                  title={
                    installed
                      ? updateAvailable
                        ? `preview the newer shared version of ${app.displayName} — read it, then update your copy`
                        : `open your copy of ${app.displayName}`
                      : `open ${app.displayName} — it stays read-only until you install it`
                  }
                >
                  <span className="tile-emoji" aria-hidden="true">
                    {app.iconEmoji ?? '⬡'}
                  </span>
                  <span className="tile-name">{app.displayName}</span>
                  <span className="tile-sub">
                    {app.description !== undefined && app.description !== '' ? `${app.description} — ` : ''}
                    {receivedLabel(entry)}
                    {installed ? (updateAvailable ? ' — a newer version: preview it, then update your copy' : ' — already in your snug file') : ' — try it first, install it if you like it'}
                  </span>
                </button>
                <div className="tile-actions">
                  <Button
                    variant="ghost"
                    data-testid="shared-dismiss"
                    aria-label={`dismiss ${app.displayName}`}
                    title="remove this shared app from your shelf (the person who shared it can send it again)"
                    onClick={() => void removeSharedEntry(entry.bundleId)}
                  >
                    ✕
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
