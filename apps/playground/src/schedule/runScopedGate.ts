// schedule/runScopedGate.ts — the run-scoped ask gate the LIVE frame's net handler carries
// (TASK-20261010-host-broker PR-1; ADR-0077 §3; contract v2 D-PR1-3, D-PR1-9).
//
// THE HAZARD IT CLOSES. The live frame's net handler is composed ONCE, at mount, with the page's
// standing→session chain. A run the user did not start, delegated to that frame (ADR-0077 §2),
// would otherwise have a remembered *remember for this session* grant — or an armed standing
// grant — answer a write nobody was watching: the hazard the Gate-5 fold named ("presence is not
// consent", lesson 2026-10-09). This gate consults a module store PER REQUEST and, while a run owns
// the app, never asks `inner` at all. It asks the present user through the SAME confirm queue,
// tagged so the dialog speaks for the host, once per run, remembering nothing — `rememberSession`
// is structurally unwritable here: the only writer is the session gate's own prompt path, which
// this gate bypasses.
//
// `confirm(request)`, in order:
//   (1) a run is in flight for the app (`delegated`) — `asking || refused.length > 0` → refused AT
//       ONCE and recorded `already-asked` (one outstanding ask per run; a handler cannot park N
//       dialogs, and nothing is asked again after a refusal); else ONE prompt, bounded: granted →
//       `granted += 1`, true; denied → `declined`; no answer within the bound → `timed-out`, and the
//       prompt's signal is aborted (what withdraws the parked dialog). The run ENDING aborts the
//       same signal (its own `signal`): the dialog is withdrawn and the call answered no, with
//       nothing recorded on a run already recorded.
//   (2) no run, but the frame generation a run touched is still the live one — the STICKY after-run
//       ask (security blocker 1): prompt with `run: undefined`, record nothing, remember nothing.
//   (3) otherwise `inner.confirm(request)` — byte-for-byte today's chain.
//
// Timers are `setTimeout` + `Date.now()` only — never `AbortSignal.timeout` (vitest's fake clock
// drives the suites). This module never imports `state/net.ts`: it takes the queue as `prompt`.

import type { NetConfirmDecision, NetConfirmGate, NetConfirmRequest } from '@snugprotocol/auth';

import type { DelegatedRun } from './runPlacement.js';

/** No answer within this → the ask is withdrawn and the call refused (the dialog says "no answer in a minute"). */
export const DELEGATED_CONFIRM_TIMEOUT_MS = 60_000;

/** What the gate parks on the confirm queue: the very request (the withdraw is by reference), the run — or none for the sticky after-run ask — and the signal that withdraws it. */
export interface ScheduledPrompt {
  request: NetConfirmRequest;
  run: { runId: string; title: string; appName: string } | undefined;
  signal: AbortSignal;
}

export interface RunScopedGateDeps {
  /** The page's standing→session chain — consulted ONLY outside a run and off a touched frame. */
  inner: NetConfirmGate;
  delegated: (appId: string) => DelegatedRun | undefined;
  /** The sticky generation (`runPlacement.ts` `touchedGeneration`). */
  touched: (appId: string) => number | undefined;
  liveGeneration: (appId: string) => number | undefined;
  /** Parks on the SAME confirm queue, tagged; withdraws (answers denied) when the signal aborts. */
  prompt: (ask: ScheduledPrompt) => Promise<NetConfirmDecision>;
  timeoutMs?: number;
}

/** Why a bounded ask ended without the user's answer. */
type Cut = 'timed-out' | 'run-ended';

/**
 * One bounded ask: the prompt's signal aborts on the timeout, and on the run's own signal when one
 * is given. Answers the decision and, when the user never answered, why.
 */
async function askOnce(
  deps: RunScopedGateDeps,
  request: NetConfirmRequest,
  run: DelegatedRun | undefined,
): Promise<{ decision: NetConfirmDecision; cut: Cut | undefined }> {
  const controller = new AbortController();
  let cut: Cut | undefined;
  const timer = setTimeout(() => {
    cut = 'timed-out';
    controller.abort();
  }, deps.timeoutMs ?? DELEGATED_CONFIRM_TIMEOUT_MS);
  const onRunEnd = (): void => {
    if (cut === undefined) cut = 'run-ended';
    controller.abort();
  };
  if (run !== undefined) {
    if (run.signal.aborted) onRunEnd();
    else run.signal.addEventListener('abort', onRunEnd, { once: true });
  }
  try {
    const decision = await deps.prompt({
      request,
      run: run === undefined ? undefined : { runId: run.runId, title: run.title, appName: run.appName },
      signal: controller.signal,
    });
    return { decision, cut };
  } finally {
    clearTimeout(timer);
    run?.signal.removeEventListener('abort', onRunEnd);
  }
}

export function createRunScopedGate(deps: RunScopedGateDeps): NetConfirmGate {
  return {
    async confirm(request: NetConfirmRequest): Promise<boolean> {
      const run = deps.delegated(request.appId);
      if (run !== undefined) {
        // (1) A run owns the app: never the page's chain. One outstanding ask per run.
        if (run.asking || run.refused.length > 0) {
          run.refused.push({ host: request.host, method: request.method, why: 'already-asked' });
          return false;
        }
        run.asking = true;
        try {
          const { decision, cut } = await askOnce(deps, request, run);
          if (cut === 'timed-out') {
            run.refused.push({ host: request.host, method: request.method, why: 'timed-out' });
            return false;
          }
          // The run ended while the ask was parked: the dialog was withdrawn, the call is refused, and the
          // record — already returned to the executor — is left as it was.
          if (cut === 'run-ended') return false;
          if (decision.granted === true) {
            run.granted += 1;
            run.grantedHost = request.host;
            return true;
          }
          run.refused.push({ host: request.host, method: request.method, why: 'declined' });
          return false;
        } finally {
          run.asking = false;
        }
      }
      // (2) The frame a run touched stays ask-only (D-PR1-3): asked once, nothing recorded, nothing remembered.
      const touched = deps.touched(request.appId);
      if (touched !== undefined && touched === deps.liveGeneration(request.appId)) {
        const { decision, cut } = await askOnce(deps, request, undefined);
        return cut === undefined && decision.granted === true;
      }
      // (3) Today's chain, byte for byte.
      return deps.inner.confirm(request);
    },
  };
}
