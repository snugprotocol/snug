// DownloadView — the desktop download page (ADR-0047 §§1,7; TASK-20260821 AC12).
//
// The web hub IS the landing page (AL-15 stays held), so this is where "get the
// desktop app" lives: the current version, its Tesla-style notes (rendered from the
// BUNDLED desktop-releases.json — this build's own trusted copy, no fetch), the
// macOS-only truth (ADR-0021 D8: the Windows WebView cannot hold the C2 sandbox
// promise, so we don't ship there), and — while builds are unsigned — the honest
// Gatekeeper paragraph. When the owner's Apple Developer ID lands, the release
// pipeline signs/notarizes and that paragraph comes out (ADR-0047 §7).
//
// On the desktop shell the page renders a short "you're already here" note instead
// of a download button — offering the DMG to someone inside the DMG is noise.

import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { getPlatform } from '../platform/platform.js';
import { newestBundledRelease } from '../desktop/desktopReleases.js';
import { DESKTOP_DOWNLOAD_URL, DESKTOP_RELEASES_PAGE_URL } from '../desktop/releaseChannel.js';

export function DownloadView(): ReactElement {
  const release = newestBundledRelease();
  const onDesktop = getPlatform().kind === 'desktop';

  if (onDesktop) {
    return (
      <div className="download-page" data-testid="download-page-desktop">
        <h1>Snug for macOS</h1>
        <p>
          you&apos;re already running the desktop app{release !== undefined ? ` — this download page serves the web hub` : ''}.
          updates arrive right here: Settings checks for them, and a chip appears in the header when one is ready.
        </p>
        <p>
          <Link to="/settings">open settings</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="download-page" data-testid="download-page">
      <h1>Snug for macOS</h1>
      <p className="download-tagline">
        your apps, your data, one portable file — with native networking the browser can&apos;t offer: connected apps
        reach your own providers and devices directly, and your <code>.snug</code> file lives in <code>~/Snug</code>.
      </p>

      <p>
        {/* target=_blank on a file URL still downloads; what it buys is the pre-flip
            case — the URL 404s anonymously until the first release, and a same-tab
            404 would navigate the playground away (owner call, 2026-08-23). */}
        <a
          className="btn btn-primary download-button"
          href={DESKTOP_DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
          data-testid="download-dmg"
        >
          download for macOS{release !== undefined ? ` — v${release.version}` : ''}
        </a>
      </p>

      <p className="hint">
        macOS only for now — deliberately. the Windows WebView cannot yet hold the app-sandbox promise Snug is built
        on, so we don&apos;t ship a build we can&apos;t stand behind (it returns when that changes).
      </p>

      <p className="hint" data-testid="gatekeeper-note">
        current builds are not yet notarized with Apple: the first launch needs a right-click → <strong>Open</strong>{' '}
        (once, then macOS remembers). signed builds are coming; nothing else changes.
      </p>

      {release !== undefined ? (
        <section className="release-entry" data-testid="download-release-notes">
          <div className="release-entry-head">
            <h2 className="release-entry-title">
              v{release.version}
              {release.title !== undefined ? ` — ${release.title}` : ''}
            </h2>
            <span className="release-entry-date">{release.date}</span>
          </div>
          {release.sections.map((section) => (
            <div key={section.title} className="release-section">
              <h3 className="release-section-title">{section.title}</h3>
              <ul className="release-section-items">
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}

      <p className="hint">
        all releases:{' '}
        <a href={DESKTOP_RELEASES_PAGE_URL} target="_blank" rel="noreferrer">
          github.com/snugprotocol/snug/releases
        </a>
        . once installed,
        the app offers its own updates — always your call, never automatic.
      </p>
    </div>
  );
}
