// schedule/scheduledTransport.ts — the counting/capping decorator over the hidden frame's
// transport (TASK-20261009-scheduling-framework A4; ADR-0074 §6; security F6, F12). The
// `share/consentTransport.ts` pattern: the app's `createAppTransport` stays what it is — the
// runtime contract, the per-app pin and the R-9 egress scrub per send — and this wrapper adds
// what an UNATTENDED run needs around it:
//
//   COUNT.  Every send that reaches the brain is one AI call on the run row (`calls.ai`), and
//           the queue charges that to the day's ceiling. A reply that refused before anything
//           left the page (F15's `CONSENT_REQUIRED` — the imported-endpoint confirm) is not a
//           call, the same rule `appThink.ts` applies.
//   CAP.    `onCall()` is asked BEFORE every send — the executor's closure reads the day's
//           counters plus what this run already spent — and a `false` refuses by name with the
//           EXISTING `HOST_ERROR` code (no new error code: feasibility F3), non-retryable, the
//           brain untouched, nothing counted.
//   SCRUB.  The reply side of the C1 wall: the text is shape-scrubbed (`scrubCredentialProse`)
//           and, when it STILL looks like a credential (`findScheduleCredential` — the same walk
//           the run row's parse refuses on), WITHHELD whole behind a named refusal. The app
//           never sees a key the brain echoed, and nothing credential-shaped can ride a
//           `schedule-result` into the file.
//   WHOLE.  `onDelta` is never forwarded: a streamed fragment is unscrubbed by construction, so
//           a scheduled reply arrives once, whole, after the scrub. The hidden frame declares
//           `streaming: false` to match (the runner's rule: the flag follows the transport).

import { ERROR_CODES, findScheduleCredential } from '@snugprotocol/protocol';
import type { AgentTransport, AgentTransportOptions, TransportResult } from '@snugprotocol/runner';

import { scrubCredentialProse } from '../security/credentialShapes.js';

export interface ScheduledTransportOptions {
  /** Asked before every send: `false` refuses at the day's ceiling without touching the brain. */
  onCall(): boolean;
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
  return {
    get calls() {
      return calls;
    },
    async send(wire: string, sendOptions: AgentTransportOptions): Promise<TransportResult> {
      if (!options.onCall()) {
        return { ok: false, code: ERROR_CODES.HOST_ERROR, message: SCHEDULED_AI_LIMIT_MESSAGE, retryable: false };
      }
      const reply = await inner.send(wire, { signal: sendOptions.signal });
      if (!reply.ok) {
        if (reply.code !== ERROR_CODES.CONSENT_REQUIRED) calls += 1;
        return reply;
      }
      calls += 1;
      const text = scrubCredentialProse(reply.text);
      if (findScheduleCredential({ text }) !== undefined) {
        return { ok: false, code: ERROR_CODES.HOST_ERROR, message: SCHEDULED_REPLY_WITHHELD, retryable: false };
      }
      return { ...reply, text };
    },
  };
}
