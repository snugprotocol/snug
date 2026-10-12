// schedule/EnableConsent.tsx — WHAT WILL RUN, verbatim, before the first enable (TASK-20261009
// U8; security F10; ADR-0074 §4). The one consent surface every channel lands on: for each
// *ask the AI* step the app, the prompt as typed, the queries as typed (or the sentence that
// says the AI reads the tables) and what it may call; for a *run <app>* step the hosts the app's
// approved connections may call ("none" otherwise); for a reminder its title; then the daily cost
// bound. Two acts: `schedule it` and `not now`. Nothing here is a summary — a summary is what the
// row shows AFTER this was seen.
//
// TASK-20261010-host-broker PR-4 (ADR-0076 §9; D-PR4-8, D-PR4-20; D4, D11, D12):
//   - WHAT AN *ASK* STEP MAY CALL. A tool-free ask step calls nothing — its row says so, never the
//     app's approved hosts (the hosts are the app's, not the AI's). A step that may look things up
//     names the connections it may use (`connectionsByApp`, the names `fetchableConnections`
//     gives), says its typed queries are where it starts, and the cost row says what one time may
//     spend beside the day's bound.
//   - THE TICK *make changes on its own* is THE act that arms a schedule (all four hosts land here),
//     offered only for a ONE-app schedule (`onItsOwnApp`). It is OFF on every mount and seeded from
//     nothing — not the steps, a suggestion, an import, a draft or storage — except the editor's own
//     choice (`presetOnItsOwn`), which the user just made there and can take back here. The answer
//     reaches the host as `onEnable({ onItsOwn })`; the host arms through `armIfTicked`.
//
// PR-4 Gate 5: an *ask* step of an app no brain here would answer (`blockedApps` — the demo, or a
// key not set) says so on the step, tools or not, so the first result is never the first to say it
// (U1); the tick names the lines that explain it (`aria-describedby`, U11); the cost row counts a
// look-up only where a step may look things up — a *run <app>* step's call is not one (U13).
//
// Text nodes only: a prompt or a query is rendered as text, never as markup.

import type { ReactElement } from 'react';
import { useId, useState } from 'react';

import { OWN_UNDO_MAX_LIVE, type ScheduleSpec, type ScheduleStep } from '@snugprotocol/protocol';

import { Button } from '../ui/Button.js';
import { armTask } from './acts.js';
import { CONSENT, brainBlocked, stepLabel } from './copy.js';
import { CONSENT_ROWS } from './copy.editor.js';
import { dailyAiBound, onItsOwnApp, type LookUpNamesByApp } from './editorModel.js';
import { occurrencesPerWeek, stepsCost, stepsLookUps } from './floors.js';

/** What the user answered on the consent: whether the schedule may make its changes on its own. */
export interface EnableChoice {
  onItsOwn: boolean;
}

export interface EnableConsentProps {
  steps: readonly ScheduleStep[];
  spec: ScheduleSpec;
  now: Date;
  /** Library id → display name for every app the steps name. */
  appNames: Readonly<Record<string, string>>;
  /** Library id → the hosts its approved connections may call (`approvedHostsByApp`) — a *run <app>* step's row. */
  hostsByApp: Readonly<Record<string, readonly string[]>>;
  /** Library id → the connections a step that may look things up could use, by name (`fetchableConnections`). */
  connectionsByApp?: LookUpNamesByApp;
  /** Library ids of the apps whose *ask* steps no brain here would answer (`blockedAppsOf`) — said on each such step. */
  blockedApps?: readonly string[];
  /**
   * The editor's own choice (*changes it suggests:*), which the user made a moment ago and confirms
   * here. Only the editor passes it; every other host leaves the tick OFF.
   */
  presetOnItsOwn?: boolean;
  busy?: boolean;
  /** The writer refused: shown in words, the acts stay. */
  error?: string;
  onEnable: (choice: EnableChoice) => void;
  onNotNow: () => void;
}

/**
 * The host's half of the tick: once the schedule is written, arm it when — and only when — the
 * user ticked it here. Answers the refusal in words, or `undefined` when there is nothing to say.
 */
export async function armIfTicked(taskId: string, choice: EnableChoice): Promise<string | undefined> {
  if (!choice.onItsOwn) return undefined;
  try {
    const armed = await armTask(taskId);
    return armed.ok ? undefined : armed.reason;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function EnableConsent({
  steps,
  spec,
  now,
  appNames,
  hostsByApp,
  connectionsByApp = {},
  blockedApps = [],
  presetOnItsOwn = false,
  busy = false,
  error,
  onEnable,
  onNotNow,
}: EnableConsentProps): ReactElement {
  const id = useId();
  const bound = dailyAiBound(spec, steps, now);
  const armableApp = onItsOwnApp(steps);
  // OFF on every mount; the editor's preset is the only seed (D-PR4-8).
  const [onItsOwn, setOnItsOwn] = useState(presetOnItsOwn);
  const ticked = armableApp !== undefined && onItsOwn;
  const looksThingsUp = steps.some((step) => step.kind === 'app-think' && step.tools === true);
  const nameOf = (appId: string): string => appNames[appId] ?? appId;
  const often = armableApp !== undefined && occurrencesPerWeek(spec, now) > OWN_UNDO_MAX_LIVE;
  const hintId = `${id}-on-its-own-hint`;
  const oftenId = `${id}-on-its-own-often`;
  /** The lines under the tick that are on screen — what a screen reader hears with it (U11). */
  const tickDescribedBy = [...(onItsOwn ? [] : [hintId]), ...(often ? [oftenId] : [])].join(' ');

  return (
    <section className="schedule-consent" role="region" aria-labelledby={`${id}-heading`} data-testid="enable-consent">
      <h3 id={`${id}-heading`} className="section-title">
        {CONSENT.heading}
      </h3>
      <ol className="schedule-consent-steps">
        {steps.map((step, index) => {
          if (step.kind === 'notify') {
            return (
              <li key={index} className="schedule-consent-step" data-testid={`consent-step-${index}`}>
                <p className="schedule-consent-app">{CONSENT_ROWS.remind(step.title)}</p>
                <p className="hint">{step.body}</p>
              </li>
            );
          }
          const name = nameOf(step.appId);
          if (step.kind === 'app-run') {
            const hosts = hostsByApp[step.appId] ?? [];
            return (
              <li key={index} className="schedule-consent-step" data-testid={`consent-step-${index}`}>
                <p className="schedule-consent-app">{stepLabel('app-run', name)}</p>
                <dl className="schedule-consent-rows">
                  <dt>{CONSENT.input}</dt>
                  <dd>
                    <code>{step.input === undefined ? CONSENT_ROWS.noHosts : JSON.stringify(step.input)}</code>
                  </dd>
                  <dt>{CONSENT.hosts}</dt>
                  <dd data-testid={`consent-hosts-${index}`}>{hosts.length === 0 ? CONSENT_ROWS.noHosts : hosts.join(', ')}</dd>
                </dl>
              </li>
            );
          }
          const queries = step.context.sql ?? [];
          const tools = step.tools === true;
          return (
            <li key={index} className="schedule-consent-step" data-testid={`consent-step-${index}`}>
              <p className="schedule-consent-app">{stepLabel('app-think', name)}</p>
              <dl className="schedule-consent-rows">
                <dt>{CONSENT.prompt}</dt>
                <dd>
                  <blockquote className="schedule-consent-prompt" data-testid={`consent-prompt-${index}`}>
                    {step.prompt}
                  </blockquote>
                </dd>
                <dt>{CONSENT.queries}</dt>
                <dd>
                  {queries.length === 0 ? (
                    <span data-testid={`consent-tables-${index}`}>{CONSENT_ROWS.tables(name)}</span>
                  ) : (
                    <>
                      <ul className="schedule-consent-queries" data-testid={`consent-queries-${index}`}>
                        {queries.map((sql, q) => (
                          <li key={q}>
                            <code>{sql}</code>
                          </li>
                        ))}
                      </ul>
                      {/* A step that may look things up starts from them; it is not bound to them. */}
                      {tools ? <span className="hint">{CONSENT_ROWS.startsFrom(name)}</span> : null}
                    </>
                  )}
                </dd>
                {tools ? null : (
                  <>
                    <dt>{CONSENT.hosts}</dt>
                    <dd data-testid={`consent-hosts-${index}`}>{CONSENT_ROWS.noCalls}</dd>
                  </>
                )}
              </dl>
              {tools ? (
                <p className="hint schedule-consent-lookups" data-testid={`consent-lookups-${index}`}>
                  {CONSENT_ROWS.lookUps(connectionsByApp[step.appId] ?? [])}
                </p>
              ) : null}
              {blockedApps.includes(step.appId) ? (
                <p className="hint" role="note" data-testid={`consent-brain-blocked-${index}`}>
                  {brainBlocked.text}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="hint" data-testid="consent-cost">
        {CONSENT.cost}: {looksThingsUp ? CONSENT_ROWS.lookUpBound(bound, { ai: stepsCost(steps).ai, net: stepsLookUps(steps) }) : CONSENT_ROWS.dailyBound(bound)}
      </p>
      {armableApp !== undefined ? (
        <div className="field schedule-consent-on-its-own">
          <label className="check-label" htmlFor={`${id}-on-its-own`}>
            <input
              id={`${id}-on-its-own`}
              type="checkbox"
              checked={onItsOwn}
              disabled={busy}
              aria-describedby={tickDescribedBy === '' ? undefined : tickDescribedBy}
              data-testid="consent-on-its-own"
              onChange={(event) => setOnItsOwn(event.target.checked)}
            />
            {CONSENT_ROWS.onItsOwn(nameOf(armableApp))}
          </label>
          {onItsOwn ? null : (
            <span className="hint" id={hintId} data-testid="consent-on-its-own-hint">
              {CONSENT_ROWS.onItsOwnOff}
            </span>
          )}
          {/* More runs a week than live undos a schedule keeps: say what happens past them. */}
          {often ? (
            <span className="hint" id={oftenId} data-testid="consent-on-its-own-often">
              {CONSENT_ROWS.onItsOwnOften}
            </span>
          ) : null}
        </div>
      ) : null}
      {error !== undefined ? (
        <div className="error-note" role="alert" aria-live="polite" data-testid="consent-error">
          {error}
        </div>
      ) : null}
      <div className="field-row field-row-wrap schedule-actions">
        <Button variant="primary" onClick={() => onEnable({ onItsOwn: ticked })} disabled={busy} data-testid="consent-enable">
          {CONSENT_ROWS.enable}
        </Button>
        <Button variant="ghost" onClick={onNotNow} disabled={busy} data-testid="consent-not-now">
          {CONSENT_ROWS.notNow}
        </Button>
      </div>
    </section>
  );
}
