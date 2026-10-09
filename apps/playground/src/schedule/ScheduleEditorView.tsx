// schedule/ScheduleEditorView.tsx — the editor ROUTE (TASK-20261009-scheduling-framework U3;
// design F3): `/schedule/new` and `/schedule/:id`, deep-linkable, surviving a reload. The view
// reads the query string — `?text=` (the create bar, the chat offer, the run-header sheet),
// `?template=nudge|spend-review|friday-review|morning-weather` (the templates), `?app=<id>` (the
// sheet's preselected app), `?suggestion=<JSON>` + `?back=<path>` (the chat's suggestion card,
// TASK-20261009 P1) — loads the library and, on `:id`, the schedule, and hands ONE draft to
// `ScheduleEditor`. A save navigates to `/schedule`, or back to the thread a card came from.
//
// Where the host says `allows('schedule') === false` the route is a named refusal, never an
// empty main region (the `/s/:id` precedent in App.tsx).

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

import type { AppRecord, UserDb } from '@snugprotocol/db';
import type { ScheduledTask } from '@snugprotocol/protocol';

import { allows } from '../platform/platform.js';
import { getUserDb } from '../state/userdb.js';
import '../theme/schedule-editor.css';
import { EmptyState } from '../ui/EmptyState.js';
import { EDITOR_HEADING, FROM_SUGGESTION, STATES } from './copy.editor.js';
import { draftFromTask, initialDraft, type EditorDraft } from './editorModel.js';
import { isBackPath } from './routes.js';
import { ScheduleEditor } from './ScheduleEditor.js';

type Load =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; db: UserDb; apps: AppRecord[]; task?: ScheduledTask; draft: EditorDraft; parseFailed: boolean };

export function ScheduleEditorView(): ReactElement {
  const { id } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const query = search.toString();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setLoad({ phase: 'loading' });
    getUserDb()
      .then((db) => {
        if (cancelled) return;
        const apps = db.listApps();
        const now = new Date();
        if (id !== undefined) {
          const task = db.getScheduledTask(id);
          if (task === undefined) {
            setLoad({ phase: 'missing' });
            return;
          }
          setLoad({ phase: 'ready', db, apps, task, draft: draftFromTask(task, now), parseFailed: false });
          return;
        }
        const params = new URLSearchParams(query);
        const { draft, parseFailed } = initialDraft({
          text: params.get('text'),
          template: params.get('template'),
          app: params.get('app'),
          proposal: params.get('suggestion'),
          apps,
          now,
        });
        setLoad({ phase: 'ready', db, apps, draft, parseFailed });
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoad({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [id, query]);

  if (!allows('schedule')) {
    return (
      <div className="run-overlay" data-testid="schedule-editor-unavailable">
        <EmptyState
          glyph="◷"
          title={STATES.unavailable}
          lesson="this host switched scheduling off — open your file in the Snug playground or in Snug for Mac."
          action={
            <Link to="/" className="btn">
              back to your apps
            </Link>
          }
        />
      </div>
    );
  }

  const back = (
    <Link to="/schedule" className="btn" data-testid="schedule-back">
      {STATES.back}
    </Link>
  );
  // The chat's suggestion card says where it came from; the save and the cancel return there.
  const params = new URLSearchParams(query);
  const backParam = params.get('back');
  const backTo = isBackPath(backParam) ? backParam : '/schedule';
  const fromSuggestion = params.get('suggestion') !== null;

  return (
    <div className="settings schedule-editor-page" data-testid="schedule-editor-view">
      <h1>{id === undefined ? EDITOR_HEADING.new : EDITOR_HEADING.edit}</h1>
      {load.phase === 'loading' ? (
        <p className="hint" role="status" data-testid="schedule-editor-loading">
          {STATES.loading}
        </p>
      ) : load.phase === 'missing' ? (
        <EmptyState glyph="◷" title={STATES.notFound} lesson="it may have been deleted, or the link may be from another file." action={back} />
      ) : load.phase === 'error' ? (
        <div className="error-note" role="alert" data-testid="schedule-editor-error">
          {load.message}
        </div>
      ) : (
        <>
          {fromSuggestion ? (
            <p className="hint" role="status" data-testid="from-suggestion-note">
              {FROM_SUGGESTION.note}
            </p>
          ) : null}
          <ScheduleEditor
            key={load.task?.id ?? query}
            initial={load.draft}
            parseFailed={load.parseFailed}
            apps={load.apps}
            db={load.db}
            {...(load.task !== undefined ? { task: load.task } : {})}
            onSaved={() => navigate(backTo)}
            onCancel={() => navigate(backTo)}
          />
        </>
      )}
    </div>
  );
}
