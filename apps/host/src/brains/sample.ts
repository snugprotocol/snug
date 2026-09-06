// sample.ts — the hosted artifact's brain (TASK-20260905-binding-a-artifacts AC1): an
// `AgentAdapter` over the artifact runtime's `sample` (`await claude.use('sample')`,
// contract 0.2.41), reached ONLY through `createTurnAdapter`'s `'host'` arm — never given a
// key, a URL or a header (C1 by construction), consumed by the same `createDirectAppTransport`
// / `createDirectBuilder` every other brain is, so the R-9 egress scrub and the F15 skip
// apply exactly as they do for webllm.
//
// One adapter per PURPOSE, one tier each (D15: a host decision, never a control): the app
// adapter answers envelopes on `quick` (T1 S3: median 1.2 s, 48/48 legal, every reply
// fenced — the graduated parser downstream unfences), the builder/inferrer adapter on
// `default` (T4 S11: a 33 KB whole-app rewrite in 94 s on `default` vs 107 s on `quick` —
// output dominates, `quick` buys nothing and thinks less).
//
// The text verb, never `sample.json`: only the text verb reports `truncated` (→
// `stopReason: 'max_tokens'`, never a parse strike — lesson 2026-08-12) and
// `modelTierApplied` (the model name the inspector shows). `cache: false` always: a live
// turn must never replay a five-minute-old answer. `onText` hands the WHOLE text so far;
// the adapter contract wants deltas, so the adapter diffs. Never called on load: the
// first think is the first call, and the consent dialog appears there (S3, S11).

import type { AdapterResult, AgentAdapter, ToolCall } from '@snugprotocol/adapters';
import { ERROR_CODES } from '@snugprotocol/protocol';

import { HOST_BRAIN_CODES, mapSampleError } from './errors.js';
import { measurePrompt, shapeInput, type ShapedInput } from './prompt.js';

export type ModelTier = 'quick' | 'default' | 'complex';
/** What `sample` accepts — exactly what the shaper produces (one type, one home). */
export type SampleInput = ShapedInput;

export interface SampleOptions {
  onText?: (event: { text: string; delta: string }) => void;
  signal?: AbortSignal;
  modelTier?: ModelTier;
  cache?: boolean;
}

export interface SampleResult {
  text: string;
  truncated: boolean;
  modelTierApplied: ModelTier;
}

/** The structural slice of the runtime's `sample` namespace the kit uses (no d.ts import — the contract is pinned by tests). */
export interface SampleFn {
  (input: SampleInput, options?: SampleOptions): Promise<SampleResult>;
  limits(): Promise<{ maxPromptBytes: number }>;
  json(input: SampleInput, options?: SampleOptions): Promise<unknown>;
}

export interface SampleAdapterOptions {
  modelTier: ModelTier;
  /** The cap `limits()` reported — named in the PROMPT_TOO_LARGE message. */
  maxPromptBytes?: number;
}

const NO_TOOLS: ToolCall[] = [];

/** Tool traffic of any shape: offered tools, a tool-call turn, a tool-result turn. */
export function carriesToolTraffic(request: Parameters<AgentAdapter['complete']>[0]): boolean {
  return (
    (request.tools !== undefined && request.tools.length > 0) ||
    request.messages.some((entry) => entry.role === 'tool' || (entry.role === 'assistant' && (entry.toolCalls?.length ?? 0) > 0))
  );
}

export const toolsUnsupported = (): AdapterResult => ({
  ok: false,
  code: HOST_BRAIN_CODES.TOOLS_UNSUPPORTED,
  message: 'the host brain cannot run tools — host turns must be offered no tools (the builder takes its tool-free arm)',
  retryable: false,
});

export const cancelled = (partialText = ''): AdapterResult => ({
  ok: false,
  code: ERROR_CODES.CANCELLED,
  message: 'stopped',
  retryable: false,
  ...(partialText !== '' ? { partialText } : {}),
});

export function createSampleAdapter(sample: SampleFn, options: SampleAdapterOptions): AgentAdapter {
  return {
    async complete(request): Promise<AdapterResult> {
      if (carriesToolTraffic(request)) return toolsUnsupported();
      if (request.signal?.aborted === true) return cancelled();

      const input = shapeInput(request.system, request.messages);
      const promptBytes = measurePrompt(request.system, request.messages);
      let sent = '';
      const onText = ({ text }: { text: string; delta: string }): void => {
        // The platform hands the whole answer so far; a rewrite (text that no longer
        // extends what was shown) is forwarded whole rather than lost.
        const delta = text.startsWith(sent) ? text.slice(sent.length) : text;
        sent = text;
        if (delta !== '') request.onDelta?.(delta);
      };
      try {
        const result = await sample(input, {
          cache: false,
          modelTier: options.modelTier,
          onText,
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        });
        return {
          ok: true,
          text: result.text,
          toolCalls: NO_TOOLS,
          stopReason: result.truncated ? 'max_tokens' : 'end',
          model: `claude (${result.modelTierApplied})`,
        };
      } catch (error) {
        if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') {
          return mapSampleError(error as { code: string; message?: unknown; text?: unknown }, {
            promptBytes,
            ...(options.maxPromptBytes !== undefined ? { maxPromptBytes: options.maxPromptBytes } : {}),
          });
        }
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, code: ERROR_CODES.HOST_ERROR, message: `the host brain threw: ${message}`, retryable: false, ...(sent !== '' ? { partialText: sent } : {}) };
      }
    },
  };
}
