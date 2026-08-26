// AppUpdateControls — the shell update channel's offer surfaces (ADR-0047 §§3,5,9;
// TASK-20260821 AC13). Renders NOTHING unless the platform supplies `appUpdates`
// (desktop only) AND an update is actually in play — the chip is a header whisper,
// never a gate (lessons 2026-08-20: prominence that blocks is a modal with extra
// steps). The one blocking surface is the sheet the USER opens by clicking it.
//
// NOTES TRUST (ADR-0047 §5): the minisign signature covers the update ARTIFACT only.
// Everything this sheet renders about a NEWER version — the fetched
// desktop-releases.json entries, the manifest's `notes` string — is TLS-trusted
// display data from an account that could be compromised without the signature
// failing. So: plain text only, no linkification, versions syntax-gated by the
// parser, and the copy never asks the user to go somewhere or type something.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { getPlatform } from '../platform/platform.js';
import {
  downloadAndInstallAppUpdate,
  relaunchForAppUpdate,
  useAppUpdate,
} from '../state/appUpdate.js';
import { Button } from '../ui/Button.js';
import { ConfirmOverlay } from '../ui/ConfirmOverlay.js';
import {
  bundledDesktopReleases,
  compareSemver,
  parseDesktopReleases,
  type DesktopRelease,
} from './desktopReleases.js';
import { DESKTOP_RELEASE_NOTES_URL } from './releaseChannel.js';

/**
 * The header chip + the sheet it opens. Mounted once in App's header nav; owns the
 * open/closed state locally (a reload closing the sheet is fine — the offer state
 * itself lives in the appUpdate store and survives navigation).
 */
export function AppUpdateSurface(): ReactElement | null {
  const state = useAppUpdate();
  const [open, setOpen] = useState(false);
  if (getPlatform().appUpdates === undefined) return null;
  const offer =
    state.phase === 'available' || state.phase === 'downloading' || state.phase === 'ready-to-restart'
      ? state.offer
      : undefined;
  if (offer === undefined) return null;
  return (
    <>
      <button
        type="button"
        className="auth-repair-chip app-update-chip"
        data-testid="app-update-chip"
        onClick={() => setOpen(true)}
      >
        {state.phase === 'ready-to-restart' ? '↻ restart to update' : `↑ update · v${offer.version}`}
      </button>
      {open ? <AppUpdateSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * Fetched release notes for the sheet: the release's own desktop-releases.json asset,
 * read through the platform's native fetch (the webview would hit CORS; the surface
 * only exists on desktop, where fetchImpl is the shell's). Failure degrades to the
 * manifest's plain-text notes, then to an honest "no notes" line — never an error
 * state: the notes are garnish on a decision the version line already supports.
 */
async function fetchReleaseNotes(): Promise<DesktopRelease[] | undefined> {
  try {
    const impl = getPlatform().fetchImpl ?? fetch;
    const res = await impl(DESKTOP_RELEASE_NOTES_URL);
    if (!res.ok) return undefined;
    return parseDesktopReleases(await res.text());
  } catch {
    return undefined;
  }
}

export function AppUpdateSheet({ onClose }: { onClose: () => void }): ReactElement | null {
  const state = useAppUpdate();
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const [fetched, setFetched] = useState<DesktopRelease[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void getPlatform()
      .appUpdates?.currentVersion()
      .then((v) => {
        if (!cancelled) setCurrent(v);
      });
    void fetchReleaseNotes().then((releases) => {
      if (!cancelled) setFetched(releases);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const offer =
    state.phase === 'available' || state.phase === 'downloading' || state.phase === 'ready-to-restart'
      ? state.offer
      : undefined;
  if (offer === undefined) return null;

  // ONLY what is newer than the running version (TASK-20260826, owner decision). Until
  // 2026-08-26 the bundled history rode beneath the new entry "Tesla-style", which
  // rendered the INSTALLED release's own "Good to know" as if it were news — on a v0.1.0
  // install offered v0.1.1 the sheet said "macOS only through 1.0…", a line about the
  // version already running. History lives on the web /download page, not here.
  // Fetched entries first; the bundled file (this build's trusted copy) contributes any
  // NEWER entry the fetch omitted — the union the old code kept, so a partial fetched
  // notes file never hides a version the user is also about to receive.
  const newerThanCurrent = (release: DesktopRelease): boolean =>
    current === undefined || compareSemver(release.version, current) > 0;
  const fetchedNewer = (fetched ?? []).filter(newerThanCurrent);
  const entries: DesktopRelease[] = [
    ...fetchedNewer,
    ...(bundledDesktopReleases() ?? [])
      .filter(newerThanCurrent)
      .filter((release) => !fetchedNewer.some((n) => n.version === release.version)),
  ].sort((a, b) => compareSemver(b.version, a.version));

  // Through ConfirmOverlay, which PORTALS to <body> (TASK-20260826 AC1 — the header's
  // backdrop-filter would otherwise confine this fixed overlay to the header's box).
  return (
    <ConfirmOverlay ariaLabel="desktop update" cardClassName="release-notes-card">
        <div className="release-notes-head">
          <h2 className="net-confirm-title">
            update to v{offer.version}
            {current !== undefined ? ` (you're on v${current})` : ''}
          </h2>
          <Button variant="ghost" aria-label="close update sheet" onClick={onClose}>
            ✕ close
          </Button>
        </div>
        <div className="release-notes-scroll">
          {entries.length === 0 ? (
            <p className="hint">
              {offer.notes !== undefined && offer.notes !== ''
                ? offer.notes
                : 'no release notes available for this version.'}
            </p>
          ) : (
            entries.map((entry) => (
              <section key={entry.version} className="release-entry">
                <div className="release-entry-head">
                  <h3 className="release-entry-title">
                    v{entry.version}
                    {entry.title !== undefined ? ` — ${entry.title}` : ''}
                  </h3>
                  <span className="release-entry-date">{entry.date}</span>
                  {current !== undefined && entry.version === current ? (
                    <span className="release-tag" data-testid={`app-release-installed-v${entry.version}`}>
                      installed
                    </span>
                  ) : current !== undefined && compareSemver(entry.version, current) > 0 ? (
                    <span className="release-tag release-tag-new" data-testid={`app-release-new-v${entry.version}`}>
                      new
                    </span>
                  ) : null}
                </div>
                {entry.sections.map((section) => (
                  <div key={section.title} className="release-section">
                    <h4 className="release-section-title">{section.title}</h4>
                    <ul className="release-section-items">
                      {section.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            ))
          )}
        </div>
        <div className="field-row net-confirm-actions">
          <Button variant="ghost" onClick={onClose}>
            later
          </Button>
          {state.phase === 'available' ? (
            <Button variant="primary" data-testid="app-update-install" onClick={() => void downloadAndInstallAppUpdate()}>
              update now
            </Button>
          ) : state.phase === 'downloading' ? (
            <Button variant="primary" disabled>
              downloading{state.progress !== undefined ? ` ${Math.round(state.progress * 100)}%` : '…'}
            </Button>
          ) : (
            <Button variant="primary" data-testid="app-update-restart" onClick={() => void relaunchForAppUpdate()}>
              restart Snug
            </Button>
          )}
        </div>
    </ConfirmOverlay>
  );
}
