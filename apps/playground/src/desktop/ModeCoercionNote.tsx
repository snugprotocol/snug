// ModeCoercionNote — the small dismissible banner for a hydrated-mode coercion (TASK-20260812
// P3 item 2; the named mode TASK-20261023-siwc-chatgpt-plan §12 L5-2). It renders only after
// hydrateSettings actually coerced the ACTIVE mode on a platform that cannot run the stored one —
// a hub subscription where there is no hub, the ChatGPT plan where there is no custody seat; the
// stored file value stays untouched, and this note is the honest trace of that difference. The
// copy names WHICH mode the file asked for: a file that asked for the ChatGPT plan must not be told
// it asked for a hub subscription. Dismissal is session-local on purpose: the divergence is real
// every time this file opens on this computer, so silencing it forever would hide a fact that
// stays true.

import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { allows } from '../platform/platform.js';
import { dismissModeCoercionNote, useCoercedFromMode, useModeCoerced } from '../state/mode.js';

export function ModeCoercionNote(): ReactElement | null {
  const coerced = useModeCoerced();
  const from = useCoercedFromMode();
  // The note points at the brain section; where that section does not exist (the host
  // kit, D15) the divergence has no user action, so the note renders nothing.
  if (!coerced || !allows('brainSettings')) return null;
  const asked =
    from === 'chatgpt'
      ? "your file asked for your ChatGPT plan, which this app can't sign in to here."
      : "your file asked for a hub subscription, which isn't part of the desktop app.";
  return (
    <div
      role="status"
      className="hint"
      data-testid="mode-coercion-note"
      style={{ margin: 'var(--space-3) var(--space-3) 0' }}
    >
      This computer uses its own AI settings — {asked} Pick how apps think in <Link to="/settings">settings</Link>.{' '}
      <button type="button" className="btn btn-ghost" onClick={() => dismissModeCoercionNote()}>
        got it
      </button>
    </div>
  );
}
