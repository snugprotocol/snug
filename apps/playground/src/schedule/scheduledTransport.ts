// schedule/scheduledTransport.ts — the counting/capping decorator over the hidden frame's
// transport (TASK-20261009-scheduling-framework A4; ADR-0074 §6; security F6, F12). The
// `share/consentTransport.ts` pattern: the app's `createAppTransport` stays what it is — the
// runtime contract, the per-app pin and the R-9 egress scrub per send — and this wrapper adds
// what an UNATTENDED run needs around it:
//
//   COUNT.  Every send that reaches the brain is one AI call on the run row (`calls.ai`), and
//           the queue charges that to the day's ceiling. A reply that refused before anything
//           left the page (F15's `CONSENT_REQUIRED` — the imported-endpoint confirm) is not a
//           call — `scrub.ts`'s `countsAsAiCall`, the rule `appThink.ts` applies too. The
//           count is readable here (`calls`) and reported to the executor's own count as it
//           happens (`onCounted`, Gate-5 PR-B M22).
//   CAP.    `onCall()` is asked BEFORE every send — the executor's closure reads the day's
//           counters plus what this run already spent — and a `false` refuses by name with the
//           EXISTING `HOST_ERROR` code (no new error code: feasibility F3), non-retryable, the
//           brain untouched, nothing counted.
//   SCRUB.  The reply side of the C1 wall, `deliver` policy (`scrub.ts`, M15): the text is
//           shape-scrubbed and, when it STILL looks like a credential, WITHHELD whole behind a
//           named refusal. The app never sees a key the brain echoed, and nothing
//           credential-shaped can ride a `schedule-result` into the file.
//   WHOLE.  `onDelta` is never forwarded: a streamed fragment is unscrubbed by construction, so
//           a scheduled reply arrives once, whole, after the scrub. The hidden frame declares
//           `streaming: false` to match (the runner's rule: the flag follows the transport).
//
// THE LIVE FRAME'S SIBLING (TASK-20261010-host-broker PR-1; ADR-0077 §4; D-PR1-6, D-PR1-7).
// `createRunCountingTransport` wraps the OPEN app's own transport so a delegated run's AI calls
// land on the run's record — and nothing else: no cap (the ceiling is asked BEFORE dispatch;
// inside the window calls are counted, never refused), no scrub (the attended frame's replies are
// the open app's own powers), and the send options forwarded WHOLE — the open app streams, so
// `onDelta` and `signal` must reach the inner transport.

import { ERROR_CODES } from '@snugprotocol/protocol';
import type { AgentTransport, AgentTransportOptions, TransportResult } from '@snugprotocol/runner';

import type { DelegatedRun } from './runPlacement.js';
import { countsAsAiCall, scrubOrWithhold } from './scrub.js';

export interface ScheduledTransportOptions {
  /** Asked before every send: `false` refuses at the day's ceiling without touching the brain. */
  onCall(): boolean;
  /** Told of every send that counted as a call, as it is counted — the executor's own tally (M22). */
  onCounted?: () => void;
}

export interface ScheduledTransport extends AgentTransport {
  /** Sends that reached the brain — what the run row records as `calls.ai`. */
  readonly calls: number;
}

/** What the app reads when the day's AI ceiling refuses a scheduled send. */
export const SCHEDULED_AI_LIMIT_MESSAGE = 'the limit on AI calls for today is reached — Snug tries again tomorrow';

/** What replaces a reply that looked like a credential even after the scrub. */
export const SCHEDULED_REPLY_WITHHELD = 'the reply was withheld because it looked like a credential';

export function createScheduledTransport(inner: AgentTransport, options: ScheduledTransportOptions): ScheduledTransport {
  let calls = 0;
  const counted = (): void => {
    calls += 1;
    options.onCounted?.();
  };
  return {
    get calls() {
      return calls;
    },
    async send(wire: string, sendOptions: AgentTransportOptions): Promise<TransportResult> {
      if (!options.onCall()) {
        return { ok: false, code: ERROR_CODES.HOST_ERROR, message: SCHEDULED_AI_LIMIT_MESSAGE, retryable: false };
      }
      const reply = await inner.send(wire, { signal: sendOptions.signal });
      if (countsAsAiCall(reply)) counted();
      if (!reply.ok) return reply;
      const text = scrubOrWithhold(reply.text, 'deliver');
      if (text === undefined) {
        return { ok: false, code: ERROR_CODES.HOST_ERROR, message: SCHEDULED_REPLY_WITHHELD, retryable: false };
      }
      return { ...reply, text };
    },
  };
}

export interface RunCountingTransportDeps {
  /** The run in flight on this app's live frame right now, if any — read per send. */
  delegated(): DelegatedRun | undefined;
  /** Told of every send that reached the brain while a run was in flight — the run's own tally. */
  onCounted(run: DelegatedRun): void;
}

/** The live frame's transport, counting AI calls on a delegated run — options forwarded whole, no cap, no scrub. */
export function createRunCountingTransport(inner: AgentTransport, deps: RunCountingTransportDeps): AgentTransport {
  return {
    async send(wire: string, sendOptions: AgentTransportOptions): Promise<TransportResult> {
      const reply = await inner.send(wire, sendOptions);
      const run = deps.delegated();
      if (run !== undefined && countsAsAiCall(reply)) deps.onCounted(run);
      return reply;
    },
  };
}
