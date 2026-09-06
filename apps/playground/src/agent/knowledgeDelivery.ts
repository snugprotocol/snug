// knowledgeDelivery.ts — THE one derivation of how the app-authoring knowledge reaches a
// build turn (TASK-20260906-tool-free-kb-inlining, ADR-0066; folded from the Gate-5 review,
// which found the builder's system slot and the build view's user slot each spelling the
// "is this build tool-free?" predicate for themselves).
//
// Both slots of a build turn consume this: `createDirectBuilder` picks the system-prompt
// delivery from it and `BuilderView` picks the matching user-message template. A tool named
// in one slot and disclaimed in the other is the defect this task fixed; deriving both from
// one function is what keeps it fixed.

import type { KnowledgeDelivery } from '@snugprotocol/knowledge';

import { HOST_BUILDER_RESERVED_MIN_BYTES, HOST_BUILDER_SYSTEM_MAX_BYTES } from './promptBudget.js';

/**
 * The structural slice of a brain this decision reads — satisfied by the playground's
 * `Brain` (state/webllm.ts) and by the platform seat's `PlatformBrain` alike, so the
 * builder (which holds the seat) and the view (which holds the resolved brain) call the
 * same function on what they have.
 */
export interface KnowledgeDeliveryBrain {
  kind: string;
  /** A pinned host brain says whether it can call tools; every other kind can. */
  tools?: boolean;
  /** A pinned host brain's declared input cap (`sample.limits()`), when it has one. */
  maxPromptBytes?: number;
}

/**
 * The smallest input cap under which the inline core is worth sending: the pinned ceiling
 * for the builder's system text plus the stated minimum for the request, the app context
 * and history. A host brain that declares less gets the honest unaided layer instead of a
 * first build that is refused before any call (Gate-5 review: `sample.limits()` is a
 * runtime answer — the only value ever observed is 65,536, but the seam that changes it is
 * platform-owned and already wired).
 */
export const INLINE_DELIVERY_MIN_CAP_BYTES = HOST_BUILDER_SYSTEM_MAX_BYTES + HOST_BUILDER_RESERVED_MIN_BYTES;

export function knowledgeDeliveryFor(brain: KnowledgeDeliveryBrain): KnowledgeDelivery {
  // webllm: no tools (web-llm's function calling excludes the builder's system prompt,
  // ADR-0015) and a 4,096-token window the core cannot fit — the unaided layer.
  if (brain.kind === 'webllm') return 'none';
  // A pinned host brain that cannot call tools carries the core inline when its window
  // can hold it, the unaided layer when it declares that it cannot.
  if (brain.kind === 'host' && brain.tools === false) {
    return brain.maxPromptBytes !== undefined && brain.maxPromptBytes < INLINE_DELIVERY_MIN_CAP_BYTES ? 'none' : 'inline';
  }
  // Everything else — byok, local, the demo brain, a host brain WITH tools — has the
  // app-builder tool and gets today's bytes.
  return 'tool';
}

/** A build on this brain runs without tools — the same fact, as the builder's arm reads it. */
export function buildsToolFree(brain: KnowledgeDeliveryBrain): boolean {
  return knowledgeDeliveryFor(brain) !== 'tool';
}
