// schedule/scrub.ts — the reply-side C1 wall of a scheduled run, in ONE place
// (TASK-20261009-scheduling-framework; ADR-0074 §6; security F12, F15; Gate-5 PR-B M15).
//
// Three seats used to spell the same two rules by hand — `executors.finalizeOutcome` (what a
// run row stores), `scheduledTransport` (what the hidden frame reads back) and `appThink`
// (what a send charges). They agree here.
//
// SCRUB OR WITHHOLD. `findScheduleCredential` is the walk the run row's strict parse refuses
// on; `scrubCredentialProse` is the shape scrub (`security/credentialShapes.ts`, prose mode).
// Two named policies, because the two seats are pinned to different answers for one text:
//   `store`   — what lands in the file. A text that looks like a credential AS RECEIVED is
//               withheld whole (`undefined`): a stored summary is read later, exported, synced,
//               so the one honest answer is to keep none of it. What survives is shape-scrubbed.
//   `deliver` — what the app reads back from its own brain mid-run. The text is shape-scrubbed
//               FIRST and withheld only when it STILL looks like a credential, so the app keeps
//               a usable answer with the token redacted ("Authorization: Bearer «redacted»").
// Either way nothing credential-shaped reaches a `schedule-result` or a run row: the stored
// policy runs again on whatever the app then reports.
//
// WHAT A SEND CHARGES. `calls.ai` is 1 whenever the transport was ASKED and answered anything
// but F15's `CONSENT_REQUIRED` — the imported-endpoint confirm refused before any provider was
// touched, so nothing left the page and nothing is counted.

import { ERROR_CODES, findScheduleCredential } from '@snugprotocol/protocol';
import type { TransportResult } from '@snugprotocol/runner';

import { scrubCredentialProse } from '../security/credentialShapes.js';

export type ScrubPolicy = 'store' | 'deliver';

/** The text made safe under `policy`, or `undefined` when it must be withheld whole. An empty string stays empty. */
export function scrubOrWithhold(text: string, policy: ScrubPolicy): string | undefined {
  if (text === '') return text;
  if (policy === 'store' && findScheduleCredential({ text }) !== undefined) return undefined;
  const scrubbed = scrubCredentialProse(text);
  if (findScheduleCredential({ text: scrubbed }) !== undefined) return undefined;
  return scrubbed;
}

/** Whether a reply counts as one AI call on the run row: everything but a refusal that never left the page. */
export function countsAsAiCall(reply: TransportResult): boolean {
  return reply.ok || reply.code !== ERROR_CODES.CONSENT_REQUIRED;
}
