// The kit's `@snugprotocol/adapters` Responses adapter — `packages/adapters/dist/openai-responses.js`
// (TASK-20261023-siwc-chatgpt-plan, Gate 5 G5-1): the OpenAI Responses adapter that runs on the
// user's ChatGPT plan over a `BearerSource`, with its wire module behind it. `agent/adapter.ts`
// imports it statically for `createTurnAdapter`'s `chatgpt` arm, and `adapterKindFor` names that arm
// for `mode: 'chatgpt'` ONLY — a mode that exists where the shell hands the page a custody seat
// (ADR-0078 §1) and nowhere else. No kit platform carries the seat: `availableModes()` never offers
// the mode and a stored one is coerced away at hydrate, so no kit turn can be routed to this arm.
// `apps/host/vite.config.ts` swaps the package's module by resolved path, the way the knowledge
// package's content module is rewritten; reaching it is a wiring defect, never a feature gap, so it
// names the call. The two constants keep the real values (a reader of the base URL must see the
// pinned one). `kitDeadLanes.test.ts` §8 pins the swap, the routing invariant and this surface;
// the playground and the desktop keep the real adapter.

import type { AgentAdapter, BearerSource, FetchLike } from '@snugprotocol/adapters';

/** Pinned: the plan route is OpenAI's public API base — never an option a caller could redirect. */
export const RESPONSES_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** Matches the Chat Completions sibling: an app build can emit a whole single-file app. */
export const RESPONSES_DEFAULT_MAX_TOKENS = 128_000;

export interface OpenAiResponsesAdapterOptions {
  bearer: BearerSource;
  model: string;
  effort?: string;
  maxTokens?: number;
  fetch?: FetchLike;
}

export function openaiResponsesAdapter(_options: OpenAiResponsesAdapterOptions): AgentAdapter {
  throw new Error('the host kit has no ChatGPT-plan seat — openaiResponsesAdapter is swapped out of the kit page (apps/host/vite.config.ts)');
}
