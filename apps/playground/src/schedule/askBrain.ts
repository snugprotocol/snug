// schedule/askBrain.ts — what the brain an *ask <app>'s AI* step would run on NOW can do there
// (TASK-20261010-host-broker PR-4 Gate 5, U1), read by the ENGINE's own gates so a surface never
// promises what a run then refuses. Three answers:
//
//  - `blocked`  — no brain here answers an *ask* step at all: `keylessBrainGate`, the executors'
//                 own test (the demo, or a BYOK brain with no key in the FILE). Every ask step of
//                 that app is refused, whether or not it may look things up.
//  - `no-tools` — it answers, but cannot look things up (`chatDoorOpen`: the data lane runs only
//                 on a keyed BYOK or a local route), so a step that may look things up runs
//                 tool-free.
//  - `tools`    — it can.
//
// The editor says it under each ask step and the consent says it on each step, BEFORE the first
// result ever has to. Not pure: the route reads the brain stores and the file's key rows, as the
// send path does — which is why it is not `editorModel`'s.

import type { UserDb } from '@snugprotocol/db';

import { chatBrainRoute, chatDoorOpen } from '../access/egress.js';
import { keylessBrainGate } from './appThink.js';

/** What the brain an app's *ask* step would run on now can do there — see the header. */
export type AskBrain = 'tools' | 'no-tools' | 'blocked';

/** The brain an *ask <app>'s AI* step would run on now, by the engine's gates in their order: the keyless gate, then the chat door. */
export function askBrainFor(db: UserDb, appId: string): AskBrain {
  const route = chatBrainRoute(db, appId);
  if (keylessBrainGate(db, appId, route) !== undefined) return 'blocked';
  return chatDoorOpen(route) ? 'tools' : 'no-tools';
}

/** The apps among `appIds` whose *ask* steps no brain here would answer — the consent's `blockedApps`. */
export function blockedAppsOf(db: UserDb, appIds: readonly string[]): string[] {
  return [...new Set(appIds)].filter((appId) => askBrainFor(db, appId) === 'blocked');
}
