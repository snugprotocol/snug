// schedule/ScheduleSheet.tsx — the run header's SMALL sheet (TASK-20261009-scheduling-framework
// U5; design F3; the share-sheet precedent). For THIS app only: the sentence box, the one step
// kind — *ask <app>'s AI* with a prompt, or *remind me* — and two acts: `more options` opens the
// full editor prefilled (`routes.newScheduleHref({ text, app })`), `schedule it` writes the
// schedule here through the engine's own `createTask`, behind the consent panel whenever the
// step asks the AI (U8). Through `ConfirmOverlay`, which PORTALS to <body> — the header's
// backdrop-filter would otherwise confine a fixed overlay to the header's box (lesson
// 2026-08-26).
//
// THE WORDS BESIDE THE SCHEDULE are read the editor's way and no other (design F1): ONE
// `readSchedule` gives the when and the phrase it was read from, and `editorModel.remainderOf`
// keeps what the person typed around it — "remind me to stretch every weekday at 8" →
// "stretch" — as the reminder's title and message or the ask's title. When nothing is left,
// the app's name stands in. The clock is the page's (`useNow` for what is shown,
// `pageClock.now()` in the act), the same one the editor and the rows read.

import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { SCHEDULE_NOTIFY_BODY_MAX_CHARS, SCHEDULE_PROMPT_MAX_CHARS, SCHEDULE_TITLE_MAX_CHARS, type ScheduleSpec, type ScheduleStep } from '@snugprotocol/protocol';

import { getUserDb } from '../state/userdb.js';
import '../theme/schedule-editor.css';
import { Button } from '../ui/Button.js';
import { ConfirmOverlay } from '../ui/ConfirmOverlay.js';
import { EMPTY, stepLabel } from './copy.js';
import { ACTIONS, SENTENCE, SHEET, STEPS } from './copy.editor.js';
import { describeSpec } from './cron.js';
import { approvedHostsByApp, remainderOf } from './editorModel.js';
import { EnableConsent } from './EnableConsent.js';
import { nextWords, pageClock, useNow } from './pageModel.js';
import { readSchedule } from './parseScheduleText.js';
import { newScheduleHref } from './routes.js';
import { createTask } from './scheduler.js';

export interface ScheduleSheetProps {
  appId: string;
  onClose: () => void;
}

type SheetKind = 'app-think' | 'notify';

export function ScheduleSheet({ appId, onClose }: ScheduleSheetProps): ReactElement {
  const navigate = useNavigate();
  const [name, setName] = useState<string>('this app');
  const [text, setText] = useState('');
  const [kind, setKind] = useState<SheetKind>('app-think');
  const [prompt, setPrompt] = useState('');
  const [consent, setConsent] = useState<{ steps: ScheduleStep[]; spec: ScheduleSpec; title: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  const [hosts, setHosts] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let cancelled = false;
    void getUserDb().then((db) => {
      if (cancelled) return;
      const app = db.getApp(appId);
      if (app !== undefined) setName(app.displayName);
      setHosts(approvedHostsByApp(db, [appId]));
    });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  const now = useNow();
  // One reading: the when, and the phrase it was read from — the remainder is the task's own words.
  const reading = useMemo(() => (text.trim() === '' ? undefined : readSchedule(text, now, 'device')), [text, now]);
  const spec = reading?.spec;
  const words = remainderOf(text, reading?.phrase ?? '');
  const ready = spec !== undefined && (kind === 'notify' || prompt.trim() !== '');

  const build = (): { steps: ScheduleStep[]; spec: ScheduleSpec; title: string } | undefined => {
    if (spec === undefined) return undefined;
    if (kind === 'notify') {
      const title = (words || name).slice(0, SCHEDULE_TITLE_MAX_CHARS);
      const body = (words || `open ${name}`).slice(0, SCHEDULE_NOTIFY_BODY_MAX_CHARS);
      return { steps: [{ kind: 'notify', title, body }], spec, title };
    }
    const ask = prompt.trim().slice(0, SCHEDULE_PROMPT_MAX_CHARS);
    if (ask === '') return undefined;
    return { steps: [{ kind: 'app-think', appId, prompt: ask, context: { maxRows: 50 } }], spec, title: (words || stepLabel('app-think', name)).slice(0, SCHEDULE_TITLE_MAX_CHARS) };
  };

  const commit = async (save: { steps: ScheduleStep[]; spec: ScheduleSpec; title: string }): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const result = await createTask({ title: save.title, steps: save.steps, spec: save.spec, provenance: 'user' });
    setBusy(false);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setConsent(undefined);
    setDone(ACTIONS.scheduled(nextWords(result.task.spec, pageClock.now(), new Date(result.task.createdAt))));
  };

  const scheduleIt = (): void => {
    const save = build();
    if (save === undefined) return;
    if (kind === 'app-think') {
      setConsent(save);
      return;
    }
    void commit(save);
  };

  const moreOptions = (): void => {
    onClose();
    navigate(newScheduleHref({ text: text.trim(), app: appId }));
  };

  const heading = SHEET.heading(name);
  return (
    <ConfirmOverlay ariaLabel={heading} cardClassName="release-notes-card schedule-sheet" data-testid="schedule-sheet">
      <div className="release-notes-head">
        <h2 className="net-confirm-title">{heading}</h2>
        <Button variant="ghost" aria-label={`${ACTIONS.close} ${heading}`} onClick={onClose}>
          ✕ {ACTIONS.close}
        </Button>
      </div>
      <div className="release-notes-scroll schedule-sheet-body">
        {done !== undefined ? (
          <p className="connection-note" role="status" data-testid="sheet-done">
            {done}
          </p>
        ) : consent !== undefined ? (
          <EnableConsent
            steps={consent.steps}
            spec={consent.spec}
            now={now}
            appNames={{ [appId]: name }}
            hostsByApp={hosts}
            busy={busy}
            {...(error !== undefined ? { error } : {})}
            onEnable={() => void commit(consent)}
            onNotNow={() => setConsent(undefined)}
          />
        ) : (
          <>
            <div className="field">
              <label htmlFor="schedule-sheet-text">{SENTENCE.label}</label>
              <input
                id="schedule-sheet-text"
                type="text"
                className="schedule-sentence"
                value={text}
                placeholder={EMPTY.createPlaceholder}
                autoComplete="off"
                data-testid="sheet-text"
                onChange={(event) => setText(event.target.value)}
              />
              <span className="hint" aria-live="polite" data-testid="sheet-text-note">
                {text.trim() === '' ? '' : spec === undefined ? SENTENCE.cannotReadSheet : describeSpec(spec)}
              </span>
            </div>
            <div className="field" role="radiogroup" aria-label={STEPS.kind}>
              <span className="schedule-radio-legend">{STEPS.kind}</span>
              <label className="check-label">
                <input type="radio" name="schedule-sheet-kind" value="app-think" checked={kind === 'app-think'} data-testid="sheet-kind-ask" onChange={() => setKind('app-think')} />
                {stepLabel('app-think', name)}
              </label>
              <label className="check-label">
                <input type="radio" name="schedule-sheet-kind" value="notify" checked={kind === 'notify'} data-testid="sheet-kind-remind" onChange={() => setKind('notify')} />
                {stepLabel('notify')}
              </label>
            </div>
            {kind === 'app-think' ? (
              <div className="field">
                <label htmlFor="schedule-sheet-prompt">{STEPS.prompt}</label>
                <textarea id="schedule-sheet-prompt" rows={3} maxLength={SCHEDULE_PROMPT_MAX_CHARS} value={prompt} data-testid="sheet-prompt" onChange={(event) => setPrompt(event.target.value)} />
              </div>
            ) : null}
            {error !== undefined ? (
              <div className="error-note" role="alert" aria-live="polite" data-testid="sheet-error">
                {error}
              </div>
            ) : null}
            <div className="field-row field-row-wrap schedule-actions">
              <Button variant="primary" onClick={scheduleIt} disabled={!ready || busy} data-testid="sheet-schedule-it">
                {ACTIONS.create}
              </Button>
              <Button variant="ghost" onClick={moreOptions} data-testid="sheet-more-options">
                {ACTIONS.moreOptions}
              </Button>
            </div>
          </>
        )}
      </div>
    </ConfirmOverlay>
  );
}
