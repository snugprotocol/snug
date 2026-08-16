/**
 * cards — inline UI cards for the chat rail (TASK-20260815-inline-cards, ADR-0031 §3).
 *
 * A card is the LLM ASKING, as UI: a bounded question/choice block rendered inline in
 * the chat, whose resolution persists on the message row and flows back as the next
 * turn's structured input. It generalizes the ADR-0019 write-proposal card's shape:
 * staged by a tool mid-turn, rendered by ChatLog, resolved exactly once, rehydrated
 * with strict re-validation (rows travel through export/import and sync, so a drifted
 * or crafted shape renders NO card rather than a lying one).
 *
 * WHAT A CARD IS NOT: an approval gate. Approvals with security meaning (data writes,
 * provider mutating calls) keep their own dedicated surfaces and executors — a card's
 * resolution only ever becomes a USER MESSAGE, which the router classifies like any
 * other. That is what keeps this feature UI-only: no new authority, no new executor
 * path, nothing a hostile card body could redeem for a capability.
 */

import { z } from 'zod';

import type { AgentTool } from '@snugprotocol/adapters';
import { getToolPrompt } from '@snugprotocol/knowledge';

export const PRESENT_CARD_TOOL_NAME = 'present_card';

/** One option per line the user can tap; ids echo back in the tool result only. */
const cardOptionSchema = z.strictObject({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  description: z.string().min(1).max(200).optional(),
});

/**
 * STRICT and bounded at every level: an unknown key is a rejection, and every cap is
 * small because a card is a QUESTION, not a document — anything longer belongs in the
 * reply text where it renders as prose, not as UI.
 */
export const chatCardSchema = z.strictObject({
  title: z.string().min(1).max(80).optional(),
  body: z.string().min(1).max(600),
  options: z.array(cardOptionSchema).min(2).max(5),
});

export type ChatCard = z.infer<typeof chatCardSchema>;

/** A card as it lives on a message: the card plus (once resolved) the user's pick. */
export interface ChatCardState extends ChatCard {
  /** Persisted row id, once the turn settles — what makes the resolution durable. */
  messageRowId?: number;
  /** Set exactly once when the user picks an option (or dismisses). */
  resolution?: { kind: 'selected'; optionId: string; label: string } | { kind: 'dismissed' };
}

/** Fail-closed parse of a model-supplied card payload. */
export function parseChatCard(input: unknown): ChatCard | undefined {
  const parsed = chatCardSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Rebuild a card from a persisted message row — validated on every READ, same rule as
 * `metaToDataWrite`. The resolution seat is re-checked structurally so an imported row
 * cannot render a phantom "selected" state pointing at an option that never existed.
 */
export function metaToCard(meta: unknown): ChatCardState | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const staged = (meta as { card?: unknown }).card;
  if (typeof staged !== 'object' || staged === null) return undefined;
  const { messageRowId, resolution, ...card } = staged as ChatCardState;
  const parsed = chatCardSchema.safeParse(card);
  if (!parsed.success) return undefined;
  const state: ChatCardState = { ...parsed.data };
  if (typeof messageRowId === 'number') state.messageRowId = messageRowId;
  if (typeof resolution === 'object' && resolution !== null) {
    if (resolution.kind === 'dismissed') {
      state.resolution = { kind: 'dismissed' };
    } else if (
      resolution.kind === 'selected' &&
      typeof resolution.optionId === 'string' &&
      parsed.data.options.some((option) => option.id === resolution.optionId)
    ) {
      const label = parsed.data.options.find((option) => option.id === resolution.optionId)?.label ?? '';
      state.resolution = { kind: 'selected', optionId: resolution.optionId, label };
    }
    // Any other shape: the CARD survives, the un-trustable resolution does not — it
    // renders as pending, and re-resolving is harmless (a card mints no authority).
  }
  return state;
}

export interface BuildCardToolOptions {
  /**
   * Called when a card is staged. Returns FALSE when the host declined it — one card
   * per turn (the message has a single card seat, same rule as the write proposal).
   */
  onCard: (card: ChatCard) => boolean | void;
}

export function buildPresentCardTool(options: BuildCardToolOptions): AgentTool {
  return {
    def: {
      name: PRESENT_CARD_TOOL_NAME,
      description: getToolPrompt('present-card'),
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['id', 'label'],
            },
          },
        },
        required: ['body', 'options'],
      },
    },
    run: async (input) => {
      const card = parseChatCard(input);
      if (card === undefined) {
        return 'Error: the card was malformed (body ≤600 chars, 2–5 options each with a short id and label). Ask your question as plain text instead.';
      }
      const ids = new Set(card.options.map((option) => option.id));
      if (ids.size !== card.options.length) {
        return 'Error: option ids must be unique within the card.';
      }
      const staged = options.onCard(card);
      if (staged === false) {
        return 'NOT shown: this turn already presented a card. Fold the question into your reply text instead.';
      }
      return [
        'The card is now shown to the user. Their choice will arrive as their next message.',
        'Finish your reply with any context they need to choose — do not repeat the options as text.',
      ].join(' ');
    },
  };
}
