// schedule/SpecControls.tsx — the WHEN of a schedule (TASK-20261009-scheduling-framework U3;
// design F7; Q13). Six chips as ONE radiogroup (arrow keys move and check; `aria-checked` is the
// state), then the panel for the checked chip over native `<input type="time">` and
// `<input type="date">`, an optional end ("ends · on a date / after N times"), and the zone line
// — "<zone> · follows this device" with a pin select over the zones this runtime can name.
//
// THE SPEC IS THE TRUTH, THE CRON IS A VIEW OF IT. The custom panel shows the compiled cron of
// whatever preset was checked and lets the user edit it; every keystroke that parses updates the
// spec (and so the preview); a cron that maps to a preset reads back as that preset's chip when
// the field is left (`onCronCommit`). An unparseable cron leaves the spec where it was and says
// so under the field, `aria-live` so the refusal is heard.
//
// Every control is a native element or the `.chip` class from `theme/app.css`; this file adds
// no colour of its own.

import type { KeyboardEvent, ReactElement } from 'react';
import { useId, useRef } from 'react';

import { SCHEDULE_EVERY_MAX_N, SCHEDULE_UNITS, SCHEDULE_UNTIL_MAX_COUNT, WEEKDAYS, type ScheduleSpec, type ScheduleUnit, type Weekday } from '@snugprotocol/protocol';

import { KIND_LABELS, WHEN, ZONE } from './copy.editor.js';
import { WEEKDAY_KEYS, WEEKEND_KEYS, describeSpec, resolveZone, sortDays } from './cron.js';
import { SPEC_KINDS, instantOf, knownZones, specFromCronText, wallParts, type SpecKind } from './editorModel.js';

/** Full names for the day chips (U9: never an abbreviation alone) and the monthly weekday select. */
export const DAY_NAMES: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};
const DAY_SHORT: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

export interface SpecControlsProps {
  mode: SpecKind;
  spec: ScheduleSpec;
  /** The custom panel's text, owned by the editor so a typed cron survives a re-render. */
  cron: string;
  onMode: (kind: SpecKind) => void;
  onSpec: (spec: ScheduleSpec) => void;
  onCron: (text: string) => void;
  /** The cron field was left: derive the chips from what it says. */
  onCronCommit: () => void;
}

const sameDays = (a: readonly Weekday[], b: readonly Weekday[]): boolean => a.length === b.length && a.every((d, i) => d === b[i]);

export function SpecControls({ mode, spec, cron, onMode, onSpec, onCron, onCronCommit }: SpecControlsProps): ReactElement {
  const id = useId();
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const zone = resolveZone(spec.tz);

  const onChipKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = SPEC_KINDS.indexOf(mode);
    let next: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % SPEC_KINDS.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + SPEC_KINDS.length) % SPEC_KINDS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = SPEC_KINDS.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    const kind = SPEC_KINDS[next] as SpecKind;
    onMode(kind);
    chipRefs.current[next]?.focus();
  };

  const timeInput = (value: string, onTime: (time: string) => void, label = WHEN.time): ReactElement => (
    <div className="field">
      <label htmlFor={`${id}-time-${mode}`}>{label}</label>
      <input id={`${id}-time-${mode}`} type="time" value={value} onChange={(event) => onTime(event.target.value)} data-testid="spec-time" />
    </div>
  );

  return (
    <fieldset className="schedule-section" data-testid="spec-controls">
      <legend className="section-title">{WHEN.legend}</legend>
      <div className="chip-row" role="radiogroup" aria-label={WHEN.legend} onKeyDown={onChipKey} data-testid="spec-kinds">
        {SPEC_KINDS.map((kind, index) => {
          const checked = kind === mode;
          return (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              className={checked ? 'chip chip-active' : 'chip'}
              data-testid={`spec-kind-${kind}`}
              ref={(el) => {
                chipRefs.current[index] = el;
              }}
              onClick={() => onMode(kind)}
            >
              {KIND_LABELS[kind]}
            </button>
          );
        })}
      </div>

      {mode === 'once' && spec.kind === 'once' ? (
        <OncePanel id={id} spec={spec} zone={zone} onSpec={onSpec} />
      ) : mode === 'every' && spec.kind === 'every' ? (
        <div className="field-row field-row-wrap">
          <div className="field">
            <label htmlFor={`${id}-n`}>{WHEN.every}</label>
            <input
              id={`${id}-n`}
              type="number"
              min={1}
              max={SCHEDULE_EVERY_MAX_N}
              value={spec.n}
              data-testid="spec-every-n"
              onChange={(event) => {
                const n = Math.max(1, Math.min(SCHEDULE_EVERY_MAX_N, Math.round(Number(event.target.value) || 1)));
                onSpec({ ...spec, n });
              }}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-unit`}>{WHEN.legend}</label>
            <select
              id={`${id}-unit`}
              value={spec.unit}
              data-testid="spec-every-unit"
              onChange={(event) => {
                const unit = event.target.value as ScheduleUnit;
                // A time is honoured only on a day stride — the schema refuses it elsewhere.
                const { time: _dropped, ...rest } = spec;
                onSpec(unit === 'days' ? { ...rest, unit } : { ...rest, unit });
              }}
            >
              {SCHEDULE_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {WHEN.unit[unit]}
                </option>
              ))}
            </select>
          </div>
          {spec.unit === 'days' ? (
            <div className="field">
              <label htmlFor={`${id}-time-${mode}`}>{WHEN.time}</label>
              <input
                id={`${id}-time-${mode}`}
                type="time"
                value={spec.time ?? ''}
                data-testid="spec-time"
                onChange={(event) => {
                  const { time: _dropped, ...rest } = spec;
                  onSpec(event.target.value === '' ? rest : { ...rest, time: event.target.value });
                }}
              />
              <span className="hint">{WHEN.daysTimeHint}</span>
            </div>
          ) : null}
        </div>
      ) : mode === 'daily' && spec.kind === 'daily' ? (
        timeInput(spec.time, (time) => onSpec({ ...spec, time }))
      ) : mode === 'weekly' && spec.kind === 'weekly' ? (
        <>
          <div className="chip-row" data-testid="spec-week-presets">
            {(
              [
                ['everyDay', WEEKDAYS],
                ['weekdays', WEEKDAY_KEYS],
                ['weekends', WEEKEND_KEYS],
              ] as const
            ).map(([preset, days]) => {
              const pressed = sameDays(sortDays(spec.days), days);
              return (
                <button
                  key={preset}
                  type="button"
                  className={pressed ? 'chip chip-active' : 'chip'}
                  aria-pressed={pressed}
                  data-testid={`spec-preset-${preset}`}
                  onClick={() => onSpec({ ...spec, days: [...days] })}
                >
                  {WHEN.presets[preset]}
                </button>
              );
            })}
          </div>
          <div className="chip-row" role="group" aria-label={WHEN.days} data-testid="spec-days">
            {WEEKDAYS.map((day) => {
              const pressed = spec.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  className={pressed ? 'chip chip-active' : 'chip'}
                  aria-pressed={pressed}
                  aria-label={DAY_NAMES[day]}
                  title={DAY_NAMES[day]}
                  data-testid={`spec-day-${day}`}
                  onClick={() => {
                    const days = pressed ? spec.days.filter((d) => d !== day) : sortDays([...spec.days, day]);
                    // The schema wants at least one day: the last chip stays pressed.
                    if (days.length > 0) onSpec({ ...spec, days });
                  }}
                >
                  {DAY_SHORT[day]}
                </button>
              );
            })}
          </div>
          {timeInput(spec.time, (time) => onSpec({ ...spec, time }))}
        </>
      ) : mode === 'monthly' && spec.kind === 'monthly' ? (
        <MonthlyPanel id={id} spec={spec} onSpec={onSpec} timeInput={timeInput} />
      ) : mode === 'custom' ? (
        <CustomPanel id={id} spec={spec} cron={cron} onCron={onCron} onCronCommit={onCronCommit} />
      ) : null}

      {spec.kind !== 'once' ? <UntilRow id={id} spec={spec} onSpec={onSpec} /> : null}

      <div className="field schedule-zone" data-testid="spec-zone">
        <label htmlFor={`${id}-zone`}>{ZONE.label}</label>
        <span className="hint" data-testid="spec-zone-line">
          {spec.tz === 'device' ? ZONE.follows(zone) : ZONE.pinned(zone)}
        </span>
        <select id={`${id}-zone`} value={spec.tz} aria-label={ZONE.pin} data-testid="spec-zone-select" onChange={(event) => onSpec({ ...spec, tz: event.target.value })}>
          <option value="device">{ZONE.device}</option>
          {knownZones().map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <p className="visually-hidden" aria-live="polite">
        {describeSpec(spec)}
      </p>
    </fieldset>
  );
}

function OncePanel({ id, spec, zone, onSpec }: { id: string; spec: Extract<ScheduleSpec, { kind: 'once' }>; zone: string; onSpec: (spec: ScheduleSpec) => void }): ReactElement {
  const parts = wallParts(zone, new Date(spec.at));
  const set = (date: string, time: string): void => {
    const at = instantOf(zone, date, time);
    if (at !== undefined) onSpec({ ...spec, at: at.toISOString() });
  };
  return (
    <div className="field-row field-row-wrap">
      <div className="field">
        <label htmlFor={`${id}-date`}>{WHEN.date}</label>
        <input id={`${id}-date`} type="date" value={parts.date} data-testid="spec-date" onChange={(event) => set(event.target.value, parts.time)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-time-once`}>{WHEN.time}</label>
        <input id={`${id}-time-once`} type="time" value={parts.time} data-testid="spec-time" onChange={(event) => set(parts.date, event.target.value)} />
      </div>
    </div>
  );
}

function MonthlyPanel({
  id,
  spec,
  onSpec,
  timeInput,
}: {
  id: string;
  spec: Extract<ScheduleSpec, { kind: 'monthly' }>;
  onSpec: (spec: ScheduleSpec) => void;
  timeInput: (value: string, onTime: (time: string) => void) => ReactElement;
}): ReactElement {
  const on = spec.on;
  return (
    <>
      <div className="field-row field-row-wrap">
        <div className="field">
          <label htmlFor={`${id}-on`}>{WHEN.on}</label>
          <select
            id={`${id}-on`}
            value={on.kind}
            data-testid="spec-monthly-on"
            onChange={(event) => {
              const kind = event.target.value;
              onSpec({
                ...spec,
                on: kind === 'day' ? { kind: 'day', day: on.kind === 'day' ? on.day : 1 } : kind === 'nth' ? { kind: 'nth', nth: 1, weekday: 'mon' } : { kind: 'last' },
              });
            }}
          >
            <option value="day">{WHEN.onDay}</option>
            <option value="nth">{WHEN.onNth}</option>
            <option value="last">{WHEN.onLast}</option>
          </select>
        </div>
        {on.kind === 'day' ? (
          <div className="field">
            <label htmlFor={`${id}-day`}>{WHEN.dayNumber}</label>
            <input
              id={`${id}-day`}
              type="number"
              min={1}
              max={31}
              value={on.day}
              data-testid="spec-monthly-day"
              onChange={(event) => onSpec({ ...spec, on: { kind: 'day', day: Math.max(1, Math.min(31, Math.round(Number(event.target.value) || 1))) } })}
            />
          </div>
        ) : on.kind === 'nth' ? (
          <>
            <div className="field">
              <label htmlFor={`${id}-nth`}>{WHEN.nth}</label>
              <select
                id={`${id}-nth`}
                value={on.nth}
                data-testid="spec-monthly-nth"
                onChange={(event) => onSpec({ ...spec, on: { ...on, nth: Number(event.target.value) as 1 | 2 | 3 | 4 } })}
              >
                {WHEN.nthWords.map((word, index) => (
                  <option key={word} value={index + 1}>
                    {word}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${id}-weekday`}>{WHEN.weekday}</label>
              <select
                id={`${id}-weekday`}
                value={on.weekday}
                data-testid="spec-monthly-weekday"
                onChange={(event) => onSpec({ ...spec, on: { ...on, weekday: event.target.value as Weekday } })}
              >
                {WEEKDAYS.map((day) => (
                  <option key={day} value={day}>
                    {DAY_NAMES[day]}
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : null}
      </div>
      {timeInput(spec.time, (time) => onSpec({ ...spec, time }))}
    </>
  );
}

function CustomPanel({
  id,
  spec,
  cron,
  onCron,
  onCronCommit,
}: {
  id: string;
  spec: ScheduleSpec;
  cron: string;
  onCron: (text: string) => void;
  onCronCommit: () => void;
}): ReactElement {
  const read = specFromCronText(cron, spec);
  const invalid = cron.trim() !== '' && read === undefined;
  return (
    <div className="field">
      <label htmlFor={`${id}-cron`}>{WHEN.cron}</label>
      <input
        id={`${id}-cron`}
        type="text"
        value={cron}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={invalid}
        data-testid="spec-cron"
        onChange={(event) => onCron(event.target.value)}
        onBlur={onCronCommit}
      />
      <span className="hint" aria-live="polite" data-testid="spec-cron-reads">
        {read !== undefined && read.kind !== 'custom' ? WHEN.cronReadsAs(describeSpec(read)) : ''}
      </span>
      {invalid ? (
        <div className="error-note" role="alert" data-testid="spec-cron-invalid">
          {WHEN.cronInvalid}
        </div>
      ) : null}
    </div>
  );
}

function UntilRow({ id, spec, onSpec }: { id: string; spec: ScheduleSpec; onSpec: (spec: ScheduleSpec) => void }): ReactElement {
  const until = spec.until;
  const kind = until?.kind ?? 'none';
  const set = (next: ScheduleSpec['until']): void => {
    const { until: _dropped, ...rest } = spec;
    onSpec(next === undefined ? rest : { ...rest, until: next });
  };
  return (
    <div className="field-row field-row-wrap" data-testid="spec-until">
      <div className="field">
        <label htmlFor={`${id}-until`}>{WHEN.until}</label>
        <select
          id={`${id}-until`}
          value={kind}
          data-testid="spec-until-kind"
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'none') set(undefined);
            else if (value === 'date') set({ kind: 'date', date: '' });
            else set({ kind: 'count', count: 1 });
          }}
        >
          <option value="none">{WHEN.untilNone}</option>
          <option value="date">{WHEN.untilDate}</option>
          <option value="count">{WHEN.untilCount}</option>
        </select>
      </div>
      {until?.kind === 'date' ? (
        <div className="field">
          <label htmlFor={`${id}-until-date`}>{WHEN.untilDateLabel}</label>
          <input id={`${id}-until-date`} type="date" value={until.date} data-testid="spec-until-date" onChange={(event) => set({ kind: 'date', date: event.target.value })} />
        </div>
      ) : until?.kind === 'count' ? (
        <div className="field">
          <label htmlFor={`${id}-until-count`}>{WHEN.untilCountLabel}</label>
          <input
            id={`${id}-until-count`}
            type="number"
            min={1}
            max={SCHEDULE_UNTIL_MAX_COUNT}
            value={until.count}
            data-testid="spec-until-count"
            onChange={(event) => set({ kind: 'count', count: Math.max(1, Math.min(SCHEDULE_UNTIL_MAX_COUNT, Math.round(Number(event.target.value) || 1))) })}
          />
        </div>
      ) : null}
    </div>
  );
}
