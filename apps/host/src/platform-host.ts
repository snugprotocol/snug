// platform-host.ts — the host kit's SnugPlatform (TASK-20260905-host-kit P2/P3; ADR-0065
// §4, D15; TASK-20260905-binding-a-artifacts seats). Like `apps/desktop/src/platform-desktop.ts`
// it only supplies capability; the policy lives in the packages and the playground's own
// readers (`allows`, `secretsUsable`, `resolveBrain`). Everything here comes from the probe
// and the composition root: the kit carries no transport seat it cannot honour, so absence
// is the truth — no `fetchImpl` (connections are off and the artifact viewer's CSP would
// refuse the call anyway), no LAN, sidecar, helper, OAuth, file-open or update seats.
//
// The capability block is `hostCapabilities()` — the ONE table every host binding composes
// from (K4), which records why each flag stands as it does. This binding changes nothing in
// it: connections stay off, and the per-app export stays on.

import type { PersistenceBackend } from '@snugprotocol/db';

import { hostCapabilities } from '@playground/platform/hostCapabilities';
import type { AgentHandInSeat, CustodySeat, SchedulerSeat, SnugPlatform } from '@playground/platform/platform';

import type { Binding, ProbeResult } from './probe.js';

export interface HostPlatformSeats {
  /** The file's home as composed (the artifact record, or the probed bucket). Absent → the probed bucket. */
  userdbBackend?: PersistenceBackend;
  custody?: CustodySeat;
  saveFile?: (bytes: Uint8Array, suggestedName: string) => Promise<void>;
  agentHandIns?: AgentHandInSeat;
  /** The scheduler's seat (TASK-20261009 H3) — `schedulerSeatFor(binding)`, composed per binding. */
  scheduler?: SchedulerSeat;
}

/**
 * The scheduler's seat per binding (TASK-20261009 H3; ADR-0074 §7). Every kit page promises
 * only the page (`wakeMode: 'page'` — a run happens while it is open) and carries NO `notify`:
 * a page inside a viewer or opened from disk cannot raise a notification, and absence is the
 * truth the engine reads (the inbox result still lands). `hostLabel` is the SUBJECT of the
 * honesty line in the binding's own words — "this artifact" under either artifact arm (a
 * reader cannot tell them apart and should not), "this page" for a plain file and for the
 * runner's page, which is a tab. The storage rung the line also needs is read off the custody
 * store by `honestyInputFor`, not carried here.
 */
export function schedulerSeatFor(binding: Binding): SchedulerSeat {
  switch (binding) {
    case 'artifact':
    case 'artifact-static':
      return { wakeMode: 'page', hostLabel: 'this artifact' };
    case 'file':
    case 'local-host':
      return { wakeMode: 'page', hostLabel: 'this page' };
    default: {
      const never: never = binding;
      return never;
    }
  }
}

export function createHostPlatform(probe: ProbeResult, sqlJsWasmBinary: Uint8Array, seats: HostPlatformSeats = {}): SnugPlatform {
  return {
    kind: 'host',
    binding: probe.binding,
    // The brain the ONE derivation honours ahead of the user file (P2): demo, or the
    // host brain the probe pinned (T4: `sample`).
    brain: probe.brain.brain,
    // The engine as bytes (P4/AC8): both sql.js callers pass it beside the locator and
    // no request for sql-wasm.wasm is ever made.
    sqlJsWasmBinary,
    // The rung that WORKED (P6), or the record/backend composed over it (T4 AC4/AC5).
    userdbBackend: seats.userdbBackend ?? probe.storage.backend,
    ...(seats.custody !== undefined ? { custody: seats.custody } : {}),
    ...(seats.saveFile !== undefined ? { saveFile: seats.saveFile } : {}),
    ...(seats.agentHandIns !== undefined ? { agentHandIns: seats.agentHandIns } : {}),
    ...(seats.scheduler !== undefined ? { scheduler: seats.scheduler } : {}),
    capabilities: hostCapabilities(),
  };
}
