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
//
// TASK-20261010-host-broker PR-4 (D-PR4-15, D-PR4-20; D10, D13): the kind `<select>` and its labels
// stay as they were and gain ONE hint per kind, naming the app — what *ask* and *run* each do. An
// *ask* step gains the tick *let it look things up*: ticked, its line REPLACES *which data?* (the
// step chooses its own questions), while any typed queries stay, as where it starts. When the brain
// cannot use tools for the step's app the editor says so HERE, under the tick, before the first
// result ever has to.
//
// THE BRAIN, THREE WAYS (PR-4 Gate 5, U1; `brainFor`, the engine's own gates handed in by the editor):
// `blocked` — no brain here answers an *ask* step at all (the demo, or a key not set), said under
// EVERY ask step of that app, ticked or not, with the way to Settings; `no-tools` — it answers but
// cannot look things up, said under a ticked step; `tools` — nothing to say. Each line that explains
// a control is attached to it (`aria-describedby`, U11): the tick names the lines under it that are
// on screen, the kind select its one hint — a screen reader hears them with the control.

import type { ReactElement } from 'react';
import { useId } from 'react';
import { Link } from 'react-router';

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
import type { AskBrain } from './askBrain.js';
import { brainBlocked } from './copy.js';
import { STEPS } from './copy.editor.js';
import { emptyNotify, emptyRun, emptyThink, parseRunInput, type StepDraft } from './editorModel.js';
import { SETTINGS_HREF } from './routes.js';

export interface StepsEditorProps {
  steps: StepDraft[];
  apps: readonly AppRecord[];
  onChange: (steps: StepDraft[]) => void;
  /** What the brain an app's *ask* step runs on now can do there (`askBrainFor`). Absent: it can look things up. */
  brainFor?: (appId: string) => AskBrain;
}

/** The ids among `ids` whose line is on screen, as one `aria-describedby` — `undefined` when none is. */
const describedBy = (ids: ReadonlyArray<string | false>): string | undefined => {
  const shown = ids.filter((id): id is string => id !== false);
  return shown.length === 0 ? undefined : shown.join(' ');
};

/** The app a hint names: the step's app, the template's missing one, or "this app" before one is chosen. */
const HINT_APP_FALLBACK = 'this app';

export function StepsEditor({ steps, apps, onChange, brainFor }: StepsEditorProps): ReactElement {
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
          const kindHintId = `${key}-kind-hint`;
          // An ask step's brain, read once its app is chosen and installed (U1), and the ids of the lines under its tick (U11).
          const brain = step.kind === 'app-think' && step.appId !== '' && missing === undefined ? brainFor?.(step.appId) : undefined;
          const blocked = brain === 'blocked';
          const noTools = step.kind === 'app-think' && step.tools && brain === 'no-tools';
          const lineIds = { blocked: `${key}-brain-blocked`, tools: `${key}-tools-line`, noTools: `${key}-tools-unavailable` };
          return (
            <li key={key} className={off ? 'card schedule-step schedule-step-off' : 'card schedule-step'} data-testid={`step-${index}`} data-kind={step.kind}>
              <div className="field-row field-row-wrap schedule-step-head">
                <div className="field">
                  <label htmlFor={`${key}-kind`}>{STEPS.kind}</label>
                  <select
                    id={`${key}-kind`}
                    value={step.kind}
                    aria-describedby={step.kind !== 'notify' ? kindHintId : undefined}
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
                  {step.kind !== 'notify' ? (
                    <span className="hint" id={kindHintId} data-testid={`step-${index}-kind-hint`}>
                      {STEPS.kindHint(step.kind, missing ?? appName(step.appId) ?? HINT_APP_FALLBACK)}
                    </span>
                  ) : null}
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
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={step.tools}
                      aria-describedby={describedBy([blocked && lineIds.blocked, step.tools && lineIds.tools, noTools && lineIds.noTools])}
                      data-testid={`step-${index}-tools`}
                      onChange={(event) => replace(index, { ...step, tools: event.target.checked })}
                    />
                    {STEPS.lookThingsUp}
                  </label>
                  {/* No brain here answers this step at all — ticked or not, it is said first, with the way to fix it (U1). */}
                  {blocked ? (
                    <p className="hint" role="note" id={lineIds.blocked} data-testid={`step-${index}-brain-blocked`}>
                      {brainBlocked.text} · <Link to={SETTINGS_HREF}>{brainBlocked.action}</Link>
                    </p>
                  ) : null}
                  {step.tools ? (
                    <>
                      <p className="hint" id={lineIds.tools} data-testid={`step-${index}-tools-line`}>
                        {STEPS.toolsLine(missing ?? appName(step.appId) ?? HINT_APP_FALLBACK)}
                      </p>
                      {noTools ? (
                        <p className="hint" role="note" id={lineIds.noTools} data-testid={`step-${index}-tools-unavailable`}>
                          {STEPS.toolsUnavailable}
                        </p>
                      ) : null}
                    </>
                  ) : (
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
                  )}
                  {/* Typed queries stay under the line of a step that may look things up: they are where it starts. */}
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
