// schedule/ScheduleCreateBar.tsx — the sentence-first create bar (TASK-20261009-scheduling-
// framework U2; design F1). FIRST on the page: a person types "every weekday at 8, summarise
// my ledger" and lands in the editor with the when already read — one click from *schedule it*.
//
// Nothing is parsed and nothing is written here: the sentence rides to the editor route as
// `?text=` (`routes.newScheduleHref`) and the editor reads it deterministically itself, so the
// two can never disagree about what the words mean; a sentence the grammar cannot read still
// opens the editor with the text, where the editor says it could not read the time.

import { useState, type KeyboardEvent, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';

import { Button } from '../ui/Button.js';
import { EMPTY } from './copy.js';
import { PAGE } from './copy.page.js';
import { newScheduleHref } from './routes.js';

export function ScheduleCreateBar(): ReactElement {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const trimmed = text.trim();

  const submit = (): void => {
    if (trimmed === '') return;
    navigate(newScheduleHref({ text: trimmed }));
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
      <Link to={newScheduleHref()} className="btn" data-testid="schedule-new">
        {PAGE.newSchedule}
      </Link>
    </div>
  );
}
