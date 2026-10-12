// schedule/proposalGate.ts — the ONE gate every scheduled change passes before it may sit on a
// result (TASK-20261010-host-broker PR-4, D-PR4-16, D-PR4-5; security S13). Extracted from the
// tool-free step's `dryRunCandidates` so both executors — that step's reply and the scheduled
// agent's `data_propose_write` — admit a change by the same four questions, in this order:
//
//   1. the item schema — one INSERT, UPDATE or DELETE over literal values (`isSingleDmlStatement`
//      refuses a second statement, DDL and any nested SELECT/FROM — Gate-5 S8 of PR-B: a subquery
//      reaches every table the app holds);
//   2. no credential — the run row's strict parse would refuse the whole row, and the value would
//      sit in the user's file;
//   3. the app not mid-change — `inTransaction` BEFORE anything is exported (D-PR4-5: the export
//      under a dry run discards a live frame transaction);
//   4. the dry run on a throwaway copy, never attaching another app's tables — its count is the
//      item's `counts.changes`, and a shared name there is simply "no such table".
//
// The app the item is FOR is the gate's argument, never the candidate's (Gate-5 S4 of PR-B: a run
// pools the items of every step, and approving one applies it against its own app's data). The
// three-a-run cap stays with the callers. A refusal is a reason token, never a message: the
// statement may carry the very value the gate refused, and the callers word their own answers.

import type { UserDb } from '@snugprotocol/db';
import { SCHEDULE_PROPOSAL_SUMMARY_MAX_CHARS, findScheduleCredential, scheduleProposalItemSchema, type ScheduleProposalItem } from '@snugprotocol/protocol';

/** One change as a step offers it: the statement and, optionally, its one-line reason. */
export interface ProposalCandidate {
  sql: string;
  summary?: string | undefined;
}

export type ProposalRefusal = 'invalid' | 'credential' | 'busy' | 'failed';

export type ProposalVerdict = { ok: true; item: ScheduleProposalItem } | { ok: false; reason: ProposalRefusal };

/**
 * What a change must look like for a schedule to make it on its own and undo it — the capture
 * walk's grammar (`ownCapturable`), as the scheduled `data_propose_write` tells the model when an
 * armed change falls outside it (D-PR4-16). The tool-free step's response schema and the agent's
 * preamble state the same rule for a reply that carries no bound values.
 */
export const OWN_CAPTURE_RULE = 'literal values or ?, a WHERE on UPDATE/DELETE, no functions, arithmetic or conflict clause';

/** What the model reads when the app is mid-change — it names the app the step asked (T-A-12). */
export function appBusy(appName: string): string {
  return `${appName} is in the middle of a change — try later`;
}

/** The same, as a tool's answer. */
export const appBusyAnswer = (appName: string): string => `Error: ${appBusy(appName)}`;

/**
 * Admit one candidate for `appId`, or say why not — the four questions above, nothing past a
 * refusal runs. The reason is trimmed to its cap rather than dropping the change for verbosity.
 * Never throws: a scratch run that fails or throws is `failed`.
 */
export async function gateProposal(db: UserDb, appId: string, candidate: ProposalCandidate): Promise<ProposalVerdict> {
  const summary = typeof candidate.summary === 'string' ? candidate.summary.slice(0, SCHEDULE_PROPOSAL_SUMMARY_MAX_CHARS) : undefined;
  const parsed = scheduleProposalItemSchema.safeParse({ appId, sql: candidate.sql, ...(summary !== undefined ? { summary } : {}) });
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  if (findScheduleCredential(parsed.data) !== undefined) return { ok: false, reason: 'credential' };
  try {
    if (await db.driver.inTransaction(appId)) return { ok: false, reason: 'busy' };
    const { statements } = await db.scratchRun(appId, [{ sql: parsed.data.sql }]);
    const first = statements[0];
    if (first === undefined || first.error !== undefined || first.changes === undefined) return { ok: false, reason: 'failed' };
    return { ok: true, item: { ...parsed.data, counts: { changes: first.changes } } };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}
