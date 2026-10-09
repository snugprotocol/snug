// schedule/honesty.ts — the honesty line for THIS host (TASK-20261009-scheduling-framework E9;
// ADR-0074 §5): who has to be open for a run to happen, whether this page keeps anything, and
// whether another tab might be ticking too. The SENTENCE lives in `copy.ts` (`hostHonesty`
// there is the pure string function the copy tests pin); this module is the one place that
// derives its input from the platform, so no surface reads the seat or the custody store on
// its own and spells the line differently.
//
// WHAT IS READ, PER CALL. The platform's `kind` (the subject's fallback), its optional
// `scheduler` seat (`hostLabel`, `wakeMode` — today's desktop carries no seat and falls back
// by kind; PR-B's seat names "Snug for Mac" itself), and the custody store's `workingCopy`
// (the host kit on Safari holds the working copy in memory only — a result written there is
// gone with the page, so the line says so). The sibling fact comes from the leader election
// (`leader.ts`), which this module does not import: the caller passes the state it holds, so
// a Settings card, the editor and the empty page can all ask with what they have.

import { getPlatform, type SnugPlatform } from '../platform/platform.js';
import { hostHonesty as honestyLine, type HostHonestyInput } from './copy.js';

/** The slice of the leader state the line needs (`LeaderState.canSeeSiblings`). */
export interface HonestyLeaderInput {
  canSeeSiblings: boolean;
}

/** The pure derivation: a platform (and the leader state, when known) → `copy.hostHonesty`'s input. */
export function honestyInputFor(platform: SnugPlatform, leader?: HonestyLeaderInput): HostHonestyInput {
  const seat = platform.scheduler;
  const workingCopy = platform.custody?.state.get().workingCopy;
  return {
    kind: platform.kind,
    ...(seat !== undefined ? { hostLabel: seat.hostLabel, wakeMode: seat.wakeMode } : {}),
    storageRung: workingCopy === 'memory' ? 'memory' : 'durable',
    ...(leader !== undefined ? { canSeeSiblingTabs: leader.canSeeSiblings } : {}),
  };
}

/** The honesty line for the platform this page runs in, read at the call. */
export function hostHonesty(leader?: HonestyLeaderInput): string {
  return honestyLine(honestyInputFor(getPlatform(), leader));
}
