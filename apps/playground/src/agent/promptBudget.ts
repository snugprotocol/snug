// promptBudget.ts — budget or refuse (TASK-20260905-binding-a-artifacts AC3).
//
// A host brain may carry an INPUT CAP (`PlatformBrain.maxPromptBytes` — the artifact
// runtime's `sample` accepts 65,536 UTF-8 bytes, inclusive, measured to the byte in T4 S11)
// and the RULER that counts what its adapter actually sends (`promptBytes`, the kit's own
// shaper — lesson 2026-08-05: a bound re-derived upstream of the sent string is a second
// bound, and the cap flips accept/refuse on one byte).
//
// The ladder: history dropped oldest-first, one message at a time; then a NAMED refusal.
// The app's html is never cut — S11 arm F showed a context cut mid-file plus "write the
// ENTIRE file" returns a plausible full-length app whose tail the model invented, landing
// as the next version. Docs and schema are read, not rewritten, so they truncate with the
// marker upstream (HOST_CONTEXT_CAPS in `buildAppTurnContext`); the html cap there is
// unbounded, and this module is where "does it fit?" is decided.

import type { AdapterMessage } from '@snugprotocol/adapters';

import type { CONTEXT_CAPS } from './appContext.js';

/**
 * The refusal code. ONE string, homed here: the kit's `brains/errors.ts` imports it for the
 * runtime's own `prompt_too_large`, so the pre-flight refusal and the platform's answer to
 * an over-cap call are the same code to every reader.
 */
export const PROMPT_TOO_LARGE_CODE = 'HOST_BRAIN_PROMPT_TOO_LARGE';

/**
 * The ceiling for the tool-free BUILDER SYSTEM TEXT under the host cap (TASK-20260906
 * AC3): the inline assembly (`knowledge: 'inline'` — the 35 layer + the five-file core,
 * ~41.3 KB measured 2026-09-06) plus the fenced-HTML suffix must measure ≤ this on the
 * kit's own ruler, leaving ≥ 20,480 B (20 KiB) of the 65,536 for the request, the app
 * context and history. A layer growing past it fails the host test that pins it
 * (`brains.test.ts`) instead of surfacing as a silently refused build turn on the artifact.
 * ONE home: the test imports it; adding a file to `INLINE_KNOWLEDGE_CORE_FILES` must clear it.
 */
export const HOST_BUILDER_SYSTEM_MAX_BYTES = 45_056;

/**
 * The stated minimum the ceiling leaves under the 65,536-byte cap for the request, the
 * app context and history (20 KiB). Pinned beside the ceiling so the two numbers that give
 * it meaning have one home: the host kit's test asserts `cap − ceiling ≥ this`, and
 * `knowledgeDeliveryFor` refuses to send the inline core to a brain whose declared cap is
 * below `ceiling + this`.
 */
export const HOST_BUILDER_RESERVED_MIN_BYTES = 20_480;

/**
 * The context caps under a 64 KiB host: html unbounded (whole or refused), the rest shrunk
 * so the app still fits beside the builder layers and the message.
 *
 * The arithmetic since TASK-20260906 (the tool-free builder carries the KB core inline), at
 * the CEILING rather than today's bytes: 65,536 − 45,056 = 20,480 for everything else; with
 * schema and docs at their caps (10,000) and history shed by the ladder below (it drops
 * oldest-first before anything is refused, so its cap is soft) that leaves ≈ 10 KB for the
 * app's html + the message; with an empty context block, ≈ 20 KB. Schema and docs truncate
 * upstream with a marker. A host-side EDIT of an app above those sizes is refused BY NAME —
 * T4's budget-or-refuse working as designed (the refusal names the playground as the place
 * to edit) — and NO shipped starter (the smallest is ~30 KB) can be edited under the host
 * brain while the core rides whole on edit turns; that consequence is recorded in
 * ADR-0066 and next-steps as an open decision. Shrinking these caps buys a few KB of html;
 * the values are unchanged for now.
 */
export const HOST_CONTEXT_CAPS: Record<keyof typeof CONTEXT_CAPS, number> = {
  html: Number.POSITIVE_INFINITY,
  schema: 4_000,
  docs: 6_000,
  history: 4_000,
};

export interface HostTurnInput {
  /** The full system text as it will be sent (base layers + the app-context suffix). */
  system: string;
  history: readonly AdapterMessage[];
  message: string;
}

export interface HostBudget {
  maxPromptBytes: number;
  promptBytes: (system: string, messages: AdapterMessage[]) => number;
}

export type FittedTurn =
  | { ok: true; messages: AdapterMessage[]; bytes: number; droppedHistory: number }
  | { ok: false; bytes: number; maxPromptBytes: number };

const format = (n: number): string => n.toLocaleString('en-US');

export function fitHostTurn(input: HostTurnInput, budget: HostBudget): FittedTurn {
  let history = [...input.history];
  let dropped = 0;
  for (;;) {
    const messages: AdapterMessage[] = [...history, { role: 'user', content: input.message }];
    const bytes = budget.promptBytes(input.system, messages);
    if (bytes <= budget.maxPromptBytes) return { ok: true, messages, bytes, droppedHistory: dropped };
    if (history.length === 0) return { ok: false, bytes, maxPromptBytes: budget.maxPromptBytes };
    history = history.slice(1);
    dropped += 1;
  }
}

/**
 * The refusal copy: the numbers, and the one thing the user can do about it. `bytes` is the
 * WHOLE turn — since TASK-20260906 the builder's own instructions are ~42 KB of it on a
 * tool-free host, so the copy names the parts rather than calling the total "this app".
 */
export function promptTooLargeMessage(bytes: number, maxPromptBytes: number): string {
  return `this turn comes to ${format(bytes)} bytes (the app, its context and the builder's own instructions together); this host accepts up to ${format(maxPromptBytes)} per turn — export your file and edit the app in the Snug playground, or ask for a smaller app`;
}
