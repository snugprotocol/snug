// YourFileChip.tsx — the "your file" chip (TASK-20260905-binding-a-artifacts AC7, D8;
// ADR-0059 extended to custody). Beside the brain chip, on every route, disclosure first:
// where the user's file lives in THIS host, what the durable copy is, what a republish does
// to it. Then the acts the host's custody seat offers — and only those (a seat without an
// act renders no control): "save to this artifact", the two divergence acts, dismiss the
// note. Renders NOTHING where the platform carries no custody seat (web, desktop): their
// file story is Settings' own.
//
// Copy derives from the platform seats and the record's state through `custodyDisclosure`
// — never from parallel UI state.

import { useState, type ReactElement } from 'react';
import { useSyncExternalStore } from 'react';

import { custodyDisclosure } from '../platform/copy.js';
import { getPlatform } from '../platform/platform.js';
import { useDismissableMenu } from '../ui/useDismissableMenu.js';

export function YourFileChip(): ReactElement | null {
  const platform = getPlatform();
  const seat = platform.custody;
  const state = useSyncExternalStore(
    seat?.state.subscribe ?? (() => () => undefined),
    () => seat?.state.get(),
    () => seat?.state.get(),
  );
  const { open, toggle, close, triggerRef, menuRef } = useDismissableMenu();
  const [busy, setBusy] = useState(false);
  if (seat === undefined || state === undefined) return null;

  const copy = custodyDisclosure(platform.binding, platform.userdbBackend?.kind, state);
  // Narrowed ONCE so the buttons below call the acts without a non-null assertion.
  const save = seat.save !== undefined && (seat.canSave?.() ?? true) && !state.readOnly ? seat.save : undefined;
  const loadPageCopy = state.divergence !== undefined ? seat.loadPageCopy : undefined;
  // The act runs synchronously on the click (the seat's own promise carries the outcome);
  // `busy` only guards a second click while it is in flight.
  const run = (act: () => Promise<unknown> | void) => (): void => {
    setBusy(true);
    void Promise.resolve(act()).finally(() => setBusy(false));
  };

  return (
    <div className="identity-menu-wrap">
      <button
        type="button"
        ref={triggerRef}
        className={`brain-chip your-file-chip${state.dirty ? ' your-file-chip-dirty' : ''}`}
        data-testid="your-file-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${copy.label}${state.dirty ? ' (unsaved changes)' : ''}`}
        title={copy.headline}
        onClick={toggle}
      >
        <span className={`brain-dot${state.dirty ? ' your-file-dot-dirty' : ''}`} aria-hidden="true" />
        <span className="brain-chip-label">{copy.label}</span>
      </button>
      {open ? (
        <div className="identity-menu brain-menu" data-testid="your-file-menu" ref={menuRef} aria-label="your file">
          <span className="identity-menu-label">{copy.headline}</span>
          <span className="brain-menu-body">{copy.body}</span>
          {copy.status !== undefined ? (
            <span className="brain-menu-hint" data-testid="your-file-status">
              {copy.status}
            </span>
          ) : null}
          {state.note !== undefined ? (
            <span className="brain-menu-hint" role="status" data-testid="your-file-note">
              {state.note}
              {seat.dismissNote !== undefined ? (
                <button type="button" className="identity-menu-item" data-testid="your-file-dismiss" onClick={() => seat.dismissNote?.()}>
                  ok
                </button>
              ) : null}
            </span>
          ) : null}
          {save !== undefined ? (
            <button
              type="button"
              className="identity-menu-item"
              data-testid="your-file-save"
              disabled={busy}
              // The menu closes on success; a refusal keeps it open so the status and the note are read.
              onClick={run(() =>
                save().then((outcome) => {
                  if (outcome.ok) close(true);
                }),
              )}
            >
              save to this artifact
            </button>
          ) : null}
          {loadPageCopy !== undefined ? (
            <button type="button" className="identity-menu-item" data-testid="your-file-load-page" disabled={busy} onClick={run(() => loadPageCopy().then(() => close(true)))}>
              load the page’s copy
            </button>
          ) : null}
          {state.divergence !== undefined && seat.keepBrowserCopy !== undefined ? (
            <button
              type="button"
              className="identity-menu-item"
              data-testid="your-file-keep-browser"
              disabled={busy}
              onClick={() => {
                seat.keepBrowserCopy?.();
                close(true);
              }}
            >
              keep this browser’s copy
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
