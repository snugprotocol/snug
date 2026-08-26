/**
 * ConfirmOverlay — the `net-confirm-overlay` / `net-confirm-card` pair, ALWAYS portaled to
 * `<body>` (TASK-20260826 AC1). `.shell-header` carries `backdrop-filter`, which makes it the
 * containing block for `position: fixed` descendants (WebKit and Chromium alike): an overlay
 * rendered in place from a header chip is the size of the header, and its card sits
 * "chopped off at the top centre" — the owner's report, reproduced by screenshot. No CSS on
 * the card can fix a containing block; only rendering outside the header can, so the portal
 * lives HERE, once, rather than as a convention at every call site.
 */
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function ConfirmOverlay({
  ariaLabel,
  cardClassName,
  children,
  'data-testid': testId,
}: {
  ariaLabel: string;
  cardClassName?: string;
  children: ReactNode;
  'data-testid'?: string;
}): ReactElement {
  return createPortal(
    <div className="net-confirm-overlay" role="dialog" aria-modal="true" aria-label={ariaLabel} data-testid={testId}>
      <div className={cardClassName === undefined ? 'net-confirm-card' : `net-confirm-card ${cardClassName}`}>{children}</div>
    </div>,
    document.body,
  );
}
