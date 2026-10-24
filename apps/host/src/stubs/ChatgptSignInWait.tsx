// The kit's `desktop/ChatgptSignInWait.tsx` (TASK-20261023-siwc-chatgpt-plan, Gate 5 G5-1): the
// awaiting hint and the primary cancel a surface shows while a ChatGPT sign-in is out in the system
// browser (AC2). A sign-in can only start from the keeper's acts over a custody seat, and no kit
// platform carries one (ADR-0078 §1): the pending flag the Welcome card and Settings read is false for
// good here, so this never mounts — and renders nothing if it is ever asked to. The two sentences are
// kept verbatim for any consumer that compares them. `kitDeadLanes.test.ts` §7 pins the swap; the
// playground and the desktop keep the real module.

export const AWAITING_SIGN_IN = "we opened your browser — finish signing in there. we're listening.";
export const CANCEL_SIGN_IN = 'cancel this sign-in';

export function ChatgptSignInWait(): null {
  return null;
}
