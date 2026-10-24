// The kit's `views/ChatgptPlanRows.tsx` (TASK-20261023-siwc-chatgpt-plan, Gate 5 G5-1): Settings'
// "my ChatGPT plan" card — the sign-in, the account, the model and level selects, the sign-out.
// `SettingsView` mounts it only when the mode is `chatgpt`, and no kit platform carries the custody
// seat that mode is built on (ADR-0078 §1): `availableModes()` never offers it and a stored `chatgpt`
// mode is coerced away at hydrate, so the card never mounts here — and renders nothing if it is ever
// asked to. The one word a consumer could compare against is kept verbatim. `kitDeadLanes.test.ts` §7
// pins the swap; the playground and the desktop keep the real module.

/** D7: sign-out is local + best-effort revocation; the account-side disconnect is ChatGPT's to do. */
export const DISCONNECT_POINTER = 'to remove Snug from your account entirely, disconnect it in ChatGPT → Settings.';

export function ChatgptPlanRows(): null {
  return null;
}
