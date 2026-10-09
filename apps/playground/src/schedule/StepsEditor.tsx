// schedule/StepsEditor.tsx — the STEPS of a schedule (TASK-20261009-scheduling-framework U3;
// scope F17). One to five steps, each a card: *remind me* (a title and a message), *ask <app>'s
// AI* (an app from the library — installed, owned apps only — a prompt, and "which data?": let
// the AI read the app's tables, or up to four read-only SELECTs TYPED BY THE USER and checked
// with the protocol's `isReadOnlySelect`; never authored by a brain here), and *run <app>* (an
// app, an optional input ≤ 1 KiB the app reads at that run, and the note that the app must
// handle scheduled runs — PR-B, A-UI). A template step whose app is not installed renders
// disabled, naming the app to add.
//
// Internals stay hidden until asked for: the data choice defaults to the tables, and the query
// fields appear only under "specific queries (advanced)".

import type { ReactElement } from 'react';
import { useId } from 'react';

import type { AppRecord } from '@snugprotocol/db';
import {
  SCHEDULE_APP_INPUT_MAX_BYTES,
  SCHEDULE_CONTEXT_MAX_ROWS,
  SCHEDULE_CONTEXT_SQL_MAX_CHARS,
  SCHEDULE_CONTEXT_SQL_MAX_STATEMENTS,
  SCHEDULE_MAX_STEPS,
  SCHEDULE_NOTIFY_BODY_MAX_CHARS,
  SCHEDULE_PROMPT_MAX_CHARS,
  SCHEDULE_TITLE_MAX_CHARS,
  isReadOnlySelect,
} from '@snugprotocol/protocol';

import { Button } from '../ui/Button.js';
import { STEPS } from './copy.editor.js';
import { emptyNotify, emptyRun, emptyThink, parseRunInput, type StepDraft } from './editorModel.js';

export interface StepsEditorProps {
  steps: StepDraft[];
  apps: readonly AppRecord[];
  onChange: (steps: StepDraft[]) => void;
}

export function StepsEditor({ steps, apps, onChange }: StepsEditorProps): ReactElement {
  const id = useId();
  const appName = (appId: string): string | undefined => apps.find((app) => app.appId === appId)?.displayName;
  const replace = (index: number, step: StepDraft): void => onChange(steps.map((s, i) => (i === index ? step : s)));
  const remove = (index: number): void => onChange(steps.filter((_, i) => i !== index));

  return (
    <fieldset className="schedule-section" data-testid="steps-editor">
      <legend className="section-title">{STEPS.legend}</legend>
      <ol className="schedule-steps">
        {steps.map((step, index) => {
          const key = `${id}-${index}`;
          const missing = step.kind !== 'notify' ? step.missingApp : undefined;
          const off = missing !== undefined;
          return (
            <li key={key} className={off ? 'card schedule-step schedule-step-off' : 'card schedule-step'} data-testid={`step-${index}`} data-kind={step.kind}>
              <div className="field-row field-row-wrap schedule-step-head">
                <div className="field">
                  <label htmlFor={`${key}-kind`}>{STEPS.kind}</label>
                  <select
                    id={`${key}-kind`}
                    value={step.kind}
                    data-testid={`step-${index}-kind`}
                    onChange={(event) => {
                      const kind = event.target.value;
                      const keepApp = step.kind !== 'notify' ? step.appId : '';
                      if (kind === 'notify') replace(index, emptyNotify());
                      else if (kind === 'app-think') replace(index, emptyThink(keepApp));
                      else if (kind === 'app-run') replace(index, emptyRun(keepApp));
                    }}
                  >
                    <option value="notify">{STEPS.remind}</option>
                    <option value="app-think">{STEPS.ask()}</option>
                    <option value="app-run">{STEPS.run()}</option>
                  </select>
                </div>
                {steps.length > 1 ? (
                  <Button variant="ghost" onClick={() => remove(index)} aria-label={`${STEPS.remove} ${index + 1}`} data-testid={`step-${index}-remove`}>
                    {STEPS.remove}
                  </Button>
                ) : null}
              </div>

              {missing !== undefined ? (
                <p className="hint" role="note" data-testid={`step-${index}-missing`}>
                  {STEPS.appMissing(missing)}
                </p>
              ) : null}

              {step.kind === 'notify' ? (
                <fieldset className="schedule-step-body" disabled={off}>
                  <div className="field">
                    <label htmlFor={`${key}-title`}>{STEPS.remindTitle}</label>
                    <input
                      id={`${key}-title`}
                      type="text"
                      maxLength={SCHEDULE_TITLE_MAX_CHARS}
                      value={step.title}
                      data-testid={`step-${index}-title`}
                      onChange={(event) => replace(index, { ...step, title: event.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`${key}-body`}>{STEPS.remindBody}</label>
                    <input
                      id={`${key}-body`}
                      type="text"
                      maxLength={SCHEDULE_NOTIFY_BODY_MAX_CHARS}
                      value={step.body}
                      data-testid={`step-${index}-body`}
                      onChange={(event) => replace(index, { ...step, body: event.target.value })}
                    />
                  </div>
                </fieldset>
              ) : step.kind === 'app-run' ? (
                <fieldset className="schedule-step-body" disabled={off}>
                  <div className="field">
                    <label htmlFor={`${key}-app`}>{STEPS.app}</label>
                    {apps.length === 0 && missing === undefined ? (
                      <span className="hint" data-testid={`step-${index}-no-apps`}>
                        {STEPS.noApps}
                      </span>
                    ) : null}
                    <select
                      id={`${key}-app`}
                      value={step.appId}
                      data-testid={`step-${index}-app`}
                      onChange={(event) => replace(index, { ...step, appId: event.target.value })}
                    >
                      <option value="">{missing ?? STEPS.pickApp}</option>
                      {apps.map((app) => (
                        <option key={app.appId} value={app.appId}>
                          {app.displayName}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor={`${key}-input`}>{STEPS.runInput}</label>
                    <textarea
                      id={`${key}-input`}
                      rows={2}
                      spellCheck={false}
                      maxLength={SCHEDULE_APP_INPUT_MAX_BYTES}
                      value={step.input}
                      aria-invalid={!parseRunInput(step.input).ok}
                      data-testid={`step-${index}-input`}
                      onChange={(event) => replace(index, { ...step, input: event.target.value })}
                    />
                    <span className="hint">{STEPS.runInputHint}</span>
                    {parseRunInput(step.input).ok ? null : (
                      <div className="error-note" role="alert">
                        {STEPS.runInputTooLong}
                      </div>
                    )}
                  </div>
                  <p className="hint" role="note" data-testid={`step-${index}-run-note`}>
                    {STEPS.runNote(missing ?? appName(step.appId) ?? 'this app')}
                  </p>
                </fieldset>
              ) : step.kind === 'app-think' ? (
                <fieldset className="schedule-step-body" disabled={off}>
                  <div className="field">
                    <label htmlFor={`${key}-app`}>{STEPS.app}</label>
                    {apps.length === 0 && missing === undefined ? (
                      <span className="hint" data-testid={`step-${index}-no-apps`}>
                        {STEPS.noApps}
                      </span>
                    ) : null}
                    <select
                      id={`${key}-app`}
                      value={step.appId}
                      data-testid={`step-${index}-app`}
                      onChange={(event) => replace(index, { ...step, appId: event.target.value })}
                    >
                      <option value="">{missing ?? STEPS.pickApp}</option>
                      {apps.map((app) => (
                        <option key={app.appId} value={app.appId}>
                          {app.displayName}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor={`${key}-prompt`}>{STEPS.prompt}</label>
                    <textarea
                      id={`${key}-prompt`}
                      rows={3}
                      maxLength={SCHEDULE_PROMPT_MAX_CHARS}
                      value={step.prompt}
                      data-testid={`step-${index}-prompt`}
                      onChange={(event) => replace(index, { ...step, prompt: event.target.value })}
                    />
                  </div>
                  <div className="field" role="radiogroup" aria-label={STEPS.data}>
                    <span className="schedule-radio-legend">{STEPS.data}</span>
                    <label className="check-label">
                      <input
                        type="radio"
                        name={`${key}-data`}
                        value="tables"
                        checked={step.dataMode === 'tables'}
                        data-testid={`step-${index}-data-tables`}
                        onChange={() => replace(index, { ...step, dataMode: 'tables' })}
                      />
                      {STEPS.dataTables}
                    </label>
                    <label className="check-label">
                      <input
                        type="radio"
                        name={`${key}-data`}
                        value="queries"
                        checked={step.dataMode === 'queries'}
                        data-testid={`step-${index}-data-queries`}
                        onChange={() => replace(index, { ...step, dataMode: 'queries' })}
                      />
                      {STEPS.dataQueries}
                    </label>
                  </div>
                  {step.dataMode === 'queries' ? (
                    <div className="schedule-queries" data-testid={`step-${index}-queries`}>
                      <span className="hint">{STEPS.queryHint}</span>
                      {step.sql.map((query, q) => {
                        const bad = query.trim() !== '' && !isReadOnlySelect(query.trim());
                        return (
                          <div className="field" key={`${key}-q${q}`}>
                            <label htmlFor={`${key}-q${q}`}>{STEPS.query(q + 1)}</label>
                            <textarea
                              id={`${key}-q${q}`}
                              rows={2}
                              spellCheck={false}
                              maxLength={SCHEDULE_CONTEXT_SQL_MAX_CHARS}
                              value={query}
                              aria-invalid={bad}
                              data-testid={`step-${index}-query-${q}`}
                              onChange={(event) => replace(index, { ...step, sql: step.sql.map((s, i) => (i === q ? event.target.value : s)) })}
                            />
                            {bad ? (
                              <div className="error-note" role="alert">
                                {STEPS.queryInvalid}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                      <div className="field-row field-row-wrap">
                        {step.sql.length < SCHEDULE_CONTEXT_SQL_MAX_STATEMENTS ? (
                          <Button variant="ghost" onClick={() => replace(index, { ...step, sql: [...step.sql, ''] })} data-testid={`step-${index}-add-query`}>
                            + {STEPS.query(step.sql.length + 1)}
                          </Button>
                        ) : null}
                        <div className="field">
                          <label htmlFor={`${key}-rows`}>{STEPS.maxRows}</label>
                          <input
                            id={`${key}-rows`}
                            type="number"
                            min={1}
                            max={SCHEDULE_CONTEXT_MAX_ROWS}
                            value={step.maxRows}
                            data-testid={`step-${index}-max-rows`}
                            onChange={(event) =>
                              replace(index, { ...step, maxRows: Math.max(1, Math.min(SCHEDULE_CONTEXT_MAX_ROWS, Math.round(Number(event.target.value) || 1))) })
                            }
                          />
                        </div>
                      </div>
                    </div>
                  ) : null}
                </fieldset>
              ) : null}
            </li>
          );
        })}
      </ol>
      {steps.length < SCHEDULE_MAX_STEPS ? (
        <Button onClick={() => onChange([...steps, emptyNotify()])} data-testid="step-add">
          + {STEPS.add}
        </Button>
      ) : (
        <span className="hint">{STEPS.tooMany}</span>
      )}
    </fieldset>
  );
}
