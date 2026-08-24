import type { AnchorHTMLAttributes, MouseEvent, ReactElement } from 'react';

import { getPlatform } from '../platform/platform.js';

/**
 * An off-site link that behaves on both surfaces (TASK-20260823-legal-terms-privacy-eula).
 *
 * Web: a plain new-tab anchor. Desktop: the click prefers the platform's
 * side-effect-free system-browser seat (`openExternalUrl` — NOT `oauth.openExternal`,
 * which binds a pending OAuth flow's loopback listener as its last pre-open step; Gate-5
 * finding, TASK-20260822), because a bare href would navigate the Tauri webview away
 * from the app. The href stays either way so the link is honest on hover and to
 * assistive tech.
 */
export function ExternalLink({
  href,
  children,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }): ReactElement {
  const openViaPlatform = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    const opener = getPlatform().openExternalUrl;
    if (opener !== undefined) {
      event.preventDefault();
      void opener(href);
    }
  };
  return (
    <a href={href} target="_blank" rel="noreferrer" onClick={openViaPlatform} {...rest}>
      {children}
    </a>
  );
}
