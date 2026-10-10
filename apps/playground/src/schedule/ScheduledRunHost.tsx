// schedule/ScheduledRunHost.tsx — the ONE hidden app frame a scheduled *Run [app]* step runs in
// (TASK-20261009-scheduling-framework A2; ADR-0074 §3, §5; security F5; feasibility F14).
//
// WHAT IT IS. The SAME `SnugAppFrame` RunView mounts — the same component, so the same
// `sandbox="allow-scripts"` and the same injected CSP (C2 holds by construction, and the C2
// reach test applies unchanged) — rendered 1×1 with `visibility: hidden`. NEVER `display: none`:
// a display-none iframe gets no layout and its `requestAnimationFrame` stalls, so an app that
// paints before it answers would never answer (feasibility F14).
//
// WHAT IT IS NOT. It never calls `registerAppHost`: the hidden frame is not the app's live
// host (the wizard must not ring it, and a visible RunView must still be "the" app on screen).
// It gets no `openUrl` (a hidden frame has no user to confirm an open — every open-url request
// is a named refusal) and declares `streaming: false` to match the scheduled transport, which
// never forwards deltas (`scheduledTransport.ts`).
//
// WHO DRIVES IT. `appRun.ts`'s executor, through `hiddenMountStore`: the queue runs one step at
// a time, so there is at most one mount; the executor sets the mount when the handshake starts
// and clears it on every exit path. This component only renders what the store holds and lends
// the executor the frame's controls (`notifyEvent` for the `schedule-run` hint) and its
// callbacks (announce, app-event, the two failure signals, and — ADR-0077 §5 — `onUnmounted`,
// called from the effect cleanup keyed by `runId` when the store clears or another run's mount
// replaces this one, so a hidden attempt handed over to the open app never overlaps it: the
// executor awaits it before it hints the live frame). Mounted ONCE in `App.tsx`, beside
// `ConnectionWizardNote`, so a run can happen on any route. It mounts ONLY when the app is
// closed: an open app takes the run on its own frame (`runPlacement.ts`).

import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import { SnugAppFrame } from '@snugprotocol/runner';

import { useStore } from '../state/store.js';
import { hiddenMountStore } from './appRun.js';

/** The wrapper keeps the frame out of the flow and out of sight; the frame itself is 1×1 and hidden, never display:none. */
const WRAP_STYLE: CSSProperties = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', visibility: 'hidden', pointerEvents: 'none' };
const FRAME_STYLE: CSSProperties = { width: 1, height: 1, border: 0, visibility: 'hidden' };

export const SCHEDULED_RUN_HOST_TEST_ID = 'scheduled-run-host';

export function ScheduledRunHost(): ReactElement | null {
  const mount = useStore(hiddenMountStore);
  const wrapRef = useRef<HTMLDivElement>(null);
  // The mount this render holds, readable from the run-keyed effect without re-running it on a
  // store write that carries an equal mount for the same run.
  const mountRef = useRef(mount);
  mountRef.current = mount;
  const runId = mount?.runId;
  // OUT OF THE TAB ORDER as well as out of sight (S5). `inert` on the wrapper takes the whole
  // subtree out of focus, hit-testing and the accessibility tree — React 18's typings do not
  // know the attribute, hence the spread. `tabindex="-1"` on the frame itself is the belt for a
  // browser without `inert`; `SnugAppFrame` forwards no attributes, so it is set on the element
  // after the mount (the frame is keyed by run, so once per run). The SAME effect's cleanup
  // reports the frame gone to the run that owned it — once per run, never while it is still up:
  // StrictMode (and React's dev double-invoke) runs the cleanup while the store STILL holds the
  // mount and the frame is still rendered, so the cleanup reports only when the store has moved
  // on from the mount it captured (Gate-5 F-9) — a cleared store or another run's mount.
  useEffect(() => {
    wrapRef.current?.querySelector('iframe')?.setAttribute('tabindex', '-1');
    const owner = mountRef.current;
    if (owner === undefined) return;
    return () => {
      if (hiddenMountStore.get() !== owner) owner.onUnmounted();
    };
  }, [runId]);
  if (mount === undefined) return null;
  return (
    <div ref={wrapRef} data-testid={SCHEDULED_RUN_HOST_TEST_ID} aria-hidden="true" style={WRAP_STYLE} {...{ inert: '' }}>
      <SnugAppFrame
        key={mount.runId}
        html={mount.html}
        transport={mount.transport}
        budgetKey={`schedule:${mount.appId}`}
        {...mount.frameProps}
        streaming={false}
        title="scheduled run"
        style={FRAME_STYLE}
        controlsRef={mount.controls}
        onAnnounce={() => mount.onAnnounce()}
        onAppEvent={(event, data) => mount.onAppEvent(event, data)}
        onNavigatedAway={() => mount.onNavigatedAway()}
        onBudgetExhausted={() => mount.onBudgetExhausted()}
      />
    </div>
  );
}
