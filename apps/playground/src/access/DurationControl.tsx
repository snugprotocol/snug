// access/DurationControl.tsx — *for how long* (TASK-20261010-cross-app-access AC18; D13, D30): a
// VERTICAL radiogroup — while <app> is open (the default, a memory access that ends with the
// app's view), a day, a week, until I stop it — and *also while I'm away* for scheduled runs.
// The away box is not offered while *while it's open* is chosen: a memory access belongs to the
// visible frame of its generation and is never usable by a hidden one (D30).

import type { ReactElement } from 'react';

import { ACCESS_DURATIONS, type AccessDuration } from '@snugprotocol/protocol';

import { CONSENT_SHEET, durationOption } from './copy.js';

export interface DurationControlProps {
  readerName: string;
  duration: AccessDuration;
  onDuration: (duration: AccessDuration) => void;
  away: boolean;
  onAway: (on: boolean) => void;
  /** The radio group's `name` and the id of the section title that labels it. */
  groupName: string;
  titleId: string;
}

export function DurationControl({ readerName, duration, onDuration, away, onAway, groupName, titleId }: DurationControlProps): ReactElement {
  return (
    <section className="access-section" aria-labelledby={titleId}>
      <h3 id={titleId} className="access-section-title">
        {CONSENT_SHEET.howLong}
      </h3>
      <div className="access-durations" role="radiogroup" aria-labelledby={titleId} data-testid="access-durations">
        {ACCESS_DURATIONS.map((kind) => {
          const option = durationOption(kind, readerName);
          return (
            <label key={kind} className="check-label" data-testid={`access-duration-row-${kind}`}>
              <input type="radio" name={groupName} value={kind} checked={duration === kind} data-testid={`access-duration-${kind}`} onChange={() => onDuration(kind)} />
              <span>
                {option.label}
                {option.hint !== undefined ? <span className="hint"> — {option.hint}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
      {duration !== 'session' ? (
        <div className="access-away" data-testid="access-away-row">
          <label className="check-label">
            <input type="checkbox" checked={away} data-testid="access-away" onChange={(event) => onAway(event.target.checked)} />
            <span>{CONSENT_SHEET.away}</span>
          </label>
          <p className="hint">{CONSENT_SHEET.awayHint(readerName)}</p>
        </div>
      ) : null}
    </section>
  );
}
