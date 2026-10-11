// access/grantFacts.ts — the facts derived from a grant record, as a LEAF
// (TASK-20261010-host-broker PR-2; ADR-0076 §1; contract v2 D-PR2-1, feasibility F4).
//
// `durationOf`, `expiresAtOf` and `isExpired` moved here VERBATIM from grants.ts, which re-exports
// them so no caller changed; the two grant shapes they are typed over (`SessionAccessGrant`,
// `AnyAccessGrant`) moved with them for the same reason. They live apart because the pure policy
// (`policy.ts`) needs them and must not reach the engine: grants.ts imports the stores, the
// app-host registry, consent.ts and the scoped-read cache, and a policy that imported it would
// load all of that. This module imports the protocol and nothing else — accessPolicy.test.ts
// reads its import lines to prove it.
//
// `expired` is never stored: it is derived from the duration at every read (grants.ts's rule),
// and the history marks it once (`markExpiredOnce`, which stays in the engine).

import { durationFromExpiry, type AccessDuration, type AccessGrant } from '@snugprotocol/protocol';

/** A memory grant: the persisted record's shape with the one duration that never persists. */
export type SessionAccessGrant = Omit<AccessGrant, 'duration'> & { duration: { kind: 'session' } };
export type AnyAccessGrant = AccessGrant | SessionAccessGrant;

/** The duration the user chose. A persisted `until` reads `day` or `week` by the protocol's own inverse of `durationToExpiry`. */
export function durationOf(grant: AnyAccessGrant): AccessDuration {
  if (grant.duration.kind === 'session') return 'session';
  if (grant.duration.kind === 'always') return 'always';
  return durationFromExpiry(grant.grantedAt, grant.duration.at);
}

export function expiresAtOf(grant: AnyAccessGrant): string | undefined {
  return grant.duration.kind === 'until' ? grant.duration.at : undefined;
}

export function isExpired(grant: AnyAccessGrant, now: number): boolean {
  const at = expiresAtOf(grant);
  return at !== undefined && Date.parse(at) <= now;
}
