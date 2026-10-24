// ManageUsageLink — OpenAI's required *Manage usage* link, typed ONCE (TASK-20261023-siwc-chatgpt-plan
// AC7, plan §1 D5; ADR-0078 §5; Gate 5 ST7). Five surfaces render it — the usage-limit message, the
// one-time notice, Settings' account line, the brain chip's popover and a scheduled result's limit row
// — and each used to retype the href, the opener and the words. The URL is `access/copy.ts`'s one
// constant; the opener is the house `ExternalLink` (the side-effect-free system-browser seat on
// desktop, never the OAuth opener). Where the limit is the state, the caller passes the primary class:
// the limit's one remedy is primary wherever it renders (AC7).

import type { ReactElement } from 'react';

import { CHATGPT_MANAGE_USAGE_URL } from '../access/copy.js';
import { ExternalLink } from './ExternalLink.js';

export interface ManageUsageLinkProps {
  className?: string;
  testId?: string;
}

export function ManageUsageLink({ className, testId }: ManageUsageLinkProps): ReactElement {
  return (
    <ExternalLink href={CHATGPT_MANAGE_USAGE_URL} {...(className !== undefined ? { className } : {})} {...(testId !== undefined ? { 'data-testid': testId } : {})}>
      Manage usage
    </ExternalLink>
  );
}
