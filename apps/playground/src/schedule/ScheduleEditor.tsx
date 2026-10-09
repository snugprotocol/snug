// schedule/ScheduleEditor.tsx — the editor FORM (TASK-20261009-scheduling-framework U3, U8;
// ADR-0074 §5; design F1, F3, F6, F8). Top to bottom: the sentence box (typed or `?text=`,
// parsed deterministically; a reading fills the controls, a failure leaves them as they are and
// says so), the title, the when (`SpecControls`), the steps (`StepsEditor`), the catch-up
// sentence with its three choices pre-set from cost (Q12), the alert choice, the live preview
// and cost (`PreviewAndCost`), and — before the FIRST save of anything that asks the AI, or
// when an imported schedule is being turned on — the consent panel (`EnableConsent`), then the
// one act. The save goes through the engine's own writers (`createTask` / `updateTask`), and a
// refusal comes back in words.
//
// THE DRAFT (`editorModel.ts`) is the whole state: one object, one `setDraft`, every control a
// pure function of it. THE CLOCK is the page's (`pageModel`): `useNow()` for what is shown —
// the preview, the floor refusal, the consent bound — re-read once a minute like every row,
// and `pageClock.now()` inside each act, so a test can hold one clock still for all of it.
//
// THE BRAIN ON THE COST LINE is the brain the app's question runs on NOW — the per-app pin over
// the resolved default, keyless falling through to the demo brain — named as the brain chip
// names it (`brainChipLabel`), so the two surfaces cannot disagree.

import type { ReactElement } from 'react';
import { useId, useMemo, useState } from 'react';

import type { AppRecord, UserDb } from '@snugprotocol/db';
import { SCHEDULE_TITLE_MAX_CHARS, type AlertKind, type MissedPolicy, type ScheduleSpec, type ScheduleStep, type ScheduledTask } from '@snugprotocol/protocol';

import { useAppProvider } from '../state/appModel.js';
import { useByokKeyPresence, useMode, useProvider } from '../state/mode.js';
import { useBrain } from '../state/webllm.js';
import { Button } from '../ui/Button.js';
import { brainChipLabel } from '../views/BrainChip.js';
import { EMPTY, alertLabel, alertSentence, imported, missedPolicyLabel, missedPolicySentence } from './copy.js';
import { ACTIONS, SENTENCE, STEPS, TITLE } from './copy.editor.js';
import { compileSpec, listWords, parseCron } from './cron.js';
import {
  appBrainKind,
  approvedHostsByApp,
  costSteps,
  cronTextFor,
  defaultPolicyFor,
  defaultSpecFor,
  prepareSteps,
  specFromCronText,
  titleFromSteps,
  remainderOf,
  titleFromText,
  type EditorDraft,
  type SpecKind,
  type StepDraft,
} from './editorModel.js';
import { EnableConsent } from './EnableConsent.js';
import { frequencyFloorRefusal } from './floors.js';
import { hostHonesty } from './honesty.js';
import { pageClock, useNow } from './pageModel.js';
import { readSchedule } from './parseScheduleText.js';
import { PreviewAndCost } from './PreviewAndCost.js';
import { createTask, setTaskEnabled, updateTask, useScheduler, type TaskResult } from './scheduler.js';
import { SpecControls } from './SpecControls.js';
import { StepsEditor } from './StepsEditor.js';
import { appIdsOf } from './taskShape.js';

const MISSED_POLICIES: readonly MissedPolicy[] = ['ask', 'run-once', 'skip'];
const ALERT_KINDS: readonly AlertKind[] = ['inbox', 'notification'];

export interface ScheduleEditorProps {
  initial: EditorDraft;
  /** `?text=` carried no readable time (the view says so; typing re-parses live). */
  parseFailed: boolean;
  apps: readonly AppRecord[];
  db: UserDb;
  /** Present on `/schedule/:id`; absent on `/schedule/new`. */
  task?: ScheduledTask;
  onSaved: (task: ScheduledTask) => void;
  onCancel: () => void;
}

interface PreparedSave {
  title: string;
  steps: ScheduleStep[];
  spec: ScheduleSpec;
}

export function ScheduleEditor({ initial, parseFailed: initialParseFailed, apps, db, task, onSaved, onCancel }: ScheduleEditorProps): ReactElement {
  const id = useId();
  const [draft, setDraft] = useState<EditorDraft>(initial);
  const [parseFailed, setParseFailed] = useState(initialParseFailed);
  const [consent, setConsent] = useState<PreparedSave | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const appNames = useMemo(() => new Map(apps.map((app) => [app.appId, app.displayName] as const)), [apps]);
  const appNameRecord = useMemo(() => Object.fromEntries(appNames), [appNames]);
  // The page's clock, for what is shown: the preview, the floor refusal, the consent bound.
  const now = useNow();
  const provenance = task?.provenance ?? 'user';
  const importedDisabled = task !== undefined && task.provenance === 'imported' && !task.enabled;

  // The brain the FIRST ask-the-AI step's app would run on now (every step names the same brain
  // unless an app pins its own provider — the first app is the one the line names).
  const firstThink = draft.steps.find((step): step is Extract<StepDraft, { kind: 'app-think' }> => step.kind === 'app-think' && step.missingApp === undefined);
  const brain = useBrain();
  const mode = useMode();
  const provider = useProvider();
  const keys = useByokKeyPresence();
  const pinned = useAppProvider(firstThink?.appId ?? '');
  const brainLabel = brainChipLabel(appBrainKind({ brain, mode, provider, pinned, keys }));
  const thinkAppNames = listWords(
    [...new Set(draft.steps.flatMap((step) => (step.kind === 'app-think' && step.missingApp === undefined && step.appId !== '' ? [step.appId] : [])))].map(
      (appId) => appNames.get(appId) ?? appId,
    ),
  );

  const scheduler = useScheduler();
  const honesty = scheduler.honesty ?? hostHonesty(scheduler.leader);

  const liveSteps = costSteps(draft.steps);
  const floorRefusal = frequencyFloorRefusal(draft.spec, provenance, now);
  const prepared = prepareSteps(draft.steps);
  const compiled = compileSpec(draft.spec, now);
  const title = draft.title.trim();
  const titleProblem = title === '' ? TITLE.required : title.length > SCHEDULE_TITLE_MAX_CHARS ? TITLE.tooLong : undefined;
  const laterRelease = !prepared.ok && prepared.reason === STEPS.laterReleaseRefusal ? prepared.reason : undefined;
  // Named top to bottom as the form reads: the hard refusal, then the title, then the steps, then the when.
  const blocker = laterRelease ?? titleProblem ?? (prepared.ok ? undefined : prepared.reason) ?? (compiled === undefined ? 'this schedule cannot be compiled — check the when' : undefined);
  const canSave = blocker === undefined && floorRefusal === undefined && !busy && consent === undefined;

  const update = (patch: Partial<EditorDraft>): void => setDraft((current) => ({ ...current, ...patch }));

  const onText = (text: string): void => {
    const at = pageClock.now();
    const read = text.trim() === '' ? undefined : readSchedule(text, at, draft.spec.tz);
    const spec = read?.spec;
    setParseFailed(text.trim() !== '' && spec === undefined);
    update({
      text,
      ...(spec !== undefined ? { spec, mode: spec.kind, cron: cronTextFor(spec, at) } : {}),
      // The title is the sentence MINUS the schedule phrase ("remind me to call mom at 5" →
      // "call mom"), the same rule the create bar's prefill uses — the whole sentence only when
      // nothing is left after the phrase.
      ...(draft.titleTouched || text.trim() === '' ? {} : { title: titleFromText(remainderOf(text, read?.phrase ?? '') || text) }),
    });
  };

  const onMode = (kind: SpecKind): void => {
    const at = pageClock.now();
    if (kind === 'custom') update({ mode: 'custom', cron: cronTextFor(draft.spec, at) });
    else if (draft.spec.kind === kind) update({ mode: kind });
    else update({ mode: kind, spec: defaultSpecFor(kind, draft.spec, at) });
  };

  const onCron = (text: string): void => {
    const spec = specFromCronText(text, draft.spec);
    update({ cron: text, ...(spec !== undefined ? { spec } : {}) });
  };

  // Leaving the cron field: a cron that maps to a preset shows as that preset's chip.
  const onCronCommit = (): void => setDraft((current) => ({ ...current, mode: parseCron(current.cron) ? current.spec.kind : 'custom' }));

  const onSteps = (steps: StepDraft[]): void =>
    update({
      steps,
      ...(draft.missedTouched ? {} : { missedPolicy: defaultPolicyFor(steps) }),
      ...(draft.titleTouched || draft.text.trim() !== '' ? {} : { title: titleFromSteps(steps, appNames) }),
    });

  const commit = async (save: PreparedSave): Promise<void> => {
    setBusy(true);
    setError(undefined);
    let result: TaskResult;
    try {
      result =
        task === undefined
          ? await createTask({ title: save.title, steps: save.steps, spec: save.spec, missedPolicy: draft.missedPolicy, alert: draft.alert, provenance: 'user' })
          : await updateTask(task.id, { title: save.title, steps: save.steps, spec: save.spec, missedPolicy: draft.missedPolicy, alert: draft.alert });
      // The consent panel IS the review (Gate 5 S2): the engine refuses an imported schedule
      // on every other path, so this call says so.
      if (result.ok && importedDisabled) result = await setTaskEnabled(task.id, true, { reviewed: true });
    } catch (err) {
      result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    setBusy(false);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setConsent(undefined);
    onSaved(result.task);
  };

  const submit = (): void => {
    if (!prepared.ok || compiled === undefined || floorRefusal !== undefined || titleProblem !== undefined) return;
    const save: PreparedSave = { title, steps: prepared.steps, spec: draft.spec };
    const asksAi = prepared.steps.some((step) => step.kind === 'app-think');
    if ((task === undefined && asksAi) || importedDisabled) {
      setError(undefined);
      setConsent(save);
      return;
    }
    void commit(save);
  };

  return (
    <form
      className="schedule-editor"
      data-testid="schedule-editor"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {importedDisabled ? (
        <p className="connection-note" role="status" data-testid="imported-note">
          {imported.text}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor={`${id}-text`}>{SENTENCE.label}</label>
        <input
          id={`${id}-text`}
          type="text"
          className="schedule-sentence"
          value={draft.text}
          placeholder={EMPTY.createPlaceholder}
          autoComplete="off"
          data-testid="schedule-text"
          onChange={(event) => onText(event.target.value)}
        />
        <span className="hint" aria-live="polite" data-testid="schedule-text-note">
          {parseFailed ? SENTENCE.cannotRead : ''}
        </span>
      </div>

      <div className="field">
        <label htmlFor={`${id}-title`}>{TITLE.label}</label>
        <input
          id={`${id}-title`}
          type="text"
          required
          maxLength={SCHEDULE_TITLE_MAX_CHARS}
          value={draft.title}
          data-testid="schedule-title"
          onChange={(event) => update({ title: event.target.value, titleTouched: true })}
        />
      </div>

      <SpecControls mode={draft.mode} spec={draft.spec} cron={draft.cron} onMode={onMode} onSpec={(spec) => update({ spec })} onCron={onCron} onCronCommit={onCronCommit} />

      <StepsEditor steps={draft.steps} apps={apps} onChange={onSteps} />

      <fieldset className="schedule-section" data-testid="missed-policy">
        <legend className="section-title">{missedPolicySentence}</legend>
        <div className="schedule-radio-row" role="radiogroup" aria-label={missedPolicySentence}>
          {MISSED_POLICIES.map((policy) => (
            <label key={policy} className="check-label">
              <input
                type="radio"
                name={`${id}-missed`}
                value={policy}
                checked={draft.missedPolicy === policy}
                data-testid={`missed-${policy}`}
                onChange={() => update({ missedPolicy: policy, missedTouched: true })}
              />
              {missedPolicyLabel(policy)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="schedule-section" data-testid="alert-kind">
        <legend className="section-title">{alertSentence}</legend>
        <div className="schedule-radio-row" role="radiogroup" aria-label={alertSentence}>
          {ALERT_KINDS.map((kind) => (
            <label key={kind} className="check-label">
              <input type="radio" name={`${id}-alert`} value={kind} checked={draft.alert === kind} data-testid={`alert-${kind}`} onChange={() => update({ alert: kind })} />
              {alertLabel(kind)}
            </label>
          ))}
        </div>
      </fieldset>

      <PreviewAndCost spec={draft.spec} steps={liveSteps} now={now} brainLabel={brainLabel} appNames={thinkAppNames} floorRefusal={floorRefusal} honesty={honesty} />

      {laterRelease !== undefined ? (
        <div className="error-note" role="alert" aria-live="polite" data-testid="later-release-refusal">
          {laterRelease}
        </div>
      ) : null}

      {consent !== undefined ? (
        <EnableConsent
          steps={consent.steps}
          spec={consent.spec}
          now={now}
          appNames={appNameRecord}
          hostsByApp={approvedHostsByApp(db, appIdsOf(consent.steps))}
          busy={busy}
          {...(error !== undefined ? { error } : {})}
          onEnable={() => void commit(consent)}
          onNotNow={() => setConsent(undefined)}
        />
      ) : (
        <div className="schedule-actions" data-testid="schedule-actions">
          {error !== undefined ? (
            <div className="error-note" role="alert" aria-live="polite" data-testid="save-error">
              {error}
            </div>
          ) : null}
          {blocker !== undefined && laterRelease === undefined ? (
            <p className="hint" role="status" data-testid="save-blocker">
              {blocker}
            </p>
          ) : null}
          <div className="field-row field-row-wrap">
            <Button type="submit" variant="primary" disabled={!canSave} data-testid="schedule-save">
              {task === undefined || importedDisabled ? ACTIONS.create : ACTIONS.save}
            </Button>
            <Button variant="ghost" onClick={onCancel} data-testid="schedule-cancel">
              {ACTIONS.cancel}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
