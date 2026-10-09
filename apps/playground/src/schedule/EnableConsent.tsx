// schedule/EnableConsent.tsx — WHAT WILL RUN, verbatim, before the first enable (TASK-20261009
// U8; security F10; ADR-0074 §4). The one consent surface every channel lands on: for each
// *ask the AI* step the app, the prompt as typed, the queries as typed (or the sentence that
// says the AI reads the tables), the hosts the app's approved connections may call ("none"
// otherwise); for a reminder its title; then the daily cost bound. Two acts: `schedule it` and
// `not now`. Nothing here is a summary — a summary is what the row shows AFTER this was seen.
//
// Text nodes only: a prompt or a query is rendered as text, never as markup.

import type { ReactElement } from 'react';

import type { ScheduleSpec, ScheduleStep } from '@snugprotocol/protocol';

import { Button } from '../ui/Button.js';
import { CONSENT, stepLabel } from './copy.js';
import { CONSENT_ROWS } from './copy.editor.js';
import { dailyAiBound } from './editorModel.js';

export interface EnableConsentProps {
  steps: readonly ScheduleStep[];
  spec: ScheduleSpec;
  now: Date;
  /** Library id → display name for every app the steps name. */
  appNames: Readonly<Record<string, string>>;
  /** Library id → the hosts its approved connections may call (`approvedHostsByApp`). */
  hostsByApp: Readonly<Record<string, readonly string[]>>;
  busy?: boolean;
  /** The writer refused: shown in words, the acts stay. */
  error?: string;
  onEnable: () => void;
  onNotNow: () => void;
}

export function EnableConsent({ steps, spec, now, appNames, hostsByApp, busy = false, error, onEnable, onNotNow }: EnableConsentProps): ReactElement {
  const bound = dailyAiBound(spec, steps, now);
  return (
    <section className="schedule-consent" role="region" aria-labelledby="schedule-consent-heading" data-testid="enable-consent">
      <h3 id="schedule-consent-heading" className="section-title">
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
          const name = appNames[step.appId] ?? step.appId;
          const hosts = hostsByApp[step.appId] ?? [];
          if (step.kind === 'app-run') {
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
                    <ul className="schedule-consent-queries" data-testid={`consent-queries-${index}`}>
                      {queries.map((sql, q) => (
                        <li key={q}>
                          <code>{sql}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </dd>
                <dt>{CONSENT.hosts}</dt>
                <dd data-testid={`consent-hosts-${index}`}>{hosts.length === 0 ? CONSENT_ROWS.noHosts : hosts.join(', ')}</dd>
              </dl>
            </li>
          );
        })}
      </ol>
      <p className="hint" data-testid="consent-cost">
        {CONSENT.cost}: {CONSENT_ROWS.dailyBound(bound)}
      </p>
      {error !== undefined ? (
        <div className="error-note" role="alert" aria-live="polite" data-testid="consent-error">
          {error}
        </div>
      ) : null}
      <div className="field-row field-row-wrap schedule-actions">
        <Button variant="primary" onClick={onEnable} disabled={busy} data-testid="consent-enable">
          {CONSENT_ROWS.enable}
        </Button>
        <Button variant="ghost" onClick={onNotNow} disabled={busy} data-testid="consent-not-now">
          {CONSENT_ROWS.notNow}
        </Button>
      </div>
    </section>
  );
}
