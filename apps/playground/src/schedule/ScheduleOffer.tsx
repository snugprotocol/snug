// schedule/ScheduleOffer.tsx — the deterministic chat offer (TASK-20261009-scheduling-framework
// E10; ADR-0074 §4; design F10): a user message that reads like a schedule gets one inline,
// dismissible line — "looks like a schedule: every weekday at 8 — review" — whose one act opens
// the editor route prefilled with the message. On EVERY brain, because it never calls one: the
// grammar is `parseScheduleText.ts`'s (`scheduleOffer`), regexes and tables, no transport.
//
// MOUNTED BESIDE EACH USER MESSAGE in `ChatLog` (the one place both the builder chat and the
// run rail's chat pass through), keyed by the message id, so the parse is memoised per message
// (`useMemo` on the text; `memo` on the component) and the dismissed state is the instance's
// own — one message, one offer, one dismissal.

import { memo, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { chatOffer } from './copy.js';
import { OFFER } from './copy.page.js';
import { pageClock } from './pageModel.js';
import { scheduleOffer } from './parseScheduleText.js';
import { newScheduleHref } from './routes.js';

export interface ScheduleOfferProps {
  /** The user's message, exactly as sent — what the editor route receives. */
  text: string;
}

export const ScheduleOffer = memo(function ScheduleOffer({ text }: ScheduleOfferProps): ReactElement | null {
  // `now` matters only to relative phrases ("in 20 minutes"), and only for the phrase quoted
  // back; the editor re-parses the text at its own `now`.
  const offer = useMemo(() => scheduleOffer(text, pageClock.now(), 'device'), [text]);
  const [dismissed, setDismissed] = useState(false);
  if (offer === undefined || dismissed) return null;
  const copy = chatOffer(offer.phrase);
  return (
    <div className="schedule-offer" data-testid="schedule-offer">
      <span className="schedule-offer-text">{copy.text}</span>
      <Link to={newScheduleHref({ text })} className="btn btn-ghost schedule-offer-review">
        {copy.action}
      </Link>
      <button type="button" className="btn btn-ghost" aria-label={OFFER.dismissName} onClick={() => setDismissed(true)}>
        {OFFER.dismiss}
      </button>
    </div>
  );
});
