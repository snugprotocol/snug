// The kit's `desktop/ChatgptButton.tsx` (TASK-20261023-siwc-chatgpt-plan, Gate 5 G5-1): "Continue with
// ChatGPT" in OpenAI's own button format, with the two official logos imported as `?url` assets. Its
// only mounts are the desktop Welcome card's third tile and Settings' ChatGPT-plan card, and neither
// shows where no custody seat exists (ADR-0078 §1) — which is every kit platform. The real module
// would ride into the single-file page as a button nothing mounts PLUS two SVGs inlined as data URLs
// that nothing references; this stub imports no asset and renders nothing. The accessible name is
// kept verbatim for any consumer that compares it. `kitDeadLanes.test.ts` §7 pins the swap and that
// the stub imports no asset; the playground and the desktop keep the real module and the logos.

import type { ButtonHTMLAttributes } from 'react';

export const CONTINUE_WITH_CHATGPT = 'Continue with ChatGPT';

export type ChatgptButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type'>;

export function ChatgptButton(_props: ChatgptButtonProps): null {
  return null;
}
