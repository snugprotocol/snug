// agent/accessProposeTool.ts — the brain's ASK to read another app's data (TASK-20261010-host-broker
// PR-2 AC12; ADR-0076 §2; D-PR2-11; DS-2, S6, F6, DS-8, DS-10). The sibling of
// `scheduleProposeTool.ts`: it rides the chat's `data` and `answer` lanes (`laneTools.ts`, under
// the offer rule) and the builder's set (`tools.ts`); it grants NOTHING. A valid ask is handed
// to `onProposal` — the hook stages ONE card per turn on the agent's message — with the
// THREAD's app, resolved host-side, never an id the model names (the sink's rule, F9). The user
// decides on the card: *review* opens the host's own sheet.
//
// THE LADDER STILL APPLIES (S6). The strip's rungs run here, at the call, by name — the Settings
// switch *never let apps ask*, the user's mute of this app, the user's earlier *don't allow* to
// this ask (its semantic hash: the hints, never the purpose), an ask already waiting for the
// user, a second proposal this turn — each answered `NOT staged` so the model tells the user
// and carries on without the other app's data. The purpose and the hints go through the
// protocol's REAL schemas (`accessPurposeSchema`, `accessHintsSchema`): a multi-line or
// over-long purpose, a bidi control, a credential, an unknown hint key, `snug_kv` — each an
// `Error:` before anything is staged. Every answer is ONE line the model reads; the ok answer
// says the user decides and never that it was allowed.

import type { AgentTool } from '@snugprotocol/adapters';
import type { UserDb } from '@snugprotocol/db';
import { getToolPrompt } from '@snugprotocol/knowledge';
import { ACCESS_PURPOSE_MAX_CHARS, accessHintsSchema, accessPurposeSchema, accessRequestHash, type AccessHints } from '@snugprotocol/protocol';

import { accessAsksOff, pendingAccessStore } from '../access/consent.js';

/** Named here like the schedule tool — no server twin, no prompt placeholder. */
export const ACCESS_PROPOSE_TOOL_NAME = 'access_propose';

/** What the brain asked for: its purpose, in the user's words, and the hints the host ranks apps by. */
export interface AccessProposal {
  purpose: string;
  hints?: AccessHints;
}

/**
 * An `access_propose` call staged an ask. The host renders it as a card on the agent's message;
 * `false` means it was NOT staged (one card per turn), and the tool tells the model so.
 */
export type OnAccessProposal = (proposal: AccessProposal, appId: string) => boolean | void;

export interface BuildAccessProposeToolOptions {
  getDb: () => Promise<UserDb>;
  /** The app the thread is pinned to — the HOST-SIDE pin, never an id the model names. */
  resolveAppId: () => Promise<string | undefined>;
  /** Absent ⇒ no surface renders asks here; the tool says so rather than staging into the void. */
  onProposal?: OnAccessProposal;
}

const CARRY_ON = 'carry on without the other app’s data';
const NO_APP = 'Error: asking to read another app’s data needs an installed app, and this thread has none yet — answer from what this app holds, or build the app first.';
const NO_SURFACE = 'NOT staged: this chat cannot show an ask — tell the user to allow it from the app’s access (⋈).';
const ASKS_OFF = `NOT staged: asks to read other apps are turned off here — ${CARRY_ON}.`;
const MUTED = `NOT staged: the user turned off asks from this app — ${CARRY_ON}.`;
const DECLINED = `NOT staged: the user said don’t allow to this ask — ${CARRY_ON}.`;
const PENDING = `NOT staged: an ask is already waiting for the user — tell them to answer it first, and ${CARRY_ON}.`;
const SECOND = 'NOT staged: a request is already waiting in this turn. Tell the user about it and let them answer it first.';

const issuesOf = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string =>
  error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');

/**
 * `access_propose` — stages ONE ask per turn for the user to review (or not) on the host's own
 * consent sheet. The sink pins the app; the real schemas decide; the ladder answers by name.
 */
export function buildAccessProposeTool(options: BuildAccessProposeToolOptions): AgentTool {
  return {
    def: {
      name: ACCESS_PROPOSE_TOOL_NAME,
      description: getToolPrompt('access-propose'),
      inputSchema: {
        type: 'object',
        properties: {
          purpose: { type: 'string' },
          hints: {
            type: 'object',
            properties: {
              words: { type: 'array', items: { type: 'string' } },
              tables: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        required: ['purpose'],
      },
    },
    run: async (input) => {
      // The REAL schemas decide (the runtime-contract tool's rule): the JSON-Schema above only
      // shapes the tool list the model sees.
      const purpose = accessPurposeSchema.safeParse(input.purpose);
      if (!purpose.success) {
        return `Error: "purpose" must be one line of 1 to ${ACCESS_PURPOSE_MAX_CHARS} characters, in the user's words, with nothing credential-shaped — ${issuesOf(purpose.error)}`;
      }
      let hints: AccessHints | undefined;
      if (input.hints !== undefined) {
        const parsedHints = accessHintsSchema.safeParse(input.hints);
        if (!parsedHints.success) return `Error: "hints" were rejected — ${issuesOf(parsedHints.error)}`;
        hints = parsedHints.data;
      }
      const db = await options.getDb();
      const target = await options.resolveAppId();
      const appId = target !== undefined && db.getApp(target) !== undefined ? target : undefined;
      if (appId === undefined) return NO_APP;

      // The ladder, by name — the same rungs the strip's intake runs for an app's ask (S6).
      if (accessAsksOff()) return ASKS_OFF;
      if (db.isAccessMuted(appId)) return MUTED;
      const hash = accessRequestHash({ hints: hints ?? {} });
      if (db.listAccessDeclines(appId).some((decline) => decline.hash === hash)) return DECLINED;
      if (pendingAccessStore.get()[appId] !== undefined) return PENDING;

      if (options.onProposal === undefined) return NO_SURFACE;
      const proposal: AccessProposal = { purpose: purpose.data, ...(hints !== undefined ? { hints } : {}) };
      if (options.onProposal(proposal, appId) === false) return SECOND;
      return [
        `Suggested (NOT allowed — the user decides on the card): "${proposal.purpose}"`,
        'Tell the user it is waiting for their review; never say it was allowed.',
      ].join('\n');
    },
  };
}
