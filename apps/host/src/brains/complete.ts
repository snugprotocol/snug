// complete.ts — the chat artifact's brain (TASK-20260905-binding-a-artifacts AC2): an
// `AgentAdapter` over the flat `window.claude.complete(prompt)` the claude.ai / Claude
// Desktop chat viewer exposes (T1 S2: `window.claude` is `{complete}`, no `use`). One
// string in, one string out, no streaming (the probe pins `streaming: false`, forwarded
// to `host-ready`), no cancel on the platform side — an abort discards the answer and
// reports CANCELLED. Unmeasured as of T4's Gate 2 (latency, consent, truncation): every
// unexpected shape is a NAMED result, never a hang.

import type { AdapterResult, AgentAdapter, ToolCall } from '@snugprotocol/adapters';
import { ERROR_CODES } from '@snugprotocol/protocol';

import { HOST_BRAIN_CODES } from './errors.js';
import { shapeString } from './prompt.js';
import { cancelled, carriesToolTraffic, toolsUnsupported } from './sample.js';

export type CompleteFn = (prompt: string) => Promise<unknown>;

const NO_TOOLS: ToolCall[] = [];

export function createCompleteAdapter(complete: CompleteFn): AgentAdapter {
  return {
    async complete(request): Promise<AdapterResult> {
      if (carriesToolTraffic(request)) return toolsUnsupported();
      // A closure, not a property read: the flag flips during the await below, and a
      // narrowed property read would be typed `false` there.
      const aborted = (): boolean => request.signal?.aborted === true;
      if (aborted()) return cancelled();
      const prompt = shapeString(request.system, request.messages);
      let reply: unknown;
      try {
        reply = await complete(prompt);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, code: ERROR_CODES.HOST_ERROR, message: `the chat brain failed: ${message}`, retryable: false };
      }
      // The platform cannot cancel a call in flight; the answer is simply not used.
      if (aborted()) return cancelled();
      if (typeof reply !== 'string') {
        return {
          ok: false,
          code: HOST_BRAIN_CODES.BAD_REPLY,
          message: `the chat brain answered with a ${reply === null ? 'null' : typeof reply}, not text`,
          retryable: false,
        };
      }
      // One delta, the whole answer: the runner's accumulator and the builder's live pane
      // both work unchanged; `streaming: false` is what the app is told.
      if (reply !== '') request.onDelta?.(reply);
      return { ok: true, text: reply, toolCalls: NO_TOOLS, stopReason: 'end', model: 'claude (chat)' };
    },
  };
}
