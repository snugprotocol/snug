// platform-host.ts — the host kit's SnugPlatform (TASK-20260905-host-kit P2/P3; ADR-0065
// §4, D15). Like `apps/desktop/src/platform-desktop.ts` it only supplies capability; the
// policy lives in the packages and the playground's own readers (`allows`, `secretsUsable`,
// `resolveBrain`). Everything here comes from the probe: the kit carries no transport seat
// it cannot honour, so absence is the truth — no `fetchImpl` (connections are off and the
// artifact viewer's CSP would refuse the call anyway), no LAN, sidecar, helper, OAuth,
// file-open or update seats.
//
// The four launch booleans are set EXPLICITLY false rather than left to the web default
// (review minor 5): a reader that compares against `true` and one that compares against
// `false` must agree. The five host surface flags are false — the ONLY platform that says
// so; web, desktop and every test-constructed platform keep every surface by absence.

import type { SnugPlatform } from '@playground/platform/platform';

import type { ProbeResult } from './probe.js';

export function createHostPlatform(probe: ProbeResult, sqlJsWasmBinary: Uint8Array): SnugPlatform {
  return {
    kind: 'host',
    binding: probe.binding,
    // The brain the ONE derivation honours ahead of the user file (P2) — demo in T2.
    brain: probe.brain.brain,
    // The engine as bytes (P4/AC8): both sql.js callers pass it beside the locator and
    // no request for sql-wasm.wasm is ever made.
    sqlJsWasmBinary,
    // The rung that WORKED, not the one that was present (P6).
    userdbBackend: probe.storage.backend,
    capabilities: {
      subscriptionMode: false,
      hubSyncOrigin: false,
      lanHttpPrivate: false,
      hubAuth: false,
      // D15: nothing to choose.
      brainSettings: false,
      account: false,
      // Capability truth: nothing reachable, nothing rendered.
      sync: false,
      connections: false,
      share: false,
    },
  };
}
