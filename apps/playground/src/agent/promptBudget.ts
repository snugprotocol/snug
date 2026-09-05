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
 * The context caps under a 64 KiB host: html unbounded (whole or refused), the rest shrunk
 * so a ~50 KB app still fits beside the builder layers (≈ 4.7 KB) and the message.
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

/** The refusal copy: the numbers, and the one thing the user can do about it. */
export function promptTooLargeMessage(bytes: number, maxPromptBytes: number): string {
  return `this app and its context come to ${format(bytes)} bytes; this host accepts up to ${format(maxPromptBytes)} per turn — export your file and edit the app in the Snug playground, or ask for a smaller app`;
}
