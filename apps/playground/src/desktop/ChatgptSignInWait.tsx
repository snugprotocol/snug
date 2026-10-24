// ChatgptSignInWait — what a surface shows while a ChatGPT sign-in is out in the system browser
// (TASK-20261023-siwc-chatgpt-plan §12 L5-1; AC2). The connection wizard's awaiting-callback
// precedent (ConnectionWizardSheet): the hint points at the right WINDOW, and the one act is a
// PRIMARY cancel — on the desktop the sign-in lives in the system browser, so without it the only
// exits from the wait would be delivery and the flow's TTL. The Welcome card and the Settings card
// both render this, so the two say the same words for the same window.

import type { ReactElement } from 'react';

import { cancelChatgptSignIn } from '../state/chatgptPlan.js';
import { Button } from '../ui/Button.js';

export const AWAITING_SIGN_IN = "we opened your browser — finish signing in there. we're listening.";
export const CANCEL_SIGN_IN = 'cancel this sign-in';

export function ChatgptSignInWait(): ReactElement {
  return (
    <>
      <span className="hint" data-testid="chatgpt-sign-in-status">
        {AWAITING_SIGN_IN}
      </span>
      <Button variant="primary" data-testid="chatgpt-sign-in-cancel" onClick={() => void cancelChatgptSignIn()}>
        {CANCEL_SIGN_IN}
      </Button>
    </>
  );
}
