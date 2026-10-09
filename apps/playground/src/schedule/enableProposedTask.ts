// schedule/enableProposedTask.ts — THE one writer for every proposal channel (TASK-20261009
// P6/P7; ADR-0074 §4 and its Gate-5 amendment: ONE consent surface, ONE writer). The builder's
// card, the chat lane's card and the app's suggestion strip all land here, after the user's act
// on `EnableConsent`, and nowhere else: `proposalWriter.test.ts` greps `src/` for any other
// `createTask` call that is not the user's own (`provenance: 'user'`).
//
// WHAT IT DOES. Re-validates the proposal with the protocol's strict schema (a card or a strip
// renders what it was staged with, but the bytes that become a task are parsed again HERE — the
// staging surface is UI, not a gate); refuses a step that names an app other than the owner
// (an app may only suggest for itself; the builder and the chat lane pin the thread's app);
// records the channel as the task's `provenance` and the app as `ownerAppId`; and hands the
// result to the engine's `createTask`, which compiles the spec, applies the frequency floor of
// that provenance (15 minutes for anything suggested), records the named apps' versions and
// refuses an app the file does not hold. The answer is the engine's own `TaskResult` — the task,
// or the refusal in words — so every channel shows the same sentence for the same refusal.
//
// Nothing here is a React import, a store or a surface: a pure async function over the db the
// engine already holds, so the test can call it the way the three surfaces do.

import { scheduleProposalSchema, type ScheduleProposal } from '@snugprotocol/protocol';

import { createTask, type TaskResult } from './scheduler.js';
import { appIdsOf } from './taskShape.js';

/** The three channels a proposal arrives on — each a `TaskProvenance` that is never `user`. */
export type ProposalChannel = 'builder' | 'chat' | 'app';

export interface EnableProposedTaskInput {
  /** The staged proposal, as the card or the strip holds it — re-parsed here, never trusted. */
  proposal: unknown;
  /** Who proposed it: the task's `provenance`. */
  provenance: ProposalChannel;
  /**
   * The app the proposal is FOR: the sender of an app suggestion, the thread's app for the
   * builder and the chat lane. Required for `app`; when given, every app step must name it.
   */
  ownerAppId?: string;
}

/** The refusal when a step names an app other than the one the proposal is for. */
export const OTHER_APP_REFUSAL = 'this suggestion names another app — a suggestion may only be for the app it came from';

/** The refusal when an app suggestion arrives with no sender. */
export const NO_OWNER_REFUSAL = 'this suggestion has no app to belong to';

const refuse = (reason: string): TaskResult => ({ ok: false, reason });

function issuesInWords(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** The strict parse, in words — exported so the strip can refuse an unparseable request with the same sentence. */
export function parseProposalOrReason(proposal: unknown): { ok: true; proposal: ScheduleProposal } | { ok: false; reason: string } {
  const parsed = scheduleProposalSchema.safeParse(proposal);
  return parsed.success ? { ok: true, proposal: parsed.data } : { ok: false, reason: `this suggestion can’t be read — ${issuesInWords(parsed.error.issues)}` };
}

/** Every app the steps name is `ownerAppId` — the "an app may only suggest for itself" rule, shared by the strip's intake and the writer. */
export function namesOnly(proposal: ScheduleProposal, ownerAppId: string): boolean {
  return appIdsOf(proposal.steps).every((appId) => appId === ownerAppId);
}

/**
 * Enable a proposal: the user said *schedule it* on the consent surface. Returns the engine's
 * verdict — the created, ENABLED task, or the refusal in one sentence.
 */
export async function enableProposedTask(input: EnableProposedTaskInput): Promise<TaskResult> {
  const parsed = parseProposalOrReason(input.proposal);
  if (!parsed.ok) return refuse(parsed.reason);
  const { proposal } = parsed;
  if (input.provenance === 'app' && input.ownerAppId === undefined) return refuse(NO_OWNER_REFUSAL);
  if (input.ownerAppId !== undefined && !namesOnly(proposal, input.ownerAppId)) return refuse(OTHER_APP_REFUSAL);
  return createTask({
    title: proposal.title,
    steps: proposal.steps,
    spec: proposal.spec,
    provenance: input.provenance,
    ...(input.ownerAppId !== undefined ? { ownerAppId: input.ownerAppId } : {}),
  });
}
