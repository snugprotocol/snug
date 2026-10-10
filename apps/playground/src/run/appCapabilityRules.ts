// run/appCapabilityRules.ts — the two "may this app …" rules, as a LEAF module
// (TASK-20261010-cross-app-access, W3 review finding 7).
//
// `run/appRuntime.ts` composes a frame's runtime and therefore imports the transport, the net
// handler and the access handler; the access handler's consent path reads `access/egress.ts`,
// and egress needs the network rule. Homing the rules in appRuntime.ts closed that loop
// (appRuntime → accessHandler → consent → egress → appRuntime). This module imports only the
// ownership predicate and the platform, so every reader of a rule — the composition, the
// egress disclosure, a test — reaches it without the composition's imports. appRuntime.ts
// re-exports both names, so its callers are unchanged.

import { allows } from '../platform/platform.js';
import { isUnownedId } from '../share/sharedInbox.js';

/** Whether this app may reach the network here — ONE rule for the visible and the hidden frame. */
export function appMayReachNetwork(appId: string): boolean {
  return !isUnownedId(appId) && allows('connections');
}

/** Whether this app may read other apps' data here — an OWNED app on a host that allows access (ADR-0075). */
export function appMayUseAccess(appId: string): boolean {
  return !isUnownedId(appId) && allows('access');
}
