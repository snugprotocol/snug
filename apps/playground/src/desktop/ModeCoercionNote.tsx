// ModeCoercionNote — the small dismissible banner for a hydrated-subscription
// coercion (TASK-20260812 P3 item 2). It renders only after hydrateSettings actually
// coerced the ACTIVE mode on a platform without subscription capability; the stored
// file value stays untouched, and this note is the honest trace of that difference.
// Dismissal is session-local on purpose: the divergence is real every time this file
// opens on this computer, so silencing it forever would hide a fact that stays true.

import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { dismissModeCoercionNote, useModeCoerced } from '../state/mode.js';

export function ModeCoercionNote(): ReactElement | null {
  const coerced = useModeCoerced();
  if (!coerced) return null;
  return (
    <div
      role="status"
      className="hint"
      data-testid="mode-coercion-note"
      style={{ margin: 'var(--space-3) var(--space-3) 0' }}
    >
      This computer uses its own AI settings — your file asked for a hub subscription, which isn&apos;t part of the
      desktop app. Pick how apps think in <Link to="/settings">settings</Link>.{' '}
      <button type="button" className="btn btn-ghost" onClick={() => dismissModeCoercionNote()}>
        got it
      </button>
    </div>
  );
}
