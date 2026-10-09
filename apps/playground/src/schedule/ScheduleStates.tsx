// schedule/ScheduleStates.tsx — the row-state helpers every schedule surface shares
// (TASK-20261009-scheduling-framework U7, U9; ADR-0072 §4, ADR-0074 §5–§6).
//
// Pure functions first, tiny components after. Nothing here reads a store or the platform:
// the caller hands in the steps, the apps the file holds and the host's offers, so a row, the
// editor and the result page all answer "can this step run HERE?" the same way — through
// `platform/availability.ts`'s one derivation (`needsOfConnections` → `availabilityOf`), never
// a `kind` check. The sentences are `copy.ts`'s (`blockedHere`, `appMissing`, `paused`,
// `imported`); this file only decides WHICH one applies.
//
// STATUS IS NEVER COLOUR ALONE (U9). `StatusDot` pairs the coloured dot with its word; the dot
// itself is `aria-hidden` and the word is the accessible content.

import type { ReactElement } from 'react';

import type { AppRecord } from '@snugprotocol/db';
import type { RunStatus, ScheduleStep, ScheduledTask, StepResultStatus } from '@snugprotocol/protocol';

import {
  availabilityOf,
  needsOfConnections,
  signedIn,
  type AppNeed,
  type HostOffers,
} from '../platform/availability.js';
import type { UserDb } from '@snugprotocol/db';
import { Button } from '../ui/Button.js';
import { appMissing, blockedHere, imported, paused, type StateCopy } from './copy.js';
import { RESULT_STATUS_WORD, STEP_STATUS_WORD, resultTone, stepTone, type StatusTone } from './copy.bits.js';

/** The two fields of an app row a state helper reads. */
export type AppName = Pick<AppRecord, 'appId' | 'displayName'>;

export function appNameOf(appId: string, apps: readonly AppName[]): string | undefined {
  return apps.find((app) => app.appId === appId)?.displayName;
}

// ---------------------------------------------------------------------------------------------
// Availability (U7)
// ---------------------------------------------------------------------------------------------

/** What the host offers and what each installed app needs — the hub's own shape (`HubView`). */
export interface StepAvailabilityInput {
  /** Per app id, from `needsOfConnections`; an app with no entry needs nothing. */
  needs: ReadonlyMap<string, readonly AppNeed[]>;
  offers: HostOffers;
}

export type StepAvailability = { ok: true } | { ok: false; blocked: string };

/**
 * The needs map for every installed app, read the way the hub reads it: ONE pass over the
 * connections table, the finished sign-ins read from the same db (an OAuth redirect is a need
 * only while a sign-in is owed).
 */
export function appNeedsOf(db: Pick<UserDb, 'listConnections' | 'getSecret' | 'listSecretKeys'>): ReadonlyMap<string, readonly AppNeed[]> {
  const rowsByApp = new Map<string, ReturnType<UserDb['listConnections']>>();
  for (const row of db.listConnections()) {
    const rows = rowsByApp.get(row.appId);
    if (rows === undefined) rowsByApp.set(row.appId, [row]);
    else rows.push(row);
  }
  const signIns = signedIn(db);
  const needs = new Map<string, readonly AppNeed[]>();
  for (const [appId, rows] of rowsByApp) needs.set(appId, needsOfConnections(rows, signIns));
  return needs;
}

/**
 * Can THIS host run this step? A *remind me* step always can. An app step cannot when its app
 * is gone from the file (`appMissing` — the row should offer *remove step*, see
 * `appMissingNote`) or when the host lacks a need the app declares — then the reason is
 * `blockedHere`'s, led by the first blocker's title ("it needs your home network").
 */
export function stepAvailability(step: ScheduleStep, apps: readonly AppName[], availability: StepAvailabilityInput): StepAvailability {
  if (step.kind === 'notify') return { ok: true };
  if (appNameOf(step.appId, apps) === undefined) return { ok: false, blocked: appMissing.text };
  const verdict = availabilityOf(availability.needs.get(step.appId) ?? [], availability.offers);
  if (verdict.ok) return { ok: true };
  const first = verdict.blockers[0];
  return { ok: false, blocked: blockedHere(first === undefined ? 'this host can’t run it' : `it ${first.title}`).text };
}

/** `appMissing` when the step names an app the file no longer holds (C3 cascade); else nothing. */
export function appMissingNote(step: ScheduleStep, apps: readonly AppName[]): StateCopy | undefined {
  if (step.kind === 'notify') return undefined;
  return appNameOf(step.appId, apps) === undefined ? appMissing : undefined;
}

// ---------------------------------------------------------------------------------------------
// Paused and imported rows (E7, E8, C4)
// ---------------------------------------------------------------------------------------------

/**
 * Why the ENGINE paused this schedule, with the count it actually hit, and *resume* as the one
 * act — or nothing when it is not paused by the engine (off by the user's hand is not a state
 * line; the switch says it).
 */
export function pausedRow(task: Pick<ScheduledTask, 'pausedReason' | 'consecutiveFailures' | 'unseenResults'>): StateCopy | undefined {
  switch (task.pausedReason) {
    case 'failures':
      return paused('failures', task.consecutiveFailures > 0 ? task.consecutiveFailures : undefined);
    case 'ignored':
      return paused('ignored', task.unseenResults > 0 ? task.unseenResults : undefined);
    case 'app-updated':
      return paused('app-updated');
    case undefined:
      return undefined;
    default: {
      const never: never = task.pausedReason;
      return never;
    }
  }
}

/** The one state line a row shows under its title: paused by the engine, or arrived disabled with an import. */
export function rowState(task: Pick<ScheduledTask, 'pausedReason' | 'consecutiveFailures' | 'unseenResults' | 'provenance' | 'enabled'>): StateCopy | undefined {
  const pausedCopy = pausedRow(task);
  if (pausedCopy !== undefined) return pausedCopy;
  if (task.provenance === 'imported' && !task.enabled) return imported;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Tiny components
// ---------------------------------------------------------------------------------------------

/** A coloured dot WITH its word (U9). `tone` colours the dot; `word` is what a reader gets. */
export function StatusDot({ tone, word, className }: { tone: StatusTone; word: string; className?: string }): ReactElement {
  return (
    <span className={`schedule-status is-${tone}${className === undefined ? '' : ` ${className}`}`} data-testid="schedule-status">
      <span className="schedule-status-dot" aria-hidden="true" />
      <span className="schedule-status-word">{word}</span>
    </span>
  );
}

export function ResultStatus({ status }: { status: RunStatus }): ReactElement {
  return <StatusDot tone={resultTone(status)} word={RESULT_STATUS_WORD[status]} />;
}

export function StepStatus({ status }: { status: StepResultStatus }): ReactElement {
  return <StatusDot tone={stepTone(status)} word={STEP_STATUS_WORD[status]} />;
}

/** A state line and its one act, side by side — the shape every row state renders in. */
export function StateLine({ copy, onAct, actDisabled, testId }: { copy: StateCopy; onAct?: () => void; actDisabled?: boolean; testId?: string }): ReactElement {
  return (
    <div className="schedule-state-line" role="status" data-testid={testId}>
      <span className="schedule-state-text">{copy.text}</span>
      {copy.action !== undefined && onAct !== undefined ? (
        <Button variant="ghost" onClick={onAct} disabled={actDisabled === true}>
          {copy.action}
        </Button>
      ) : null}
    </div>
  );
}

/** "this app was deleted · remove step" — the C3 cascade's surviving step. */
export function AppMissingNote({ onRemove }: { onRemove: () => void }): ReactElement {
  return <StateLine copy={appMissing} onAct={onRemove} testId="schedule-app-missing" />;
}

/** "not available in this host — …" — no act; the reason is the whole line. */
export function BlockedStepNote({ reason }: { reason: string }): ReactElement {
  return <StateLine copy={{ text: reason }} testId="schedule-step-blocked" />;
}

/** "paused: 5 failures in a row · resume" — renders nothing for a schedule the engine did not pause. */
export function PausedRow({
  task,
  onResume,
  resuming,
}: {
  task: Pick<ScheduledTask, 'pausedReason' | 'consecutiveFailures' | 'unseenResults'>;
  onResume: () => void;
  resuming?: boolean;
}): ReactElement | null {
  const copy = pausedRow(task);
  if (copy === undefined) return null;
  return <StateLine copy={copy} onAct={onResume} actDisabled={resuming} testId="schedule-paused-row" />;
}

/**
 * A 44 px `role="switch"` with a visible on/off word. `labelledBy` points at the row's own
 * label so the switch is named by the text beside it; `name` names it directly where there is
 * no such element.
 */
export function Switch({
  checked,
  onChange,
  name,
  labelledBy,
  disabled,
  testId,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  name?: string;
  labelledBy?: string;
  disabled?: boolean;
  testId?: string;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      className="schedule-switch"
      aria-checked={checked}
      {...(name !== undefined ? { 'aria-label': name } : {})}
      {...(labelledBy !== undefined ? { 'aria-labelledby': labelledBy } : {})}
      disabled={disabled === true}
      data-testid={testId}
      onClick={() => onChange(!checked)}
    >
      <span className="schedule-switch-knob" aria-hidden="true" />
      <span className="schedule-switch-word">{checked ? 'on' : 'off'}</span>
    </button>
  );
}
