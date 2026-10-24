// The kit's `views/ChatgptPlanNotice.tsx` (TASK-20261023-siwc-chatgpt-plan, Gate 5 G5-1): OpenAI's
// required one-time notice, shown only while the plan is IN USE — mode `chatgpt`, signed in, plan
// granted (AC11). `App.tsx` mounts it on every platform, but no kit platform carries the custody seat
// the mode is built on (ADR-0078 §1): the mode is never offered and the keeper's status is signed out
// for good, so the real notice would answer `null` on every render here. This one answers it without
// carrying the notice's words, its button and its link into the page. `kitDeadLanes.test.ts` §7 pins
// the swap; the playground and the desktop keep the real module.

export function ChatgptPlanNotice(): null {
  return null;
}
