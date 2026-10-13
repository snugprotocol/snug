// The app side of the host's NAMED events, as a hook (TASK-20261010-host-broker PR-6, AC40b/AC40c;
// ADR-0034's promised `useHostEvents`; D-PR6-3).
//
// The host rings named events on the one `host-event` channel — hints with ids, never content
// (R7): `connection-event { slot, verified, requestRefresh }` when a connection the app holds is
// verified in the wizard and its data is stale (the "load my real data" signal), `schedule-run`
// and the access hints for the hooks that answer them. `onHostEvent` is the primitive
// (bridge.ts); `useHostEvents` subscribes a component to several events by name — the record's
// keys — and unsubscribes on unmount.
// Scheduled runs and the access hints have their own hooks (`useSnugSchedule`, `useSnugAccess`),
// which validate their seats; a handler here receives the frame's `data` seat as `unknown`.
//
// Both forms carry it: section 6 of the embedded hooks block is the same hook, the same contract
// (contract-host-events.ts runs against each).
import { useEffect, useRef } from 'react';
import { onHostEvent, type HostEventListener } from './bridge.js';

/** Named host-events to their handlers — the record `useHostEvents` subscribes. */
export type HostEventHandlers = Readonly<Record<string, HostEventListener>>;

/**
 * Subscribes the component to each named host-event in `handlers` (one subscription per key,
 * through `onHostEvent`, so this may be the first hook to mount). The LATEST render's handler is
 * the one that runs; the subscriptions change only when the SET of keys does (the keys joined by
 * `'\n'` are the dependency), and every one is removed on unmount. A key whose value is not a
 * function at the moment its event arrives is ignored. `theme-change` is still handled by the
 * bridge itself, first — a handler for it only observes.
 */
export function useHostEvents(handlers: HostEventHandlers): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });
  const events = Object.keys(handlers).join('\n');
  useEffect(() => {
    const offs = events
      .split('\n')
      .filter((event) => event !== '')
      .map((event) =>
        onHostEvent(event, (data) => {
          const handler: unknown = handlersRef.current[event];
          if (typeof handler === 'function') (handler as HostEventListener)(data);
        }),
      );
    return () => {
      for (const off of offs) off();
    };
  }, [events]);
}
