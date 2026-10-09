// schedule/PreviewAndCost.tsx — the live preview and the cost line (TASK-20261009 U3; design
// F6, F8; E7). The next THREE occurrences from now, rendered by `Intl` in the schedule's zone
// (so a pinned zone reads in that zone and a device-following one in this device's), the
// "next" sentence with its honesty tail (`copy.nextLine`), the cost line (`copy.costLine`: calls
// a week on the app's brain NOW, and where the rows go), the ceiling warning when the cadence
// would cross the daily ceiling, the frequency-floor refusal (an `.error-note` the editor also
// reads to disable the save), and the honesty footer — the one sentence about what THIS host
// can do, where the user decides (F6).
//
// `aria-live="polite"` on the region: a chip change re-reads the preview to a screen reader.

import type { ReactElement } from 'react';

import { SCHEDULE_DAILY_CEILINGS, type ScheduleSpec, type ScheduleStep } from '@snugprotocol/protocol';

import { ceilingWarning, costLine, nextLine } from './copy.js';
import { PREVIEW } from './copy.editor.js';
import { SEARCH_BOUND_DAYS, describeSpec, occurrencesBetween, resolveZone } from './cron.js';
import { estimatedCallsPerWeek } from './floors.js';

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** "Fri, Oct 16, 5:00 PM PDT" — the zone's own abbreviation names where the clock was read. */
export function formatOccurrence(at: Date, zone: string, locale = 'en-US'): string {
  const key = `${locale}|${zone}`;
  let fmt = formatters.get(key);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone, timeZoneName: 'short' });
    formatters.set(key, fmt);
  }
  return fmt
    .formatToParts(at)
    .map((p) => (p.type === 'literal' && /^\s+$/.test(p.value) ? ' ' : p.value))
    .join('');
}

export interface PreviewAndCostProps {
  spec: ScheduleSpec;
  /** The live steps as protocol steps — what the cost rules count. */
  steps: readonly ScheduleStep[];
  now: Date;
  /** The brain the app's question runs on NOW, named as the brain chip names it. */
  brainLabel: string;
  /** The names of the apps whose rows the queries read ("Ledger", "Ledger and Standup"). */
  appNames: string;
  /** `frequencyFloorRefusal` — present, the save is disabled and this says why. */
  floorRefusal: string | undefined;
  honesty: string;
}

export function PreviewAndCost({ spec, steps, now, brainLabel, appNames, floorRefusal, honesty }: PreviewAndCostProps): ReactElement {
  const zone = resolveZone(spec.tz);
  const next = occurrencesBetween(spec, now, new Date(now.getTime() + SEARCH_BOUND_DAYS * DAY_MS), { limit: 3, anchor: now });
  const perWeek = estimatedCallsPerWeek(spec, steps, now);
  const sendsRows = steps.some((step) => step.kind === 'app-think');
  const overCeiling = perWeek.ai / 7 > SCHEDULE_DAILY_CEILINGS.ai;

  return (
    <section className="schedule-section schedule-preview" aria-live="polite" aria-label={PREVIEW.heading} data-testid="schedule-preview">
      <h3 className="section-title">{PREVIEW.heading}</h3>
      {next.length === 0 ? (
        <p className="hint" data-testid="preview-none">
          {PREVIEW.none}
        </p>
      ) : (
        <ol className="schedule-preview-list" data-testid="preview-occurrences">
          {next.map((at) => (
            <li key={at.toISOString()}>
              <time dateTime={at.toISOString()}>{formatOccurrence(at, zone)}</time>
            </li>
          ))}
        </ol>
      )}
      <p className="hint" data-testid="preview-next-line">
        {nextLine(describeSpec(spec))}
      </p>
      <p className="hint" data-testid="preview-cost">
        {PREVIEW.cost}: {costLine({ perWeek: perWeek.ai, brainLabel, appName: appNames, sendsRows })}
      </p>
      {overCeiling ? (
        <p className="connection-note" role="status" data-testid="preview-ceiling">
          {ceilingWarning('AI call')}
        </p>
      ) : null}
      {floorRefusal !== undefined ? (
        <div className="error-note" role="alert" data-testid="preview-floor">
          {floorRefusal}
        </div>
      ) : null}
      <footer className="hint schedule-honesty" data-testid="preview-honesty">
        {honesty}
      </footer>
    </section>
  );
}
