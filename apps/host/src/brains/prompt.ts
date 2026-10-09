// prompt.ts — the ONE turn shaper for the host brain (TASK-20260905-binding-a-artifacts
// AC1/AC3), and the budget's ruler.
//
// `sample` has no system slot: it takes a prompt string or user/assistant turns starting and
// ending on a user turn ("there is no system prompt the page controls: put the instruction,
// the page's data and the output format you want in `input`" — sample.d.ts, 0.2.41 and
// 0.2.67 alike). So the system prompt the playground assembles (identity + runtime doctrine
// + response format + the app's contract, or the builder layers) rides at the FRONT of the
// user content. T1 S3 measured the two shapes equivalent (one concatenated string ≡ a
// leading user turn: 48/48 legal moves); the input cap was measured on the one-string shape
// to the byte — 65,536 under 0.2.41 (T4 S11), 262,144 under 0.2.67 (2026-10-03), the number
// `limits()` reports. ADR-0018 D3's authority downgrade (system slot → user turn) is
// disclosed in ADR-0065 and owed a threat-model row (T7).
//
// `measurePrompt` counts the bytes of EXACTLY what `shapeInput` sends — the same function
// the adapters call — so the builder's budget-or-refuse check (AC3) and the wire can never
// disagree by a byte (lesson 2026-08-05: a bound re-derived upstream is a second bound).

import type { AdapterMessage } from '@snugprotocol/adapters';

export const PROMPT_SEPARATOR = '\n\n';

/**
 * The cap when `limits()` cannot be read — it rejects, or answers something that is not a
 * byte count. The live number is `limits().maxPromptBytes`: 262,144 under contract 0.2.67
 * (measured 2026-10-03, inclusive to the byte, in a chat-created and a tool-published
 * artifact alike). This is the 0.2.41 cap T4 S11 measured to the byte: the smallest a viewer
 * has been seen to take, and the one the builder's knowledge delivery is sized against
 * (ADR-0066), so a page that cannot learn its cap still budgets on a number that was true.
 * ONE home: the probe falls back to it and the `prompt_too_large` sentence names it.
 */
export const DEFAULT_MAX_PROMPT_BYTES = 65_536;

export interface HostTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** What `sample` accepts: one string, or turns ending on a user turn. */
export type ShapedInput = string | HostTurn[];

const encoder = new TextEncoder();
const utf8 = (text: string): number => encoder.encode(text).length;

function asTurns(messages: readonly AdapterMessage[]): HostTurn[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      throw new Error('the host brains are tool-free — a tool message cannot be shaped into a prompt');
    }
    return { role: message.role, content: message.content };
  });
}

/**
 * One user message (an app envelope; the first builder turn) → ONE string, `system` +
 * separator + content — the exact shape S3 and S11 measured. A thread with history → turns:
 * the system prompt as a leading user turn (the contract's own chat pattern), then the
 * history, ending on the new user message.
 */
export function shapeInput(system: string, messages: readonly AdapterMessage[]): ShapedInput {
  const turns = asTurns(messages);
  if (turns.length === 1 && turns[0]!.role === 'user') return `${system}${PROMPT_SEPARATOR}${turns[0]!.content}`;
  return [{ role: 'user', content: system }, ...turns];
}

/** UTF-8 bytes of what `shapeInput` sends: the string's bytes, or every turn's content summed — the measure `limits().maxPromptBytes` is stated in. */
export function measurePrompt(system: string, messages: readonly AdapterMessage[]): number {
  const shaped = shapeInput(system, messages);
  return typeof shaped === 'string' ? utf8(shaped) : shaped.reduce((sum, turn) => sum + utf8(turn.content), 0);
}
