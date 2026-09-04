// ShareLinkPanel.tsx — the link transport inside the share sheet (phase 2 of
// TASK-20260904-app-sharing, ADR-0064). Rendered ONLY when a relay origin is configured
// (`SHARE_RELAY_ORIGIN`); a build without one — self-hosters, the desktop shell before
// the relay exists — shows no copy-link action at all, so the attachment path never
// depends on a hosted surface.

import type { ReactElement } from 'react';

import { SHARE_RELAY_ORIGIN } from '../config/site.js';
import type { PreparedShare } from './exportShare.js';

export function shareLinksAvailable(): boolean {
  return SHARE_RELAY_ORIGIN !== '';
}

export interface ShareLinkPanelProps {
  appId: string;
  prepared: PreparedShare;
  disabled: boolean;
}

// Phase 2 fills this in (encrypt → upload → link with copy + active links + revoke).
export function ShareLinkPanel(_props: ShareLinkPanelProps): ReactElement | null {
  return null;
}
