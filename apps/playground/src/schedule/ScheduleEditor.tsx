// schedule/ScheduleEditor.tsx — the editor FORM (TASK-20261009-scheduling-framework U3, U8;
// ADR-0074 §5; design F1, F3, F6, F8). Top to bottom: the sentence box (typed or `?text=`,
// parsed deterministically; a reading fills the controls, a failure leaves them as they are and
// says so), the title, the when (`SpecControls`), the steps (`StepsEditor`), the catch-up
// sentence with its three choices pre-set from cost (Q12), the alert choice, the live preview
// and cost (`PreviewAndCost`), and — before the FIRST save of anything that spends (asks the AI
// or runs an app — U8: the prompt, the queries, the input, the hosts), or when an imported
// schedule is being turned on — the consent panel (`EnableConsent`), then the one act. The save goes through the engine's own writers (`createTask` / `updateTask`), and a
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
//
// MAKING CHANGES ON ITS OWN (TASK-20261010-host-broker PR-4; ADR-0076 §9; D-PR4-8; D1). Under the
// steps, when the schedule asks ONE app's AI, the task-level control *changes it suggests:* —
// *wait for my OK* / *make them on its own* — shows the task's own state and nothing else (a new
// draft waits). The control is a CHOICE; the consent's tick is the ACT: a save that would make a
// schedule start making changes on its own, or widen what an armed one does (its steps, compared
// canonically, or a shorter gap between runs — `widensAuthority`), goes through `EnableConsent`
// with the tick pre-set to the choice, and is warned about above save first. *wait for my OK*
// disarms on save with no consent; a title, alert or catch-up edit never touches the authority.
// The engine's acts do the writing: `updateTask` (which also disarms a widening it was not told
// about), then `armTask` for a ticked consent or `disarmTask` for a choice to wait.

import type { ReactElement } from 'react';
import { useId, useMemo, useRef, useState } from 'react';

import type { AppRecord, UserDb } from '@snugprotocol/db';
import { SCHEDULE_TITLE_MAX_CHARS, type AlertKind, type MissedPolicy, type ScheduleSpec, type ScheduleStep, type ScheduledTask } from '@snugprotocol/protocol';

import { chatBrainRoute, chatDoorOpen } from '../access/egress.js';
import { useAppProvider } from '../state/appModel.js';
import { useByokKeyPresence, useMode, useProvider } from '../state/mode.js';
import { useBrain } from '../state/webllm.js';
import { Button } from '../ui/Button.js';
import { brainChipLabel } from '../views/BrainChip.js';
import { disarmTask } from './acts.js';
import { EMPTY, alertLabel, alertSentence, imported, missedPolicyLabel, missedPolicySentence } from './copy.js';
import { ACTIONS, CHANGES_CONTROL, SENTENCE, TITLE } from './copy.editor.js';
import { compileSpec, listWords, parseCron } from './cron.js';
import {
  appBrainKind,
  approvedHostsByApp,
  costSteps,
  cronTextFor,
  defaultPolicyFor,
  defaultSpecFor,
  lookUpNamesByApp,
  onItsOwnAppOf,
  prepareSteps,
  specFromCronText,
  titleFromSteps,
  remainderOf,
  titleFromText,
  widensAuthority,
  type EditorDraft,
  type SpecKind,
  type StepDraft,
} from './editorModel.js';
import { EnableConsent, armIfTicked, type EnableChoice } from './EnableConsent.js';
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

/** A save waiting on the consent, and what its tick starts at — the editor's choice, or OFF. */
interface PendingConsent extends PreparedSave {
  presetOnItsOwn: boolean;
}

export function ScheduleEditor({ initial, parseFailed: initialParseFailed, apps, db, task, onSaved, onCancel }: ScheduleEditorProps): ReactElement {
  const id = useId();
  const [draft, setDraft] = useState<EditorDraft>(initial);
  const [parseFailed, setParseFailed] = useState(initialParseFailed);
  const [consent, setConsent] = useState<PendingConsent | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  /**
   * The schedule this form already wrote when the arming after it was refused: a retry arms it
   * (and edits it) instead of writing a second one.
   */
  const written = useRef<ScheduledTask | undefined>(undefined);

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
  // Named top to bottom as the form reads: the title, then the steps, then the when.
  const blocker = titleProblem ?? (prepared.ok ? undefined : prepared.reason) ?? (compiled === undefined ? 'this schedule cannot be compiled — check the when' : undefined);
  const canSave = blocker === undefined && floorRefusal === undefined && !busy && consent === undefined;

  // Making changes on its own: offered for a ONE-app schedule. `existing` is the schedule this
  // form edits — the route's, or the one it already wrote when the arming after it was refused.
  const onItsOwnApp = onItsOwnAppOf(draft.steps);
  const wantsOnItsOwn = onItsOwnApp !== undefined && draft.onItsOwn;
  const existing = written.current ?? task;
  const armed = existing?.writeAuthority !== undefined;
  /** An armed schedule whose steps or timing this save would widen: the consent confirms it again. */
  const widening = existing !== undefined && armed && wantsOnItsOwn && prepared.ok && widensAuthority(existing, { steps: prepared.steps, spec: draft.spec }, now);
  /** The brain an app's AI runs on now cannot look things up there: the chat door's own derivation. */
  const toolsUnavailable = (appId: string): boolean => !chatDoorOpen(chatBrainRoute(db, appId));

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

  /**
   * Write the save, then the authority: `choice` is the consent's answer — absent when the save
   * did not go through the consent, which keeps an authority only where the choice still wants it.
   */
  const commit = async (save: PreparedSave, choice?: EnableChoice): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const target = existing;
    let result: TaskResult;
    let refusal: string | undefined;
    try {
      result =
        target === undefined
          ? await createTask({ title: save.title, steps: save.steps, spec: save.spec, missedPolicy: draft.missedPolicy, alert: draft.alert, provenance: 'user' })
          : await updateTask(target.id, { title: save.title, steps: save.steps, spec: save.spec, missedPolicy: draft.missedPolicy, alert: draft.alert });
      // The consent panel IS the review (Gate 5 S2): the engine refuses an imported schedule
      // on every other path, so this call says so.
      if (result.ok && importedDisabled) result = await setTaskEnabled(result.task.id, true, { reviewed: true });
      if (result.ok) {
        written.current = result.task;
        refusal = await settleAuthority(result.task.id, choice?.onItsOwn ?? wantsOnItsOwn, choice !== undefined);
      }
    } catch (err) {
      result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    setBusy(false);
    if (!result.ok || refusal !== undefined) {
      setError(result.ok ? refusal : result.reason);
      setConsent(undefined);
      return;
    }
    setConsent(undefined);
    onSaved(result.task);
  };

  /**
   * The authority after the write: the consent's tick arms (`ticked` — only a consent may); a
   * choice to wait takes it away. Read from the file, so a disarm the write itself made (a
   * widening) is never written twice. Answers a refusal in words.
   */
  const settleAuthority = async (taskId: string, onItsOwn: boolean, ticked: boolean): Promise<string | undefined> => {
    if (ticked && onItsOwn) return armIfTicked(taskId, { onItsOwn });
    if (onItsOwn || db.getScheduledTask(taskId)?.writeAuthority === undefined) return undefined;
    const disarmed = await disarmTask(taskId);
    return disarmed.ok ? undefined : disarmed.reason;
  };

  const submit = (): void => {
    if (!prepared.ok || compiled === undefined || floorRefusal !== undefined || titleProblem !== undefined) return;
    const save: PreparedSave = { title, steps: prepared.steps, spec: draft.spec };
    // Anything that spends — the brain or the app's own code — is shown before the first enable (U8),
    // and so is a save that starts or widens making changes on its own (D-PR4-8).
    const spends = prepared.steps.some((step) => step.kind !== 'notify');
    const startsOnItsOwn = wantsOnItsOwn && !armed;
    if ((existing === undefined && spends) || importedDisabled || (existing !== undefined && (startsOnItsOwn || widening))) {
      setError(undefined);
      setConsent({ ...save, presetOnItsOwn: wantsOnItsOwn });
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

      <StepsEditor steps={draft.steps} apps={apps} onChange={onSteps} toolsUnavailable={toolsUnavailable} />

      {onItsOwnApp !== undefined ? (
        <fieldset className="schedule-section" data-testid="changes-it-suggests">
          <legend className="section-title">{CHANGES_CONTROL.legend}</legend>
          <div className="schedule-radio-row" role="radiogroup" aria-label={CHANGES_CONTROL.legend}>
            <label className="check-label">
              <input type="radio" name={`${id}-changes`} checked={!draft.onItsOwn} data-testid="changes-wait" onChange={() => update({ onItsOwn: false })} />
              {CHANGES_CONTROL.wait}
            </label>
            <label className="check-label">
              <input type="radio" name={`${id}-changes`} checked={draft.onItsOwn} data-testid="changes-on-its-own" onChange={() => update({ onItsOwn: true })} />
              {CHANGES_CONTROL.onItsOwn}
            </label>
          </div>
        </fieldset>
      ) : null}

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

      {consent !== undefined ? (
        <EnableConsent
          steps={consent.steps}
          spec={consent.spec}
          now={now}
          appNames={appNameRecord}
          hostsByApp={approvedHostsByApp(db, appIdsOf(consent.steps))}
          connectionsByApp={lookUpNamesByApp(db, appIdsOf(consent.steps))}
          presetOnItsOwn={consent.presetOnItsOwn}
          busy={busy}
          {...(error !== undefined ? { error } : {})}
          onEnable={(choice) => void commit(consent, choice)}
          onNotNow={() => setConsent(undefined)}
        />
      ) : (
        <div className="schedule-actions" data-testid="schedule-actions">
          {widening ? (
            <p className="connection-note" role="status" data-testid="armed-warning">
              {CHANGES_CONTROL.armedWarning}
            </p>
          ) : null}
          {error !== undefined ? (
            <div className="error-note" role="alert" aria-live="polite" data-testid="save-error">
              {error}
            </div>
          ) : null}
          {blocker !== undefined ? (
            <p className="hint" role="status" data-testid="save-blocker">
              {blocker}
            </p>
          ) : null}
          <div className="field-row field-row-wrap">
            <Button type="submit" variant="primary" disabled={!canSave} data-testid="schedule-save">
              {existing === undefined || importedDisabled ? ACTIONS.create : ACTIONS.save}
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
