// schedule/scheduledConfirmGate.ts — the STANDALONE confirm gate a scheduled run's net
// handler carries (TASK-20261009-scheduling-framework A5; ADR-0074 §6; security F2, F16).
//
// THE ONE IDEA. An unattended run has nobody at the dialog, so the only honest answer to a
// mutating call is NO — and that answer must be STRUCTURAL: this gate never consults the
// session-remember gate or the standing-approval gate in `state/net.ts` (it does not even
// import that module), so a POST the user remembered for the session, or armed for a thread,
// cannot leak into a run the user is not watching. The executor answers the app with the
// EXISTING `NET_CONFIRM_DENIED` (no new error code — feasibility F3); what the person reads is
// composed by the *Run [app]* executor from what this gate RECORDED (`refused`), in the app's
// words: "Ledger needs your OK — Snug doesn’t post to api.github.com while you’re away".
//
// Reads (`GET`/`HEAD`) never reach a confirm gate at all (the executor asks only for mutating
// methods), so a scheduled run can still refresh what it shows; counting those calls is the
// handler's `onNetCall` seam, not this gate's job.
//
// One gate per run, never shared: the record of what was refused belongs to the run that
// refused it.

import type { NetConfirmGate, NetConfirmRequest } from '@snugprotocol/auth';

/** What the gate refused — enough to say what the app tried, never the body or a credential. */
export interface ScheduledRefusal {
  host: string;
  method: string;
}

export interface ScheduledConfirmGate extends NetConfirmGate {
  /** Every mutating call this gate refused, in order. The first is what the result names. */
  readonly refused: readonly ScheduledRefusal[];
}

/** The verb when nothing specific was recorded (a refusal reported without a request). */
export const SCHEDULED_REFUSAL_VERB = 'send changes anywhere';

/** "post to api.github.com" · "delete on hooks.slack.com" — the verb `copy.needsYou` reads. */
export function scheduledRefusalVerb(refusal: ScheduledRefusal | undefined): string {
  if (refusal === undefined) return SCHEDULED_REFUSAL_VERB;
  const method = refusal.method.toLowerCase();
  return method === 'post' || method === 'put' ? `${method} to ${refusal.host}` : `${method} on ${refusal.host}`;
}

export function createScheduledConfirmGate(): ScheduledConfirmGate {
  const refused: ScheduledRefusal[] = [];
  return {
    refused,
    confirm(request: NetConfirmRequest): boolean {
      refused.push({ host: request.host, method: request.method });
      return false;
    },
  };
}
