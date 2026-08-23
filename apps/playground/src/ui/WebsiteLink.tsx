import type { MouseEvent, ReactElement } from 'react';

import { WEBSITE_URL } from '../config/site.js';
import { getPlatform } from '../platform/platform.js';

/**
 * Shell-nav link back to the public website (TASK-20260821-site-playground-polish
 * AC2). One component serves both surfaces: on web it is a plain new-tab anchor; on
 * the desktop shell the click prefers the platform's system-browser opener — a bare
 * href would navigate the Tauri webview away from the app (the DesktopWelcome
 * pattern). The href stays either way so the link is honest on hover and to
 * assistive tech.
 */
export function WebsiteLink(): ReactElement {
  const openViaPlatform = (event: MouseEvent<HTMLAnchorElement>): void => {
    const opener = getPlatform().oauth?.openExternal;
    if (opener !== undefined) {
      event.preventDefault();
      void opener(WEBSITE_URL);
    }
  };

  return (
    <a
      className="nav-link"
      href={WEBSITE_URL}
      target="_blank"
      rel="noreferrer"
      // Short label (owner call, TASK-20260822 — the 16-char domain crowded the
      // header); the domain stays discoverable via tooltip + accessible name.
      title="snugprotocol.org — about Snug"
      aria-label="about — snugprotocol.org"
      onClick={openViaPlatform}
    >
      about ↗
    </a>
  );
}
