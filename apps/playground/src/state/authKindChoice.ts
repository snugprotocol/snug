/**
 * authKindChoice — the ONE production writer of the `user` connection channel
 * (TASK-20260812-auth-kind-choice, D7/AC13).
 *
 * WHY THIS FILE IS SMALL AND ALONE. `persistConnectionRequirement` on `channel:'user'`
 * writes a row R3 protects FOREVER against inference overwrites (Gate 5,
 * `skipped_user_provenance`) — a guarantee exactly as strong as this write path is hard
 * to reach. So the channel is a HARDCODED LITERAL here, this module is called only from
 * the choice card's click handler (a real DOM gesture), and an executable source scan
 * (AC13) fails the suite if any other production file ever passes `channel: 'user'`.
 * No directive, import, recovery result, or message-meta value can become the channel.
 *
 * WHAT A CHOICE IS. The user picked one of a provider's auth options (the pinned
 * registry's, or a validated inference alternative). The chosen requirement goes
 * through the FULL persist gate chain — schema, admission (where the matched-option
 * handle keeps the variant's shape intact, P1), re-parse, lint — and lands as a
 * `declared` row with `user` provenance. It still faces the strong review; choosing is
 * a rebind, never an approval.
 */
import { getUserDb } from './userdb.js';
import { openConnectionWizard } from './connectionWizard.js';
import {
  persistConnectionRequirement,
  type ConnectionPersistOutcome,
} from '../agent/connectionPipeline.js';

export interface ChooseAuthOptionInput {
  appId: string;
  slot: string;
  /** The chosen option's COMPLETE requirement — untrusted until the gates have run. */
  requirement: unknown;
}

/**
 * Rebind (app, slot) to the user's chosen auth option and open the wizard on it.
 *
 * Returns the persist outcome so the card can render a refusal honestly — a choice
 * that fails admission must say so, never silently keep the old row (the F4 rule).
 */
export async function chooseAuthOption(input: ChooseAuthOptionInput): Promise<ConnectionPersistOutcome> {
  const db = await getUserDb();
  const outcome = await persistConnectionRequirement(db, {
    appId: input.appId,
    requirement: input.requirement,
    // THE literal — see the module doc before touching this line (AC13 scans for it).
    channel: 'user',
  });
  if (outcome.ok) {
    openConnectionWizard({ appId: input.appId, slot: input.slot, source: 'directive' });
  }
  return outcome;
}
