// ChatgptPlanNotice — OpenAI's required one-time notice, once per file (TASK-20261023-siwc-chatgpt-plan
// AC11; plan §3 L5; ADR-0078 §5).
//
// The `demoCallout` precedent: a latch in the user file (`chatgptNoticeShown`, hydrated into a store
// so this reads it the moment a sign-in completes — not only at mount), a surface that reads it. It
// shows only while the plan is IN USE — mode `chatgpt`, signed in, plan granted — because its body
// ("Eligible usage in this app uses your ChatGPT plan") would be untrue anywhere else; "Got it" writes
// the row and it never shows again on this file. Copy is byte-pinned (chatgptPlanNotice.test.tsx).

import type { ReactElement } from 'react';

import { CHATGPT_MANAGE_USAGE_URL } from '../access/copy.js';
import { useChatgptPlan } from '../state/chatgptPlan.js';
import { markChatgptNoticeShown, useChatgptNoticeShown, useMode } from '../state/mode.js';
import { Button } from '../ui/Button.js';
import { ExternalLink } from '../ui/ExternalLink.js';

export function ChatgptPlanNotice(): ReactElement | null {
  const mode = useMode();
  const plan = useChatgptPlan();
  const shown = useChatgptNoticeShown();
  if (shown || mode !== 'chatgpt' || plan === 'unknown' || !plan.signedIn || !plan.planGranted) return null;
  return (
    <div className="connection-note chatgpt-plan-notice" role="note" data-testid="chatgpt-plan-notice">
      <p className="connection-note-title">You&apos;re using your ChatGPT plan</p>
      <p className="connection-note-body">Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.</p>
      <div className="connection-note-actions">
        <Button variant="primary" onClick={() => void markChatgptNoticeShown()}>
          Got it
        </Button>
        <ExternalLink href={CHATGPT_MANAGE_USAGE_URL} className="btn btn-ghost">
          Manage usage
        </ExternalLink>
      </div>
    </div>
  );
}
