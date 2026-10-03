// platform/hostCapabilities.ts — the ONE capability table a host platform carries
// (TASK-20261003 K4, ADR-0072 §3).
//
// The block was hand-written four times: `platform-host.ts`, twice in `compose-local.ts`, and
// in this package's own test fixture. Four copies of ten booleans drift one key at a time —
// the fixture never said `appExport`, the local composition's refusal arm said it in a
// different order — and each drift is a surface a host shows or hides differently for no
// reason anyone chose. A lint (apps/host `oneKit.test.ts`) refuses a capability literal
// anywhere else under the kit or the runner.
//
// It lives in the playground because the fixture must import it too, and the playground
// cannot import from a shell (the shells import the playground — ADR-0021 D9).

import type { SnugPlatform } from './platform.js';

export type HostCapabilities = SnugPlatform['capabilities'];

/**
 * The kit's posture, every binding: the four launch booleans EXPLICITLY false rather than
 * left to the web default (a reader that compares against `true` and one that compares
 * against `false` must agree — T2 review minor 5), every host surface off (D15: the brain
 * and the account are the host's; `sync`, `connections` and `share` are capability truth —
 * a control that cannot work is not rendered), and `appExport` ON: the per-app bundle
 * download is how a kit-edited app goes back to the agent (T4 AC6).
 *
 * A binding states only what it does DIFFERENTLY — the runner turns `connections` on and
 * says whether an OAuth redirect can come back; a page that refuses to open turns
 * `appExport` off.
 */
export function hostCapabilities(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    subscriptionMode: false,
    hubSyncOrigin: false,
    lanHttpPrivate: false,
    hubAuth: false,
    brainSettings: false,
    account: false,
    sync: false,
    connections: false,
    share: false,
    appExport: true,
    ...overrides,
  };
}
