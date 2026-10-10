// run/appRuntime.ts — ONE app's runtime composition, lifted out of `RunView`
// (TASK-20261009-scheduling-framework A1; ADR-0074 §3, §5; feasibility F5).
//
// WHY A SEPARATE MODULE. There is no headless runner: `createRunnerHost` needs a live
// iframe and `RunView` was the one place that composed what a frame needs — the app's OWN
// LLM transport, the value-blind net handler bound to the HOST-assigned id, the db driver and
// its namespace. The scheduler's hidden frame (`schedule/ScheduledRunHost.tsx`) must run an app
// with exactly those seams, so they are composed HERE and consumed by both mounts: a second
// composition in the scheduler would be a second network path with its own gate configuration
// — the thing `connectedFetchDepsFor`'s header was written to prevent.
//
// WHAT IS LIFTED, AND WHAT IS NOT. Lifted: the transport (`createAppTransport` — the runtime
// contract, the per-app model pin and the R-9 scrub applied per send), the net handler
// (`createNetHandlerFor` — the executor reads the app's frozen ceiling and credentials per use;
// the runner never sees a token) and the frame's capability bindings. NOT lifted: the shared
// preview's consent gate (a RunView concern — the hidden frame never runs an unowned app),
// `openUrl` (a visible user act; a hidden frame gets none, so every open-url request is a named
// refusal) and `registerAppHost`, which stays RunView's — it is the wizard's seam, and the
// hidden frame must never register as the app's live host (security F5).
//
// THE ONE DIFFERENCE A CALLER MAY INJECT is the confirm gate: absent, the page's ordinary gate
// (the standing gate over the session gate) answers mutating calls; the scheduler hands its
// STANDALONE refusing gate (`schedule/scheduledConfirmGate.ts`) so no remembered or armed grant
// can reach an unattended run (ADR-0074 §6). `onNetCall` is the scheduler's counting seam.
//
// THE NET RULE IS ONE RULE: an app reaches the network only when it is OWNED (an uninstalled
// starter has no auth spec; a shared preview is uninstalled by definition) and the host allows
// connections — then `host-ready.net` is false STRUCTURALLY, not by a flag the app must trust.
//
// THE ACCESS RULE (TASK-20261010-cross-app-access AC20, ADR-0075) has the same shape: the third
// pair — the access handler and its HOST-assigned id — is bound only for an OWNED app where the
// host allows access (a starter browse or a shared preview has no row to read from or to keep a
// history against), so `host-ready.access` is false structurally everywhere else. `attended` is
// REQUIRED, never defaulted: the visible frame says `true` (someone is there to be asked), the
// scheduler's hidden frame `false` (an ask is refused `ACCESS_UNATTENDED`, a read needs the
// grant's *also while I'm away*). A default would let one mount inherit the other's answer.
// `generation` is the host's frame generation the handler keys on (RunView's `frameEpoch`) —
// REQUIRED for the visible frame and ABSENT for the hidden one, which owns no session ("while
// it's open") access at any epoch; nothing is defaulted (a default 0 would collide with the first
// epoch, and a session grant's readability would hang on a number the user cannot see). The
// handler module is called only inside
// `composeAppRuntime` — the access engine reads this module's `appMayReachNetwork`, so nothing
// here may touch it while modules load.

import type { AgentTurnEvent } from '@snugprotocol/adapters';
import type { NetConfirmGate } from '@snugprotocol/auth';
import type { SnugDbDriver } from '@snugprotocol/db';
import type { AccessHandler, AgentTransport, NetHandler } from '@snugprotocol/runner';

import { createAccessHandlerFor } from '../access/accessHandler.js';
import { createAppTransport } from '../agent/transport.js';
import { allows } from '../platform/platform.js';
import { isUnownedId } from '../share/sharedInbox.js';
import type { ByokProvider, PlaygroundMode } from '../state/mode.js';
import { createNetHandlerFor, type CreateNetHandlerOptions } from '../state/net.js';

// The two "may this app …" rules live in a LEAF module (review finding 7: the composition imports the
// access handler, whose consent path reads egress, which needs the network rule); re-exported here
// so every existing caller keeps its import.
export { appMayReachNetwork, appMayUseAccess } from './appCapabilityRules.js';
import { appMayReachNetwork, appMayUseAccess } from './appCapabilityRules.js';

/**
 * Whether someone is looking at this frame — REQUIRED, no default (AC20): the visible run view
 * says `true` with its frame generation, the scheduler's hidden frame `false` with none. The
 * access handler refuses an unattended ask and reads, unattended, only through a persisted grant
 * the user allowed *also while I'm away*.
 */
export type FrameAttendance =
  | {
      attended: true;
      /** The host's frame generation the access handler keys on (RunView's `frameEpoch`). */
      generation: number;
    }
  | { attended: false; generation?: undefined };

export type ComposeAppRuntimeOptions = ComposeAppRuntimeBase & FrameAttendance;

interface ComposeAppRuntimeBase {
  /** The HOST-assigned app id — the db namespace and the net binding, never anything the app claims. */
  appId: string;
  mode: PlaygroundMode;
  provider: ByokProvider;
  /** The LLM surface's feed (RunView's inspector); a hidden frame passes none. */
  onLlmEvent?: ((event: AgentTurnEvent) => void) | undefined;
  /** Fired when an app's turn begins (the inspector reset); a hidden frame passes none. */
  onTurnStart?: (() => void) | undefined;
  /** The gate a mutating net call must pass. Absent → the page's ordinary gate. */
  confirmGate?: NetConfirmGate | undefined;
  /** Host-side observer of net-error OUTCOMES, code-keyed (AL-04 AC9). */
  onNetError?: CreateNetHandlerOptions['onNetError'];
  /** Asked before every net call the handler carries — the scheduler's counting/capping seam. */
  onNetCall?: CreateNetHandlerOptions['onNetCall'];
  /** Injectable for tests and the e2e stub; defaults to the platform fetch seam. */
  fetchImpl?: CreateNetHandlerOptions['fetchImpl'];
  /** The driver the frame's db capability binds to — the user file's face, or an ephemeral one for a browse. */
  driver: SnugDbDriver;
}

/**
 * The frame's capability bindings, spread onto `SnugAppFrame`: db + namespace always, net + its id
 * when the app may reach the network, access + its id when the app may read another app's data.
 */
export type FrameCapabilityProps = { db: SnugDbDriver; dbNamespace: string } & NetPair & AccessPair;

/** The net handler and the id it is bound to — both, or neither. */
type NetPair = { net: NetHandler; netAppId: string } | { net?: undefined; netAppId?: undefined };
/** The access handler and the id it is bound to — both, or neither. */
type AccessPair = { access: AccessHandler; accessAppId: string } | { access?: undefined; accessAppId?: undefined };

export interface AppRuntime {
  /** The app's OWN transport (ADR-0018 contract, the per-app pin, the R-9 scrub — all per send). */
  transport: AgentTransport;
  /** The frame's bindings: db + namespace always; the value-blind net handler and the access handler, each with its host-assigned id, only where this app may use them (M5: nothing is duplicated beside them). */
  frameProps: FrameCapabilityProps;
}



export function composeAppRuntime(options: ComposeAppRuntimeOptions): AppRuntime {
  const { appId } = options;
  const transport = createAppTransport(options.mode, options.provider, options.onLlmEvent, appId, options.onTurnStart);
  const netHandler = appMayReachNetwork(appId)
    ? createNetHandlerFor({
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.onNetError !== undefined ? { onNetError: options.onNetError } : {}),
        ...(options.onNetCall !== undefined ? { onNetCall: options.onNetCall } : {}),
        ...(options.confirmGate !== undefined ? { confirmGate: options.confirmGate } : {}),
      })
    : undefined;
  const netPair: NetPair = netHandler !== undefined ? { net: netHandler, netAppId: appId } : {};
  const accessPair: AccessPair = appMayUseAccess(appId)
    ? { access: createAccessHandlerFor(appId, options.attended ? { attended: true, generation: options.generation } : { attended: false }), accessAppId: appId }
    : {};
  const frameProps: FrameCapabilityProps = { db: options.driver, dbNamespace: appId, ...netPair, ...accessPair };
  return { transport, frameProps };
}
