// HostPassport.tsx — the host passport (TASK-20261003 S5, ADR-0072 §4). Beside the brain and
// "your file" chips on HOST platforms: what this host can and cannot do, in words — thinks,
// keeps your file, live connections, a provider sign-in, your home network, the phone helper.
//
// It exists because the shelf now disables what a host cannot run, and "needs your home
// network" on six tiles is a symptom; this is the one place that states the cause, once, for
// the whole host. Disclosure only — it offers no act and changes nothing.
//
// Every row comes from `hostPassport` (platform/copy.ts), which reads `offersOf` — the same
// table the tiles obey — so the passport cannot say a host can do what a tile says it cannot.
// Web and desktop render nothing: their capabilities are the product's own, told by Settings.

import { useSyncExternalStore, type ReactElement } from 'react';

import { hostPassport } from '../platform/copy.js';
import { getPlatform, type CustodyState } from '../platform/platform.js';
import { useBrainRevision } from '../platform/signals.js';
import { useDismissableMenu } from '../ui/useDismissableMenu.js';

/** One stable no-op for the seatless render (a fresh closure per render would resubscribe every render). */
const noSubscription = (): (() => void) => () => undefined;
/** A host with no custody seat has nothing owed and nothing refused. One object, so the snapshot is stable. */
const NO_CUSTODY: CustodyState = { dirty: false, readOnly: false };

export function HostPassport(): ReactElement | null {
  const platform = getPlatform();
  const custodySeat = platform.custody;
  const custody = useSyncExternalStore(
    custodySeat?.state.subscribe ?? noSubscription,
    () => custodySeat?.state.get() ?? NO_CUSTODY,
    () => custodySeat?.state.get() ?? NO_CUSTODY,
  );
  // The runner's brain is a live getter on a platform that is set once: the revision is the
  // signal that "thinks" would now answer differently (a probe that came back after boot).
  useBrainRevision();
  const { open, toggle, triggerRef, menuRef } = useDismissableMenu();
  // Presentation, not capability: WHERE the passport is shown. What it says is derived below.
  if (platform.kind !== 'host') return null;

  const passport = hostPassport(platform, custody);
  const can = passport.rows.filter((row) => row.can).length;
  const summary = `what this host can do: ${can} of ${passport.rows.length}`;

  return (
    <div className="identity-menu-wrap host-passport-wrap">
      <button
        type="button"
        ref={triggerRef}
        className="brain-chip host-passport-chip"
        data-testid="host-passport"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={summary}
        title={summary}
        onClick={toggle}
      >
        <svg className="host-passport-glyph" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <rect x="2.75" y="1.75" width="10.5" height="12.5" rx="2" />
          <path d="m5.5 8.25 1.75 1.75L10.5 6.5" />
        </svg>
        <span className="brain-chip-label">this host</span>
      </button>
      {open ? (
        // role="group": `aria-label` on a role-less <div> is not exposed by assistive
        // technology, and the chip announces that it opens something. A group, not a dialog
        // or a menu — it traps no focus and offers no act; it is a labelled list to read.
        <div className="identity-menu brain-menu host-passport-menu" data-testid="host-passport-menu" ref={menuRef} role="group" aria-label="what this host can do">
          <span className="identity-menu-label">this host: {passport.where}</span>
          <ul className="host-passport-rows">
            {passport.rows.map((row) => (
              <li key={row.key} className="host-passport-row" data-testid={`host-passport-row-${row.key}`} data-can={row.can}>
                <span className="host-passport-mark" aria-hidden="true">
                  {row.can ? '✓' : '✗'}
                </span>
                <span className="host-passport-text">
                  <span className="visually-hidden">{row.can ? 'yes: ' : 'no: '}</span>
                  <span className="host-passport-name">{row.name}</span>
                  <span className="host-passport-sentence">{row.sentence}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
