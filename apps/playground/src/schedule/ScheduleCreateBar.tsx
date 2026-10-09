// schedule/ScheduleCreateBar.tsx — the sentence-first create bar (TASK-20261009-scheduling-
// framework U2; design F1). FIRST on the page: a person types "every weekday at 8, summarise
// my ledger" and lands in the editor with the when already read — one click from *schedule it*.
//
// The parse happens here only to RIDE ALONG (`?spec=`): the editor re-reads the sentence
// deterministically either way, and a sentence the grammar cannot read still opens the editor
// with the text, where the editor says it could not read the time. Nothing is written here.

import { useState, type KeyboardEvent, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';

import { Button } from '../ui/Button.js';
import { EMPTY } from './copy.js';
import { PAGE } from './copy.page.js';
import { pageClock } from './pageModel.js';
import { parseScheduleText } from './parseScheduleText.js';

/** The editor route for a typed sentence — the text always, the parsed when beside it when there is one. */
export function editorHrefForText(text: string, now: Date = pageClock.now()): string {
  const spec = parseScheduleText(text, now, 'device');
  const params = new URLSearchParams({ text });
  if (spec !== undefined) params.set('spec', JSON.stringify(spec));
  return `/schedule/new?${params.toString()}`;
}

export function ScheduleCreateBar(): ReactElement {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const trimmed = text.trim();

  const submit = (): void => {
    if (trimmed === '') return;
    navigate(editorHrefForText(trimmed));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') submit();
  };

  return (
    <div className="create-bar schedule-create-bar" data-testid="schedule-create-bar">
      <input
        value={text}
        placeholder={EMPTY.createPlaceholder}
        aria-label={PAGE.createLabel}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <Button variant="primary" onClick={submit} disabled={trimmed === ''} data-testid="schedule-create-submit">
        {PAGE.createSubmit}
      </Button>
      <Link to="/schedule/new" className="btn" data-testid="schedule-new">
        {PAGE.newSchedule}
      </Link>
    </div>
  );
}
