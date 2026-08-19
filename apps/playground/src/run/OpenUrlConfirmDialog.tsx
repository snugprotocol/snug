// OpenUrlConfirmDialog — the open-url human gate (ADR-0038 D5, TASK-20260818 Phase C).
//
// SECURITY SHAPE (review SF8, all four pinned by test):
//  1. PROVENANCE COPY — the URL came from the APP (often from an LLM lane inside it);
//     Snug has not checked it, and the copy says so before anyone signs in anywhere.
//  2. PUNYCODE HOST on the confirm button — `new URL(...).hostname` is already the
//     toASCII form (the URL parser normalizes IDN), so a homograph host renders as its
//     `xn--` self, never as the brand it imitates.
//  3. SYNCHRONOUS OPEN — `window.open` runs inside the click handler with no await
//     between gesture and open, which is what escapes popup blockers; desktop routes
//     the same gesture through the shell's https-only system opener.
//  4. 'noopener,noreferrer' — the opened page gets no window handle and no referrer.
import type { ReactElement } from 'react';

import { openUrlConfirmStore, resolveOpenUrlConfirm } from '../state/openUrl.js';
import { useStore } from '../state/store.js';
import { getPlatform } from '../platform/platform.js';
import { Button } from '../ui/Button.js';

export function OpenUrlConfirmDialog(): ReactElement | null {
  const pending = useStore(openUrlConfirmStore);
  if (pending === null) return null;

  let host = '';
  let normalizedUrl = '';
  try {
    const parsed = new URL(pending.url);
    host = parsed.hostname;
    // Render the NORMALIZED href, never the raw frame bytes: the URL parser stores the
    // toASCII host, so a homograph URL displays as its xn-- self in the full-URL line
    // exactly as it does on the button.
    normalizedUrl = parsed.href;
  } catch {
    // The runner validated the frame, so this cannot happen — but a dialog must never
    // render a confirm for a URL it cannot even name.
    resolveOpenUrlConfirm('declined');
    return null;
  }

  const confirm = (): void => {
    // OPEN FIRST, INSIDE THE GESTURE — then resolve. The order is the popup-blocker
    // contract; an await between the click and the open would re-classify the open as
    // scripted and lose the gesture token.
    const platformOauth = getPlatform().oauth;
    if (platformOauth !== undefined) {
      void platformOauth.openExternal(pending.url);
    } else {
      window.open(pending.url, '_blank', 'noopener,noreferrer');
    }
    resolveOpenUrlConfirm('opened');
  };

  return (
    <div className="net-confirm-overlay" role="dialog" aria-modal="true" aria-label="confirm opening a link">
      <div className="net-confirm-card">
        <h2 className="net-confirm-title">this app wants to open a website</h2>
        <p className="net-confirm-body" data-testid="open-url-provenance">
          <code>{pending.appId}</code> asked to open this address — <strong>Snug hasn&apos;t checked it</strong>. It
          will open in your browser, signed out, with nothing shared. Sign in there only if you&apos;re sure it&apos;s
          your provider&apos;s real site.
        </p>
        <p className="net-confirm-body">
          <code data-testid="open-url-full">{normalizedUrl}</code>
        </p>
        <div className="net-confirm-actions">
          <Button variant="primary" data-testid="open-url-confirm" onClick={confirm}>
            open {host}
          </Button>
          <Button data-testid="open-url-decline" onClick={() => resolveOpenUrlConfirm('declined')}>
            don&apos;t open it
          </Button>
        </div>
      </div>
    </div>
  );
}
