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

import type { AgentTurnEvent } from '@snugprotocol/adapters';
import type { NetConfirmGate } from '@snugprotocol/auth';
import type { SnugDbDriver } from '@snugprotocol/db';
import type { AgentTransport, NetHandler } from '@snugprotocol/runner';

import { createAppTransport } from '../agent/transport.js';
import { allows } from '../platform/platform.js';
import { isUnownedId } from '../share/sharedInbox.js';
import type { ByokProvider, PlaygroundMode } from '../state/mode.js';
import { createNetHandlerFor, type CreateNetHandlerOptions } from '../state/net.js';

export interface ComposeAppRuntimeOptions {
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

/** The frame's capability bindings, spread onto `SnugAppFrame`: db + namespace always, net + its id when the app may reach the network. */
export type FrameCapabilityProps = { db: SnugDbDriver; dbNamespace: string } & ({ net: NetHandler; netAppId: string } | { net?: undefined; netAppId?: undefined });

export interface AppRuntime {
  /** The app's OWN transport (ADR-0018 contract, the per-app pin, the R-9 scrub — all per send). */
  transport: AgentTransport;
  /** The frame's bindings: db + namespace always; the value-blind net handler and its host-assigned id only where this app may reach the network (M5: nothing is duplicated beside them). */
  frameProps: FrameCapabilityProps;
}

/** Whether this app may reach the network here — ONE rule for the visible and the hidden frame. */
export function appMayReachNetwork(appId: string): boolean {
  return !isUnownedId(appId) && allows('connections');
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
  const frameProps: FrameCapabilityProps =
    netHandler !== undefined ? { db: options.driver, dbNamespace: appId, net: netHandler, netAppId: appId } : { db: options.driver, dbNamespace: appId };
  return { transport, frameProps };
}
