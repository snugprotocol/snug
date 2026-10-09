// schedule/routes.ts — the scheduling routes, spelled ONCE (TASK-20261009-scheduling-framework
// U1–U5). Every link and every `navigate` under `schedule/` and `views/Schedule*.tsx` builds its
// href here, so the editor route, the result route and the new-schedule query string (`?text=`,
// `?template=`, `?app=`) cannot drift between the row, the hub section, the feed, the create
// bar, the sheet, the chat offer and the templates. The route table itself is `App.tsx`'s.

/** `/schedule/:id` — the editor for one schedule. */
export const editHref = (taskId: string): string => `/schedule/${encodeURIComponent(taskId)}`;

/** `/schedule/:id/result/:dueAt` — one result, opened. */
export const resultHref = (taskId: string, dueAt: string): string => `${editHref(taskId)}/result/${encodeURIComponent(dueAt)}`;

export interface NewScheduleParams {
  /** A sentence to read ("every weekday at 8, summarise my ledger") — the create bar, the sheet, the chat offer. */
  text?: string;
  /** A template name (`editorModel.TEMPLATE_NAMES`). */
  template?: string;
  /** The app an *ask the AI* step starts with — the run-header sheet's *more options*. */
  app?: string;
  /** A `ScheduleProposal` as JSON — the chat's suggestion card's *edit…* (TASK-20261009 P1); read by `parseScheduleProposal`, never trusted raw. The key reads `suggestion`, the user's word (Q8). */
  suggestion?: string;
  /** An in-app path to return to after the save or cancel — the thread the card lives in. Same-origin paths only (`isBackPath`). */
  back?: string;
}

/** `/schedule/new` with whichever of the params the caller has, in this order; the bare route with none. */
export function newScheduleHref(params: NewScheduleParams = {}): string {
  const query = new URLSearchParams();
  if (params.text !== undefined && params.text !== '') query.set('text', params.text);
  if (params.template !== undefined) query.set('template', params.template);
  if (params.app !== undefined) query.set('app', params.app);
  if (params.suggestion !== undefined) query.set('suggestion', params.suggestion);
  if (params.back !== undefined && isBackPath(params.back)) query.set('back', params.back);
  const search = query.toString();
  return search === '' ? '/schedule/new' : `/schedule/new?${search}`;
}

/** A `?back=` the editor will follow: an in-app path (`/run/…`, `/build/…`), never a URL, never protocol-relative. */
export const isBackPath = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\r\n]/.test(value);
