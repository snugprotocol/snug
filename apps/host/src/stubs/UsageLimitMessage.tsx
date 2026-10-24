// The kit's `ui/UsageLimitMessage.tsx` (TASK-20261023-siwc-chatgpt-plan, Gate 5 G5-1): the ChatGPT
// plan's usage-limit message with Manage usage as the primary act (AC7). `ChatLog`, `RunView` and the
// Settings card render it for a `CHATGPT_USAGE_LIMIT` — a code only the Responses adapter on the plan
// answers, and that adapter is built only on the `chatgpt` arm, which no kit turn can take: the mode
// exists only where the shell hands the page a custody seat (ADR-0078 §1), and no kit platform
// carries one. So the limit never shows here, and this renders nothing if it is ever asked to. The
// sentence stays the adapters' own bytes — `BrainChip` recognises a limit by comparing to it — through
// the same single home, never retyped. `kitDeadLanes.test.ts` §7 pins the swap; the playground and the
// desktop keep the real module.

import { CHATGPT_ERROR_CODES, CHATGPT_ERROR_SENTENCES } from '@snugprotocol/adapters';

export const USAGE_LIMIT_SENTENCE = CHATGPT_ERROR_SENTENCES[CHATGPT_ERROR_CODES.USAGE_LIMIT];

export interface UsageLimitMessageProps {
  /** When given, a ghost **dismiss** follows Manage usage (the run view's banner). */
  onDismiss?: () => void;
  testId?: string;
}

export function UsageLimitMessage(_props: UsageLimitMessageProps): null {
  return null;
}
