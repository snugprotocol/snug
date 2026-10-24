// UsageLimitMessage — the ChatGPT plan's usage-limit message with Manage usage as the PRIMARY act
// (TASK-20261023-siwc-chatgpt-plan AC7, plan §1 D5, §12 L5-8; ADR-0078 §5).
//
// The sentence is single-homed in the adapters (`CHATGPT_ERROR_SENTENCES`) and imported — never
// retyped — so a surface can recognise a limit by comparing to the same bytes it renders. The one
// remedy is OpenAI's: review the plan or the app's limit in ChatGPT settings, so **Manage usage** is
// the first act and the primary one wherever this renders (the builder chat, the run view's banner,
// a scheduled step's row). A generic "— try again." would be untrue: nothing here is retryable until
// the limit lifts.

import type { ReactElement } from 'react';

import { CHATGPT_ERROR_CODES, CHATGPT_ERROR_SENTENCES } from '@snugprotocol/adapters';

import { Button } from './Button.js';
import { ManageUsageLink } from './ManageUsageLink.js';

export const USAGE_LIMIT_SENTENCE = CHATGPT_ERROR_SENTENCES[CHATGPT_ERROR_CODES.USAGE_LIMIT];

export interface UsageLimitMessageProps {
  /** When given, a ghost **dismiss** follows Manage usage (the run view's banner). */
  onDismiss?: () => void;
  testId?: string;
}

export function UsageLimitMessage({ onDismiss, testId = 'usage-limit-message' }: UsageLimitMessageProps): ReactElement {
  return (
    <div className="connection-note" role="alert" data-testid={testId}>
      <p className="connection-note-title">{USAGE_LIMIT_SENTENCE}</p>
      <div className="connection-note-actions">
        <ManageUsageLink className="btn btn-primary" />
        {onDismiss !== undefined ? (
          <Button variant="ghost" onClick={onDismiss}>
            dismiss
          </Button>
        ) : null}
      </div>
    </div>
  );
}
