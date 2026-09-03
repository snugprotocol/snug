import { useSyncExternalStore } from 'react';

/** Reactive matchMedia — drives the rail→sheet switch at the mobile breakpoint. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      // No matchMedia (jsdom, some embedded webviews): never matches, never notifies.
      if (typeof window.matchMedia !== 'function') return () => {};
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false),
    () => false,
  );
}
