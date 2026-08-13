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
 *
 * WHY A SECOND FUNCTION LIVES HERE (ADR-0023 D1, TASK-20260812 P5-flow). The
 * wizard's LAN address step is the same act under a different name: the user typing a
 * fact about a device they own, onto a row an inference channel declared. It is a
 * `user`-channel write by definition, so it belongs in the one module that may name
 * that channel — putting it in the wizard would either fork the AC13 allowlist (two
 * writers to audit instead of one) or tempt a local `putDeclaredConnection` that
 * bypasses admission, which is exactly where the LAN host CLASS is re-validated
 * (amendment 10c). The functions share the channel and nothing else; each states its
 * own act.
 */
import { getUserDb } from './userdb.js';
import { openConnectionWizard, refreshOpenConnectionWizard } from './connectionWizard.js';
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
    // When the choice was made INSIDE the open wizard (the desktop refusal's steer,
    // P3 item 4b), reopening would refuse — refresh the live session instead.
    if (!refreshOpenConnectionWizard(input.appId, input.slot)) {
      openConnectionWizard({ appId: input.appId, slot: input.slot, source: 'directive' });
    }
  }
  return outcome;
}

export interface RecordLanHostChoiceInput {
  appId: string;
  slot: string;
  /** The row's OWN requirement with the collected address in `declaredApiHosts`. */
  requirement: unknown;
}

/**
 * Record the bridge address the user typed (ADR-0023 D1's collection step).
 *
 * IT OPENS NO WIZARD, and that asymmetry with `chooseAuthOption` is the point:
 * this is called from INSIDE a live wizard session that is about to advance to
 * its own review screen. Re-opening — or even refreshing — would reset the step
 * machine the caller is mid-way through, and `openConnectionWizard` would refuse
 * anyway (one wizard at a time). The caller bumps its own revision so the sheet
 * re-reads the row.
 *
 * Everything else is identical, deliberately: the same seam, the same gate chain,
 * the same channel. Admission is where the collected address meets
 * `lanHostsAcceptable` — the authoritative class check — and where the registry's
 * pinned fields and header template are substituted onto the row for the first
 * time. A local write here would skip both.
 */
export async function recordLanHostChoice(input: RecordLanHostChoiceInput): Promise<ConnectionPersistOutcome> {
  const db = await getUserDb();
  return persistConnectionRequirement(db, {
    appId: input.appId,
    requirement: input.requirement,
    // THE literal — see the module doc before touching this line (AC13 scans for it).
    channel: 'user',
  });
}
