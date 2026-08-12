/**
 * ConnectionWizardNote — the ONE renderer for `connectionWizardNoteStore`
 * (TASK-20260812, AC11).
 *
 * THE STORE EXISTED WITH NO SURFACE. Every wizard-open refusal wrote its reason here —
 * "a connection wizard is already open", and now the zero-row F4 explanation — and no
 * component ever subscribed, so every refusal was SILENT in the UI. That silence class
 * is what the owner hit: a net-error banner CTA that did nothing at all. One renderer,
 * mounted beside the sheet in App, fixes the class rather than one caller.
 *
 * The note self-clears on a successful wizard open (`openConnectionWizard` nulls the
 * store) and on dismissal here, so it can never sit stale next to a live wizard.
 */
import type { ReactElement } from 'react';

import { useStore } from '../state/store.js';
import { connectionWizardNoteStore } from '../state/connectionWizard.js';
import { Button } from '../ui/Button.js';

export function ConnectionWizardNote(): ReactElement | null {
  const note = useStore(connectionWizardNoteStore);
  if (note === null) return null;
  return (
    <div className="error-note connection-wizard-note" role="alert" data-testid="connection-wizard-note">
      {note}
      <div className="field-row">
        <Button variant="ghost" onClick={() => connectionWizardNoteStore.set(null)}>
          dismiss
        </Button>
      </div>
    </div>
  );
}
